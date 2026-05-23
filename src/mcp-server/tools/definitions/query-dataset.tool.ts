/**
 * @fileoverview SoQL query execution tool for Socrata datasets.
 * @module mcp-server/tools/definitions/query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import type { QueryResult } from '@/services/socrata/types.js';
import { DATASET_ID_PATTERN } from '@/services/socrata/types.js';

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
        'Total matching rows when result is truncated (row_count < total_count). Absent when the full result fits.',
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
        'DataCanvas token when results spilled (requires CANVAS_PROVIDER_TYPE=duckdb). Pass to socrata_dataframe_query for SQL over the full result set.',
      ),
  }),

  errors: [
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.InvalidParams,
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
      code: JsonRpcErrorCode.InvalidParams,
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
  ],

  async handler(input, ctx) {
    const domain =
      input.domain && input.domain.trim() ? input.domain.trim() : getServerConfig().defaultDomain;

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
    const search = input.search && input.search.trim() ? input.search : undefined;
    const select = input.select && input.select.trim() ? input.select : undefined;
    const where = input.where && input.where.trim() ? input.where : undefined;
    const group = input.group && input.group.trim() ? input.group : undefined;
    const having = input.having && input.having.trim() ? input.having : undefined;
    const order = input.order && input.order.trim() ? input.order : undefined;
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
      if (
        err instanceof McpError &&
        err.code === JsonRpcErrorCode.NotFound &&
        (err.data as Record<string, unknown> | undefined)?.reason === 'not_found'
      ) {
        throw ctx.fail('not_found', err.message, { ...ctx.recoveryFor('not_found') });
      }
      throw err;
    }

    // Attempt DataCanvas spillover when canvas is available and result hit the limit.
    let canvasId: string | undefined;
    const canvas = (ctx as unknown as { core?: { canvas?: DataCanvas } }).core?.canvas;
    if (canvas && qResult.rowCount >= input.limit) {
      try {
        const instance = await canvas.acquire(
          input.canvas_id && input.canvas_id.trim() ? input.canvas_id : undefined,
          ctx,
        );
        const tableName = `${input.dataset_id.replace('-', '_')}_rows`;
        await instance.registerTable(tableName, qResult.rows);
        canvasId = instance.canvasId;
        ctx.log.info('Spilled query result to DataCanvas', {
          canvasId,
          tableName,
          rowCount: qResult.rowCount,
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
      lines.push(
        `**Canvas ID:** ${result.canvas_id} — use socrata_dataframe_query for SQL over full result set`,
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

    if (cols.length > 0 && cols.length <= 10) {
      lines.push(`| ${cols.join(' | ')} |`);
      lines.push(`| ${cols.map(() => ':---').join(' | ')} |`);
      for (const row of result.rows.slice(0, 50)) {
        const cells = cols.map((c) => {
          const v = row[c];
          const s = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
          return s.replace(/\|/g, '\\|');
        });
        lines.push(`| ${cells.join(' | ')} |`);
      }
      if (result.rows.length > 50) {
        lines.push(`\n_... and ${result.rows.length - 50} more rows_`);
      }
    } else {
      // Fall back to JSON for wide datasets.
      for (const row of result.rows.slice(0, 20)) {
        lines.push('```json');
        lines.push(JSON.stringify(row));
        lines.push('```');
      }
      if (result.rows.length > 20) {
        lines.push(`\n_... and ${result.rows.length - 20} more rows_`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
