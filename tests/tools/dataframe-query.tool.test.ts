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
            { canvasId: 'xxxx-invalid' },
          ),
        ),
    };
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    setCanvas(mockCanvas as unknown as DataCanvas);

    const input = dataframeQuery.input.parse({
      canvas_id: 'xxxx-invalid',
      sql: 'SELECT * FROM some_table LIMIT 10',
    });
    await expect(dataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_not_found' },
    });
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
