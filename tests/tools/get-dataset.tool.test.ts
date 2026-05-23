/**
 * @fileoverview Tests for the get-dataset tool.
 * @module tests/tools/get-dataset.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataset } from '@/mcp-server/tools/definitions/get-dataset.tool.js';

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ defaultDomain: 'data.seattle.gov' }),
}));

import { getSocrataService } from '@/services/socrata/socrata-service.js';

const mockGetDataset = vi.fn();
const mockService = { getDataset: mockGetDataset };

beforeEach(() => {
  vi.clearAllMocks();
  (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

describe('getDataset', () => {
  it('throws invalid_id for malformed dataset ID', async () => {
    const ctx = createMockContext({ errors: getDataset.errors });

    const input = getDataset.input.parse({ dataset_id: 'not-valid-id' });
    await expect(getDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('returns full dataset metadata for valid ID', async () => {
    const ctx = createMockContext({ errors: getDataset.errors });
    mockGetDataset.mockResolvedValue({
      datasetId: 'kzjm-xkqj',
      domain: 'data.seattle.gov',
      name: 'Seattle 911 Incidents',
      tags: ['public safety'],
      rowCount: 150000,
      columns: [
        { fieldName: 'incident_type', dataType: 'Text' },
        { fieldName: 'incident_date', dataType: 'Calendar date' },
      ],
    });

    const input = getDataset.input.parse({ dataset_id: 'kzjm-xkqj' });
    const result = await getDataset.handler(input, ctx);

    expect(result.dataset_id).toBe('kzjm-xkqj');
    expect(result.name).toBe('Seattle 911 Incidents');
    expect(result.columns).toHaveLength(2);
    expect(result.columns[0]).toMatchObject({ field_name: 'incident_type', data_type: 'Text' });
  });

  it('handles sparse upstream metadata (no optional fields)', async () => {
    const ctx = createMockContext({ errors: getDataset.errors });
    mockGetDataset.mockResolvedValue({
      datasetId: 'aaaa-1111',
      domain: 'data.example.gov',
      name: 'Minimal Dataset',
      tags: [],
      columns: [],
      // rowCount, description, category, dataUpdatedAt, license absent
    });

    const input = getDataset.input.parse({ dataset_id: 'aaaa-1111' });
    const result = await getDataset.handler(input, ctx);

    expect(result.dataset_id).toBe('aaaa-1111');
    expect(result.row_count).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it('formats output with ID, domain, column table', () => {
    const output = {
      dataset_id: 'kzjm-xkqj',
      domain: 'data.seattle.gov',
      name: 'Seattle 911 Incidents',
      tags: ['public safety'],
      columns: [
        { field_name: 'incident_type', data_type: 'Text' },
        { field_name: 'year', data_type: 'Number' },
      ],
    };
    const blocks = getDataset.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('kzjm-xkqj');
    expect(text).toContain('data.seattle.gov');
    expect(text).toContain('incident_type');
    expect(text).toContain('Text');
  });
});
