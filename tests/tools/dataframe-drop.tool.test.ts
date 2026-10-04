/**
 * @fileoverview Tests for the dataframe-drop tool over a real DuckDB DataCanvas:
 * whole-canvas and single-table drops on both client surfaces, every declared
 * error reason, and the follow-up describe/query calls a drop invalidates.
 * @module tests/tools/dataframe-drop.tool.test
 */

import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dataframeDescribe } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDrop } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';

/** A well-formed canvas ID no canvas was ever minted under. */
const UNKNOWN_CANVAS_ID = 'zzzz999999';

const CRIMES = Array.from({ length: 150 }, (_, i) => ({
  id: i + 1,
  primary_type: i % 2 === 0 ? 'HOMICIDE' : 'THEFT',
}));
const PERMITS = Array.from({ length: 3 }, (_, i) => ({ permit: `P-${i}`, fee: 100 * i }));

let canvas: DataCanvas;

/** Stage the given tables on a fresh canvas and return its canvas_id. */
async function stage(tables: Record<string, Record<string, unknown>[]>): Promise<string> {
  const instance = await canvas.acquire(undefined, createMockContext());
  for (const [name, rows] of Object.entries(tables)) await instance.registerTable(name, rows);
  return instance.canvasId;
}

type ErrorEnvelope = { code: number; message: string; data: Record<string, unknown> };

/** The failing result's structuredContent error and its content[] text. */
function failure(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).toBe(true);
  const error = (result.structuredContent as { error: ErrorEnvelope }).error;
  const text = (result.content[0] as { text: string }).text;
  return { error, text };
}

function successText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  expect(result.isError).toBeFalsy();
  return (result.content[0] as { text: string }).text;
}

