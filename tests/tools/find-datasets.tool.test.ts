/**
 * @fileoverview Tests for the find-datasets tool.
 * @module tests/tools/find-datasets.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findDatasets } from '@/mcp-server/tools/definitions/find-datasets.tool.js';

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: vi.fn(),
}));

import { getSocrataService } from '@/services/socrata/socrata-service.js';

const mockFindDatasets = vi.fn();
const mockService = { findDatasets: mockFindDatasets };

beforeEach(() => {
  vi.clearAllMocks();
  (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

describe('findDatasets', () => {
  it('returns results for a basic query', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({
      results: [
        {
          datasetId: 'kzjm-xkqj',
          domain: 'data.seattle.gov',
          name: 'Seattle 911 Incidents',
          tags: ['public safety', '911'],
          columnNames: ['incident_type', 'date'],
        },
      ],
      totalCount: 1,
    });

    const input = findDatasets.input.parse({ query: '911' });
    const result = await findDatasets.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      dataset_id: 'kzjm-xkqj',
      domain: 'data.seattle.gov',
      name: 'Seattle 911 Incidents',
    });
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.effectiveQuery).toBe('911');
  });

  it('returns empty results with enrichment notice when no datasets found', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });

    const input = findDatasets.input.parse({ query: 'xyzabcnotreal' });
    const result = await findDatasets.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No datasets matched');
  });

  it('applies domain scoping when provided', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });

    const input = findDatasets.input.parse({ domain: 'data.seattle.gov' });
    await findDatasets.handler(input, ctx);

    const call = mockFindDatasets.mock.calls[0][0];
    expect(call.domain).toBe('data.seattle.gov');
  });

  it('echoes query in enrichment when provided', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({
      results: [
        {
          datasetId: 'abcd-efgh',
          domain: 'data.cityofnewyork.us',
          name: 'NYC Tree Census',
          tags: [],
          columnNames: ['tree_id'],
        },
      ],
      totalCount: 1,
    });

    const input = findDatasets.input.parse({ query: 'trees' });
    await findDatasets.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('trees');
  });

  it('handles sparse upstream result (no optional fields)', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({
      results: [
        {
          datasetId: 'aaaa-1111',
          domain: 'data.example.gov',
          name: 'Minimal Dataset',
          tags: [],
          columnNames: [],
          // description, category, license, dataUpdatedAt, viewCount all absent
        },
      ],
      totalCount: 1,
    });

    const input = findDatasets.input.parse({});
    const result = await findDatasets.handler(input, ctx);

    expect(result.results[0]).toMatchObject({
      dataset_id: 'aaaa-1111',
      name: 'Minimal Dataset',
    });
    expect(result.results[0].description).toBeUndefined();
    expect(result.results[0].license).toBeUndefined();
    expect(result.results[0].view_count).toBeUndefined();
  });

  it('formats results with dataset IDs and names', () => {
    const output = {
      results: [
        {
          dataset_id: 'kzjm-xkqj',
          domain: 'data.seattle.gov',
          name: 'Seattle 911 Incidents',
          tags: ['911', 'public safety'],
          column_names: ['incident_type', 'date'],
        },
      ],
    };
    const blocks = findDatasets.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('kzjm-xkqj');
    expect(text).toContain('Seattle 911 Incidents');
    expect(text).toContain('data.seattle.gov');
  });

  it('formats empty results as empty text', () => {
    const output = { results: [] };
    const blocks = findDatasets.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
  });
});
