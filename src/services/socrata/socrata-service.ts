/**
 * @fileoverview Socrata SODA API and Discovery API client.
 * Handles dataset discovery, schema inspection, SoQL query execution, and portal listing.
 * @module services/socrata/socrata-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  configurationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  DatasetColumn,
  DatasetMetadata,
  DiscoveryResult,
  FindDatasetsOptions,
  PortalEntry,
  QueryDatasetOptions,
  QueryResult,
  RowCountSource,
  SodaError,
} from './types.js';
import { DATASET_ID_PATTERN } from './types.js';

/** Discovery API base URL (cross-portal). */
const DISCOVERY_BASE = 'https://api.us.socrata.com/api/catalog/v1';

/**
 * Curated list of well-known Socrata portals.
 * The Discovery API no longer exposes a /domains listing endpoint (returns 404),
 * so membership is static; per-portal dataset counts are fetched live from the
 * catalog endpoint and TTL-cached (see the portal-count cache below).
 */
const KNOWN_PORTALS: ReadonlyArray<Omit<PortalEntry, 'datasetCount'>> = [
  { domain: 'data.cityofnewyork.us', organization: 'City of New York' },
  { domain: 'data.seattle.gov', organization: 'City of Seattle' },
  { domain: 'data.cityofchicago.org', organization: 'City of Chicago' },
  { domain: 'data.sfgov.org', organization: 'City and County of San Francisco' },
  { domain: 'data.lacity.org', organization: 'City of Los Angeles' },
  { domain: 'data.boston.gov', organization: 'City of Boston' },
  { domain: 'data.austintexas.gov', organization: 'City of Austin, TX' },
  { domain: 'data.baltimorecity.gov', organization: 'City of Baltimore' },
  { domain: 'data.nashville.gov', organization: 'City of Nashville' },
  { domain: 'data.detroitmi.gov', organization: 'City of Detroit' },
  { domain: 'data.cityofmadison.com', organization: 'City of Madison, WI' },
  { domain: 'data.colorado.gov', organization: 'State of Colorado' },
  { domain: 'data.ny.gov', organization: 'State of New York' },
  { domain: 'data.texas.gov', organization: 'State of Texas' },
  { domain: 'data.wa.gov', organization: 'State of Washington' },
  { domain: 'data.oregon.gov', organization: 'State of Oregon' },
  { domain: 'data.illinois.gov', organization: 'State of Illinois' },
  { domain: 'data.maryland.gov', organization: 'State of Maryland' },
  { domain: 'data.michigan.gov', organization: 'State of Michigan' },
  { domain: 'data.ohio.gov', organization: 'State of Ohio' },
  { domain: 'data.ct.gov', organization: 'State of Connecticut' },
  { domain: 'data.iowa.gov', organization: 'State of Iowa' },
  { domain: 'data.hawaii.gov', organization: 'State of Hawaii' },
  { domain: 'data.kcmo.org', organization: 'City of Kansas City, MO' },
  { domain: 'data.montgomerycountymd.gov', organization: 'Montgomery County, MD' },
  { domain: 'opendata.dc.gov', organization: 'District of Columbia' },
  { domain: 'data.gov', organization: 'U.S. Federal Government (data.gov)' },
  { domain: 'data.cdc.gov', organization: 'Centers for Disease Control and Prevention' },
  { domain: 'data.hhs.gov', organization: 'U.S. Dept. of Health and Human Services' },
  { domain: 'data.cityofsacramento.org', organization: 'City of Sacramento' },
  { domain: 'data.sandiego.gov', organization: 'City of San Diego' },
  { domain: 'data.mesaaz.gov', organization: 'City of Mesa, AZ' },
  { domain: 'data.tucsonaz.gov', organization: 'City of Tucson, AZ' },
  { domain: 'data.opendatasoft.com', organization: 'OpenDataSoft' },
  { domain: 'opendata.minneapolismn.gov', organization: 'City of Minneapolis' },
  { domain: 'data.cityoflewisville.com', organization: 'City of Lewisville, TX' },
];

