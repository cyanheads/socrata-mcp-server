/**
 * @fileoverview Socrata SODA API and Discovery API client.
 * Handles dataset discovery, schema inspection, SoQL query execution, and portal listing.
 * @module services/socrata/socrata-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
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

/** Host of the Discovery API — its 404s mean an unindexed `domains` filter, never a missing dataset. */
const DISCOVERY_HOST = new URL(DISCOVERY_BASE).host;

/**
 * Budget for the best-effort Discovery `?ids=` lookup on a dataset not_found.
 * One attempt, outside `withRetry` — the lookup only runs on a request that has
 * already failed (live: 0.33–0.51 s per call), so it must never add seconds.
 */
const DISCOVERY_LOOKUP_TIMEOUT_MS = 2_500;

/** A lowercase DNS hostname with at least one dot and an alphabetic (or punycode) TLD. */
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+(?:[a-z]{2,63}|xn--[a-z\d-]{1,59})$/;

/** The query coordinator's trailing `; position: Map(…)` echo on a SoQL error message. */
const SODA_POSITION_ECHO = /;\s*position: Map\([\s\S]*$/;

/** Prefix of Socrata's system computed-region columns — geospatial join artifacts. */
const COMPUTED_REGION_PREFIX = ':@computed_region_';

/** SODA `$limit` ceiling per request — the paginated canvas drain fetches pages this size. */
const SODA_PAGE_MAX = 5000;

/**
 * Curated list of well-known Socrata portals.
 * The Discovery API no longer exposes a /domains listing endpoint (returns 404),
 * so membership is static; per-portal dataset counts are fetched live from the
 * catalog endpoint and TTL-cached (see the portal-count cache below).
 *
 * Every domain is a live Discovery-catalog member — verified 2026-09-22 via
 * `?domains=<domain>&search_context=<domain>&only=dataset&limit=0` returning
 * 200 with a resultSetSize (the same scope {@link discoveryScope} builds). A
 * zero count is honest signal (the portal exposes no dataset-type assets to
 * the catalog), not a dead portal; a 404 "Domain not found" is a dead one.
 * Each entry is the host the portal serves SODA from without a redirect
 * (`data.sfgov.org` 301s to `data.sf.gov`). Re-verify with the same probe
 * before changing membership.
 */
const KNOWN_PORTALS: ReadonlyArray<Omit<PortalEntry, 'datasetCount'>> = [
  // Cities
  { domain: 'data.cityofnewyork.us', organization: 'City of New York' },
  { domain: 'data.cityofchicago.org', organization: 'City of Chicago' },
  { domain: 'data.lacity.org', organization: 'City of Los Angeles' },
  { domain: 'www.dallasopendata.com', organization: 'City of Dallas' },
  { domain: 'data.sf.gov', organization: 'City and County of San Francisco' },
  { domain: 'data.seattle.gov', organization: 'City of Seattle' },
  { domain: 'data.austintexas.gov', organization: 'City of Austin, TX' },
  { domain: 'data.oaklandca.gov', organization: 'City of Oakland' },
  { domain: 'data.nola.gov', organization: 'City of New Orleans' },
  { domain: 'data.kcmo.org', organization: 'City of Kansas City, MO' },
  { domain: 'data.cincinnati-oh.gov', organization: 'City of Cincinnati' },
  { domain: 'data.honolulu.gov', organization: 'City and County of Honolulu' },
  { domain: 'data.cambridgema.gov', organization: 'City of Cambridge, MA' },
  { domain: 'data.providenceri.gov', organization: 'City of Providence, RI' },
  { domain: 'data.brla.gov', organization: 'City of Baton Rouge, LA' },
  { domain: 'data.norfolk.gov', organization: 'City of Norfolk, VA' },
  { domain: 'data.mesaaz.gov', organization: 'City of Mesa, AZ' },
  // States
  { domain: 'data.ny.gov', organization: 'State of New York' },
  { domain: 'data.texas.gov', organization: 'State of Texas' },
  { domain: 'data.wa.gov', organization: 'State of Washington' },
  { domain: 'data.colorado.gov', organization: 'State of Colorado' },
  { domain: 'data.oregon.gov', organization: 'State of Oregon' },
  { domain: 'data.ct.gov', organization: 'State of Connecticut' },
  { domain: 'data.illinois.gov', organization: 'State of Illinois' },
  { domain: 'data.michigan.gov', organization: 'State of Michigan' },
  { domain: 'opendata.maryland.gov', organization: 'State of Maryland' },
  { domain: 'data.pa.gov', organization: 'Commonwealth of Pennsylvania' },
  { domain: 'data.nj.gov', organization: 'State of New Jersey' },
  { domain: 'data.delaware.gov', organization: 'State of Delaware' },
  { domain: 'data.vermont.gov', organization: 'State of Vermont' },
  { domain: 'data.mo.gov', organization: 'State of Missouri' },
  // Counties
  { domain: 'data.kingcounty.gov', organization: 'King County, WA' },
  { domain: 'datacatalog.cookcountyil.gov', organization: 'Cook County, IL' },
  { domain: 'data.montgomerycountymd.gov', organization: 'Montgomery County, MD' },
  { domain: 'data.sccgov.org', organization: 'County of Santa Clara, CA' },
  // Federal agencies
  { domain: 'data.cdc.gov', organization: 'Centers for Disease Control and Prevention' },
  { domain: 'data.energystar.gov', organization: 'U.S. EPA ENERGY STAR' },
  // Canada
  { domain: 'data.edmonton.ca', organization: 'City of Edmonton' },
  { domain: 'data.calgary.ca', organization: 'City of Calgary' },
];

/**
 * Discovery-catalog domain aliases. A few portals keep a public vanity domain
 * for direct SODA access (metadata + row queries by dataset ID) while their
 * catalog assets are indexed under a separate Socrata tenant with a different
 * hostname — so a Discovery `domains` filter naming the vanity domain alone
 * matches nothing. Every Discovery scope built for a domain listed here — a
 * scoped {@link SocrataService.findDatasets} search and the portal dataset
 * count — comma-joins each alias in (an OR); the caller's original domain is
 * always retained, never substituted. Portals whose catalog is federated from
 * a hub tenant need no entry: `search_context` (see {@link discoveryScope})
 * already covers them. Both hostnames still serve the SODA
 * views/resource endpoints for the same dataset ID, so get/query chaining works
 * regardless of which domain is reported back — and a not_found lookup that
 * finds the ID under an alias is not a portal mismatch.
 *
 * Seattle: `data.seattle.gov` (→ seattle.socrata.com) has zero Discovery members;
 * its datasets are cataloged under `cos-data.seattle.gov` (a distinct
 * *.cust.socrata.net tenant, not a DNS alias). Verified live 2026-07-10 against
 * api.us.socrata.com/api/catalog/v1. Extend this map as other such portals surface.
 */
const DISCOVERY_DOMAIN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'data.seattle.gov': ['cos-data.seattle.gov'],
};

