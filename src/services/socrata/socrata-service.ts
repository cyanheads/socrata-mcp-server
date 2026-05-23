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
            const code = sodaErr.code ?? '';
            if (
              code.includes('no-such-column') ||
              code.includes('query.soql') ||
              code.includes('query.unknown')
            ) {
              throw validationError(`SoQL error: ${sodaErr.message}`, {
                reason: 'soql_error',
                socrataCode: code,
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
      const resource = (item['resource'] ?? {}) as Record<string, unknown>;
      const classification = (item['classification'] ?? {}) as Record<string, unknown>;
      const metadata = (item['metadata'] ?? {}) as Record<string, unknown>;

      const id = String(resource['id'] ?? '');
      const domainCname = String(metadata['domain'] ?? '');

      return {
        datasetId: id,
        domain: domainCname,
        name: String(resource['name'] ?? ''),
        ...(resource['description'] ? { description: String(resource['description']) } : {}),
        ...(classification['domain_category']
          ? { category: String(classification['domain_category']) }
          : {}),
        tags: Array.isArray(classification['domain_tags'])
          ? (classification['domain_tags'] as string[])
          : [],
        columnNames: Array.isArray(resource['columns_name'])
          ? (resource['columns_name'] as string[])
          : [],
        ...(resource['license'] ? { license: String(resource['license']) } : {}),
        ...(resource['data_updated_at']
          ? { dataUpdatedAt: String(resource['data_updated_at']) }
          : {}),
        ...(typeof resource['page_views'] === 'object' &&
        resource['page_views'] !== null &&
        'page_views_total' in (resource['page_views'] as Record<string, unknown>)
          ? {
              viewCount: Number(
                (resource['page_views'] as Record<string, unknown>)['page_views_total'],
              ),
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

    const rawColumns = Array.isArray(raw['columns']) ? (raw['columns'] as unknown[]) : [];

    const columns: DatasetColumn[] = rawColumns
      .map((c): DatasetColumn | null => {
        const col = c as Record<string, unknown>;
        const fieldName = String(col['fieldName'] ?? col['name'] ?? '');
        // Filter out computed region columns (geospatial join artifacts).
        if (fieldName.startsWith(':@computed_region_')) return null;
        const cachedContents = (col['cachedContents'] ?? {}) as Record<string, unknown>;
        return {
          fieldName,
          dataType: String(col['dataTypeName'] ?? col['renderTypeName'] ?? 'text'),
          ...(col['description'] ? { description: String(col['description']) } : {}),
          ...(cachedContents['non_null'] != null
            ? { nonNullCount: Number(cachedContents['non_null']) }
            : {}),
        };
      })
      .filter((c): c is DatasetColumn => c !== null);

    return {
      datasetId,
      domain,
      name: String(raw['name'] ?? ''),
      ...(raw['description'] ? { description: String(raw['description']) } : {}),
      ...(raw['category'] ? { category: String(raw['category']) } : {}),
      tags: Array.isArray(raw['tags']) ? (raw['tags'] as string[]) : [],
      ...(raw['rowsUpdatedAt']
        ? { dataUpdatedAt: new Date(Number(raw['rowsUpdatedAt']) * 1000).toISOString() }
        : {}),
      ...(raw['license']
        ? { license: String((raw['license'] as Record<string, unknown>)['name'] ?? raw['license']) }
        : {}),
      ...(raw['cachedContents']
        ? {
            rowCount: Number(
              (raw['cachedContents'] as Record<string, unknown>)['total_rows'] ??
                (raw['cachedContents'] as Record<string, unknown>)['rows_reviewed'] ??
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
    const queryParts: string[] = [];

    if (opts.select) {
      params.set('$select', opts.select);
      queryParts.push(`$select=${opts.select}`);
    }
    if (opts.search) {
      params.set('$q', opts.search);
      queryParts.push(`$q=${opts.search}`);
    }
    if (opts.where) {
      params.set('$where', opts.where);
      queryParts.push(`$where=${opts.where}`);
    }
    if (opts.group) {
      params.set('$group', opts.group);
      queryParts.push(`$group=${opts.group}`);
    }
    if (opts.having) {
      params.set('$having', opts.having);
      queryParts.push(`$having=${opts.having}`);
    }
    if (opts.order) {
      params.set('$order', opts.order);
      queryParts.push(`$order=${opts.order}`);
    }
    params.set('$limit', String(limit));
    queryParts.push(`$limit=${limit}`);
    if (opts.offset) {
      params.set('$offset', String(opts.offset));
      queryParts.push(`$offset=${opts.offset}`);
    }

    const dataUrl = `https://${opts.domain}/resource/${opts.datasetId}.json?${params.toString()}`;
    ctx.log.debug('SoQL query', { domain: opts.domain, datasetId: opts.datasetId });

    // Fetch data rows.
    const rows = await this.fetchJson<Record<string, string>[]>(dataUrl, ctx);

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

    return {
      rows,
      rowCount: rows.length,
      ...(totalCount != null ? { totalCount } : {}),
      assembledQuery:
        queryParts.length > 0 ? queryParts.join(' ') : '(default — all columns, up to limit)',
    };
  }

  /** List all known Socrata portals from the Discovery API domains endpoint. */
  async listPortals(ctx: Context): Promise<PortalEntry[]> {
    const url = `${DISCOVERY_BASE}/domains`;
    ctx.log.debug('Listing Socrata portals');

    const raw = await this.fetchJson<{ results: unknown[] }>(url, ctx);

    return (raw.results ?? []).map((r): PortalEntry => {
      const item = r as Record<string, unknown>;
      return {
        domain: String(item['domain'] ?? ''),
        ...(item['organization'] ? { organization: String(item['organization']) } : {}),
        datasetCount: typeof item['count'] === 'number' ? item['count'] : 0,
      };
    });
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
