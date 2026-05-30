/**
 * @fileoverview DataCanvas describe tool — list registered tables in a canvas session.
 * Only meaningful when CANVAS_PROVIDER_TYPE=duckdb.
 * @module mcp-server/tools/definitions/dataframe-describe.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

const ColumnInfoSchema = z
  .object({
    name: z.string().describe('Column name.'),
    type: z.string().describe('DuckDB inferred type (e.g. VARCHAR, DOUBLE, BIGINT).'),
  })
  .describe('Column name and DuckDB type.');

const TableInfoSchema = z
  .object({
    table_id: z.string().describe('Table name registered on the canvas.'),
    row_count: z.number().describe('Number of rows in this table.'),
    columns: z
      .array(ColumnInfoSchema)
      .describe(
        'Column names and DuckDB types. Numeric SODA columns become queryable with numeric comparisons after spillover.',
      ),
  })
  .describe('A registered DataCanvas table.');

export const dataframeDescribe = tool('socrata_dataframe_describe', {
  title: 'Describe DataCanvas Tables',
  description:
    'List registered tables in a DataCanvas session — schema, row count, column names, and registration time. Shows what datasets are available for SQL queries via socrata_dataframe_query. Only meaningful when CANVAS_PROVIDER_TYPE=duckdb is set. Use after socrata_query_dataset spills a large result set to canvas.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID returned from socrata_query_dataset. Omit to list all tables visible in the current session.',
      ),
  }),
  output: z.object({
    tables: z
      .array(TableInfoSchema)
      .describe('Tables available for SQL queries. Empty when none registered.'),
    canvas_id: z.string().optional().describe('Canvas ID resolved, when canvas is enabled.'),
  }),

  // Agent-facing context: status notice when canvas is disabled or no tables exist.
  // Reaches structuredContent and content[] automatically — no format() entry needed.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Status message when canvas is not enabled or no tables are registered. Absent when tables are present.',
      ),
  },

  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Provided canvas_id does not match any registered canvas.',
      recovery:
        'Omit canvas_id to list all active tables, or run socrata_query_dataset again to create a new canvas.',
    },
  ],

  async handler(input, ctx) {
    const canvas = (ctx as unknown as { core?: { canvas?: DataCanvas } }).core?.canvas;

    if (!canvas) {
      ctx.enrich.notice(
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to enable canvas spillover.',
      );
      return { tables: [] };
    }

    const canvasIdInput = input.canvas_id?.trim() ? input.canvas_id.trim() : undefined;
    const instance = await canvas.acquire(canvasIdInput, ctx);
    const tableInfos = await instance.describe();

    if (tableInfos.length === 0) {
      ctx.enrich.notice(
        'No tables registered on this canvas yet. Run socrata_query_dataset to populate.',
      );
      return {
        tables: [],
        canvas_id: instance.canvasId,
      };
    }

    return {
      tables: tableInfos.map((t) => ({
        table_id: t.name,
        row_count: t.rowCount,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
      })),
      canvas_id: instance.canvasId,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    // Always render optional fields for format-parity.
    if (result.canvas_id != null) lines.push(`**Canvas ID:** ${result.canvas_id}`);

    if (result.tables.length === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('');
    for (const table of result.tables) {
      lines.push(`### ${table.table_id}`);
      lines.push(`**Rows:** ${table.row_count.toLocaleString()}`);
      lines.push(`**Columns:** ${table.columns.map((c) => `${c.name} (${c.type})`).join(', ')}`);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