/**
 * The Discovery params that scope a request to one portal. `domains` is the
 * domain itself plus any known catalog alias, comma-joined (an OR) — the
 * caller's domain always stays in the filter, never substituted.
 * `search_context` asks the catalog to answer as that portal: it adds the
 * datasets the portal federates from another tenant (a city or state data hub,
 * an internal publishing site) and reports them under the portal's own domain,
 * where SODA serves them. Without it, a portal whose catalog is federated from
 * a hub counts near zero (live 2026-09-22: data.austintexas.gov 0 → 710,
 * data.illinois.gov 0 → 297, data.mesaaz.gov 18 → 321, data.sf.gov 4 → 666).
 */
function discoveryScope(domain: string): { domains: string; search_context: string } {
  const aliases = DISCOVERY_DOMAIN_ALIASES[domain];
  return {
    domains: aliases ? [domain, ...aliases].join(',') : domain,
    search_context: domain,
  };
}

/** True when two hostnames are the same portal, directly or via a Discovery alias. */
function sameCatalogPortal(a: string, b: string): boolean {
  return (
    a === b ||
    (DISCOVERY_DOMAIN_ALIASES[a]?.includes(b) ?? false) ||
    (DISCOVERY_DOMAIN_ALIASES[b]?.includes(a) ?? false)
  );
}