beforeAll(() => {
  const created = createCanvasService(parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' }));
  if (!created) throw new Error('CANVAS_PROVIDER_TYPE=duckdb did not produce a canvas.');
  canvas = created;
  setCanvas(canvas);
});

// Restore the canvas after a test that simulates an unconfigured provider.
afterEach(() => {
  setCanvas(canvas);
});

afterAll(async () => {
  setCanvas(undefined);
  await canvas.shutdown(requestContextService.createRequestContext({ operation: 'test' }));
});

describe('socrata_dataframe_drop — whole canvas', () => {
  it('drops every table on the canvas and reports them on both surfaces', async () => {
    const canvasId = await stage({ crimes_rows: CRIMES, permits_rows: PERMITS });

    const result = await runToolContract(dataframeDrop, { canvas_id: canvasId });

    expect(result.structuredContent).toEqual({
      canvas_id: canvasId,
      scope: 'canvas',
      dropped_tables: [
        { table_id: 'crimes_rows', row_count: 150 },
        { table_id: 'permits_rows', row_count: 3 },
      ],
      remaining_tables: [],
    });
    const text = successText(result);
    expect(text).toContain(`Dropped canvas \`${canvasId}\``);
    expect(text).toContain('**Scope:** canvas');
    expect(text).toContain('`crimes_rows` — 150 rows');
    expect(text).toContain('`permits_rows` — 3 rows');
    expect(text).toContain('**Remaining tables:** none');
  });

  it('drops an empty canvas, reporting that it held no tables', async () => {
    const canvasId = await stage({});

    const result = await runToolContract(dataframeDrop, { canvas_id: canvasId });

    expect(result.structuredContent).toMatchObject({
      scope: 'canvas',
      dropped_tables: [],
      remaining_tables: [],
    });
    expect(successText(result)).toContain('_The canvas held no tables._');
  });

  it('reads a blank table_name from a form client as omitted — the whole canvas drops', async () => {
    const canvasId = await stage({ crimes_rows: CRIMES });

    const result = await runToolContract(dataframeDrop, { canvas_id: canvasId, table_name: '' });

    expect(result.structuredContent).toMatchObject({ scope: 'canvas' });
    expect(
      failure(await runToolContract(dataframeDrop, { canvas_id: canvasId })).error.data,
    ).toMatchObject({
      reason: 'canvas_not_found',
    });
  });

  it('leaves the dropped canvas_id unresolvable for describe and query', async () => {
    const canvasId = await stage({ crimes_rows: CRIMES });
    successText(await runToolContract(dataframeDrop, { canvas_id: canvasId }));

    const described = failure(await runToolContract(dataframeDescribe, { canvas_id: canvasId }));
    expect(described.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });

    const queried = failure(
      await runToolContract(dataframeQuery, {
        canvas_id: canvasId,
        sql: 'SELECT count(*) AS n FROM crimes_rows',
      }),
    );
    expect(queried.error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('fails as canvas_not_found, with its recovery hint, when the canvas was already dropped', async () => {
    const canvasId = await stage({ crimes_rows: CRIMES });
    successText(await runToolContract(dataframeDrop, { canvas_id: canvasId }));

    const { error, text } = failure(await runToolContract(dataframeDrop, { canvas_id: canvasId }));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'canvas_not_found',
        recovery: { hint: expect.stringContaining('socrata_query_dataset') },
      },
    });
    expect(text).toContain('socrata_query_dataset');
    expect(text).toContain('canvas_not_found');
  });

  it('fails as canvas_not_found for a well-formed canvas_id that was never minted', async () => {
    const { error } = failure(
      await runToolContract(dataframeDrop, { canvas_id: UNKNOWN_CANVAS_ID }),
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });
});

describe('socrata_dataframe_drop — one table', () => {
  it('drops only the named table and reports what remains on both surfaces', async () => {
    const canvasId = await stage({ crimes_rows: CRIMES, permits_rows: PERMITS });

    const result = await runToolContract(dataframeDrop, {
      canvas_id: canvasId,
      table_name: 'crimes_rows',
    });

    expect(result.structuredContent).toEqual({
      canvas_id: canvasId,
      scope: 'table',
      dropped_tables: [{ table_id: 'crimes_rows', row_count: 150 }],
      remaining_tables: ['permits_rows'],
    });
    const text = successText(result);
    expect(text).toContain(`Dropped one table from canvas \`${canvasId}\``);
    expect(text).toContain('**Scope:** table');
    expect(text).toContain('`crimes_rows` — 150 rows');
    expect(text).toContain('**Remaining tables:** `permits_rows`');
  });

  it('keeps the canvas live: the dropped table is gone and the others still query', async () => {
    const canvasId = await stage({ crimes_rows: CRIMES, permits_rows: PERMITS });
    successText(
      await runToolContract(dataframeDrop, { canvas_id: canvasId, table_name: 'crimes_rows' }),
    );

    const described = await runToolContract(dataframeDescribe, { canvas_id: canvasId });
    expect(
      (described.structuredContent as { tables: { table_id: string }[] }).tables.map(
        (t) => t.table_id,
      ),
    ).toEqual(['permits_rows']);

    const gone = failure(
      await runToolContract(dataframeQuery, {
        canvas_id: canvasId,
        sql: 'SELECT count(*) AS n FROM crimes_rows',
      }),
    );
    expect(gone.error.data).toMatchObject({ reason: 'table_not_found' });

    const kept = await runToolContract(dataframeQuery, {
      canvas_id: canvasId,
      sql: 'SELECT count(*) AS n FROM permits_rows',
    });
    expect(kept.isError).toBeFalsy();
    expect(String((kept.structuredContent as { rows: { n: unknown }[] }).rows[0]!.n)).toBe('3');
  });

  it('fails as table_not_found, naming the staged tables, and drops nothing', async () => {
    const canvasId = await stage({ crimes_rows: CRIMES, permits_rows: PERMITS });

    const { error, text } = failure(
      await runToolContract(dataframeDrop, { canvas_id: canvasId, table_name: 'crimes' }),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'table_not_found',
        tableName: 'crimes',
        availableTables: ['crimes_rows', 'permits_rows'],
        recovery: { hint: expect.stringContaining('socrata_dataframe_describe') },
      },
    });
    expect(text).toContain('No table named "crimes"');
    expect(text).toContain('socrata_dataframe_describe');

    const described = await runToolContract(dataframeDescribe, { canvas_id: canvasId });
    expect((described.structuredContent as { tables: unknown[] }).tables).toHaveLength(2);
  });

  it('fails as table_not_found when the table was already dropped', async () => {
    const canvasId = await stage({ crimes_rows: CRIMES, permits_rows: PERMITS });
    const args = { canvas_id: canvasId, table_name: 'crimes_rows' };
    successText(await runToolContract(dataframeDrop, args));

    const { error } = failure(await runToolContract(dataframeDrop, args));
    expect(error.data).toMatchObject({
      reason: 'table_not_found',
      availableTables: ['permits_rows'],
    });
  });
});

describe('socrata_dataframe_drop — input and configuration boundaries', () => {
  it('rejects a canvas_id that cannot be a minted token at argument validation', async () => {
    for (const canvas_id of ['xxxx-invalid', 'short', 'crimes_rows']) {
      const { error } = failure(await runToolContract(dataframeDrop, { canvas_id }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    }
  });

  it('fails as canvas_disabled, with its recovery hint, when the canvas provider is not configured', async () => {
    setCanvas(undefined);

    const { error, text } = failure(
      await runToolContract(dataframeDrop, { canvas_id: UNKNOWN_CANVAS_ID }),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      data: {
        reason: 'canvas_disabled',
        recovery: { hint: expect.stringContaining('CANVAS_PROVIDER_TYPE=duckdb') },
      },
    });
    expect(text).toContain('DataCanvas is not enabled');
  });
});
