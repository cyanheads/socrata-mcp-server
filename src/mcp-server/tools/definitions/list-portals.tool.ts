/**
 * @fileoverview Portal catalog listing tool for Socrata-powered government open-data portals.
 * @module mcp-server/tools/definitions/list-portals.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

const PortalEntrySchema = z
  .object({
    domain: z
      .string()
      .describe('Portal domain (e.g. data.seattle.gov). Pass to socrata_find_datasets.'),
    organization: z
      .string()
      .optional()
      .describe('Organization name when available (e.g. City of Seattle).'),
    dataset_count: z.number().describe('Number of datasets on this portal.'),
  })
  .describe('A single Socrata portal.');

export const listPortals = tool('socrata_list_portals', {
  title: 'List Socrata Portals',
  description:
    'List known Socrata-powered government open-data portals with their domain, organization name, and dataset count. Backed by the Discovery API domains catalog. Filtering is client-side substring match on the query parameter. Use this first when you do not know which portal to target, then pass the domain to socrata_find_datasets.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Keyword to filter portal names or organization names (case-insensitive substring match). Omit to list all portals.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Max portals to return (1–200). Default 50.'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset. Default 0.'),
  }),
  output: z.object({
    portals: z.array(PortalEntrySchema).describe('Matching portals. Empty when no results.'),
  }),

  // Agent-facing context: total portal count and an empty-result notice.
  // Reaches structuredContent and content[] automatically — no format() entry needed.
  enrichment: {
    totalCount: z.number().describe('Total portals before pagination. 0 when empty.'),
    notice: z
      .string()
      .optional()
      .describe('Recovery hint when no portals matched the filter. Absent on non-empty pages.'),
  },

  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Discovery API returned 429.',
      retryable: true,
      recovery: 'Retry after a short delay. Set SOCRATA_APP_TOKEN for higher per-IP rate limits.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Listing portals', { query: input.query, limit: input.limit });

    const svc = getSocrataService();
    let portals = await svc.listPortals(ctx);

    // Client-side filtering — the domains endpoint has no server-side text filter.
    const queryFilter = input.query?.trim() ? input.query.trim().toLowerCase() : undefined;
    if (queryFilter) {
      portals = portals.filter(
        (p) =>
          p.domain.toLowerCase().includes(queryFilter) ||
          (p.organization?.toLowerCase().includes(queryFilter) ?? false),
      );
    }

    const totalCount = portals.length;
    const page = portals.slice(input.offset, input.offset + input.limit);

    ctx.enrich.total(totalCount);

    if (page.length === 0) {
      ctx.enrich.notice(
        queryFilter
          ? `No portals matched "${input.query}". Try a broader term or omit the query to list all portals.`
          : 'No portals available.',
      );
      return { portals: [] };
    }

    return {
      portals: page.map((p) => ({
        domain: p.domain,
        ...(p.organization ? { organization: p.organization } : {}),
        dataset_count: p.datasetCount,
      })),
    };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.portals.length === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('| Domain | Organization | Datasets |');
    lines.push('|:-------|:-------------|:---------|');
    for (const p of result.portals) {
      lines.push(
        `| ${p.domain} | ${p.organization ?? '—'} | ${p.dataset_count.toLocaleString()} |`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