/**
 * Reduce a caller-supplied portal domain to a bare lowercase hostname — the
 * form every request URL and Discovery filter is built from. Accepts the URL
 * forms a portal's address bar shows (`https://data.cdc.gov/browse?x=1`):
 * an `http`/`https` scheme, path, query, fragment, port, trailing slash, and the
 * DNS root dot (`data.cdc.gov.`) are dropped. Anything that is still not a
 * dotted hostname fails fast as
 * `invalid_domain` — a typed input error, raised before any request, so it is
 * never retried.
 */
export function normalizeDomain(domain: string): string {
  const trimmed = domain.trim();
  const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  let host: string | undefined;
  if (scheme === undefined || scheme === 'http' || scheme === 'https') {
    try {
      host = new URL(scheme ? trimmed : `https://${trimmed}`).hostname.replace(/\.$/, '');
    } catch {
      // Unparseable — rejected below.
    }
  }
  if (!host || !HOSTNAME_PATTERN.test(host)) {
    throw validationError(
      `Invalid domain ${JSON.stringify(domain)}: expected a portal hostname such as data.cityofnewyork.us.`,
      { reason: 'invalid_domain', domain },
    );
  }
  return host;
}

/** Parse a response body as JSON; undefined when it is not JSON. */
function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return;
  }
}

/** True for a JSON array whose every element is a string. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * The SODA type of each field a `/resource` response returned, from its
 * `X-SODA2-Fields` / `X-SODA2-Types` headers (JSON string arrays, index-aligned).
 * Undefined when either header is missing, is not a string array, or the two
 * differ in length — the pairing is then unknowable.
 */
function parseFieldTypes(headers: Headers): Map<string, string> | undefined {
  const fields = parseJsonBody(headers.get('X-SODA2-Fields') ?? '');
  const types = parseJsonBody(headers.get('X-SODA2-Types') ?? '');
  if (!isStringArray(fields) || !isStringArray(types) || fields.length !== types.length) return;
  return new Map(fields.map((field, i) => [field, types[i] as string]));
}

/**
 * True for an error body the SODA API itself wrote: a `message` plus `error: true`
 * (the codeless 404 some resource paths answer) or a `code`/`errorCode` key.
 * Every live Socrata error carries one of these; a gateway page, another
 * platform's JSON error, or a non-JSON body does not.
 */
function isSodaErrorBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.message === 'string' && (b.error === true || 'code' in b || 'errorCode' in b);
}

/**
 * The errno-style code on a rejected `fetch`: Bun sets it on the error itself,
 * Node's undici on `cause` (both verified live for a DNS failure).
 */
function fetchErrorCode(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return;
  const { code, cause } = err as { code?: unknown; cause?: unknown };
  if (code !== undefined) return code;
  return typeof cause === 'object' && cause !== null
    ? (cause as { code?: unknown }).code
    : undefined;
}

/**
 * What a 2xx body must be to answer the request. A body that is not is never
 * returned as data: redirected off the requested host it is `unknown_domain`;
 * from the requested host itself it fails with `sameHostReason`.
 */
interface ExpectedBody {
  /** Noun phrase for error messages, e.g. "the metadata of dataset kzjm-xkqj". */
  describe: string;
  matches: (body: unknown) => boolean;
  sameHostReason: 'not_found' | 'unknown_domain';
}

/** A SODA `/resource` answer: always a JSON array of rows. */
const ROW_ARRAY: ExpectedBody = {
  describe: 'a SODA row array',
  matches: Array.isArray,
  sameHostReason: 'unknown_domain',
};

/** A views-API answer for `datasetId`: an object whose `id` is that dataset. */
function datasetMetadata(datasetId: string): ExpectedBody {
  return {
    describe: `the metadata of dataset ${datasetId}`,
    matches: (body) =>
      typeof body === 'object' &&
      body !== null &&
      (body as Record<string, unknown>).id === datasetId,
    sameHostReason: 'not_found',
  };
}

