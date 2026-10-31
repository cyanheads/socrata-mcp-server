/**
 * @fileoverview Cross-portal dataset discovery tool using the Socrata Discovery API.
 * @module mcp-server/tools/definitions/find-datasets.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { inlineUpstream, upstreamBlockquote } from '@/mcp-server/tools/upstream-text.js';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

/** Results one call returns, bounding the response size. */
const FIND_LIMIT_CAP = 100;

/**
 * Discovery serves only the first 10,000 matches of a search: a request whose
 * `offset + limit` passes it answers HTTP 400, and `resultSetSize` stops
 * counting there. It is also the hard ceiling on `limit` while clamping is on.
 */
const DISCOVERY_RESULT_WINDOW = 10_000;

/** SOCRATA_CLAMP_LIMITS, read at import: it sets the `limit` maximum the schema advertises. */
const { clampLimits } = getServerConfig();

/**
 * The notice for a page served below the requested `limit`: by the per-call
 * cap, where paging continues at `nextOffset`, and/or by the result window,
 * past which no page exists, so the search must narrow instead.
 */
function limitNotice(
  requested: number,
  served: number,
  nextOffset: number,
  windowEnd: boolean,
): string {
  const causes = [
    ...(requested > FIND_LIMIT_CAP ? [`the per-call cap is ${FIND_LIMIT_CAP}`] : []),
    ...(windowEnd ? ['this page ends at match 10,000'] : []),
  ];
  const head = `The requested limit ${requested} was served as ${served}: ${causes.join(', and ')}.`;
  return windowEnd
    ? `${head} The Discovery catalog serves only the first 10,000 matches of a search, so no later page exists; narrow the search with domain, categories, tags, query, or only to reach the rest.`
    : `${head} Continue with offset ${nextOffset}.`;
}

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
      .describe(
        'Filter by domain categories (e.g. ["Public Safety", "Transportation"]). Multiple values are ORed: a dataset in any listed category matches.',
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        'Filter by tags (e.g. ["covid19", "permits"]). Multiple values are ORed: a dataset carrying any listed tag matches.',
      ),
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
      .max(clampLimits ? DISCOVERY_RESULT_WINDOW : FIND_LIMIT_CAP)
      .default(10)
      .describe(
        clampLimits
          ? 'Number of results to return (1–10,000). One call returns at most 100 results: a larger limit is served as 100, with a notice naming the offset that continues. Default 10.'
          : 'Number of results to return (1–100). Default 10.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Pagination offset. Default 0. Must be below 10,000: the Discovery catalog serves only the first 10,000 matches of a search.',
      ),
  }),
  output: z.object({
    results: z.array(DatasetResultSchema).describe('Matching datasets. Empty when no results.'),
  }),

  // Agent-facing context: the query as sent, total match count, and the page notice.
  // Reaches structuredContent and content[] automatically — no format() entry needed.
  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Total matches before pagination. 0 when empty. Discovery counts no further than 10,000: when totalCountCapped is true, 10,000 is a lower bound.',
      ),
    totalCountCapped: z
      .boolean()
      .optional()
      .describe(
        "True when totalCount reached Discovery's 10,000-match count ceiling, so more datasets may match than totalCount says. Absent otherwise.",
      ),
    effectiveQuery: z.string().optional().describe('Search query applied, for reference.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for this page. When limit was served below the requested value (the 100-result per-call cap or the 10,000-match window), names the served limit and where paging continues; when results are empty, echoes the filters and suggests how to broaden, or, when offset passed the last match, names the offset to page below. Absent otherwise.',
      ),
  },

  errors: [
    {
      reason: 'result_window_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'offset is 10,000 or more: the Discovery catalog serves only the first 10,000 matches of a search.',
      recovery:
        'Narrow the search with domain, categories, tags, query, or only so the matches you need fall within the first 10,000, then page with an offset below 10,000.',
    },
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
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The Discovery API did not answer within the 50-second time limit the call shares across its requests, retries included.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Retry with a narrower search: set domain, categories, tags, or a more specific query.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Finding datasets', {
      query: input.query,
      domain: input.domain,
      limit: input.limit,
      offset: input.offset,
    });

    if (input.offset >= DISCOVERY_RESULT_WINDOW) {
      throw ctx.fail(
        'result_window_exceeded',
        `offset ${input.offset} is past the Discovery result window: the catalog serves only the first 10,000 matches of a search.`,
        { offset: input.offset },
      );
    }
    // One effective limit: the per-call cap and the matches left in the window.
    const limit = Math.min(input.limit, FIND_LIMIT_CAP, DISCOVERY_RESULT_WINDOW - input.offset);
    const windowEnd = input.offset + limit === DISCOVERY_RESULT_WINDOW;

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
          limit,
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
          throw ctx.fail(reason, err.message, data, { cause: err });
        }
      }
      throw err;
    }
    const { results, totalCount } = found;
    const totalCountCapped = totalCount >= DISCOVERY_RESULT_WINDOW;

    ctx.enrich.total(totalCount);
    if (totalCountCapped) ctx.enrich({ totalCountCapped: true });
    if (query) ctx.enrich.echo(query);

    // Sentences of the page's one notice, joined once below.
    const notices: string[] = [];
    // A cut limit is named only when it withheld matches: past the window when
    // this page ends there, otherwise on a later page.
    const withheld = windowEnd ? totalCountCapped : input.offset + results.length < totalCount;
    if (limit < input.limit && withheld) {
      notices.push(limitNotice(input.limit, limit, input.offset + results.length, windowEnd));
    }
    if (results.length === 0 && input.offset > 0 && totalCount > 0) {
      notices.push(
        `The offset ${input.offset} is past the end of the ${totalCount} matching ${totalCount === 1 ? 'dataset' : 'datasets'}. Page with an offset below ${totalCount}.`,
      );
    } else if (results.length === 0) {
      const filtersApplied: string[] = [];
      if (input.query) filtersApplied.push(`query="${input.query}"`);
      if (input.domain) filtersApplied.push(`domain=${input.domain}`);
      if (input.categories?.length) filtersApplied.push(`categories=${input.categories.join(',')}`);
      if (input.tags?.length) filtersApplied.push(`tags=${input.tags.join(',')}`);

      notices.push(
        `No datasets matched${filtersApplied.length ? ` with ${escapeMarkdownInline(filtersApplied.join(', '))}` : ''}. Try broader search terms, remove category/tag filters, or omit domain to search all portals.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

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
      lines.push(`### "${escapeMarkdownInline(inlineUpstream(ds.name))}"`);
      lines.push(`**ID:** ${ds.dataset_id} | **Domain:** ${ds.domain}`);
      if (ds.category != null) lines.push(`**Category:** ${escapeMarkdownInline(ds.category)}`);
      if (ds.tags.length) lines.push(`**Tags:** ${ds.tags.map(escapeMarkdownInline).join(', ')}`);
      if (ds.description != null) {
        // Trailing blank line seals the blockquote — without it a following
        // metadata line would be a lazy continuation of the quote.
        lines.push(...upstreamBlockquote('Upstream dataset description', ds.description), '');
      }
      if (ds.column_names.length) {
        // Render the full column list structuredContent carries — a render-only
        // slice here would drop names content[]-reading clients can't recover.
        lines.push(
          `**Columns (field names):** ${ds.column_names.map(escapeMarkdownInline).join(', ')}`,
        );
      }
      if (ds.data_updated_at != null) lines.push(`**Last updated:** ${ds.data_updated_at}`);
      if (ds.view_count != null) lines.push(`**Views:** ${ds.view_count}`);
      if (ds.license != null) lines.push(`**License:** ${escapeMarkdownInline(ds.license)}`);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
