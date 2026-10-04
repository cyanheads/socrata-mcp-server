/**
 * @fileoverview DataCanvas drop tool — remove a whole canvas, or one table on it.
 * Opt-in via SOCRATA_DATAFRAME_DROP_ENABLED (listed as disabled otherwise); only
 * meaningful when CANVAS_PROVIDER_TYPE=duckdb.
 * @module mcp-server/tools/definitions/dataframe-drop.tool
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas-accessor.js';

const DroppedTableSchema = z
  .object({
    table_id: z.string().describe('Name of the dropped table.'),
    row_count: z.number().describe('Rows the table held when it was dropped.'),
  })
  .describe('A table removed by the drop.');

const dataframeDropDefinition = tool('socrata_dataframe_drop', {
  title: 'Drop DataCanvas Data',
  description:
    "Permanently remove staged DataCanvas data — the whole canvas, or one table on it when table_name is given. Dropping the canvas invalidates its canvas_id: socrata_dataframe_describe and socrata_dataframe_query calls with it then fail as canvas_not_found. Dropping one table leaves the canvas and its other tables in place. Only the server's staged copy is deleted; the portal data is untouched, and socrata_query_dataset can stage it again. Call socrata_dataframe_describe first to see what a canvas holds. Only works when CANVAS_PROVIDER_TYPE=duckdb is set.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID returned by socrata_query_dataset when a large result spilled to canvas.',
    ),
    // A form client submits '' for an untouched field — read it as "omitted".
    table_name: z
      .preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional())
      .describe(
        'Exact table name from socrata_dataframe_describe to drop only that table. Omit to drop the whole canvas.',
      ),
  }),
  output: z.object({
    canvas_id: z.string().describe('Canvas ID the drop ran against.'),
    scope: z
      .enum(['canvas', 'table'])
      .describe(
        'canvas: the whole canvas was dropped and its canvas_id no longer resolves. table: one table was dropped and the canvas stays usable.',
      ),
    dropped_tables: z
      .array(DroppedTableSchema)
      .describe(
        'Tables removed, with their row counts. Empty when a dropped canvas held no tables.',
      ),
    remaining_tables: z
      .array(z.string())
      .describe(
        'Tables still on the canvas after the drop. Empty when the whole canvas was dropped.',
      ),
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
      when: 'canvas_id does not match a live canvas — unknown, expired, or already dropped.',
      recovery:
        'Canvases cannot be listed, and an expired or dropped canvas is gone. Nothing is left to drop; re-run socrata_query_dataset to stage the data on a fresh canvas if you still need it.',
    },
    {
      reason: 'table_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'table_name does not match a table on the canvas.',
      recovery:
        'List the tables on this canvas with socrata_dataframe_describe and pass an exact table_name, or omit table_name to drop the whole canvas.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();

    if (!canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to stage and drop canvas data.',
      );
    }

    let instance: Awaited<ReturnType<DataCanvas['acquire']>>;
    try {
      instance = await canvas.acquire(input.canvas_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('canvas_not_found', err.message);
      }
      throw err;
    }

    const tables = await instance.describe();
    const toDropped = (t: (typeof tables)[number]) => ({ table_id: t.name, row_count: t.rowCount });

    if (input.table_name) {
      const target = tables.find((t) => t.name === input.table_name);
      if (!target) {
        throw ctx.fail(
          'table_not_found',
          `No table named "${input.table_name}" on canvas ${input.canvas_id}.`,
          { tableName: input.table_name, availableTables: tables.map((t) => t.name) },
        );
      }
      await instance.drop(target.name);
      ctx.log.info('Dropped DataCanvas table', {
        canvasId: input.canvas_id,
        tableName: target.name,
      });
      return {
        canvas_id: input.canvas_id,
        scope: 'table' as const,
        dropped_tables: [toDropped(target)],
        remaining_tables: tables.filter((t) => t !== target).map((t) => t.name),
      };
    }

    await canvas.drop(input.canvas_id, ctx);
    ctx.log.info('Dropped DataCanvas canvas', {
      canvasId: input.canvas_id,
      tableCount: tables.length,
    });
    return {
      canvas_id: input.canvas_id,
      scope: 'canvas' as const,
      dropped_tables: tables.map(toDropped),
      remaining_tables: [],
    };
  },

  format: (result) => {
    const lines: string[] = [
      result.scope === 'canvas'
        ? `Dropped canvas \`${result.canvas_id}\` — its canvas_id no longer resolves.`
        : `Dropped one table from canvas \`${result.canvas_id}\`.`,
      `**Scope:** ${result.scope}`,
      '',
    ];

    if (result.dropped_tables.length === 0) {
      lines.push('_The canvas held no tables._');
    } else {
      lines.push('**Dropped tables:**');
      for (const table of result.dropped_tables) {
        lines.push(`- \`${table.table_id}\` — ${table.row_count.toLocaleString()} rows`);
      }
    }

    lines.push(
      `**Remaining tables:** ${
        result.remaining_tables.length > 0
          ? result.remaining_tables.map((name) => `\`${name}\``).join(', ')
          : 'none'
      }`,
    );

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

export const dataframeDrop = getServerConfig().dataframeDropEnabled
  ? dataframeDropDefinition
  : disabledTool(dataframeDropDefinition, {
      reason: 'Dropping DataCanvas data is turned off in this deployment.',
      hint: 'SOCRATA_DATAFRAME_DROP_ENABLED=true',
    });
