/**
 * @fileoverview SoQL query execution tool for Socrata datasets.
 * @module mcp-server/tools/definitions/query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  assertValidIdentifier,
  CANVAS_IDENTIFIER_REGEX,
  CanvasIdSchema,
  type ColumnSchema,
  inferSchemaFromRows,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { codeEcho } from '@/mcp-server/tools/code-echo.js';
import { escapeTableCell, fencedJson, inlineUpstream } from '@/mcp-server/tools/upstream-text.js';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import type { QueryResult } from '@/services/socrata/types.js';
import { DATASET_ID_PATTERN } from '@/services/socrata/types.js';

/**
 * Hard cap on rows staged onto a DataCanvas per spill. The inline response stays
 * bounded by the caller's `limit`; this is the `$limit` of the one SODA request
 * that stages the copy, so a match of millions stages a queryable subset rather
 * than an unbounded fetch. The canvas is honestly a bounded copy, not "the full
 * result set" when total_count exceeds this cap. Also the hard ceiling on
 * `limit` while clamping is on.
 */
const CANVAS_SPILL_MAX_ROWS = 50_000;

/** Rows one call returns inline, bounding the response size. */
const QUERY_LIMIT_CAP = 5_000;

/** SOCRATA_CLAMP_LIMITS, read at import: it sets the `limit` maximum the schema advertises. */
const { clampLimits } = getServerConfig();

/** When a spill fires, as both `limit` describes state it. */
const LIMIT_SPILL =
  'When the server has a canvas and more rows match past a full page, up to 50,000 matching rows are staged on it whatever the limit — pass a small limit (e.g. 10) to stage a large match without a large inline page.';

/**
 * Whether the canvas registers `name` as a table: its identifier check, which
 * also refuses bare SQL keywords (select, order, …) from a list it does not
 * export.
 */
function canvasAcceptsTableName(name: string): boolean {
  try {
    assertValidIdentifier(name, 'table');
    return true;
  } catch {
    return false;
  }
}

/**
 * The notice sentence for a spill that staged nothing. A staging request the
 * call's deadline cut off gets the query shapes that stage faster; any other
 * failure names its class — the `data.reason`, else the error code.
 */
