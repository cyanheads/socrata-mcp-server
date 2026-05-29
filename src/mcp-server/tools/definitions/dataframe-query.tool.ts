/**
 * @fileoverview DataCanvas SQL query tool — run SELECT SQL against canvas-registered tables.
 * Only meaningful when CANVAS_PROVIDER_TYPE=duckdb.
 * @module mcp-server/tools/definitions/dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

export const dataframeQuery = tool('socrata_dataframe_query', {
  title: 'Query DataCanvas Table',
  description:
    'Run SELECT-only SQL against a DataCanvas table populated by socrata_query_dataset. DuckDB infers types from spilled data, so numeric columns that SODA returned as strings become queryable with numeric comparisons (year > 2020, amount < 500). Only works when CANVAS_PROVIDER_TYPE=duckdb is set. Use socrata_dataframe_describe to see registered tables and their schemas.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    canvas_id: z
      .string()
      .describe('Canvas ID returned from socrata_query_dataset or socrata_dataframe_describe.'),
    sql: z
      .string()
      .describe(
        'SELECT-only SQL to run against registered canvas tables. DDL, DML, and file-reading functions are rejected. Use table names from socrata_dataframe_describe.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(1000)
      .describe('Max rows to return (1–10000). Default 1000.'),
  }),
  output: z.object({
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Query result rows. DuckDB may return native JS types (number, boolean, null) for numeric/boolean columns.',
      ),
    row_count: z.number().describe('Number of rows returned.'),
    sql: z.string().describe('SQL that was executed.'),
    canvas_id: z.string().describe('Canvas ID queried.'),
  }),

  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'CANVAS_PROVIDER_TYPE is not set to duckdb — DataCanvas is unavailable.',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb in server config and restart.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'canvas_id does not match any registered canvas.',
      recovery:
        'Use socrata_dataframe_describe without canvas_id to list active canvases, or re-run socrata_query_dataset to create a new one.',
    },
    {
      reason: 'sql_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL was not a SELECT statement or contained disallowed functions.',
      recovery:
        'Only SELECT statements are allowed. Remove DDL, DML, file-reading functions (read_csv, read_parquet), and PRAGMA statements.',
    },
  ],

  async handler(input, ctx) {
    const canvas = (ctx as unknown as { core?: { canvas?: DataCanvas } }).core?.canvas;

    if (!canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to run SQL queries.',
        { ...ctx.recoveryFor('canvas_disabled') },
      );
    }

    ctx.log.info('Running DataCanvas query', {
      canvasId: input.canvas_id,
      sql: input.sql.slice(0, 200),
    });

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.sql, {
      rowLimit: input.limit,
      signal: ctx.signal,
    });

    return {
      rows: result.rows,
      row_count: result.rows.length,
      sql: input.sql,
      canvas_id: input.canvas_id,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**${result.row_count} rows** from canvas \`${result.canvas_id}\``);
    lines.push(`**SQL:** \`${result.sql.slice(0, 200)}\``);

    if (result.rows.length === 0) {
      lines.push('\n_No rows returned._');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('');
    const firstRow = result.rows[0];
    const cols = Object.keys(firstRow ?? {});

    if (cols.length > 0 && cols.length <= 10) {
      lines.push(`| ${cols.join(' | ')} |`);
      lines.push(`| ${cols.map(() => ':---').join(' | ')} |`);
      for (const row of result.rows.slice(0, 50)) {
        const cells = cols.map((c) =>
          String((row as Record<string, unknown>)[c] ?? '').replace(/\|/g, '\\|'),
        );
        lines.push(`| ${cells.join(' | ')} |`);
      }
      if (result.rows.length > 50) {
        lines.push(`\n_... and ${result.rows.length - 50} more rows_`);
      }
    } else {
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
