/**
 * @fileoverview Tests for the list-portals tool.
 * @module tests/tools/list-portals.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listPortals } from '@/mcp-server/tools/definitions/list-portals.tool.js';

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: vi.fn(),
}));

import { getSocrataService } from '@/services/socrata/socrata-service.js';

const mockListPortals = vi.fn();
const mockService = { listPortals: mockListPortals };

const samplePortals = [
  { domain: 'data.seattle.gov', organization: 'City of Seattle', datasetCount: 500 },
  { domain: 'data.cityofnewyork.us', organization: 'City of New York', datasetCount: 2000 },
  { domain: 'data.sfgov.org', organization: 'City of San Francisco', datasetCount: 400 },
];

beforeEach(() => {
  vi.clearAllMocks();
  (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
  mockListPortals.mockResolvedValue(samplePortals);
});

describe('listPortals', () => {
  it('returns all portals when no filter is applied', async () => {
    const ctx = createMockContext({ errors: listPortals.errors });
    const input = listPortals.input.parse({});
    const result = await listPortals.handler(input, ctx);

    expect(result.portals).toHaveLength(3);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(3);
    expect(result.portals[0]).toMatchObject({
      domain: 'data.seattle.gov',
      organization: 'City of Seattle',
      dataset_count: 500,
    });
  });

  it('filters portals by query (case-insensitive)', async () => {
    const ctx = createMockContext({ errors: listPortals.errors });
    const input = listPortals.input.parse({ query: 'seattle' });
    const result = await listPortals.handler(input, ctx);

    expect(result.portals).toHaveLength(1);
    expect(result.portals[0].domain).toBe('data.seattle.gov');
  });

  it('returns enrichment notice when filter matches nothing', async () => {
    const ctx = createMockContext({ errors: listPortals.errors });
    const input = listPortals.input.parse({ query: 'xyznotreal' });
    const result = await listPortals.handler(input, ctx);

    expect(result.portals).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('xyznotreal');
  });

  it('applies pagination via offset and limit', async () => {
    const ctx = createMockContext({ errors: listPortals.errors });
    const input = listPortals.input.parse({ limit: 2, offset: 1 });
    const result = await listPortals.handler(input, ctx);

    expect(result.portals).toHaveLength(2);
    // offset=1 skips first portal (seattle), returns NY and SF
    expect(result.portals[0].domain).toBe('data.cityofnewyork.us');
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(3);
  });

  it('handles portals with no organization (sparse payload)', async () => {
    mockListPortals.mockResolvedValue([
      { domain: 'data.example.gov', datasetCount: 100 }, // no organization
    ]);
    const ctx = createMockContext({ errors: listPortals.errors });
    const input = listPortals.input.parse({});
    const result = await listPortals.handler(input, ctx);

    expect(result.portals[0].organization).toBeUndefined();
    expect(result.portals[0].dataset_count).toBe(100);
  });

  it('formats portals as a markdown table', () => {
    const output = {
      portals: [
        { domain: 'data.seattle.gov', organization: 'City of Seattle', dataset_count: 500 },
        { domain: 'data.sfgov.org', dataset_count: 400 },
      ],
    };
    const blocks = listPortals.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('data.seattle.gov');
    expect(text).toContain('City of Seattle');
    expect(text).toContain('data.sfgov.org');
  });

  it('formats empty result as empty text', () => {
    const output = { portals: [] };
    const blocks = listPortals.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
  });
});
