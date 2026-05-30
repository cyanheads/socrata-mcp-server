/**
 * @fileoverview Tests for the query-dataset tool.
 * @module tests/tools/query-dataset.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ defaultDomain: 'data.seattle.gov' }),
}));

import { getSocrataService } from '@/services/socrata/socrata-service.js';

const mockQueryDataset = vi.fn();
const mockService = { queryDataset: mockQueryDataset };

beforeEach(() => {
  vi.clearAllMocks();
  (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

describe('queryDataset', () => {
  it('throws invalid_id for malformed dataset ID', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });

    const input = queryDataset.input.parse({ dataset_id: 'not-valid!!' });
    await expect(queryDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('returns rows and assembled query for valid input', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    mockQueryDataset.mockResolvedValue({
      rows: [{ incident_type: 'Theft', year: '2023' }],
      rowCount: 1,
      assembledQuery: '$where=year=2023 $limit=100',
    });

    const input = queryDataset.input.parse({
      dataset_id: 'kzjm-xkqj',
      where: 'year=2023',
    });
    const result = await queryDataset.handler(input, ctx);

    expect(result.rows).toHaveLength(1);
    expect(result.row_count).toBe(1);
    expect(result.assembled_query).toBe('$where=year=2023 $limit=100');
    expect(result.domain).toBe('data.seattle.gov');
    expect(result.dataset_id).toBe('kzjm-xkqj');
  });

  it('includes total_count when result is truncated', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    mockQueryDataset.mockResolvedValue({
      rows: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })),
      rowCount: 100,
      totalCount: 5000,
      assembledQuery: '$limit=100',
    });

    const input = queryDataset.input.parse({ dataset_id: 'abcd-1234', limit: 100 });
    const result = await queryDataset.handler(input, ctx);

    expect(result.total_count).toBe(5000);
  });

  it('passes through optional SoQL clauses to service', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    mockQueryDataset.mockResolvedValue({
      rows: [],
      rowCount: 0,
      assembledQuery: '$select=category,count(*) $group=category $order=n DESC $limit=50',
    });

    const input = queryDataset.input.parse({
      dataset_id: 'abcd-1234',
      select: 'category, count(*) as n',
      group: 'category',
      order: 'n DESC',
      limit: 50,
    });
    await queryDataset.handler(input, ctx);

    const call = mockQueryDataset.mock.calls[0][0];
    expect(call.select).toBe('category, count(*) as n');
    expect(call.group).toBe('category');
    expect(call.order).toBe('n DESC');
  });

  it('formats rows as markdown table when columns fit', () => {
    const output = {
      rows: [
        { incident_type: 'Theft', year: '2023' },
        { incident_type: 'Assault', year: '2023' },
      ],
      row_count: 2,
      assembled_query: '$where=year=2023',
      domain: 'data.seattle.gov',
      dataset_id: 'kzjm-xkqj',
    };
    const blocks = queryDataset.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('kzjm-xkqj');
    expect(text).toContain('data.seattle.gov');
    expect(text).toContain('Theft');
  });

  it('formats empty result set without rows', () => {
    const output = {
      rows: [],
      row_count: 0,
      assembled_query: '$where=year=9999',
      domain: 'data.seattle.gov',
      dataset_id: 'kzjm-xkqj',
    };
    const blocks = queryDataset.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('No rows returned');
  });

  it('populates enrichment notice when query returns empty rows', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    mockQueryDataset.mockResolvedValue({
      rows: [],
      rowCount: 0,
      assembledQuery: '$where=year=9999 $limit=100',
    });

    const input = queryDataset.input.parse({ dataset_id: 'kzjm-xkqj', where: 'year=9999' });
    const result = await queryDataset.handler(input, ctx);

    expect(result.rows).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No rows returned');
  });

  it('format shows canvas_id when spilled to canvas', () => {
    const output = {
      rows: [],
      row_count: 0,
      assembled_query: '$limit=100',
      domain: 'data.seattle.gov',
      dataset_id: 'kzjm-xkqj',
      canvas_id: 'abc1234567',
    };
    const blocks = queryDataset.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('abc1234567');
  });
});
