/**
 * @fileoverview DataCanvas SQL query tool — run SELECT SQL against canvas-registered tables.
 * Only meaningful when CANVAS_PROVIDER_TYPE=duckdb.
 * @module mcp-server/tools/definitions/dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type DataCanvas, SQL_GATE_REASONS } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { codeEcho } from '@/mcp-server/tools/code-echo.js';
import { escapeTableCell, fencedJson } from '@/mcp-server/tools/upstream-text.js';
import { getCanvas } from '@/services/canvas-accessor.js';

/**
 * Rows one call returns, bounding the response size. Also the DataCanvas
 * default row limit (CANVAS_DEFAULT_ROW_LIMIT), above which the provider
 * rejects a query's rowLimit outright.
 */
const QUERY_LIMIT_CAP = 10_000;

/**
 * Hard ceiling on `limit` while clamping is on — the most rows
 * socrata_query_dataset stages into one table.
 */
const QUERY_LIMIT_CEILING = 50_000;

/** SOCRATA_CLAMP_LIMITS, read at import: it sets the `limit` maximum the schema advertises. */
const { clampLimits } = getServerConfig();

/**
 * How to read past a page held to the per-call cap. The tool takes no offset,
 * so paging happens in the SQL. Only a stable order pages soundly: a page of
 * SQL without one does not line up with an ordered OFFSET page, which would
 * skip some rows and repeat others, so such SQL restarts at OFFSET 0. The
 * page LIMIT replaces any LIMIT the SQL carried, so that one becomes the
 * walk's end bound.
 */
const PAGING_GUIDANCE = `To read every row exactly once, page in the SQL: ORDER BY a unique column (ORDER BY ALL when none is unique), LIMIT ${QUERY_LIMIT_CAP}, and OFFSET raised by ${QUERY_LIMIT_CAP} per call. If this SQL already orders that way, these rows are one such page: continue at OFFSET ${QUERY_LIMIT_CAP}, or ${QUERY_LIMIT_CAP} past the OFFSET it already has. If it does not, start over at OFFSET 0: rows served in any other order do not line up with ordered pages. When the SQL has its own LIMIT, stop once the pages have read that many rows. Or narrow the result with WHERE or aggregates.`;

/**
 * The notice for a page held to `served` rows while more match. Raising
 * `limit` helps only below the cap; at the cap, and for a limit served at it,
 * the way on is paging.
 */
function truncationNotice(requested: number, served: number): string {
  if (served < requested) {
    return `The requested limit ${requested} was served as ${served}: the per-call cap is ${served}, and more rows match. ${PAGING_GUIDANCE}`;
  }
  if (served === QUERY_LIMIT_CAP) {
    return `Results were capped at the ${QUERY_LIMIT_CAP}-row per-call cap — more rows match. ${PAGING_GUIDANCE}`;
  }
  return `Results were capped at the limit — more rows match. Raise limit (max ${QUERY_LIMIT_CAP}), or refine the SQL with WHERE/aggregates to narrow the result set.`;
}

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
    'Run SELECT-only SQL against a DataCanvas table populated by socrata_query_dataset. Columns SODA types as number (including aggregate aliases like count(*) as n) are staged as DOUBLE, so numeric comparisons work without a cast (year > 2020, amount < 500). Text and timestamp columns stay VARCHAR — compare times with CAST(date AS TIMESTAMP). Works when the server has a DataCanvas. Use socrata_dataframe_describe to see registered tables and their schemas.',
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
      .max(clampLimits ? QUERY_LIMIT_CEILING : QUERY_LIMIT_CAP)
      .default(1000)
      .describe(
        clampLimits
          ? 'Max rows to return (1–50,000). One call returns at most 10,000 rows: a larger limit is served as 10,000, with a notice naming how to page through the rest when more rows match. Default 1000.'
          : 'Max rows to return (1–10000). Default 1000.',
      ),
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
      .describe(
        'Guidance for this page: how to adjust the SQL when it returned zero rows, or how to reach the rest when rows were capped, naming the requested and served limit when a limit above the 10,000-row per-call cap was served as 10,000. Absent otherwise.',
      ),
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
        throw ctx.fail('canvas_not_found', err.message);
      }
      throw err;
    }
    // Served limit: a limit between the cap and the ceiling is served at the cap.
    const limit = Math.min(input.limit, QUERY_LIMIT_CAP);
    let result: Awaited<ReturnType<typeof instance.query>>;
    try {
      result = await instance.query(input.sql, {
        rowLimit: limit,
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
          throw ctx.fail('sql_rejected', err.message, { ...rest, gateReason });
        }
        if (err.code === JsonRpcErrorCode.NotFound && reason === 'missing_table') {
          throw ctx.fail('table_not_found', err.message);
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
        cap: limit,
        guidance: truncationNotice(input.limit, limit),
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
    lines.push(...codeEcho('SQL', result.sql, 'sql'));

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