/** How long a successful portal-count refresh stays fresh. */
const PORTAL_COUNT_TTL_MS = 24 * 60 * 60 * 1000;
/** Retry sooner when a refresh produced no counts at all (upstream outage). */
const PORTAL_COUNT_RETRY_MS = 5 * 60 * 1000;
/** Cap on concurrent Discovery count requests during a cache warm. */
const PORTAL_COUNT_CONCURRENCY = 8;

/**
 * Module-scope TTL cache of per-domain dataset counts. Deliberately module-scope
 * rather than `ctx.state`: counts are public upstream reference data shared by
 * every tenant, not tenant state. A failed refresh keeps last-known-good values;
 * domains that have never resolved surface as `datasetCount: null`.
 */
let portalCounts = new Map<string, number>();
let portalCountsNextRefreshAt = 0;
let portalCountsRefresh: Promise<void> | undefined;

/** Reset the module-scope portal-count cache. Test-only. */
export function resetPortalCountCache(): void {
  portalCounts = new Map();
  portalCountsNextRefreshAt = 0;
  portalCountsRefresh = undefined;
}

/** Parse an upstream numeric value (number or non-blank numeric string); undefined otherwise. */
function toFiniteNumber(value: unknown): number | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve a dataset's row count from views-API metadata. Prefers the top-level
 * `cachedContents` fields; when those are absent (common on live portals),
 * derives the count as the maximum per-column `cachedContents.count` — upstream
 * reports `count = non_null + null` per column, so the max column count is the
 * closest available proxy for total rows.
 */
function deriveRowCount(
  raw: Record<string, unknown>,
  rawColumns: unknown[],
): { rowCount?: number; rowCountSource?: RowCountSource } {
  const top = (raw.cachedContents ?? {}) as Record<string, unknown>;
  const direct = toFiniteNumber(top.total_rows) ?? toFiniteNumber(top.rows_reviewed);
  if (direct != null) {
    return { rowCount: direct, rowCountSource: 'top_level_cached_contents' };
  }

  let max: number | undefined;
  for (const c of rawColumns) {
    const cached = ((c as Record<string, unknown>).cachedContents ?? {}) as Record<string, unknown>;
    const count = toFiniteNumber(cached.count);
    if (count != null && (max == null || count > max)) max = count;
  }
  return max != null ? { rowCount: max, rowCountSource: 'column_cached_contents' } : {};
}

/** Socrata geo/spatial column type names (dataTypeName or renderTypeName). */
const GEO_TYPES = new Set([
  'location',
  'point',
  'polygon',
  'line',
  'multipoint',
  'multiline',
  'multipolygon',
  'geo_entity',
  'geometry',
]);

