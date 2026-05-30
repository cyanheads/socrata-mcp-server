/**
 * @fileoverview Tests for the portals resource.
 * @module tests/mcp-server/resources/definitions/portals.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { portalsResource } from '@/mcp-server/resources/definitions/portals.resource.js';

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: vi.fn(),
}));

import { getSocrataService } from '@/services/socrata/socrata-service.js';

const mockListPortals = vi.fn();
const mockService = { listPortals: mockListPortals };

const samplePortals = [
  { domain: 'data.seattle.gov', organization: 'City of Seattle', datasetCount: 500 },
  { domain: 'data.cityofnewyork.us', organization: 'City of New York', datasetCount: 2000 },
  { domain: 'data.sfgov.org', organization: 'City and County of San Francisco', datasetCount: 400 },
];

beforeEach(() => {
  vi.clearAllMocks();
  (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
  mockListPortals.mockResolvedValue(samplePortals);
});

describe('portalsResource', () => {
  describe('handler', () => {
    it('returns the first page of portals without a cursor', async () => {
      const ctx = createMockContext();
      const params = portalsResource.params.parse({});
      const result = await portalsResource.handler(params, ctx);

      expect(result.portals).toBeInstanceOf(Array);
      expect(result.portals.length).toBeGreaterThan(0);
      expect(result.total_count).toBe(3);
      for (const p of result.portals) {
        expect(p).toHaveProperty('domain');
        expect(p).toHaveProperty('dataset_count');
      }
    });

    it('maps organization when present and omits it when absent', async () => {
      mockListPortals.mockResolvedValue([
        { domain: 'data.example.gov', organization: 'Example Agency', datasetCount: 10 },
        { domain: 'data.other.gov', datasetCount: 5 }, // no organization
      ]);
      const ctx = createMockContext();
      const params = portalsResource.params.parse({});
      const result = await portalsResource.handler(params, ctx);

      expect(result.portals[0].organization).toBe('Example Agency');
      expect(result.portals[1].organization).toBeUndefined();
    });

    it('handles an empty portal list from the service', async () => {
      mockListPortals.mockResolvedValue([]);
      const ctx = createMockContext();
      const params = portalsResource.params.parse({});
      const result = await portalsResource.handler(params, ctx);

      expect(result.portals).toHaveLength(0);
      expect(result.total_count).toBe(0);
    });

    it('includes next_cursor when there are more pages', async () => {
      // Populate more than 50 entries to trigger pagination.
      const manyPortals = Array.from({ length: 60 }, (_, i) => ({
        domain: `data.city${i}.gov`,
        organization: `City ${i}`,
        datasetCount: i * 10,
      }));
      mockListPortals.mockResolvedValue(manyPortals);

      const ctx = createMockContext();
      const params = portalsResource.params.parse({});
      const result = await portalsResource.handler(params, ctx);

      // Default page size is 50 — 60 entries means there is a next page.
      expect(result.portals.length).toBeLessThanOrEqual(50);
      expect(result.total_count).toBe(60);
      expect(result.next_cursor).toBeDefined();
    });

    it('accepts a cursor param without throwing (pagination round-trip)', async () => {
      // Provide enough portals to fill a page so a cursor is produced.
      const manyPortals = Array.from({ length: 60 }, (_, i) => ({
        domain: `data.city${i}.gov`,
        organization: `City ${i}`,
        datasetCount: 100,
      }));
      mockListPortals.mockResolvedValue(manyPortals);

      const ctx = createMockContext();

      // First page — capture cursor.
      const firstPage = await portalsResource.handler(portalsResource.params.parse({}), ctx);
      const cursor = firstPage.next_cursor;
      expect(cursor).toBeDefined();

      // Second page via cursor.
      const secondPage = await portalsResource.handler(
        portalsResource.params.parse({ cursor }),
        ctx,
      );
      expect(secondPage.portals).toBeInstanceOf(Array);
      expect(secondPage.total_count).toBe(60);
    });

    it('propagates service errors', async () => {
      mockListPortals.mockRejectedValue(new Error('Discovery API unreachable'));
      const ctx = createMockContext();
      const params = portalsResource.params.parse({});
      await expect(portalsResource.handler(params, ctx)).rejects.toThrow(
        'Discovery API unreachable',
      );
    });
  });

  describe('list', () => {
    it('returns a resource listing with at least one entry', () => {
      const listing = portalsResource.list!();
      expect(listing.resources).toBeInstanceOf(Array);
      expect(listing.resources.length).toBeGreaterThan(0);
      for (const r of listing.resources) {
        expect(r).toHaveProperty('uri');
        expect(r).toHaveProperty('name');
      }
    });
  });
});
