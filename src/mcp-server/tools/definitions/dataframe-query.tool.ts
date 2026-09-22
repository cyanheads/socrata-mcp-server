/**
 * @fileoverview DataCanvas SQL query tool — run SELECT SQL against canvas-registered tables.
 * Only meaningful when CANVAS_PROVIDER_TYPE=duckdb.
 * @module mcp-server/tools/definitions/dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type DataCanvas, SQL_GATE_REASONS } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeTableCell, fencedJson } from '@/mcp-server/tools/upstream-text.js';
import { getCanvas } from '@/services/canvas-accessor.js';

/**
 * DuckDB read-only SQL-gate rejection reasons that map to this tool's declared
 * `sql_rejected` contract. The gate (in `@cyanheads/mcp-ts-core`'s DuckdbProvider)
 * throws these as plain `ValidationError`s with `data.reason` set but no recovery
 * hint — it is a framework-internal validator with no access to this tool's
 * contract — so the handler re-throws them via `ctx.fail('sql_rejected', …)`.
 * `invalid_sql` (a SELECT that parses but fails to prepare — a column/function
 * typo) and `missing_table` (a NotFound, handled separately) are deliberately
 * excluded: they are distinct failure surfaces that bubble on their own reasons.
 */
const SQL_GATE_REJECTION_REASONS: ReadonlySet<string> = new Set([
  SQL_GATE_REASONS.nonSelectStatement,
  SQL_GATE_REASONS.multiStatement,
  SQL_GATE_REASONS.systemCatalogAccess,
  SQL_GATE_REASONS.deniedFunction,
  SQL_GATE_REASONS.deniedFunctionInPlan,
  SQL_GATE_REASONS.planOperatorNotAllowed,
]);

export const dataframeQuery = tool('socrata_dataframe_query', {
  title: 'Query DataCanvas Table',
  description:
    'Run SELECT-only SQL against a DataCanvas table populated by socrata_query_dataset. Columns SODA types as number (including aggregate aliases like count(*) as n) are staged as DOUBLE, so numeric comparisons work without a cast (year > 2020, amount < 500). Text and timestamp columns stay VARCHAR — compare times with CAST(date AS TIMESTAMP). Only works when CANVAS_PROVIDER_TYPE=duckdb is set. Use socrata_dataframe_describe to see registered tables and their schemas.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID returned from socrata_query_dataset or socrata_dataframe_describe.',
    ),
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

  // Agent-facing context: empty-result notice, plus truncation disclosure when the
  // row cap was hit. Reaches structuredContent and content[] automatically — no format() entry needed.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when the SQL returned zero rows. Absent when rows are present.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when results were capped at the limit — more rows match the query.'),
    shown: z.number().optional().describe('Rows returned in this response when capped.'),
    cap: z.number().optional().describe('The row limit that was applied when capped.'),
  },

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
        'Canvas tokens expire after inactivity and cannot be listed. Re-run socrata_query_dataset to stage a fresh canvas and pass the canvas_id it returns.',
    },
    {
      reason: 'table_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL referenced a canvas table that does not exist — expired, dropped, or a mistyped name.',
      recovery:
        'List staged tables and their schemas with socrata_dataframe_describe, or re-run socrata_query_dataset to re-stage the data, then reference the exact table name.',
    },
    {
      reason: 'sql_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL was not a SELECT statement, referenced a system catalog, or contained disallowed functions.',
      recovery:
        'Only SELECT statements against registered tables are allowed. Remove DDL, DML, file-reading functions (read_csv, read_parquet), PRAGMA statements, and system catalog references (information_schema, pg_catalog, sqlite_master, duckdb_*). Use socrata_dataframe_describe to list tables and schemas.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();

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

    let instance: Awaited<ReturnType<DataCanvas['acquire']>>;
    try {
      instance = await canvas.acquire(input.canvas_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('canvas_not_found', err.message, {
          ...ctx.recoveryFor('canvas_not_found'),
        });
      }
      throw err;
    }
    let result: Awaited<ReturnType<typeof instance.query>>;
    try {
      result = await instance.query(input.sql, {
        rowLimit: input.limit,
        denySystemCatalogs: true,
        signal: ctx.signal,
      });
    } catch (err) {
      // The read-only SQL gate rejects before any DuckDB execution and throws a
      // plain ValidationError/NotFound carrying data.reason but no recovery hint.
      // Re-throw gate rejections and missing-table errors through this tool's
      // declared contract so the recovery hint reaches the wire (mirrors the
      // canvas_not_found rewrap at the acquire() call above).
      if (err instanceof McpError) {
        const data = (err.data ?? {}) as Record<string, unknown>;
        const reason = data.reason;
        if (typeof reason === 'string' && SQL_GATE_REJECTION_REASONS.has(reason)) {
          // ctx.fail writes data.reason='sql_rejected' last, so a bare {...data}
          // spread would clobber the gate's own reason under the same key — lift
          // it out first and preserve it as gateReason diagnostic context.
          const { reason: gateReason, ...rest } = data;
          throw ctx.fail('sql_rejected', err.message, {
            ...rest,
            gateReason,
            ...ctx.recoveryFor('sql_rejected'),
          });
        }
        if (err.code === JsonRpcErrorCode.NotFound && reason === 'missing_table') {
          throw ctx.fail('table_not_found', err.message, {
            ...ctx.recoveryFor('table_not_found'),
          });
        }
      }
      throw err;
    }

    if (result.rows.length === 0) {
      ctx.enrich.notice(
        'Query returned zero rows. Check table names with socrata_dataframe_describe or adjust the SQL filter.',
      );
    } else if (result.truncated) {
      ctx.enrich.truncated({
        shown: result.rows.length,
        cap: input.limit,
        guidance:
          'Results were capped at the limit — more rows match. Raise limit (max 10000), or refine the SQL with WHERE/aggregates to narrow the result set.',
      });
    }

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
    lines.push(`**SQL:** \`${result.sql}\``);

    if (result.rows.length === 0) {
      lines.push('\n_No rows returned._');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('');
    const firstRow = result.rows[0];
    const cols = Object.keys(firstRow ?? {});

    // Render every row structuredContent carries — result.rows is already bounded
    // by the caller's `limit`, so a second render-only cap here would silently
    // drop rows from content[] that structuredContent-reading clients still see.
    if (cols.length > 0 && cols.length <= 10) {
      lines.push(`| ${cols.map((c) => escapeTableCell(c)).join(' | ')} |`);
      lines.push(`| ${cols.map(() => ':---').join(' | ')} |`);
      for (const row of result.rows) {
        const cells = cols.map((c) =>
          escapeTableCell(String((row as Record<string, unknown>)[c] ?? '')),
        );
        lines.push(`| ${cells.join(' | ')} |`);
      }
    } else {
      for (const row of result.rows) {
        lines.push(...fencedJson(JSON.stringify(row)));
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
