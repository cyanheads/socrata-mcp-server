/**
 * @fileoverview SoQL query execution tool for Socrata datasets.
 * @module mcp-server/tools/definitions/query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  CanvasIdSchema,
  type ColumnSchema,
  inferSchemaFromRows,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { escapeTableCell, fencedJson, inlineUpstream } from '@/mcp-server/tools/upstream-text.js';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import type { QueryResult } from '@/services/socrata/types.js';
import { DATASET_ID_PATTERN } from '@/services/socrata/types.js';

/**
 * Hard cap on rows staged onto a DataCanvas per spill. The inline response stays
 * bounded by the caller's `limit`; this bounds the paginated copy drained across
 * repeated SODA calls, so a match of millions stages a queryable subset rather
 * than an unbounded fetch. The canvas is honestly a bounded copy, not "the full
 * result set" when total_count exceeds this cap.
 */
const CANVAS_SPILL_MAX_ROWS = 50_000;

/**
 * Explicit schema for a spilled table. Columns are inferred over every staged
 * row — SODA omits null-valued keys, so a 100-row sniff drops a column that is
 * null that long — plus any header field no row carried (`:`-prefixed system
 * fields excluded). SODA 2.1 sends numbers as strings, so `number` fields
 * (aggregate aliases included) register as DOUBLE; every other column keeps its
 * inferred type. `floating_timestamp` stays VARCHAR: the canvas appender reads
 * offset-less ISO strings as host-local time, while `CAST(col AS TIMESTAMP)`
 * keeps the wall-clock value. Without field types the inferred schema stands.
 */
function spillSchema(
  rows: Record<string, unknown>[],
  fieldTypes: ReadonlyMap<string, string> | undefined,
): ColumnSchema[] {
  const inferred = inferSchemaFromRows(rows);
  if (!fieldTypes) return inferred;
  const staged = new Set(inferred.map((c) => c.name));
  const headerOnly = [...fieldTypes.keys()]
    .filter((name) => !name.startsWith(':') && !staged.has(name))
    .map((name): ColumnSchema => ({ name, type: 'VARCHAR', nullable: true }));
  return [...inferred, ...headerOnly].map((c) =>
    fieldTypes.get(c.name) === 'number' ? { ...c, type: 'DOUBLE' } : c,
  );
}

/**
 * Recovery hint for a `soql_error`, chosen by the upstream Socrata error code:
 * a parse error, an unknown identifier, and a literal/column type mismatch
 * each have a different fix. Undefined for codes without a specific fix — the
 * caller falls back to the declared generic recovery.
 */
function soqlRecoveryHint(socrataCode: unknown, column: unknown): string | undefined {
  switch (socrataCode) {
    case 'query.compiler.malformed':
      return 'Reference columns by API field name — field_name from socrata_get_dataset (cuisine_description, not "CUISINE DESCRIPTION"); a display label containing a space does not parse. Then check quoting: text values take closed single quotes (boro=\'Manhattan\').';
    case 'query.soql.no-such-column': {
      const token = typeof column === 'string' && column ? inlineUpstream(column, 80) : undefined;
      return token
        ? `"${token}" is not a column. If it names a column, use its API field_name from socrata_get_dataset; if it is a text value, single-quote it ('${token}').`
        : "An identifier is not a column. Use API field names (field_name from socrata_get_dataset), and single-quote text values (boro='Manhattan') so they are not read as column names.";
    }
    case 'query.soql.type-mismatch':
      return "A literal's type does not match its column. Check data_type with socrata_get_dataset: Text columns need single-quoted strings (year='2020'); Number columns use bare literals (year=2020).";
    default:
      return;
  }
}

