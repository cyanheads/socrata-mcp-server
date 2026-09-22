/**
 * @fileoverview Portals list resource — stable URI for clients that support resources.
 * Returns known Socrata portals with org name and dataset count.
 * @module mcp-server/resources/definitions/portals.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { extractCursor, paginateArray } from '@cyanheads/mcp-ts-core/utils';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

export const portalsResource = resource('socrata://portals', {
  name: 'socrata-portals',
  title: 'Socrata Portal Catalog',
  description:
    'List of known Socrata-powered government open-data portals with organization name and approximate dataset count. The catalog is a curated list of 39 well-known portals; dataset counts are fetched from the Discovery API and cached for ~24 hours (null when temporarily unavailable). Paginated — default 50 per page. Use the domain values with socrata_find_datasets to search a specific portal.',
  mimeType: 'application/json',
  params: z.object({
    cursor: z.string().optional().describe('Opaque pagination cursor. Omit for first page.'),
  }),
  output: z.object({
    portals: z
      .array(
        z
          .object({
            domain: z.string().describe('Portal domain used by Socrata API calls.'),
            organization: z.string().optional().describe('Organization name when available.'),
            dataset_count: z
              .number()
              .nullable()
              .describe(
                'Approximate dataset count. Zero is a real count; null means temporarily unavailable.',
              ),
          })
          .describe('A Socrata portal catalog entry.'),
      )
      .describe('Portal entries in this page.'),
    total_count: z.number().describe('Total portal entries before pagination.'),
    next_cursor: z.string().optional().describe('Opaque cursor for the next page, when present.'),
  }),

  async handler(params, ctx) {
    ctx.log.debug('Fetching portals resource');
    const svc = getSocrataService();
    const portals = await svc.listPortals(ctx);

    const cursor = extractCursor(params.cursor ? { cursor: params.cursor } : {});
    const page = paginateArray(portals, cursor, 50, 200, ctx);

    return {
      portals: page.items.map((p) => ({
        domain: p.domain,
        ...(p.organization ? { organization: p.organization } : {}),
        dataset_count: p.datasetCount,
      })),
      total_count: portals.length,
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
    };
  },

  list: () => ({
    resources: [
      {
        uri: 'socrata://portals',
        name: 'Socrata Portal Catalog',
        mimeType: 'application/json',
      },
    ],
  }),
});
