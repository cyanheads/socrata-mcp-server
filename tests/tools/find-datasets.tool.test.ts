/**
 * @fileoverview Tests for the find-datasets tool.
 * @module tests/tools/find-datasets.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    expect(result.total_count).toBe(1);
  });

  it('returns empty results with message when no datasets found', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });

    const input = findDatasets.input.parse({ query: 'xyzabcnotreal' });
    const result = await findDatasets.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    expect(result.total_count).toBe(0);
    expect(result.message).toBeDefined();
    expect(result.message).toContain('No datasets matched');
  });

  it('applies domain scoping when provided', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });

    const input = findDatasets.input.parse({ domain: 'data.seattle.gov' });
    await findDatasets.handler(input, ctx);

    const call = mockFindDatasets.mock.calls[0][0];
    expect(call.domain).toBe('data.seattle.gov');
  });

  it('echoes query in output when provided', async () => {
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
    const result = await findDatasets.handler(input, ctx);

    expect(result.query).toBe('trees');
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
      total_count: 1,
    };
    const blocks = findDatasets.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('kzjm-xkqj');
    expect(text).toContain('Seattle 911 Incidents');
    expect(text).toContain('data.seattle.gov');
  });

  it('formats empty results with total count', () => {
    const output = { results: [], total_count: 0, message: 'No datasets matched.' };
    const blocks = findDatasets.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('No datasets matched.');
  });
});