/**
 * The human-readable upstream message from a JSON error body, whichever key
 * carries it: SODA uses `message`, Discovery uses `error` as a string.
 */
function upstreamMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return;
  const { message, error } = body as Record<string, unknown>;
  if (typeof message === 'string' && message.trim()) return message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return;
}

/**
 * Build a status-classified error for a response whose failure this service
 * recognizes. The code, `status`, and `retryAfter` come from
 * `httpErrorFromResponse` — so `withRetry` still honors an upstream
 * `Retry-After` — while the message and `data.reason` are Socrata-specific.
 * The body is never captured: the message already carries what it says, and a
 * non-Socrata host's HTML page must not reach the client.
 */
async function classifiedHttpError(
  response: Response,
  message: string,
  data: Record<string, unknown>,
): Promise<McpError> {
  const base = await httpErrorFromResponse(response, {
    service: 'Socrata',
    captureBody: false,
    data,
  });
  return new McpError(base.code, message, base.data);
}

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
  /**
   * Set to `true` once Socrata rejects the configured app token (403 invalid
   * token). While set, {@link buildHeaders} omits `X-App-Token`, so every later
   * request — and the immediate keyless retry in {@link fetchJson} — runs keyless.
   * Process-lifetime state, cleared by a restart with a corrected token. An
   * instance field (not module scope) so the singleton owns it and each
   * `new SocrataService()` in tests starts with a clean slate.
   */
  private appTokenDisabled = false;

  /** Build the default request headers, adding the app token unless it's disabled. */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    const token = getServerConfig().appToken;
    if (token && !this.appTokenDisabled) {
      headers['X-App-Token'] = token;
    }
    return headers;
  }

  /**
   * Fetch JSON from a URL with retry, timeout, and Socrata error classification.
   * The portal host's own answer decides the reason (docs/design.md, "Upstream
   * failure classification"): a hostname DNS has no address for, a 404 that is
   * not a SODA error body, a redirect off the requested host to anything but
   * `expected`, and a Discovery 404 are `unknown_domain`; a SODA 404, a gateway
   * 403 (not a SODA body), and a same-host views answer that is not the dataset
   * are `not_found`; a 429 is `rate_limited` whatever the body. `unknown_domain`
   * and `not_found` are non-transient, so they fail on the first attempt; every
   * other network error and a same-host non-JSON 2xx stay transient.
   */
  private async fetchJson<T>(url: string, ctx: Context, expected?: ExpectedBody): Promise<T> {
    return (await this.fetchJsonResponse<T>(url, ctx, expected)).body;
  }

  /**
   * {@link fetchJson}, also returning the successful response's headers — the
   * `/resource` endpoint carries each returned field's SODA type in them.
   */
  private fetchJsonResponse<T>(
    url: string,
    ctx: Context,
    expected?: ExpectedBody,
  ): Promise<{ body: T; headers: Headers }> {
    const host = new URL(url).host;
    return withRetry(
      async (attempt) => {
        // attempt.signal composes the caller's abort with withRetry's own
        // clock, so an in-flight request is interrupted rather than left to
        // run out on its own.
        let response: Response;
        try {
          response = await fetch(url, {
            headers: this.buildHeaders(),
            signal: attempt.signal,
          });
        } catch (err) {
          // ENOTFOUND is DNS saying the name does not exist — deterministic,
          // unlike EAI_AGAIN (resolver unavailable) or a reset connection. The
          // Discovery host failing to resolve means this server's own network
          // is down, so that stays transient.
          if (host !== DISCOVERY_HOST && fetchErrorCode(err) === 'ENOTFOUND') {
            throw notFound(
              `The request to ${host} failed DNS resolution (ENOTFOUND): no server answers at that hostname.`,
              { host, reason: 'unknown_domain' },
              { cause: err },
            );
          }
          throw err;
        }

        if (!response.ok) {
          // Preserve an unread copy for the framework's generic mapper. This
          // method inspects the original body for Socrata-specific errors first;
          // without a clone, generic failures lose their canonical data.body.
          const errorResponse = response.clone();
          // A structured SODA error (400 SoQL errors, 403 app-token rejection)
          // carries a code key that varies by subsystem: compiler errors use
          // `code`, query-coordinator errors use `errorCode` — accept either.
          const body = parseJsonBody(await response.text());
          const sodaErr =
            typeof body === 'object' &&
            body !== null &&
            ('code' in body || 'errorCode' in body) &&
            'message' in body
              ? (body as SodaError)
              : undefined;

          if (sodaErr) {
            // Map SODA error codes to appropriate MCP errors.
            const socrataCode = sodaErr.code ?? sodaErr.errorCode ?? '';
            if (response.status === 400) {
              // All 400s with a SODA body are SoQL/query errors. The coordinator
              // appends `; position: Map(…)` echoing the fully expanded SELECT
              // and a caret line — hundreds of characters with nothing the
              // caller needs — so the message stops before it. `data.column`
              // names the offending token when upstream supplies one.
              const column = sodaErr.data?.column;
              throw validationError(
                `SoQL error: ${sodaErr.message.replace(SODA_POSITION_ECHO, '')}`,
                {
                  reason: 'soql_error',
                  socrataCode,
                  ...(typeof column === 'string' && column ? { column } : {}),
                },
              );
            }
            if (
              response.status === 403 &&
              /app[_ ]token/i.test(sodaErr.message) &&
              getServerConfig().appToken &&
              !this.appTokenDisabled
            ) {
              // Optional-credential degradation: an invalid or revoked
              // SOCRATA_APP_TOKEN is not a hard dependency — the same request
              // succeeds keyless (the no-token default). Disable the token for the
              // rest of the process, warn once, and retry this call keyless.
              // buildHeaders() now omits X-App-Token, so the retry sends no token;
              // a later app-token 403 (flag already set, or no token configured)
              // is a genuine permissions failure and falls through to the generic
              // path below — the keyless retry can never re-enter here. A
              // private-dataset denial returns 403 without mentioning the app token
              // and also takes the generic path. Never log the token value.
              this.appTokenDisabled = true;
              ctx.log.warning(
                'SOCRATA_APP_TOKEN rejected (invalid or revoked) — falling back to keyless requests; per-IP rate limits apply. Replace or unset the token to restore higher limits.',
                { reason: 'invalid_app_token' },
              );
              return this.fetchJsonResponse<T>(url, ctx, expected);
            }
          }

          // The request URL stays out of the client-facing error data — a SODA
          // URL carries the caller's SoQL in its query string — so the host is
          // the only upstream locator surfaced.
          const detail = upstreamMessage(body);
          const sodaBody = isSodaErrorBody(body);
          if (response.status === 429) {
            throw await classifiedHttpError(
              errorResponse,
              `Socrata rate limited the request to ${host}${detail ? `: ${detail}` : '.'}`,
              { host, reason: 'rate_limited' },
            );
          }
          if (response.status === 404) {
            if (host === DISCOVERY_HOST) {
              throw await classifiedHttpError(
                errorResponse,
                `The Socrata Discovery catalog does not index the requested domain${detail ? ` (${detail})` : ''}.`,
                { host, reason: 'unknown_domain' },
              );
            }
            if (!sodaBody) {
              throw await classifiedHttpError(
                errorResponse,
                `${host} does not look like a Socrata portal: its API answered HTTP 404 without a Socrata error body.`,
                { host, reason: 'unknown_domain' },
              );
            }
            throw await classifiedHttpError(
              errorResponse,
              `Socrata returned HTTP 404 from ${host}${detail ? `: ${detail}` : '.'}`,
              { host, reason: 'not_found' },
            );
          }
          if (response.status === 403 && !sodaBody && host !== DISCOVERY_HOST) {
            // A gateway in front of the portal answered, not the SODA API
            // (live: data.cityofberkeley.info returns this for any dataset ID it
            // does not serve, and 200 for real ones). Whether the ID or the host
            // is wrong is settled by the Discovery lookup in fetchDatasetJson.
            throw notFound(
              `${host} refused the request with HTTP 403 and a gateway page instead of a Socrata error.`,
              { host, status: 403, reason: 'not_found' },
            );
          }

          throw await httpErrorFromResponse(errorResponse, {
            service: 'Socrata',
            data: { host },
          });
        }

        // `fetch` follows redirects; `response.url` is where it landed.
        const finalHost = response.url ? new URL(response.url).host : host;
        const body = parseJsonBody(await response.text());
        if (body === undefined) {
          if (finalHost !== host) {
            throw notFound(
              `${host} does not look like a Socrata portal: the request was redirected to ${finalHost}, which answered with a non-JSON page.`,
              { host, redirectedTo: finalHost, reason: 'unknown_domain' },
            );
          }
          throw serviceUnavailable(
            'Socrata API returned a non-JSON response — likely rate-limited or endpoint unavailable.',
            { host },
          );
        }
        if (expected && !expected.matches(body)) {
          if (finalHost !== host) {
            throw notFound(
              `${host} does not look like a Socrata portal: the request was redirected to ${finalHost}, which did not answer with ${expected.describe}.`,
              { host, redirectedTo: finalHost, reason: 'unknown_domain' },
            );
          }
          throw notFound(
            expected.sameHostReason === 'not_found'
              ? `${host} did not answer with ${expected.describe}.`
              : `${host} does not look like a Socrata portal: its SODA endpoint did not answer with ${expected.describe}.`,
            { host, reason: expected.sameHostReason },
          );
        }

        return { body: body as T, headers: response.headers };
      },
      {
        operation: 'SocrataService.fetchJson',
        context: ctx,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Fetch one dataset's SODA URL. A dataset ID is only meaningful on its own
   * portal, so a `not_found` is rebuilt to name the ID and the domain queried
   * (`data.domain`, `data.dataset_id`) and, when the Discovery catalog places
   * the ID on a different portal, that portal (`data.found_on_domain`). A
   * gateway 403 for an ID the catalog places on this very host is the host
   * refusing a real dataset, so it becomes `unknown_domain` instead.
   */
  private async fetchDatasetJson<T>(
    url: string,
    domain: string,
    datasetId: string,
    ctx: Context,
    expected: ExpectedBody,
  ): Promise<{ body: T; headers: Headers }> {
    try {
      return await this.fetchJsonResponse<T>(url, ctx, expected);
    } catch (err) {
      if (!(err instanceof McpError) || err.data?.reason !== 'not_found') throw err;
      const foundOn = await this.lookupDatasetDomain(datasetId, ctx);
      const refused = err.data.status === 403;
      const onThisPortal = foundOn !== undefined && sameCatalogPortal(foundOn, domain);
      if (refused && onThisPortal) {
        throw notFound(
          `${domain} refused dataset ${datasetId} with HTTP 403 and a gateway page although the Discovery catalog lists it there: the host is not serving the SODA API to this server.`,
          { ...err.data, reason: 'unknown_domain', dataset_id: datasetId },
          { cause: err },
        );
      }
      throw notFound(
        refused
          ? `Dataset ${datasetId} not found on ${domain}: the host answered HTTP 403 with a gateway page instead of a Socrata error.`
          : `Dataset ${datasetId} not found on ${domain}.`,
        {
          ...err.data,
          domain,
          dataset_id: datasetId,
          ...(foundOn && !onThisPortal ? { found_on_domain: foundOn } : {}),
        },
        { cause: err },
      );
    }
  }

  /**
   * Best-effort Discovery `?ids=` lookup of the portal that catalogs a dataset
   * ID. One attempt under its own short timeout; any failure (timeout, 429,
   * 5xx, malformed body, network) resolves `undefined` so the caller's original
   * not_found stands unchanged.
   */
  private async lookupDatasetDomain(datasetId: string, ctx: Context): Promise<string | undefined> {
    // A manual timer rather than AbortSignal.timeout: fake timers drive it in tests.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), DISCOVERY_LOOKUP_TIMEOUT_MS);
    try {
      const params = new URLSearchParams({ ids: datasetId, limit: '1' });
      const response = await fetch(`${DISCOVERY_BASE}?${params.toString()}`, {
        headers: this.buildHeaders(),
        signal: AbortSignal.any([timeout.signal, ctx.signal]),
      });
      if (!response.ok) return;
      const raw = (await response.json()) as { results?: { metadata?: { domain?: unknown } }[] };
      const domain = raw.results?.[0]?.metadata?.domain;
      return typeof domain === 'string' && domain ? domain : undefined;
    } catch (err) {
      ctx.log.debug('Discovery dataset-ID lookup failed', { datasetId, error: String(err) });
      return;
    } finally {
      clearTimeout(timer);
    }
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
    if (opts.domain) {
      for (const [key, value] of Object.entries(discoveryScope(normalizeDomain(opts.domain)))) {
        params.set(key, value);
      }
    }
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
        // `columns_field_name` holds the SoQL identifiers; `columns_name` holds
        // display labels, which SoQL rejects once they contain a space, so a
        // result without field names carries none rather than labels.
        columnNames: Array.isArray(resource.columns_field_name)
          ? (resource.columns_field_name as unknown[]).filter(
              (f): f is string =>
                typeof f === 'string' && f !== '' && !f.startsWith(COMPUTED_REGION_PREFIX),
            )
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

    const host = normalizeDomain(domain);
    const url = `https://${host}/api/views/${datasetId}.json`;
    ctx.log.debug('Fetching dataset metadata', { domain: host, datasetId });

    const { body: raw } = await this.fetchDatasetJson<Record<string, unknown>>(
      url,
      host,
      datasetId,
      ctx,
      datasetMetadata(datasetId),
    );

    const rawColumns = Array.isArray(raw.columns) ? (raw.columns as unknown[]) : [];

    const columns: DatasetColumn[] = rawColumns
      .map((c): DatasetColumn | null => {
        const col = c as Record<string, unknown>;
        const fieldName = String(col.fieldName ?? col.name ?? '');
        const dataType = String(col.dataTypeName ?? col.renderTypeName ?? 'text');
        // Filter out computed region columns (geospatial join artifacts), but keep
        // actual geo-typed columns even when their fieldName uses a system prefix.
        if (fieldName.startsWith(COMPUTED_REGION_PREFIX)) return null;
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
      domain: host,
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

  /**
   * Assemble the SoQL query-string params shared by the single-page
   * ({@link queryDataset}) and paginated ({@link streamDatasetRows}) fetch paths.
   * `$limit`/`$offset` are passed explicitly so each caller controls paging.
   */
  private buildQueryParams(
    opts: QueryDatasetOptions,
    limit: number,
    offset: number,
  ): URLSearchParams {
    const params = new URLSearchParams();
    if (opts.select) params.set('$select', opts.select);
    if (opts.search) params.set('$q', opts.search);
    if (opts.where) params.set('$where', opts.where);
    if (opts.group) params.set('$group', opts.group);
    if (opts.having) params.set('$having', opts.having);
    if (opts.order) params.set('$order', opts.order);
    params.set('$limit', String(limit));
    if (offset) params.set('$offset', String(offset));
    return params;
  }

  /** Execute a SoQL query against a dataset. */
  async queryDataset(opts: QueryDatasetOptions, ctx: Context): Promise<QueryResult> {
    if (!DATASET_ID_PATTERN.test(opts.datasetId)) {
      throw validationError(
        `Invalid dataset ID format: "${opts.datasetId}". Expected pattern like kzjm-xkqj.`,
        { reason: 'invalid_id', datasetId: opts.datasetId },
      );
    }

    const host = normalizeDomain(opts.domain);
    const limit = Math.min(opts.limit ?? 100, 5000);
    const params = this.buildQueryParams(opts, limit, opts.offset ?? 0);

    const dataUrl = `https://${host}/resource/${opts.datasetId}.json?${params.toString()}`;
    ctx.log.debug('SoQL query', { domain: host, datasetId: opts.datasetId });

    // Fetch data rows.
    const { body: rows, headers } = await this.fetchDatasetJson<Record<string, unknown>[]>(
      dataUrl,
      host,
      opts.datasetId,
      ctx,
      ROW_ARRAY,
    );

    // Fetch total count separately when result is at the limit (may be truncated).
    // Skipped for grouped queries: the recount carries only where/search, so it
    // would count matching source rows, not result groups — a misleading number.
    let totalCount: number | undefined;
    if (rows.length === limit && !opts.group) {
      const countParams = new URLSearchParams();
      countParams.set('$select', 'count(*)');
      if (opts.where) countParams.set('$where', opts.where);
      if (opts.search) countParams.set('$q', opts.search);
      const countUrl = `https://${host}/resource/${opts.datasetId}.json?${countParams.toString()}`;

      try {
        const countResult = await this.fetchJson<[{ count: string }]>(countUrl, ctx, ROW_ARRAY);
        const total = parseInt(countResult[0]?.count ?? '0', 10);
        if (total > rows.length) totalCount = total;
      } catch {
        // Count fetch is best-effort — don't fail the query if it errors.
      }
    }

    // Echo exactly what was sent — `$offset` rides along only when non-zero,
    // as in the request. A bare `$limit` is the default query.
    const sent = [...params.entries()];
    const fieldTypes = parseFieldTypes(headers);

    return {
      rows,
      rowCount: rows.length,
      domain: host,
      ...(totalCount != null ? { totalCount } : {}),
      assembledQuery: sent.some(([k]) => k !== '$limit')
        ? sent.map(([k, v]) => `${k}=${v}`).join(' ')
        : '(default — all columns, up to limit)',
      ...(fieldTypes ? { fieldTypes } : {}),
    };
  }

  /**
   * Stream a dataset's matching rows across paginated SODA calls, bounded by a
   * hard `maxRows` safety cap. Walks `$offset` in pages of {@link SODA_PAGE_MAX}
   * until the upstream is exhausted (a short page) or the cap is reached.
   *
   * Distinct from {@link queryDataset}, whose single call bounds the inline
   * response by the caller's `limit`: this drains the wider matching set (up to
   * the cap) so a bounded copy can be staged onto a DataCanvas for SQL — the
   * canvas is a bounded subset, never literally the full result set when the
   * match exceeds the cap.
   */
  async *streamDatasetRows(
    opts: QueryDatasetOptions,
    maxRows: number,
    ctx: Context,
  ): AsyncGenerator<Record<string, unknown>> {
    if (!DATASET_ID_PATTERN.test(opts.datasetId)) {
      throw validationError(
        `Invalid dataset ID format: "${opts.datasetId}". Expected pattern like kzjm-xkqj.`,
        { reason: 'invalid_id', datasetId: opts.datasetId },
      );
    }

    const host = normalizeDomain(opts.domain);
    let offset = opts.offset ?? 0;
    let yielded = 0;
    while (yielded < maxRows) {
      const pageLimit = Math.min(SODA_PAGE_MAX, maxRows - yielded);
      const params = this.buildQueryParams(opts, pageLimit, offset);
      const url = `https://${host}/resource/${opts.datasetId}.json?${params.toString()}`;
      ctx.log.debug('SoQL spill page', {
        domain: host,
        datasetId: opts.datasetId,
        offset,
        pageLimit,
      });

      const page = await this.fetchJson<Record<string, unknown>[]>(url, ctx, ROW_ARRAY);
      for (const row of page) yield row;
      yielded += page.length;

      // A short page means the upstream is exhausted — stop before an empty fetch.
      if (page.length < pageLimit) break;
      offset += page.length;
    }
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

  /**
   * Count dataset-type assets on one portal via the Discovery catalog, in the
   * same portal scope a domain-scoped {@link findDatasets} search uses, so the
   * two agree.
   */
  private async fetchPortalDatasetCount(domain: string, ctx: Context): Promise<number> {
    const params = new URLSearchParams({ ...discoveryScope(domain), only: 'dataset', limit: '0' });
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
