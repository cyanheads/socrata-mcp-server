/**
 * @fileoverview Tests for the dataframe-describe tool.
 * @module tests/tools/dataframe-describe.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { dataframeDescribe } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';

describe('dataframeDescribe', () => {
  it('returns empty tables with enrichment notice when canvas is not enabled', async () => {
    const ctx = createMockContext({ errors: dataframeDescribe.errors });
    // ctx has no canvas attached — simulates CANVAS_PROVIDER_TYPE unset
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
});
