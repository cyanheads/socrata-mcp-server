/**
 * @fileoverview Tests for the dataframe-describe tool.
 * @module tests/tools/dataframe-describe.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribe } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';

afterEach(() => {
  setCanvas(undefined);
});

describe('dataframeDescribe', () => {
  it('returns empty tables with enrichment notice when canvas is not enabled', async () => {
    const ctx = createMockContext({ errors: dataframeDescribe.errors });
    // No setCanvas call — simulates CANVAS_PROVIDER_TYPE unset
    const input = dataframeDescribe.input.parse({});
    const result = await dataframeDescribe.handler(input, ctx);

    expect(result.tables).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('DataCanvas is not enabled');
  });

  it('formats output with canvas_id when present', () => {
    const output = {
      tables: [
        {
          table_id: 'kzjm_xkqj_rows',
          row_count: 500,
          columns: [
            { name: 'incident_type', type: 'VARCHAR' },
            { name: 'year', type: 'BIGINT' },
          ],
          registered_at: '2025-01-01T00:00:00.000Z',
        },
      ],
      canvas_id: 'abc1234567',
    };
    const blocks = dataframeDescribe.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('abc1234567');
    expect(text).toContain('kzjm_xkqj_rows');
    expect(text).toContain('incident_type');
  });

  it('formats empty canvas state showing canvas_id', () => {
    const output = {
      tables: [],
      canvas_id: 'abc1234567',
    };
    const blocks = dataframeDescribe.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('abc1234567');
  });

  it('formats disabled-canvas state (no canvas_id, no tables)', () => {
    const output = { tables: [] };
    const blocks = dataframeDescribe.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
  });

  it('throws canvas_not_found when canvas.acquire rejects with NotFound and canvas_id was provided', async () => {
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
    const ctx = createMockContext({ errors: dataframeDescribe.errors });
    setCanvas(mockCanvas as unknown as DataCanvas);

    const input = dataframeDescribe.input.parse({ canvas_id: 'xxxx-invalid' });
    await expect(dataframeDescribe.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_not_found' },
    });
  });

  it('throws canvas_id_required when canvas is enabled and canvas_id is omitted', async () => {
    // acquire(undefined) would mint a fresh empty canvas and describe it as empty —
    // the handler must fail fast instead of ever calling acquire without an id.
    const mockCanvas = { acquire: vi.fn() };
    const ctx = createMockContext({ errors: dataframeDescribe.errors });
    setCanvas(mockCanvas as unknown as DataCanvas);

    const input = dataframeDescribe.input.parse({});
    await expect(dataframeDescribe.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'canvas_id_required',
        recovery: { hint: expect.stringContaining('socrata_query_dataset') },
      },
    });
    expect(mockCanvas.acquire).not.toHaveBeenCalled();
  });

  it('throws canvas_id_required for a blank canvas_id when canvas is enabled', async () => {
    const mockCanvas = { acquire: vi.fn() };
    const ctx = createMockContext({ errors: dataframeDescribe.errors });
    setCanvas(mockCanvas as unknown as DataCanvas);

    const input = dataframeDescribe.input.parse({ canvas_id: '   ' });
    await expect(dataframeDescribe.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_id_required' },
    });
    expect(mockCanvas.acquire).not.toHaveBeenCalled();
  });
});
