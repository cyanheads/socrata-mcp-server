/**
 * @fileoverview SoQL query execution tool for Socrata datasets.
 * @module mcp-server/tools/definitions/query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { escapeTableCell, fencedJson } from '@/mcp-server/tools/upstream-text.js';
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

export const queryDataset = tool('socrata_query_dataset', {
  title: 'Query Dataset',
  description:
    'Execute a SoQL query against any dataset on any Socrata portal. Use the search parameter for quick full-text lookup, or combine select/where/group/having/order for full analytical control. Returns rows plus the assembled SoQL string so you can learn the pattern. All SODA 2.1 row values are strings even for numeric columns — check dataType from socrata_get_dataset to determine correct WHERE quoting: Number columns use bare literals (year=2023), Text columns use single-quoted strings (year=\'2023\'). To enumerate distinct values, use select="col, count(*) as n" with group="col" and order="n DESC". When CANVAS_PROVIDER_TYPE=duckdb and rows fill the limit, results spill to a DataCanvas table for SQL-based analysis.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    domain: z
      .string()
      .optional()
      .describe(
        'Portal domain (e.g. data.seattle.gov). Defaults to SOCRATA_DEFAULT_DOMAIN or data.seattle.gov.',
      ),
    dataset_id: z
      .string()
      .describe('Four-by-four dataset ID (e.g. kzjm-xkqj). Obtain from socrata_find_datasets.'),
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
        'SoQL SELECT clause — column names, aliases, aggregates: "state, sum(deaths) as total_deaths". Omit for all columns.',
      ),
    where: z
      .string()
      .optional()
      .describe(
        "SoQL WHERE clause. Check column dataType from socrata_get_dataset first — Number columns: year=2023, Text columns: year='2023'. Operators: =, !=, >, <, LIKE, IN(...), BETWEEN, IS NULL, starts_with(), contains(), AND, OR, NOT.",
      ),
    group: z
      .string()
      .optional()
      .describe('SoQL GROUP BY clause. Requires an aggregate function in select.'),
    having: z
      .string()
      .optional()
      .describe('SoQL HAVING clause. Filters on aggregated results, e.g. count > 100.'),
    order: z
      .string()
      .optional()
      .describe('SoQL ORDER BY clause, e.g. "total_deaths DESC" or "date ASC".'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(100)
      .describe('Max rows to return (1–5000). Default 100. Use with offset for pagination.'),
    offset: z.number().int().min(0).default(0).describe('Row offset for pagination. Default 0.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Optional 10-char DataCanvas token from a prior call. Omit on first call when CANVAS_PROVIDER_TYPE=duckdb to mint a fresh canvas. Large result sets spill here automatically.',
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
    domain: z.string().describe('Portal domain queried.'),
    dataset_id: z.string().describe('Dataset ID queried.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token when results spilled (requires CANVAS_PROVIDER_TYPE=duckdb). Pass to socrata_dataframe_query to run SQL over the staged rows — a bounded copy of the matching set (up to 50,000 rows, reported in canvas_row_count), not the full set when total_count exceeds that cap. Page with offset to reach rows beyond it.',
      ),
    canvas_row_count: z
      .number()
      .optional()
      .describe(
        'Rows staged onto the DataCanvas — a bounded copy of the matching result set (capped at 50,000). Fewer than total_count when the match exceeds the cap. Present only when canvas_id is.',
      ),
  }),

  // Agent-facing context: empty-result notice, plus truncation disclosure when the
  // row cap was hit. Reaches structuredContent and content[] automatically — no format() entry needed.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the query returned zero rows — suggests narrowing or reviewing the SoQL. Absent on non-empty result sets.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when rows filled the limit — more rows may match (see total_count when present). Spills to canvas when enabled.',
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
      when: 'Dataset does not exist on this domain.',
      recovery:
        'Search again with socrata_find_datasets — the dataset may be on a different domain or was retired.',
    },
    {
      reason: 'soql_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SoQL syntax error or unknown column name.',
      recovery:
        "Check column names with socrata_get_dataset. Text columns need single-quoted strings (year='2020'); Number columns use bare literals (year=2020).",
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'SODA endpoint returned 429.',
      retryable: true,
      recovery: 'Retry after a short delay. Set SOCRATA_APP_TOKEN for higher per-IP rate limits.',
    },
    {
      reason: 'invalid_app_token',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'Socrata rejected the configured SOCRATA_APP_TOKEN.',
      recovery:
        'Unset SOCRATA_APP_TOKEN or replace it with a valid Socrata app token, then restart the server.',
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
      // ctx.fail so the contract recovery hint reaches the wire.
      if (err instanceof McpError) {
        const reason = (err.data as Record<string, unknown> | undefined)?.reason;
        if (
          reason === 'not_found' ||
          reason === 'soql_error' ||
          reason === 'rate_limited' ||
          reason === 'invalid_app_token'
        ) {
          throw ctx.fail(reason, err.message, {
            ...(err.data as Record<string, unknown>),
            ...ctx.recoveryFor(reason),
          });
        }
      }
      throw err;
    }

    if (qResult.rowCount === 0) {
      ctx.enrich.notice(
        `No rows returned for dataset "${input.dataset_id}"${where ? ` with WHERE ${where}` : ''}. ` +
          'Check column names and quoting with socrata_get_dataset, or broaden the filter.',
      );
    } else if (qResult.rowCount >= input.limit) {
      // Only claim an exact count when the recount actually produced one —
      // total_count is absent for grouped queries and when the recount failed.
      ctx.enrich.truncated({
        shown: qResult.rowCount,
        cap: input.limit,
        guidance: `Rows filled the limit — more rows may match${qResult.totalCount != null ? ' (exact count in total_count)' : ''}. Page with offset, raise limit (max 5000), or query the spilled canvas via socrata_dataframe_query when CANVAS_PROVIDER_TYPE=duckdb (the staged copy is bounded to ${CANVAS_SPILL_MAX_ROWS.toLocaleString()} rows).`,
      });
    }

    // Attempt DataCanvas spillover when canvas is available and result hit the limit.
    let canvasId: string | undefined;
    let canvasRowCount: number | undefined;
    const canvas = getCanvas();
    if (canvas && qResult.rowCount >= input.limit) {
      try {
        const instance = await canvas.acquire(
          input.canvas_id?.trim() ? input.canvas_id : undefined,
          ctx,
        );
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
            domain,
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
        const registered = await instance.registerTable(tableName, canvasRows);
        canvasId = instance.canvasId;
        canvasRowCount = registered.rowCount ?? canvasRows.length;
        ctx.log.info('Spilled query result to DataCanvas', {
          canvasId,
          tableName,
          rowCount: canvasRowCount,
        });
      } catch (err) {
        // Canvas is best-effort — log but don't fail the query.
        ctx.log.warning('DataCanvas spillover failed', { error: String(err) });
      }
    }

    return {
      rows: qResult.rows,
      row_count: qResult.rowCount,
      ...(qResult.totalCount != null ? { total_count: qResult.totalCount } : {}),
      assembled_query: qResult.assembledQuery,
      domain,
      dataset_id: input.dataset_id,
      ...(canvasId ? { canvas_id: canvasId } : {}),
      ...(canvasRowCount != null ? { canvas_row_count: canvasRowCount } : {}),
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
      lines.push(
        `**Canvas ID:** ${result.canvas_id} — ${staged} for SQL via socrata_dataframe_query (bounded copy, up to ${CANVAS_SPILL_MAX_ROWS.toLocaleString()} rows; page with offset for any beyond the cap)`,
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