function notStagedNotice(err: unknown): string {
  if (!(err instanceof McpError)) return 'The matching rows were not staged on the canvas.';
  const reason = err.data?.reason;
  if (reason === 'retry_deadline_exceeded') {
    return "The matching rows were not staged on the canvas within the call's 50-second time limit; a narrower where, or no order, stages faster.";
  }
  return `The matching rows were not staged on the canvas (${typeof reason === 'string' ? reason : JsonRpcErrorCode[err.code]}).`;
}

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
    'Execute a SoQL query against any dataset on any Socrata portal. Use the search parameter for quick full-text lookup, or combine select/where/group/having/order for full analytical control. Returns rows plus the assembled SoQL string so you can learn the pattern. Columns are referenced by API field name (field_name from socrata_get_dataset, e.g. cuisine_description), never the display label. All SODA 2.1 row values are strings even for numeric columns — check data_type from socrata_get_dataset to determine correct WHERE quoting: Number columns use bare literals (year=2023), Text columns use single-quoted strings (year=\'2023\'). To enumerate distinct values, use select="col, count(*) as n" with group="col" and order="n DESC". When the server has a canvas and more rows match past a full page, up to 50,000 matching rows spill to a DataCanvas table whatever the limit: list its columns with socrata_dataframe_describe, then run SQL with socrata_dataframe_query.',
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
      .max(clampLimits ? CANVAS_SPILL_MAX_ROWS : QUERY_LIMIT_CAP)
      .default(100)
      .describe(
        clampLimits
          ? `Max rows to return (1–50,000). One call returns at most 5,000 rows: a larger limit is served as 5,000, with a notice naming the offset that continues when more rows match. Default 100. Use with offset for pagination. ${LIMIT_SPILL}`
          : `Max rows to return (1–5000). Default 100. Use with offset for pagination. ${LIMIT_SPILL}`,
      ),
    offset: z.number().int().min(0).default(0).describe('Row offset for pagination. Default 0.'),
    canvas_id: CanvasIdSchema.optional().describe(
      'Optional 10-char DataCanvas token from a prior socrata_query_dataset or socrata_dataframe_describe call. Omit on first call to mint a fresh canvas. Large result sets spill here automatically.',
    ),
    // A blank from a form client reads as unset. The name is lowercased before
    // the check, so the advertised pattern admits the mixed-case form.
    table_name: z
      .preprocess(
        (value) =>
          value === '' ? undefined : typeof value === 'string' ? value.toLowerCase() : value,
        z
          .string()
          .regex(
            CANVAS_IDENTIFIER_REGEX,
            'table_name takes letters, digits, and underscores, starting with a letter or underscore, 63 characters at most: ^[a-z_][a-z0-9_]{0,62}$ once lowercased.',
          )
          .refine((name) => !CANVAS_IDENTIFIER_REGEX.test(name) || canvasAcceptsTableName(name), {
            error: (issue) =>
              `table_name "${String(issue.input)}" is a SQL keyword, which the canvas refuses as a table name. Choose another name, such as one for the extract (crimes_2025).`,
          })
          .optional(),
      )
      .describe(
        'Name for the canvas table a spill stages: letters, digits, and underscores, starting with a letter or underscore, 63 characters at most; lowercased, and not a SQL keyword such as select or order. Defaults to a name derived from dataset_id (ijzp_q8t2_rows). A spill under a name the canvas already holds replaces that table, so give each extract its own name, with the same canvas_id, to keep several on one canvas.',
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
        'Rows the query matches, in the same unit as rows: groups for a grouped query, distinct values for a distinct select. Counted when rows fill limit or a page past offset 0 comes back empty; present when the match holds more rows than this response. Absent otherwise, and when the count failed or ran past its 15-second bound.',
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
        'DataCanvas token when results spilled. Pass to socrata_dataframe_query to run SQL over the staged rows in table_name — a bounded copy of the matching set (up to 50,000 rows, reported in canvas_row_count), not the full set when total_count exceeds that cap. Page with offset to reach rows beyond it.',
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
        'Guidance when the query returned zero rows (review the SoQL or broaden the filter; past offset 0, whether the offset passed the end of the match), or when more rows match past this page: how to page, naming the requested and served limit when a limit above the 5,000-row per-call cap was served as 5,000; the staged table to query when the result spilled, and the earlier table of that name it replaced; or why nothing was staged. Absent otherwise.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more rows match past this page: total_count exceeds offset + row_count, or rows filled the limit and no count was made. Spills to canvas when enabled; table_name names the staged table.',
      ),
    shown: z.number().optional().describe('Rows returned in this response when capped.'),
    cap: z.number().optional().describe('The row limit that was applied when capped.'),
  },

  errors: [
    {
      reason: 'query_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The gateway refused query clauses but a bare row request succeeded.',
      recovery:
        "Simplify the query and use SoQL syntax; conditional aggregates use case(condition, value, true, fallback), for example sum(case(status = 'Closed', 1, true, 0)).",
    },
    {
      reason: 'not_tabular',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SODA returned the non-tabular asset access error.',
      recovery:
        'Find a queryable table with socrata_find_datasets using only: "datasets", then retry with its dataset_id and domain.',
    },
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
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The portal did not answer the query within the 50-second time limit the call shares across its requests, retries included.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Make the query cheaper, then retry: a narrower where, a smaller limit, or no order (sorting a large dataset is slow).',
    },
  ],

  async handler(input, ctx) {
    const domain = input.domain?.trim() ? input.domain.trim() : getServerConfig().defaultDomain;

    if (!DATASET_ID_PATTERN.test(input.dataset_id)) {
      throw ctx.fail(
        'invalid_id',
        `Invalid dataset ID "${input.dataset_id}". Expected pattern like kzjm-xkqj.`,
      );
    }

    // Served limit: a limit between the cap and the ceiling is served at the cap.
    const limit = Math.min(input.limit, QUERY_LIMIT_CAP);
    ctx.log.info('Querying dataset', {
      domain,
      datasetId: input.dataset_id,
      limit,
      requestedLimit: input.limit,
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
          limit,
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
          reason === 'not_tabular' ||
          reason === 'query_rejected' ||
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
            { ...data, ...(hint ? { recovery: { hint } } : {}) },
            { cause: err },
          );
        }
      }
      throw err;
    }

    // The recount (present when it ran and succeeded) settles what the page
    // cannot: whether rows remain past it, and whether an empty page overshot
    // the match. total_count is reported when the match holds more rows than
    // this response.
    const { rowCount, totalCount } = qResult;
    const total = totalCount != null && totalCount > rowCount ? totalCount : undefined;
    // More rows match past this page: the count says so, or the page filled the served limit and no count was made.
    const truncated =
      rowCount >= limit && (totalCount == null || totalCount > input.offset + rowCount);

    if (rowCount === 0) {
      if (input.offset > 0 && total != null) {
        ctx.enrich.notice(
          `The offset ${input.offset} is past the end of the ${total} matching ${total === 1 ? 'row' : 'rows'}. Page with an offset below ${total}.`,
        );
      } else if (input.offset > 0 && totalCount == null) {
        ctx.enrich.notice(
          `No rows returned at offset ${input.offset}; the offset may be past the end of the matching rows, which could not be counted. Rerun with offset 0 to tell that apart from a filter that matches nothing.`,
        );
      } else {
        ctx.enrich.notice(
          `No rows returned for dataset "${input.dataset_id}"${where ? ` with WHERE ${escapeMarkdownInline(where)}` : ''}. Check field names and quoting with socrata_get_dataset, or broaden the filter.`,
        );
      }
    }

    // Stage the match on the DataCanvas when one is available and rows remain past this page.
    let spill:
      | { canvasId: string; rowCount: number; tableName: string; replacedRowCount?: number }
      | undefined;
    // Why nothing was staged: a spill that failed, or a caller-named table the call made none of.
    let notStaged: string | undefined;
    const canvas = getCanvas();
    if (canvas && truncated) {
      try {
        const instance = await canvas.acquire(input.canvas_id, ctx);
        const tableName =
          input.table_name ??
          `${/^[0-9]/.test(input.dataset_id) ? 't_' : ''}${input.dataset_id.replaceAll('-', '_')}_rows`;
        // Stage the wider matching set, not just this page: one SODA request
        // up to the safety cap, bounded by what is left of the call's
        // deadline. The inline `rows` above stay bounded by the served limit; only
        // this copy holds the wider set the canvas advertises. Socrata system
        // columns (`:@computed_region_*` and other `:`-prefixed keys) are not
        // valid canvas identifiers and would fail registerTable — strip them
        // from the staged projection; the inline `rows` keep every column.
        const staged = await svc.fetchStagingRows(
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
        );
        const canvasRows = staged.map((row) =>
          Object.keys(row).some((k) => k.startsWith(':'))
            ? Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith(':')))
            : row,
        );
        if (!qResult.fieldTypes) {
          ctx.log.warning(
            'SODA X-SODA2-Fields/X-SODA2-Types headers missing or malformed — spilled table uses inferred column types',
            { datasetId: input.dataset_id, tableName },
          );
        }
        // The table this spill replaces: one the canvas already holds under
        // the name. A canvas this call minted holds none.
        const [replaced] = instance.isNew ? [] : await instance.describe({ tableName });
        const registered = await instance.registerTable(tableName, canvasRows, {
          schema: spillSchema(canvasRows, qResult.fieldTypes),
        });
        spill = {
          canvasId: instance.canvasId,
          rowCount: registered.rowCount,
          tableName: registered.tableName,
          ...(replaced ? { replacedRowCount: replaced.rowCount } : {}),
        };
        ctx.log.info('Spilled query result to DataCanvas', spill);
      } catch (err) {
        // Staging is best-effort: the inline page stands and the notice says
        // why nothing was staged. A cancelled call stays cancelled.
        ctx.signal.throwIfAborted();
        notStaged = notStagedNotice(err);
        ctx.log.warning('DataCanvas spillover failed', { error: String(err) });
      }
    } else if (input.table_name && rowCount > 0) {
      // A smaller limit makes the page stop short of the match, which stages it.
      notStaged = canvas
        ? `Nothing was staged as table "${input.table_name}": no rows match past this page, and only a match that runs past the page is staged.${rowCount > 1 ? ` Rerun with a limit below ${rowCount} to stage these rows.` : ''}`
        : `Nothing was staged as table "${input.table_name}": this server has no DataCanvas.`;
    }

    if (truncated) {
      // One call: truncated() writes `notice`, which is last-wins. Only claim an
      // exact count when the recount produced one — total_count is absent when
      // the recount failed or timed out. A limit served below the one asked
      // names both and the offset that continues; raising limit helps only
      // below the cap.
      const exact = total != null ? ' (exact count in total_count)' : '';
      const clamped = limit < input.limit;
      const more = clamped
        ? `The requested limit ${input.limit} was served as ${limit}: the per-call cap is ${QUERY_LIMIT_CAP}, and more rows may match${exact}. Continue with offset ${input.offset + rowCount}.`
        : `Rows filled the limit — more rows may match${exact}.`;
      const paging = clamped
        ? ''
        : limit < QUERY_LIMIT_CAP
          ? ` Page with offset or raise limit (max ${QUERY_LIMIT_CAP}).`
          : ' Page with offset.';
      const replaced =
        spill?.replacedRowCount != null
          ? ` Replaced table "${spill.tableName}" (previously ${spill.replacedRowCount.toLocaleString()} rows).`
          : '';
      ctx.enrich.truncated({
        shown: rowCount,
        cap: limit,
        guidance: spill
          ? `${more} Staged ${spill.rowCount.toLocaleString()} rows as table "${spill.tableName}" on canvas ${spill.canvasId}: list its columns with socrata_dataframe_describe, then run SQL with socrata_dataframe_query.${replaced} The staged copy stops at ${CANVAS_SPILL_MAX_ROWS.toLocaleString()} rows; page with offset for rows beyond it.`
          : `${more}${notStaged ? ` ${notStaged}` : ''}${paging}`,
      });
    } else if (notStaged) {
      ctx.enrich.notice(notStaged);
    }

    return {
      rows: qResult.rows,
      row_count: rowCount,
      ...(total != null ? { total_count: total } : {}),
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
    // Caller clauses (a where value like '*none*') read back verbatim.
    lines.push(...codeEcho('Query', result.assembled_query));
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

    // Columns are every key any row carries, in first-appearance order: SODA
    // omits a null-valued key from its row, so the first row alone would drop
    // a column that is null there. A row without a key gets an empty cell.
    // Render as a markdown table when that union is not too wide.
    const cols = [...new Set(result.rows.flatMap((row) => Object.keys(row)))];

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
