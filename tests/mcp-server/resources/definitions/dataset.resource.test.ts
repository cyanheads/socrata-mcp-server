/**
 * @fileoverview Tests for the dataset resource.
 * @module tests/mcp-server/resources/definitions/dataset.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { datasetResource } from '@/mcp-server/resources/definitions/dataset.resource.js';

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: vi.fn(),
}));

import { getSocrataService } from '@/services/socrata/socrata-service.js';

const mockGetDataset = vi.fn();
const mockService = { getDataset: mockGetDataset };

beforeEach(() => {
  vi.clearAllMocks();
  (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

describe('datasetResource', () => {
  describe('handler', () => {
    it('returns full dataset metadata for a valid four-by-four ID', async () => {
      const ctx = createMockContext();
      mockGetDataset.mockResolvedValue({
        datasetId: 'kzjm-xkqj',
        domain: 'data.seattle.gov',
        name: 'Seattle 911 Incidents',
        description: 'Calls to the 911 emergency line.',
        category: 'Public Safety',
        tags: ['911', 'emergency'],
        rowCount: 200000,
        dataUpdatedAt: '2024-01-15T00:00:00.000Z',
        license: 'Public Domain',
        columns: [
          { fieldName: 'incident_type', dataType: 'Text', description: 'Type of incident' },
          { fieldName: 'report_date', dataType: 'Calendar date' },
        ],
      });

      const params = datasetResource.params.parse({
        domain: 'data.seattle.gov',
        datasetId: 'kzjm-xkqj',
      });
      const result = await datasetResource.handler(params, ctx);

      expect(result.dataset_id).toBe('kzjm-xkqj');
      expect(result.domain).toBe('data.seattle.gov');
      expect(result.name).toBe('Seattle 911 Incidents');
      expect(result.description).toBe('Calls to the 911 emergency line.');
      expect(result.category).toBe('Public Safety');
      expect(result.tags).toEqual(['911', 'emergency']);
      expect(result.row_count).toBe(200000);
      expect(result.license).toBe('Public Domain');
      expect(Array.isArray(result.columns)).toBe(true);
      expect(result.columns).toHaveLength(2);
      expect(result.columns[0]).toMatchObject({
        field_name: 'incident_type',
        data_type: 'Text',
        description: 'Type of incident',
      });
    });

    it('throws ValidationError for a malformed dataset ID', async () => {
      const ctx = createMockContext();
      const params = datasetResource.params.parse({
        domain: 'data.seattle.gov',
        datasetId: 'not-valid',
      });
      await expect(datasetResource.handler(params, ctx)).rejects.toMatchObject({
        message: expect.stringContaining('Invalid dataset ID format'),
      });
    });

    it('throws ValidationError for dataset ID with wrong length segments', async () => {
      const ctx = createMockContext();
      const params = datasetResource.params.parse({
        domain: 'data.seattle.gov',
        datasetId: 'ab-1234',
      });
      await expect(datasetResource.handler(params, ctx)).rejects.toThrow();
    });

    it('throws NotFound when service returns a dataset with no name', async () => {
      const ctx = createMockContext();
      mockGetDataset.mockResolvedValue({
        datasetId: 'aaaa-1111',
        domain: 'data.example.gov',
        name: '',
        tags: [],
        columns: [],
      });

      const params = datasetResource.params.parse({
        domain: 'data.example.gov',
        datasetId: 'aaaa-1111',
      });
      await expect(datasetResource.handler(params, ctx)).rejects.toMatchObject({
        message: expect.stringContaining('not found'),
      });
    });

    it('handles sparse upstream metadata — omits optional fields not present', async () => {
      const ctx = createMockContext();
      mockGetDataset.mockResolvedValue({
        datasetId: 'bbbb-2222',
        domain: 'data.example.gov',
        name: 'Sparse Dataset',
        tags: [],
        columns: [],
        // description, category, rowCount, dataUpdatedAt, license all absent
      });

      const params = datasetResource.params.parse({
        domain: 'data.example.gov',
        datasetId: 'bbbb-2222',
      });
      const result = await datasetResource.handler(params, ctx);

      expect(result.dataset_id).toBe('bbbb-2222');
      expect(result.name).toBe('Sparse Dataset');
      expect(result.description).toBeUndefined();
      expect(result.category).toBeUndefined();
      expect(result.row_count).toBeUndefined();
      expect(result.data_updated_at).toBeUndefined();
      expect(result.license).toBeUndefined();
      expect(result.columns).toHaveLength(0);
    });

    it('maps column optional fields correctly when present', async () => {
      const ctx = createMockContext();
      mockGetDataset.mockResolvedValue({
        datasetId: 'cccc-3333',
        domain: 'data.example.gov',
        name: 'Rich Columns',
        tags: [],
        columns: [
          {
            fieldName: 'amount',
            dataType: 'Number',
            description: 'Dollar amount',
            nonNullCount: 9000,
          },
          { fieldName: 'note', dataType: 'Text' },
        ],
      });

      const params = datasetResource.params.parse({
        domain: 'data.example.gov',
        datasetId: 'cccc-3333',
      });
      const result = await datasetResource.handler(params, ctx);

      expect(result.columns[0].non_null_count).toBe(9000);
      expect(result.columns[0].description).toBe('Dollar amount');
      expect(result.columns[1].non_null_count).toBeUndefined();
      expect(result.columns[1].description).toBeUndefined();
    });

    it('propagates service errors without swallowing them', async () => {
      const ctx = createMockContext();
      mockGetDataset.mockRejectedValue(new Error('Network timeout'));

      const params = datasetResource.params.parse({
        domain: 'data.example.gov',
        datasetId: 'dddd-4444',
      });
      await expect(datasetResource.handler(params, ctx)).rejects.toThrow('Network timeout');
    });
  });

  describe('list', () => {
    it('returns at least one example resource entry', () => {
      const listing = datasetResource.list!();
      expect(listing.resources).toBeInstanceOf(Array);
      expect(listing.resources.length).toBeGreaterThan(0);
      for (const r of listing.resources) {
        expect(r).toHaveProperty('uri');
        expect(r).toHaveProperty('name');
        expect(r.uri).toMatch(/^socrata:\/\/datasets\//);
      }
    });
  });
});
