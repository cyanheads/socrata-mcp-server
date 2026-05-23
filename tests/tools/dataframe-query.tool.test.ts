/**
 * @fileoverview Tests for the dataframe-query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { dataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';

describe('dataframeQuery', () => {
  it('throws when canvas is not enabled', async () => {
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    // ctx has no canvas attached — simulates CANVAS_PROVIDER_TYPE unset
    const input = dataframeQuery.input.parse({
      canvas_id: 'abc1234567',
      sql: 'SELECT * FROM kzjm_xkqj_rows LIMIT 10',
    });
    await expect(dataframeQuery.handler(input, ctx)).rejects.toThrow('DataCanvas is not enabled');
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
});