export class SocrataService {
  /** Build the default request headers, optionally adding the app token. */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    const token = getServerConfig().appToken;
    if (token) {
      headers['X-App-Token'] = token;
    }
    return headers;
  }

  /** Fetch JSON from a URL with retry, timeout, and SODA error detection. */
  private fetchJson<T>(url: string, ctx: Context): Promise<T> {
    return withRetry(
      async () => {
        const response = await fetch(url, {
          headers: this.buildHeaders(),
          signal: ctx.signal,
        });

        if (!response.ok) {
          // Try to read structured SODA error before delegating to httpErrorFromResponse.
          // The error-code key varies by subsystem: compiler errors use `code`,
          // query-coordinator errors use `errorCode` — accept either.
          const text = await response.text();
          let sodaErr: SodaError | undefined;
          try {
            const parsed = JSON.parse(text) as unknown;
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              ('code' in parsed || 'errorCode' in parsed) &&
              'message' in parsed
            ) {
              sodaErr = parsed as SodaError;
            }
          } catch {
            // Not JSON — fall through.
          }

          if (sodaErr) {
            // Map SODA error codes to appropriate MCP errors.
            const socrataCode = sodaErr.code ?? sodaErr.errorCode ?? '';
            if (response.status === 400) {
              // All 400s with a SODA body are SoQL/query errors — propagate upstream message.
              throw validationError(`SoQL error: ${sodaErr.message}`, {
                reason: 'soql_error',
                socrataCode,
              });
            }
            if (response.status === 403 && /app[_ ]token/i.test(sodaErr.message)) {
              // Invalid SOCRATA_APP_TOKEN — a config problem, not a caller-permissions one.
              // Discriminate on the message content: a private-dataset denial also returns
              // 403 permission_denied but without mentioning the app token, and must keep
              // the generic path below. Never include the token value here.
              throw configurationError(
                `Socrata rejected the configured app token: ${sodaErr.message}`,
                {
                  reason: 'invalid_app_token',
                  socrataCode,
                },
              );
            }
            if (response.status === 429) {
              throw serviceUnavailable(`Socrata API rate limited: ${sodaErr.message}`, {
                reason: 'rate_limited',
              });
            }
            if (response.status === 404) {
              const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
              throw notFound(`Dataset not found: ${sodaErr.message}`, {
                reason: 'not_found',
              });
            }
          }

          // Generic HTTP error.
          throw await httpErrorFromResponse(response, {
            service: 'Socrata',
            data: { url: url.slice(0, 200) },
          });
        }

        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'Socrata API returned HTML instead of JSON — likely rate-limited or endpoint unavailable.',
            { url: url.slice(0, 200) },
          );
        }

        return JSON.parse(text) as T;
      },
      {
        operation: 'SocrataService.fetchJson',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Search for datasets across all portals or scoped to one domain.
   * Uses the Socrata Discovery API.
   */
  async findDatasets(
    opts: FindDatasetsOptions,
    ctx: Context,
  ): Promise<{ results: DiscoveryResult[]; totalCount: number }> {
    const params = new URLSearchParams();
    if (opts.query) params.set('q', opts.query);
    if (opts.domain) params.set('domains', opts.domain);
    if (opts.categories?.length) params.set('categories', opts.categories.join(','));
    if (opts.tags?.length) params.set('tags', opts.tags.join(','));
    if (opts.only) params.set('only', opts.only);
    if (opts.order) params.set('order', opts.order);
    params.set('limit', String(Math.min(opts.limit ?? 10, 100)));
    if (opts.offset) params.set('offset', String(opts.offset));

    const url = `${DISCOVERY_BASE}?${params.toString()}`;
    ctx.log.debug('Discovery API search', { url: url.slice(0, 300) });

    const raw = await this.fetchJson<{
      results: unknown[];
      resultSetSize: number;
    }>(url, ctx);

    const results = (raw.results ?? []).map((r): DiscoveryResult => {
      const item = r as Record<string, unknown>;
      const resource = (item.resource ?? {}) as Record<string, unknown>;
      const classification = (item.classification ?? {}) as Record<string, unknown>;
      const metadata = (item.metadata ?? {}) as Record<string, unknown>;

      const id = String(resource.id ?? '');
      const domainCname = String(metadata.domain ?? '');

      return {
        datasetId: id,
        domain: domainCname,
        name: String(resource.name ?? ''),
        ...(resource.description ? { description: String(resource.description) } : {}),
        ...(classification.domain_category
          ? { category: String(classification.domain_category) }
          : {}),
        tags: Array.isArray(classification.domain_tags)
          ? (classification.domain_tags as string[])
          : [],
        columnNames: Array.isArray(resource.columns_name)
          ? (resource.columns_name as string[])
          : [],
        ...(resource.license ? { license: String(resource.license) } : {}),
        ...(resource.data_updated_at ? { dataUpdatedAt: String(resource.data_updated_at) } : {}),
        ...(typeof resource.page_views === 'object' &&
        resource.page_views !== null &&
        'page_views_total' in (resource.page_views as Record<string, unknown>)
          ? {
              viewCount: Number((resource.page_views as Record<string, unknown>).page_views_total),
            }
          : {}),
      };
    });

    return {
      results,
      totalCount: typeof raw.resultSetSize === 'number' ? raw.resultSetSize : results.length,
    };
  }

  /** Fetch full metadata and column schema for a dataset by ID. */
  async getDataset(domain: string, datasetId: string, ctx: Context): Promise<DatasetMetadata> {
    if (!DATASET_ID_PATTERN.test(datasetId)) {
      throw validationError(
        `Invalid dataset ID format: "${datasetId}". Expected pattern like kzjm-xkqj.`,
        { reason: 'invalid_id', datasetId },
      );
    }

    const url = `https://${domain}/api/views/${datasetId}.json`;
    ctx.log.debug('Fetching dataset metadata', { domain, datasetId });

    const raw = await this.fetchJson<Record<string, unknown>>(url, ctx);

    const rawColumns = Array.isArray(raw.columns) ? (raw.columns as unknown[]) : [];

    const columns: DatasetColumn[] = rawColumns
      .map((c): DatasetColumn | null => {
        const col = c as Record<string, unknown>;
        const fieldName = String(col.fieldName ?? col.name ?? '');
        const dataType = String(col.dataTypeName ?? col.renderTypeName ?? 'text');
        // Filter out computed region columns (geospatial join artifacts), but keep
        // actual geo-typed columns even when their fieldName uses a system prefix.
        if (fieldName.startsWith(':@computed_region_')) return null;
        // Keep columns with empty fieldName only if they have a known geo type.
        if (!fieldName && !GEO_TYPES.has(dataType.toLowerCase())) return null;
        const cachedContents = (col.cachedContents ?? {}) as Record<string, unknown>;
        const nonNullCount = toFiniteNumber(cachedContents.non_null);
        return {
          fieldName: fieldName || dataType,
          dataType,
          ...(col.description ? { description: String(col.description) } : {}),
          ...(nonNullCount != null ? { nonNullCount } : {}),
        };
      })
      .filter((c): c is DatasetColumn => c !== null);

    const { rowCount, rowCountSource } = deriveRowCount(raw, rawColumns);

    return {
      datasetId,
      domain,
      name: String(raw.name ?? ''),
      ...(raw.description ? { description: String(raw.description) } : {}),
      ...(raw.category ? { category: String(raw.category) } : {}),
      tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
      ...(raw.rowsUpdatedAt
        ? { dataUpdatedAt: new Date(Number(raw.rowsUpdatedAt) * 1000).toISOString() }
        : {}),
      ...(raw.license
        ? { license: String((raw.license as Record<string, unknown>).name ?? raw.license) }
        : {}),
      ...(rowCount != null ? { rowCount } : {}),
      ...(rowCountSource ? { rowCountSource } : {}),
      columns,
    };
  }

  /** Execute a SoQL query against a dataset. */
  async queryDataset(opts: QueryDatasetOptions, ctx: Context): Promise<QueryResult> {
    if (!DATASET_ID_PATTERN.test(opts.datasetId)) {
      throw validationError(
        `Invalid dataset ID format: "${opts.datasetId}". Expected pattern like kzjm-xkqj.`,
        { reason: 'invalid_id', datasetId: opts.datasetId },
      );
    }

    const limit = Math.min(opts.limit ?? 100, 5000);
    const params = new URLSearchParams();

    if (opts.select) params.set('$select', opts.select);
    if (opts.search) params.set('$q', opts.search);
    if (opts.where) params.set('$where', opts.where);
    if (opts.group) params.set('$group', opts.group);
    if (opts.having) params.set('$having', opts.having);
    if (opts.order) params.set('$order', opts.order);
    params.set('$limit', String(limit));
    if (opts.offset) params.set('$offset', String(opts.offset));

    const dataUrl = `https://${opts.domain}/resource/${opts.datasetId}.json?${params.toString()}`;
    ctx.log.debug('SoQL query', { domain: opts.domain, datasetId: opts.datasetId });

    // Fetch data rows.
    const rows = await this.fetchJson<Record<string, unknown>[]>(dataUrl, ctx);

    // Fetch total count separately when result is at the limit (may be truncated).
    // Skipped for grouped queries: the recount carries only where/search, so it
    // would count matching source rows, not result groups — a misleading number.
    let totalCount: number | undefined;
    if (rows.length === limit && !opts.group) {
      const countParams = new URLSearchParams();
      countParams.set('$select', 'count(*)');
      if (opts.where) countParams.set('$where', opts.where);
      if (opts.search) countParams.set('$q', opts.search);
      const countUrl = `https://${opts.domain}/resource/${opts.datasetId}.json?${countParams.toString()}`;

      try {
        const countResult = await this.fetchJson<[{ count: string }]>(countUrl, ctx);
        const total = parseInt(countResult[0]?.count ?? '0', 10);
        if (total > rows.length) totalCount = total;
      } catch {
        // Count fetch is best-effort — don't fail the query if it errors.
      }
    }

    const clauses = [...params.entries()]
      .filter(([k]) => k !== '$limit' && k !== '$offset')
      .map(([k, v]) => `${k}=${v}`);

    return {
      rows,
      rowCount: rows.length,
      ...(totalCount != null ? { totalCount } : {}),
      assembledQuery:
        clauses.length > 0
          ? [...clauses, `$limit=${limit}`].join(' ')
          : '(default — all columns, up to limit)',
    };
  }

  /**
   * List the curated well-known Socrata portals with live dataset counts.
   * Counts come from the TTL-cached Discovery catalog lookups; a portal whose
   * count has never resolved carries `datasetCount: null` rather than failing
   * the whole listing.
   */
  async listPortals(ctx: Context): Promise<PortalEntry[]> {
    if (Date.now() >= portalCountsNextRefreshAt) {
      // Deduplicate concurrent refreshes — all callers await the same warm.
      portalCountsRefresh ??= this.refreshPortalCounts(ctx).finally(() => {
        portalCountsRefresh = undefined;
      });
      await portalCountsRefresh;
    }
    return KNOWN_PORTALS.map((p) => ({
      ...p,
      datasetCount: portalCounts.get(p.domain) ?? null,
    }));
  }

  /**
   * Warm the portal-count cache: one `limit=0` Discovery catalog query per
   * known domain (`resultSetSize` is the count of dataset-type assets).
   * Per-domain failures are logged and skipped — last-known-good values are
   * retained. A refresh that resolves nothing schedules a short retry instead
   * of holding an empty cache for the full TTL.
   */
  private async refreshPortalCounts(ctx: Context): Promise<void> {
    const domains = KNOWN_PORTALS.map((p) => p.domain);
    ctx.log.info('Refreshing portal dataset counts', { domains: domains.length });

    let fetched = 0;
    for (let i = 0; i < domains.length; i += PORTAL_COUNT_CONCURRENCY) {
      const chunk = domains.slice(i, i + PORTAL_COUNT_CONCURRENCY);
      await Promise.all(
        chunk.map(async (domain) => {
          try {
            portalCounts.set(domain, await this.fetchPortalDatasetCount(domain, ctx));
            fetched++;
          } catch (err) {
            ctx.log.warning('Portal dataset count fetch failed', {
              domain,
              error: String(err),
            });
          }
        }),
      );
    }

    portalCountsNextRefreshAt =
      Date.now() + (fetched > 0 ? PORTAL_COUNT_TTL_MS : PORTAL_COUNT_RETRY_MS);
    ctx.log.info('Portal dataset counts refreshed', {
      fetched,
      failed: domains.length - fetched,
    });
  }

  /** Count dataset-type assets on one portal via the Discovery catalog. */
  private async fetchPortalDatasetCount(domain: string, ctx: Context): Promise<number> {
    const params = new URLSearchParams({ domains: domain, only: 'dataset', limit: '0' });
    const raw = await this.fetchJson<{ resultSetSize?: number }>(
      `${DISCOVERY_BASE}?${params.toString()}`,
      ctx,
    );
    if (typeof raw.resultSetSize !== 'number' || !Number.isFinite(raw.resultSetSize)) {
      throw serviceUnavailable('Discovery catalog count response missing resultSetSize.', {
        domain,
      });
    }
    return raw.resultSetSize;
  }
}

// --- Init/accessor pattern ---

let _service: SocrataService | undefined;

export function initSocrataService(): void {
  _service = new SocrataService();
}

export function getSocrataService(): SocrataService {
  if (!_service) {
    throw new Error('SocrataService not initialized — call initSocrataService() in setup()');
  }
  return _service;
}
