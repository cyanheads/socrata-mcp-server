/**
 * @fileoverview Cross-portal dataset discovery tool using the Socrata Discovery API.
 * @module mcp-server/tools/definitions/find-datasets.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { inlineUpstream, upstreamBlockquote } from '@/mcp-server/tools/upstream-text.js';
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
        'API field names — the identifiers SoQL takes in select/where/group/order (e.g. cuisine_description), not display labels. Computed-region system columns are dropped; empty when the catalog lists no field names. No type info — call socrata_get_dataset for the typed schema.',
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
    'Search for datasets across all Socrata-powered government open-data portals, or scope to one portal with the domain parameter. Returns dataset IDs, names, domains, update timestamps, and column_names — the API field names SoQL takes, not display labels. Use socrata_get_dataset to fetch the typed column schema before writing queries — column_names carry no type information.',
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
        'Scope search to a single portal by bare hostname (e.g. data.seattle.gov, data.cityofnewyork.us); URL forms like https://data.seattle.gov/ are accepted and reduced to the host. Omit to search all portals.',
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
    {
      reason: 'unknown_domain',
      code: JsonRpcErrorCode.NotFound,
      when: 'The Discovery catalog does not index the domain ("Domain not found").',
      recovery:
        'The domain is not a Socrata portal the catalog knows. Pass a bare portal hostname such as data.cityofnewyork.us, pick one from socrata_list_portals, or omit domain to search every indexed portal.',
    },
    {
      reason: 'invalid_domain',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The domain is not a hostname, even after dropping a URL scheme, path, or query.',
      recovery:
        'Pass a bare portal hostname such as data.cityofnewyork.us, or pick one from socrata_list_portals.',
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
    let found: Awaited<ReturnType<typeof svc.findDatasets>>;
    try {
      found = await svc.findDatasets(
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
    } catch (err) {
      // Re-throw service failures that map to declared contract reasons via
      // ctx.fail so the contract recovery hint reaches the wire.
      if (err instanceof McpError) {
        const data = (err.data ?? {}) as Record<string, unknown>;
        const { reason } = data;
        if (
          reason === 'rate_limited' ||
          reason === 'unknown_domain' ||
          reason === 'invalid_domain'
        ) {
          throw ctx.fail(
            reason,
            err.message,
            { ...data, ...ctx.recoveryFor(reason) },
            { cause: err },
          );
        }
      }
      throw err;
    }
    const { results, totalCount } = found;

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
      // Dataset names and descriptions are upstream-controlled — render names
      // quoted on a single line and descriptions as labeled blockquotes.
      lines.push(`### "${inlineUpstream(ds.name)}"`);
      lines.push(`**ID:** ${ds.dataset_id} | **Domain:** ${ds.domain}`);
      if (ds.category != null) lines.push(`**Category:** ${ds.category}`);
      if (ds.tags.length) lines.push(`**Tags:** ${ds.tags.join(', ')}`);
      if (ds.description != null) {
        // Trailing blank line seals the blockquote — without it a following
        // metadata line would be a lazy continuation of the quote.
        lines.push(...upstreamBlockquote('Upstream dataset description', ds.description), '');
      }
      if (ds.column_names.length) {
        // Render the full column list structuredContent carries — a render-only
        // slice here would drop names content[]-reading clients can't recover.
        lines.push(`**Columns (field names):** ${ds.column_names.join(', ')}`);
      }
      if (ds.data_updated_at != null) lines.push(`**Last updated:** ${ds.data_updated_at}`);
      if (ds.view_count != null) lines.push(`**Views:** ${ds.view_count}`);
      if (ds.license != null) lines.push(`**License:** ${ds.license}`);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
