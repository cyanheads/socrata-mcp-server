/**
 * @fileoverview Cross-portal dataset discovery tool using the Socrata Discovery API.
 * @module mcp-server/tools/definitions/find-datasets.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

const DatasetResultSchema = z
  .object({
    dataset_id: z
      .string()
      .describe(
        'Four-by-four dataset ID (e.g. kzjm-xkqj). Pass to socrata_get_dataset or socrata_query_dataset.',
      ),
    domain: z.string().describe('Portal domain hosting this dataset (e.g. data.seattle.gov).'),
    name: z.string().describe('Dataset display name.'),
    description: z.string().optional().describe('Dataset description when available.'),
    category: z.string().optional().describe('Domain category when available.'),
    tags: z.array(z.string()).describe('Associated tags.'),
    column_names: z
      .array(z.string())
      .describe(
        'Preview column name list (no type info). Call socrata_get_dataset for typed schema.',
      ),
    license: z.string().optional().describe('Dataset license when available.'),
    data_updated_at: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of last data update when available.'),
    view_count: z.number().optional().describe('Total page views when available.'),
  })
  .describe('A single matching dataset.');

export const findDatasets = tool('socrata_find_datasets', {
  title: 'Find Socrata Datasets',
  description:
    'Search for datasets across all Socrata-powered government open-data portals, or scope to one portal with the domain parameter. Returns dataset IDs, names, abbreviated column lists, domains, and update timestamps. Use socrata_get_dataset to fetch the full typed column schema before writing queries — columnNames here are preview-only and lack type information.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search across dataset names and descriptions. Omit to browse without filtering.',
      ),
    domain: z
      .string()
      .optional()
      .describe(
        'Scope search to a single portal (e.g. data.seattle.gov, data.cityofnewyork.us). Omit to search all portals.',
      ),
    categories: z
      .array(z.string())
      .optional()
      .describe('Filter by domain categories (e.g. ["Public Safety", "Transportation"]).'),
    tags: z.array(z.string()).optional().describe('Filter by tags (e.g. ["covid19", "permits"]).'),
    only: z
      .enum(['datasets', 'maps', 'files', 'calendars', 'stories'])
      .optional()
      .describe(
        'Filter by asset type. Omit to include all types. Usually "datasets" is what you want.',
      ),
    order: z
      .enum(['relevance', 'page_views_total', 'created_at', 'updated_at'])
      .optional()
      .describe(
        'Sort order. Defaults to relevance. Use updated_at to surface recently-refreshed datasets.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Number of results to return (1–100). Default 10.'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset. Default 0.'),
  }),
  output: z.object({
    results: z.array(DatasetResultSchema).describe('Matching datasets. Empty when no results.'),
  }),

  // Agent-facing context: the query as sent, total match count, and an empty-result notice.
  // Reaches structuredContent and content[] automatically — no format() entry needed.
  enrichment: {
    totalCount: z.number().describe('Total matches before pagination. 0 when empty.'),
    effectiveQuery: z.string().optional().describe('Search query applied, for reference.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty — echoes filters and suggests how to broaden. Absent on non-empty result pages.',
      ),
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
    ctx.log.info('Finding datasets', {
      query: input.query,
      domain: input.domain,
      limit: input.limit,
    });

    const svc = getSocrataService();
    const query = input.query?.trim() ? input.query : undefined;
    const domain = input.domain?.trim() ? input.domain : undefined;
    const categories = input.categories?.length ? input.categories : undefined;
    const tags = input.tags?.length ? input.tags : undefined;
    const { results, totalCount } = await svc.findDatasets(
      {
        ...(query ? { query } : {}),
        ...(domain ? { domain } : {}),
        ...(categories ? { categories } : {}),
        ...(tags ? { tags } : {}),
        ...(input.only ? { only: input.only } : {}),
        ...(input.order ? { order: input.order } : {}),
        limit: input.limit,
        offset: input.offset,
      },
      ctx,
    );

    ctx.enrich.total(totalCount);
    if (query) ctx.enrich.echo(query);

    if (results.length === 0) {
      const filtersApplied: string[] = [];
      if (input.query) filtersApplied.push(`query="${input.query}"`);
      if (input.domain) filtersApplied.push(`domain=${input.domain}`);
      if (input.categories?.length) filtersApplied.push(`categories=${input.categories.join(',')}`);
      if (input.tags?.length) filtersApplied.push(`tags=${input.tags.join(',')}`);

      ctx.enrich.notice(
        `No datasets matched${filtersApplied.length ? ` with ${filtersApplied.join(', ')}` : ''}. ` +
          'Try broader search terms, remove category/tag filters, or omit domain to search all portals.',
      );
      return { results: [] };
    }

    return {
      results: results.map((r) => ({
        dataset_id: r.datasetId,
        domain: r.domain,
        name: r.name,
        ...(r.description ? { description: r.description } : {}),
        ...(r.category ? { category: r.category } : {}),
        tags: r.tags,
        column_names: r.columnNames,
        ...(r.license ? { license: r.license } : {}),
        ...(r.dataUpdatedAt ? { data_updated_at: r.dataUpdatedAt } : {}),
        ...(r.viewCount != null ? { view_count: r.viewCount } : {}),
      })),
    };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.results.length === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push(`\n**${result.results.length} datasets found**\n`);

    for (const ds of result.results) {
      lines.push(`### ${ds.name}`);
      lines.push(`**ID:** ${ds.dataset_id} | **Domain:** ${ds.domain}`);
      if (ds.category != null) lines.push(`**Category:** ${ds.category}`);
      if (ds.tags.length) lines.push(`**Tags:** ${ds.tags.join(', ')}`);
      if (ds.description != null) lines.push(ds.description);
      if (ds.column_names.length) {
        lines.push(
          `**Columns (preview):** ${ds.column_names.slice(0, 8).join(', ')}${ds.column_names.length > 8 ? ` (+${ds.column_names.length - 8} more)` : ''}`,
        );
      }
      if (ds.data_updated_at != null) lines.push(`**Last updated:** ${ds.data_updated_at}`);
      if (ds.view_count != null) lines.push(`**Views:** ${ds.view_count}`);
      if (ds.license != null) lines.push(`**License:** ${ds.license}`);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