export const queryDataset = tool('socrata_query_dataset', {
  title: 'Query Dataset',
  description:
    'Execute a SoQL query against any dataset on any Socrata portal. Use the search parameter for quick full-text lookup, or combine select/where/group/having/order for full analytical control. Returns rows plus the assembled SoQL string so you can learn the pattern. Columns are referenced by API field name (field_name from socrata_get_dataset, e.g. cuisine_description), never the display label. All SODA 2.1 row values are strings even for numeric columns — check data_type from socrata_get_dataset to determine correct WHERE quoting: Number columns use bare literals (year=2023), Text columns use single-quoted strings (year=\'2023\'). To enumerate distinct values, use select="col, count(*) as n" with group="col" and order="n DESC". When CANVAS_PROVIDER_TYPE=duckdb and rows fill limit, up to 50,000 matching rows spill to a DataCanvas table whatever the limit: list its columns with socrata_dataframe_describe, then run SQL with socrata_dataframe_query.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    domain: z
      .string()
      .optional()
      .describe(
        'Portal the dataset lives on, as a bare hostname (e.g. data.cityofnewyork.us); URL forms like https://data.cityofnewyork.us/ are accepted and reduced to the host. Pass the domain from the same socrata_find_datasets result as dataset_id. Defaults to SOCRATA_DEFAULT_DOMAIN or data.seattle.gov, which is wrong for another portal’s ID.',
      ),
    dataset_id: z
      .string()
      .describe(
        'Four-by-four dataset ID (e.g. kzjm-xkqj). IDs are portal-scoped: take it from socrata_find_datasets together with that result’s domain.',
      ),
    search: z
      .string()
      .optional()
      .describe(
        'Full-text search across all text columns ($q). For field-specific filtering, use where instead.',
      ),
    select: z
      .string()
      .optional()
      .describe(
        'SoQL SELECT clause — API field names (field_name from socrata_get_dataset, not display labels), aliases, aggregates: "state, sum(deaths) as total_deaths". Omit for all columns.',
      ),
    where: z
      .string()
      .optional()
      .describe(
        "SoQL WHERE clause over API field names (field_name from socrata_get_dataset). Check column data_type there first — Number columns: year=2023, Text columns: year='2023'; an unquoted text value is read as a column name. Operators: =, !=, >, <, LIKE, IN(...), BETWEEN, IS NULL, starts_with(), contains(), AND, OR, NOT.",
      ),
    group: z
      .string()
      .optional()
      .describe(
        'SoQL GROUP BY clause over API field names (field_name from socrata_get_dataset). Requires an aggregate function in select.',
      ),
    having: z
      .string()
      .optional()
      .describe('SoQL HAVING clause. Filters on aggregated results, e.g. count > 100.'),
    order: z
      .string()
      .optional()
      .describe(
        'SoQL ORDER BY clause over API field names or select aliases, e.g. "total_deaths DESC" or "date ASC".',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(100)
      .describe(
        'Max rows to return (1–5000). Default 100. Use with offset for pagination. When the canvas is enabled and the page fills limit, up to 50,000 matching rows are staged on it whatever the limit — pass a small limit (e.g. 10) to stage a large match without a large inline page.',
      ),
    offset: z.number().int().min(0).default(0).describe('Row offset for pagination. Default 0.'),
    canvas_id: CanvasIdSchema.optional().describe(
      'Optional 10-char DataCanvas token from a prior socrata_query_dataset or socrata_dataframe_describe call. Omit on first call when CANVAS_PROVIDER_TYPE=duckdb to mint a fresh canvas. Large result sets spill here automatically.',
    ),
  }),
  output: z.object({
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Result rows. Scalar values are strings (SODA 2.1); geo/location columns return nested objects. Use column schema from socrata_get_dataset for type context.',
      ),
    row_count: z.number().describe('Rows returned in this response.'),
    total_count: z
      .number()
      .optional()
      .describe(
        'Total matching source rows when a plain row query is truncated (row_count < total_count). Absent when the full result fits and for grouped/aggregate queries (group set), where a source-row count would not describe the returned groups.',
      ),
    assembled_query: z
      .string()
      .describe('SoQL clauses assembled for this request — useful for learning the syntax.'),
    domain: z.string().describe('Portal hostname queried, normalized from the domain input.'),
    dataset_id: z.string().describe('Dataset ID queried.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token when results spilled (requires CANVAS_PROVIDER_TYPE=duckdb). Pass to socrata_dataframe_query to run SQL over the staged rows in table_name — a bounded copy of the matching set (up to 50,000 rows, reported in canvas_row_count), not the full set when total_count exceeds that cap. Page with offset to reach rows beyond it.',
      ),
    canvas_row_count: z
      .number()
      .optional()
      .describe(
        'Rows staged onto the DataCanvas — a bounded copy of the matching result set (capped at 50,000). Fewer than total_count when the match exceeds the cap. Present only when canvas_id is.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'Canvas table holding the staged rows; present when canvas_id is. Use it as the FROM target in socrata_dataframe_query SQL; list its columns with socrata_dataframe_describe.',
      ),
  }),

  // Agent-facing context: empty-result notice, plus truncation disclosure when the
  // row cap was hit. Reaches structuredContent and content[] automatically — no format() entry needed.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the query returned zero rows (review the SoQL or broaden the filter), or when rows filled the limit (how to page, and the staged table to query when the result spilled). Absent otherwise.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when rows filled the limit — more rows may match (see total_count when present). Spills to canvas when enabled; table_name names the staged table.',
      ),
    shown: z.number().optional().describe('Rows returned in this response when capped.'),
    cap: z.number().optional().describe('The row limit that was applied when capped.'),
  },

  errors: [
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Dataset ID does not match the four-by-four pattern.',
      recovery:
        'Dataset IDs are always 9 characters like kzjm-xkqj. Obtain from socrata_find_datasets.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The dataset does not exist on the domain queried — including a gateway HTTP 403 for an ID the portal does not serve.',
      recovery:
        'The ID may belong to a different portal — retry with the domain from the same socrata_find_datasets result, or search again with socrata_find_datasets; the dataset may also have been retired.',
    },
    {
      reason: 'unknown_domain',
      code: JsonRpcErrorCode.NotFound,
      when: 'The domain does not serve the Socrata API to this server: its hostname does not resolve (DNS ENOTFOUND), its API answered HTTP 404 without a Socrata error body, it redirected the request to another host that did not answer with Socrata data, or a gateway refused a dataset the Discovery catalog lists there.',
      recovery:
        'The domain is not serving the Socrata API. Check the hostname for typos and pass a bare portal hostname such as data.cityofnewyork.us, or pick one from socrata_list_portals.',
    },
    {
      reason: 'invalid_domain',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The domain is not a hostname, even after dropping a URL scheme, path, or query.',
      recovery:
        'Pass a bare portal hostname such as data.cityofnewyork.us, or pick one from socrata_list_portals.',
    },
    {
      reason: 'soql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SoQL syntax error, unknown column, or literal/column type mismatch. data.socrataCode carries the upstream code and data.column the offending token when upstream names one.',
      recovery:
        "Check API field names (field_name) and data types with socrata_get_dataset. Text columns need single-quoted strings (year='2020'); Number columns use bare literals (year=2020).",
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'SODA endpoint returned 429.',
      retryable: true,
      recovery: 'Retry after a short delay. Set SOCRATA_APP_TOKEN for higher per-IP rate limits.',
    },
  ],

  async handler(input, ctx) {
    const domain = input.domain?.trim() ? input.domain.trim() : getServerConfig().defaultDomain;

    if (!DATASET_ID_PATTERN.test(input.dataset_id)) {
      throw ctx.fail(
        'invalid_id',
        `Invalid dataset ID "${input.dataset_id}". Expected pattern like kzjm-xkqj.`,
        { ...ctx.recoveryFor('invalid_id') },
      );
    }

    ctx.log.info('Querying dataset', {
      domain,
      datasetId: input.dataset_id,
      limit: input.limit,
    });

    const svc = getSocrataService();
    const search = input.search?.trim() ? input.search : undefined;
    const select = input.select?.trim() ? input.select : undefined;
    const where = input.where?.trim() ? input.where : undefined;
    const group = input.group?.trim() ? input.group : undefined;
    const having = input.having?.trim() ? input.having : undefined;
    const order = input.order?.trim() ? input.order : undefined;
    let qResult: QueryResult;
    try {
      qResult = await svc.queryDataset(
        {
          domain,
          datasetId: input.dataset_id,
          ...(search ? { search } : {}),
          ...(select ? { select } : {}),
          ...(where ? { where } : {}),
          ...(group ? { group } : {}),
          ...(having ? { having } : {}),
          ...(order ? { order } : {}),
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
    } catch (err) {
      // Re-throw service failures that map to declared contract reasons via
      // ctx.fail so a recovery hint reaches the wire. A not_found whose ID the
      // Discovery catalog places on another portal names that portal, and a
      // soql_error takes the hint for its upstream code, instead of the static
      // hint.
      if (err instanceof McpError) {
        const data = (err.data ?? {}) as Record<string, unknown>;
        const { reason, found_on_domain: foundOn, socrataCode, column } = data;
        if (
          reason === 'not_found' ||
          reason === 'unknown_domain' ||
          reason === 'invalid_domain' ||
          reason === 'soql_error' ||
          reason === 'rate_limited'
        ) {
          const hint =
            reason === 'not_found' && typeof foundOn === 'string'
              ? `${input.dataset_id} is on ${foundOn} — retry with domain "${foundOn}".`
              : reason === 'soql_error'
                ? soqlRecoveryHint(socrataCode, column)
                : undefined;
          throw ctx.fail(
            reason,
            err.message,
            { ...data, ...(hint ? { recovery: { hint } } : ctx.recoveryFor(reason)) },
            { cause: err },
          );
        }
      }
      throw err;
    }

    if (qResult.rowCount === 0) {
      ctx.enrich.notice(
        `No rows returned for dataset "${input.dataset_id}"${where ? ` with WHERE ${where}` : ''}. ` +
          'Check field names and quoting with socrata_get_dataset, or broaden the filter.',
      );
    }

    // Attempt DataCanvas spillover when canvas is available and result hit the limit.
    const filled = qResult.rowCount >= input.limit;
    let spill: { canvasId: string; rowCount: number; tableName: string } | undefined;
    const canvas = getCanvas();
    if (canvas && filled) {
      try {
        const instance = await canvas.acquire(input.canvas_id, ctx);
        const tableName = `${input.dataset_id.replaceAll('-', '_')}_rows`;
        // Stage the wider matching set, not just this page: drain paginated SODA
        // calls up to the safety cap. The inline `rows` above stay bounded by
        // input.limit; only this spilled copy holds the wider set the canvas
        // advertises. Socrata system columns (`:@computed_region_*` and other
        // `:`-prefixed keys) are not valid canvas identifiers and would fail
        // registerTable — strip them from the spilled projection; the inline
        // `rows` keep every column.
        const canvasRows: Record<string, unknown>[] = [];
        for await (const row of svc.streamDatasetRows(
          {
            domain: qResult.domain,
            datasetId: input.dataset_id,
            ...(search ? { search } : {}),
            ...(select ? { select } : {}),
            ...(where ? { where } : {}),
            ...(group ? { group } : {}),
            ...(having ? { having } : {}),
            ...(order ? { order } : {}),
            offset: input.offset,
          },
          CANVAS_SPILL_MAX_ROWS,
          ctx,
        )) {
          canvasRows.push(
            Object.keys(row).some((k) => k.startsWith(':'))
              ? Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith(':')))
              : row,
          );
        }
        if (!qResult.fieldTypes) {
          ctx.log.warning(
            'SODA X-SODA2-Fields/X-SODA2-Types headers missing or malformed — spilled table uses inferred column types',
            { datasetId: input.dataset_id, tableName },
          );
        }
        const registered = await instance.registerTable(tableName, canvasRows, {
          schema: spillSchema(canvasRows, qResult.fieldTypes),
        });
        spill = {
          canvasId: instance.canvasId,
          rowCount: registered.rowCount,
          tableName: registered.tableName,
        };
        ctx.log.info('Spilled query result to DataCanvas', spill);
      } catch (err) {
        // Canvas is best-effort — log but don't fail the query.
        ctx.log.warning('DataCanvas spillover failed', { error: String(err) });
      }
    }

    if (filled) {
      // One call: truncated() writes `notice`, which is last-wins. Only claim an
      // exact count when the recount produced one — total_count is absent for
      // grouped queries and when the recount failed.
      const more = `Rows filled the limit — more rows may match${qResult.totalCount != null ? ' (exact count in total_count)' : ''}.`;
      ctx.enrich.truncated({
        shown: qResult.rowCount,
        cap: input.limit,
        guidance: spill
          ? `${more} Staged ${spill.rowCount.toLocaleString()} rows as table "${spill.tableName}" on canvas ${spill.canvasId}: list its columns with socrata_dataframe_describe, then run SQL with socrata_dataframe_query. The staged copy stops at ${CANVAS_SPILL_MAX_ROWS.toLocaleString()} rows; page with offset for rows beyond it.`
          : `${more} Page with offset or raise limit (max 5000).`,
      });
    }

    return {
      rows: qResult.rows,
      row_count: qResult.rowCount,
      ...(qResult.totalCount != null ? { total_count: qResult.totalCount } : {}),
      assembled_query: qResult.assembledQuery,
      domain: qResult.domain,
      dataset_id: input.dataset_id,
      ...(spill
        ? {
            canvas_id: spill.canvasId,
            canvas_row_count: spill.rowCount,
            table_name: spill.tableName,
          }
        : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**${result.row_count} rows** from \`${result.dataset_id}\` on ${result.domain}`);
    if (result.total_count != null) {
      lines.push(
        `_Total matching rows: ${result.total_count.toLocaleString()} — paginate with offset or narrow the query._`,
      );
    }
    lines.push(`**Query:** ${result.assembled_query}`);
    if (result.canvas_id) {
      const staged =
        result.canvas_row_count != null
          ? `${result.canvas_row_count.toLocaleString()} rows staged`
          : 'rows staged';
      const table = result.table_name ? ` as table \`${result.table_name}\`` : '';
      lines.push(
        `**Canvas ID:** ${result.canvas_id} — ${staged}${table}; list its columns with socrata_dataframe_describe, then run SQL with socrata_dataframe_query (bounded copy, up to ${CANVAS_SPILL_MAX_ROWS.toLocaleString()} rows; page with offset for any beyond the cap)`,
      );
    }

    if (result.rows.length === 0) {
      lines.push('\n_No rows returned._');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('');

    // Render as markdown table if columns are consistent and not too wide.
    const firstRow = result.rows[0];
    const cols = Object.keys(firstRow ?? {});

    // Render every row structuredContent carries — result.rows is already bounded
    // by the caller's `limit`, so a second render-only cap here would silently
    // drop rows from content[] that structuredContent-reading clients still see.
    if (cols.length > 0 && cols.length <= 10) {
      // Row values (and column keys) are upstream-controlled — escape pipes and
      // newlines so a value can never split its cell or its row.
      lines.push(`| ${cols.map((c) => escapeTableCell(c)).join(' | ')} |`);
      lines.push(`| ${cols.map(() => ':---').join(' | ')} |`);
      for (const row of result.rows) {
        const cells = cols.map((c) => {
          const v = row[c];
          const s = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
          return escapeTableCell(s);
        });
        lines.push(`| ${cells.join(' | ')} |`);
      }
    } else {
      // Fall back to fenced JSON for wide datasets — the fence is sized past any
      // backtick run in the payload so row values cannot break out of it.
      for (const row of result.rows) {
        lines.push(...fencedJson(JSON.stringify(row)));
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
