/**
 * @fileoverview Tests for the dataframe-query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';

afterEach(() => {
  setCanvas(undefined);
});

describe('dataframeQuery', () => {
  it('throws when canvas is not enabled', async () => {
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    // No setCanvas call — simulates CANVAS_PROVIDER_TYPE unset
    const input = dataframeQuery.input.parse({
      canvas_id: 'abc1234567',
      sql: 'SELECT * FROM kzjm_xkqj_rows LIMIT 10',
    });
    await expect(dataframeQuery.handler(input, ctx)).rejects.toThrow('DataCanvas is not enabled');
  });

  it('populates enrichment notice when query returns empty rows', async () => {
    const mockInstance = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const mockCanvas = {
      acquire: vi.fn().mockResolvedValue(mockInstance),
    };
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    setCanvas(mockCanvas as unknown as DataCanvas);

    const input = dataframeQuery.input.parse({
      canvas_id: 'abc1234567',
      sql: 'SELECT * FROM kzjm_xkqj_rows WHERE year = 9999',
    });
    const result = await dataframeQuery.handler(input, ctx);

    expect(result.row_count).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('zero rows');
  });

  it('formats rows as markdown table when columns fit', () => {
    const output = {
      rows: [
        { incident_type: 'Theft', year: 2023 },
        { incident_type: 'Assault', year: 2022 },
      ],
      row_count: 2,
      sql: 'SELECT incident_type, year FROM kzjm_xkqj_rows LIMIT 10',
      canvas_id: 'abc1234567',
    };
    const blocks = dataframeQuery.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('abc1234567');
    expect(text).toContain('Theft');
    expect(text).toContain('2 rows');
  });

  it('formats empty result without table rows', () => {
    const output = {
      rows: [],
      row_count: 0,
      sql: 'SELECT * FROM kzjm_xkqj_rows WHERE year = 9999',
      canvas_id: 'abc1234567',
    };
    const blocks = dataframeQuery.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('No rows returned');
    expect(text).toContain('abc1234567');
  });

  it('throws canvas_not_found when canvas.acquire rejects with NotFound', async () => {
    const mockCanvas = {
      acquire: vi
        .fn()
        .mockRejectedValue(
          new McpError(
            JsonRpcErrorCode.NotFound,
            'Canvas not found or expired. Omit canvas_id to start a new canvas.',
            { canvasId: 'zzzz999999' },
          ),
        ),
    };
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    setCanvas(mockCanvas as unknown as DataCanvas);

    const input = dataframeQuery.input.parse({
      canvas_id: 'zzzz999999',
      sql: 'SELECT * FROM some_table LIMIT 10',
    });
    await expect(dataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_not_found' },
    });
  });

  it('rejects a canvas_id that cannot be a minted token at argument validation', () => {
    // CanvasIdSchema puts the minted `^[A-Za-z0-9_-]{10}$` shape in inputSchema,
    // so a malformed token is an argument rejection, never a canvas lookup.
    expect(() =>
      dataframeQuery.input.parse({ canvas_id: 'xxxx-invalid', sql: 'SELECT 1' }),
    ).toThrow();
  });

  it('re-throws non-NotFound errors from canvas.acquire unchanged', async () => {
    const mockCanvas = {
      acquire: vi.fn().mockRejectedValue(new Error('Unexpected internal failure')),
    };
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    setCanvas(mockCanvas as unknown as DataCanvas);

    const input = dataframeQuery.input.parse({
      canvas_id: 'abc1234567',
      sql: 'SELECT * FROM some_table LIMIT 10',
    });
    await expect(dataframeQuery.handler(input, ctx)).rejects.toThrow('Unexpected internal failure');
  });

  /** Wire a canvas whose acquired instance.query() rejects with the given error. */
  function canvasWhereQueryRejects(err: unknown): DataCanvas {
    return {
      acquire: vi.fn().mockResolvedValue({ query: vi.fn().mockRejectedValue(err) }),
    } as unknown as DataCanvas;
  }

  it('re-throws a non-SELECT SQL-gate rejection as sql_rejected with a recovery hint (#22)', async () => {
    // Exactly the repro: the gate throws before DuckDB executes, ValidationError
    // with data.reason: 'non_select_statement' and no recovery hint.
    setCanvas(
      canvasWhereQueryRejects(
        new McpError(
          JsonRpcErrorCode.ValidationError,
          'Canvas query must be SELECT; got DELETE. Mutations must use registerTable, drop, or clear.',
          { reason: 'non_select_statement', statementType: 'DELETE' },
        ),
      ),
    );
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    const input = dataframeQuery.input.parse({
      canvas_id: 'abc1234567',
      sql: 'DELETE FROM kzjm_xkqj_rows',
    });

    await expect(dataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'sql_rejected',
        // The original gate reason is preserved as diagnostic context, not clobbered.
        gateReason: 'non_select_statement',
        statementType: 'DELETE',
        recovery: { hint: expect.stringContaining('SELECT') },
      },
    });
  });

  it('maps other SQL-gate rejections (system_catalog_access) to sql_rejected too (#22)', async () => {
    setCanvas(
      canvasWhereQueryRejects(
        new McpError(
          JsonRpcErrorCode.ValidationError,
          'Canvas query references a system catalog: information_schema.',
          { reason: 'system_catalog_access', catalog: 'information_schema' },
        ),
      ),
    );
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    const input = dataframeQuery.input.parse({
      canvas_id: 'abc1234567',
      sql: 'SELECT * FROM information_schema.tables',
    });

    await expect(dataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'sql_rejected',
        gateReason: 'system_catalog_access',
        catalog: 'information_schema',
        recovery: { hint: expect.stringContaining('SELECT') },
      },
    });
  });

  it('passes invalid_sql through unchanged — a SELECT typo is not a gate rejection (#22)', async () => {
    setCanvas(
      canvasWhereQueryRejects(
        new McpError(
          JsonRpcErrorCode.ValidationError,
          'Canvas query failed to prepare: Referenced column "nope" not found.',
          { reason: 'invalid_sql', binderMessage: 'Referenced column "nope" not found' },
        ),
      ),
    );
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    const input = dataframeQuery.input.parse({
      canvas_id: 'abc1234567',
      sql: 'SELECT nope FROM t',
    });

    // Stays invalid_sql — not remapped to sql_rejected.
    await expect(dataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_sql' },
    });
  });

  it('re-throws a missing_table NotFound as table_not_found with a recovery hint (#22)', async () => {
    setCanvas(
      canvasWhereQueryRejects(
        new McpError(
          JsonRpcErrorCode.NotFound,
          'Canvas table "kzjm_xkqj_rows" does not exist. Re-stage it or call describe().',
          { reason: 'missing_table', tableName: 'kzjm_xkqj_rows' },
        ),
      ),
    );
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    const input = dataframeQuery.input.parse({
      canvas_id: 'abc1234567',
      sql: 'SELECT * FROM kzjm_xkqj_rows',
    });

    await expect(dataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'table_not_found',
        recovery: { hint: expect.stringContaining('socrata_dataframe_describe') },
      },
    });
  });

  it('format renders the whole executed SQL past the old 200-character cap (#19)', () => {
    const conditions = Array.from({ length: 12 }, (_, i) => `year <> ${2000 + i}`).join(' AND ');
    const sql = `SELECT primary_type, count(*) AS n FROM ijzp_q8t2_rows WHERE ${conditions} GROUP BY primary_type ORDER BY n DESC`;
    const output = {
      rows: [{ primary_type: 'THEFT', n: 3 }],
      row_count: 1,
      sql,
      canvas_id: 'abc1234567',
    };
    const text = (dataframeQuery.format!(output)[0] as { text?: string }).text ?? '';

    expect(sql.length).toBeGreaterThan(200);
    expect(text).toContain(`**SQL:** \`${sql}\``);
  });

  it('format renders every row in table mode — no 50-row render cap (#19)', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, type: 'X' }));
    const output = { rows, row_count: 60, sql: 'SELECT id, type FROM t', canvas_id: 'abc1234567' };
    const blocks = dataframeQuery.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('| 59 | X |');
    expect(text).not.toMatch(/more rows/);
    const dataRows = text.split('\n').filter((l) => /^\| \d+ \| X \|$/.test(l));
    expect(dataRows).toHaveLength(60);
  });

  it('format renders every row in wide JSON mode — no 20-row render cap (#19)', () => {
    const cols = Array.from({ length: 15 }, (_, i) => `col${i}`);
    const rows = Array.from({ length: 25 }, (_, r) =>
      Object.fromEntries(cols.map((c, i) => [c, `v${r}_${i}`])),
    );
    const output = {
      rows,
      row_count: 25,
      sql: 'SELECT * FROM wide_table',
      canvas_id: 'xyz9876543',
    };
    const blocks = dataframeQuery.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).not.toMatch(/more rows/);
    expect(text).toContain('v24_0'); // last row's marker value is present
    expect((text.match(/```json/g) ?? []).length).toBe(25);
  });

  it('formats wide result set as JSON blocks', () => {
    const cols = Array.from({ length: 15 }, (_, i) => `col${i}`);
    const rows = Array.from({ length: 5 }, (_, r) =>
      Object.fromEntries(cols.map((c, i) => [c, `val${r}_${i}`])),
    );
    const output = {
      rows,
      row_count: 5,
      sql: 'SELECT * FROM wide_table',
      canvas_id: 'xyz9876543',
    };
    const blocks = dataframeQuery.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    // Wide result falls back to JSON blocks
    expect(text).toContain('```json');
    expect(text).toContain('xyz9876543');
  });

  it('escapes upstream row values and column keys in table mode', () => {
    const output = {
      rows: [{ 'weird|key': 'pipe|value', note: 'line1\nline2', slash: 'a\\|b' }],
      row_count: 1,
      sql: 'SELECT * FROM t',
      canvas_id: 'abc1234567',
    };
    const blocks = dataframeQuery.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('weird\\|key');
    expect(text).toContain('pipe\\|value');
    expect(text).not.toMatch(/\n\| [^|\\]*pipe\|value/);
    expect(text).toContain('line1 line2');
    expect(text).toContain('a\\\\\\|b');
  });

  it('sizes wide-mode fences past embedded backtick runs', () => {
    const cols = Array.from({ length: 15 }, (_, i) => `col${i}`);
    const row = Object.fromEntries(cols.map((c) => [c, c === 'col0' ? 'x ``` y' : 'v']));
    const output = {
      rows: [row],
      row_count: 1,
      sql: 'SELECT * FROM wide_table',
      canvas_id: 'xyz9876543',
    };
    const blocks = dataframeQuery.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    const fences = text.match(/`{3,}/g) ?? [];
    const maxFence = Math.max(...fences.map((f) => f.length));
    expect(maxFence).toBeGreaterThanOrEqual(4);
  });
});
