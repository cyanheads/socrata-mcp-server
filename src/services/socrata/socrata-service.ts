/**
 * @fileoverview Socrata SODA API and Discovery API client.
 * Handles dataset discovery, schema inspection, SoQL query execution, and portal listing.
 * @module services/socrata/socrata-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
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
  SodaError,
} from './types.js';
import { DATASET_ID_PATTERN } from './types.js';

/** Discovery API base URL (cross-portal). */
const DISCOVERY_BASE = 'https://api.us.socrata.com/api/catalog/v1';

/**
 * Curated list of well-known Socrata portals.
 * The Discovery API no longer exposes a /domains listing endpoint (returns 404).
 */
const KNOWN_PORTALS: PortalEntry[] = [
  { domain: 'data.cityofnewyork.us', organization: 'City of New York', datasetCount: 0 },
  { domain: 'data.seattle.gov', organization: 'City of Seattle', datasetCount: 0 },
  { domain: 'data.cityofchicago.org', organization: 'City of Chicago', datasetCount: 0 },
  { domain: 'data.sfgov.org', organization: 'City and County of San Francisco', datasetCount: 0 },
  { domain: 'data.lacity.org', organization: 'City of Los Angeles', datasetCount: 0 },
  { domain: 'data.boston.gov', organization: 'City of Boston', datasetCount: 0 },
  { domain: 'data.austintexas.gov', organization: 'City of Austin, TX', datasetCount: 0 },
  { domain: 'data.baltimorecity.gov', organization: 'City of Baltimore', datasetCount: 0 },
  { domain: 'data.nashville.gov', organization: 'City of Nashville', datasetCount: 0 },
  { domain: 'data.detroitmi.gov', organization: 'City of Detroit', datasetCount: 0 },
  { domain: 'data.cityofmadison.com', organization: 'City of Madison, WI', datasetCount: 0 },
  { domain: 'data.colorado.gov', organization: 'State of Colorado', datasetCount: 0 },
  { domain: 'data.ny.gov', organization: 'State of New York', datasetCount: 0 },
  { domain: 'data.texas.gov', organization: 'State of Texas', datasetCount: 0 },
  { domain: 'data.wa.gov', organization: 'State of Washington', datasetCount: 0 },
  { domain: 'data.oregon.gov', organization: 'State of Oregon', datasetCount: 0 },
  { domain: 'data.illinois.gov', organization: 'State of Illinois', datasetCount: 0 },
  { domain: 'data.maryland.gov', organization: 'State of Maryland', datasetCount: 0 },
  { domain: 'data.michigan.gov', organization: 'State of Michigan', datasetCount: 0 },
  { domain: 'data.ohio.gov', organization: 'State of Ohio', datasetCount: 0 },
  { domain: 'data.ct.gov', organization: 'State of Connecticut', datasetCount: 0 },
  { domain: 'data.iowa.gov', organization: 'State of Iowa', datasetCount: 0 },
  { domain: 'data.hawaii.gov', organization: 'State of Hawaii', datasetCount: 0 },
  { domain: 'data.kcmo.org', organization: 'City of Kansas City, MO', datasetCount: 0 },
  { domain: 'data.montgomerycountymd.gov', organization: 'Montgomery County, MD', datasetCount: 0 },
  { domain: 'opendata.dc.gov', organization: 'District of Columbia', datasetCount: 0 },
  { domain: 'data.gov', organization: 'U.S. Federal Government (data.gov)', datasetCount: 0 },
  {
    domain: 'data.cdc.gov',
    organization: 'Centers for Disease Control and Prevention',
    datasetCount: 0,
  },
  {
    domain: 'data.hhs.gov',
    organization: 'U.S. Dept. of Health and Human Services',
    datasetCount: 0,
  },
  { domain: 'data.cityofsacramento.org', organization: 'City of Sacramento', datasetCount: 0 },
  { domain: 'data.sandiego.gov', organization: 'City of San Diego', datasetCount: 0 },
  { domain: 'data.mesaaz.gov', organization: 'City of Mesa, AZ', datasetCount: 0 },
  { domain: 'data.tucsonaz.gov', organization: 'City of Tucson, AZ', datasetCount: 0 },
  { domain: 'data.opendatasoft.com', organization: 'OpenDataSoft', datasetCount: 0 },
  { domain: 'opendata.minneapolismn.gov', organization: 'City of Minneapolis', datasetCount: 0 },
  { domain: 'data.cityoflewisville.com', organization: 'City of Lewisville, TX', datasetCount: 0 },
];

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
  private async fetchJson<T>(url: string, ctx: Context): Promise<T> {
    return withRetry(
      async () => {
        const response = await fetch(url, {
          headers: this.buildHeaders(),
          signal: ctx.signal,
        });

        if (!response.ok) {
          // Try to read structured SODA error before delegating to httpErrorFromResponse.
          const text = await response.text();
          let sodaErr: SodaError | undefined;
          try {
            const parsed = JSON.parse(text) as unknown;
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              'code' in parsed &&
              'message' in parsed
            ) {
              sodaErr = parsed as SodaError;
            }
          } catch {
            // Not JSON — fall through.
          }

          if (sodaErr) {
            // Map SODA error codes to appropriate MCP errors.
            if (response.status === 400) {
              // All 400s with a SODA body are SoQL/query errors — propagate upstream message.
              throw validationError(`SoQL error: ${sodaErr.message}`, {
                reason: 'soql_error',
                socrataCode: sodaErr.code ?? '',
              });
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
        return {
          fieldName: fieldName || dataType,
          dataType,
          ...(col.description ? { description: String(col.description) } : {}),
          ...(cachedContents.non_null != null
            ? { nonNullCount: Number(cachedContents.non_null) }
            : {}),
        };
      })
      .filter((c): c is DatasetColumn => c !== null);

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
      ...(raw.cachedContents
        ? {
            rowCount: Number(
              (raw.cachedContents as Record<string, unknown>).total_rows ??
                (raw.cachedContents as Record<string, unknown>).rows_reviewed ??
                0,
            ),
          }
        : {}),
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
    let totalCount: number | undefined;
    if (rows.length === limit) {
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

  /** Return a curated static list of well-known Socrata portals. */
  listPortals(_ctx: Context): Promise<PortalEntry[]> {
    return Promise.resolve(KNOWN_PORTALS);
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
