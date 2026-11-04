/**
 * @fileoverview Tests for the dataset resource.
 * @module tests/mcp-server/resources/definitions/dataset.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetTypeSchema } from '@/mcp-server/asset-type-schema.js';
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

      const params = datasetResource.params!.parse({
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
      expect(result.columns[0]!).toMatchObject({
        field_name: 'incident_type',
        data_type: 'Text',
        description: 'Type of incident',
      });
    });

    it.each(['not-valid', 'ab-1234'])(
      'rejects the malformed dataset ID %j at params validation, naming the four-by-four form',
      (datasetId) => {
        const parsed = datasetResource.params!.safeParse({ domain: 'data.seattle.gov', datasetId });

        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues).toEqual([
          expect.objectContaining({
            path: ['datasetId'],
            message: expect.stringContaining('four-by-four'),
          }),
        ]);
      },
    );

    it('fetches an uppercase dataset ID as its lowercase form', async () => {
      const ctx = createMockContext();
      mockGetDataset.mockResolvedValue({
        datasetId: 'kzjm-xkqj',
        domain: 'data.seattle.gov',
        name: 'Seattle 911 Incidents',
        tags: [],
        columns: [],
      });

      const params = datasetResource.params!.parse({
        domain: 'data.seattle.gov',
        datasetId: 'KZJM-XKQJ',
      });
      const result = await datasetResource.handler(params, ctx);

      expect(mockGetDataset).toHaveBeenCalledWith('data.seattle.gov', 'kzjm-xkqj', ctx);
      expect(result.dataset_id).toBe('kzjm-xkqj');
    });

    it('returns whatever dataset the service returned, as socrata_get_dataset does — the not-this-dataset check lives in getDataset', async () => {
      // getDataset rejects a views answer whose id is not the requested one
      // (covered through the real service in tests/tools/upstream-errors.test.ts),
      // so a returned dataset is the requested one even with an empty name.
      const ctx = createMockContext();
      mockGetDataset.mockResolvedValue({
        datasetId: 'aaaa-1111',
        domain: 'data.example.gov',
        name: '',
        tags: [],
        columns: [],
      });

      const params = datasetResource.params!.parse({
        domain: 'data.example.gov',
        datasetId: 'aaaa-1111',
      });
      const result = await datasetResource.handler(params, ctx);

      expect(result).toMatchObject({ dataset_id: 'aaaa-1111', name: '' });
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

      const params = datasetResource.params!.parse({
        domain: 'data.example.gov',
        datasetId: 'bbbb-2222',
      });
      const result = await datasetResource.handler(params, ctx);

      expect(result.dataset_id).toBe('bbbb-2222');
      expect(result.name).toBe('Sparse Dataset');
      expect(result.description).toBeUndefined();
      expect(result.category).toBeUndefined();
      expect(result.row_count).toBeUndefined();
      expect(result.row_count_source).toBeUndefined();
      expect(result.data_updated_at).toBeUndefined();
      expect(result.license).toBeUndefined();
      expect(result.columns).toHaveLength(0);
    });

    it('mirrors a derived row count and its source from the service', async () => {
      const ctx = createMockContext();
      mockGetDataset.mockResolvedValue({
        datasetId: 'ijzp-q8t2',
        domain: 'data.cityofchicago.org',
        name: 'Crimes - 2001 to Present',
        tags: [],
        rowCount: 8585919,
        rowCountSource: 'column_cached_contents',
        columns: [],
      });

      const params = datasetResource.params!.parse({
        domain: 'data.cityofchicago.org',
        datasetId: 'ijzp-q8t2',
      });
      const result = await datasetResource.handler(params, ctx);

      expect(result.row_count).toBe(8585919);
      expect(result.row_count_source).toBe('column_cached_contents');
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

      const params = datasetResource.params!.parse({
        domain: 'data.example.gov',
        datasetId: 'cccc-3333',
      });
      const result = await datasetResource.handler(params, ctx);

      expect(result.columns[0]!.non_null_count).toBe(9000);
      expect(result.columns[0]!.description).toBe('Dollar amount');
      expect(result.columns[1]!.non_null_count).toBeUndefined();
      expect(result.columns[1]!.description).toBeUndefined();
    });

    it('propagates service errors without swallowing them', async () => {
      const ctx = createMockContext();
      mockGetDataset.mockRejectedValue(new Error('Network timeout'));

      const params = datasetResource.params!.parse({
        domain: 'data.example.gov',
        datasetId: 'dddd-4444',
      });
      await expect(datasetResource.handler(params, ctx)).rejects.toThrow('Network timeout');
    });
  });

  describe('asset_type from the views response, through the real service (#68)', () => {
    beforeEach(async () => {
      const { SocrataService } = await vi.importActual<
        typeof import('@/services/socrata/socrata-service.js')
      >('@/services/socrata/socrata-service.js');
      (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(new SocrataService());
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each([
      ['a7mk-8suc', { assetType: 'map' }, 'map'],
      ['t6tk-mr48', { assetType: 'dataset' }, 'dataset'],
      ['t6tk-mr48', {}, undefined],
    ])('reads %s with views fields %j as asset_type %s', async (datasetId, extra, assetType) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(Response.json({ id: datasetId, name: 'NJ asset', columns: [], ...extra })),
      );

      const params = datasetResource.params!.parse({ domain: 'data.nj.gov', datasetId });
      const result = datasetResource.output!.parse(
        await datasetResource.handler(params, createMockContext()),
      );

      if (assetType) expect(result.asset_type).toBe(assetType);
      else expect(result).not.toHaveProperty('asset_type');
      expect(result).toMatchObject({ dataset_id: datasetId, domain: 'data.nj.gov', columns: [] });
    });

    it('describes asset_type with the shared catalog asset-type text', () => {
      expect(datasetResource.output!.shape.asset_type.description).toBe(
        AssetTypeSchema.description,
      );
    });
  });

  describe('list', () => {
    it('returns at least one example resource entry', async () => {
      const serverContext = {} as Parameters<NonNullable<typeof datasetResource.list>>[0];
      const listing = await datasetResource.list!(serverContext);
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
