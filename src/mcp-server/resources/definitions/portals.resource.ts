/**
 * @fileoverview Portals list resource — stable URI for clients that support resources.
 * Returns known Socrata portals with org name and dataset count.
 * @module mcp-server/resources/definitions/portals.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { extractCursor, paginateArray, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

export const portalsResource = resource('socrata://portals', {
  name: 'socrata-portals',
  title: 'Socrata Portal Catalog',
  description:
    'List of known Socrata-powered government open-data portals with organization name and dataset count. Backed by the Discovery API domains catalog. Paginated — default 50 per page. Use the domain values with socrata_find_datasets to search a specific portal.',
  mimeType: 'application/json',
  params: z.object({
    cursor: z.string().optional().describe('Opaque pagination cursor. Omit for first page.'),
  }),

  async handler(params, ctx) {
    ctx.log.debug('Fetching portals resource');
    const svc = getSocrataService();
    const portals = await svc.listPortals(ctx);

    const cursor = extractCursor(params.cursor ? { cursor: params.cursor } : {});
    const reqCtx = requestContextService.createRequestContext({
      operation: 'portals-resource',
      parentContext: { requestId: ctx.requestId, traceId: ctx.traceId },
    });
    const page = paginateArray(portals, cursor, 50, 200, reqCtx);

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
