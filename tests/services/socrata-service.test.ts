/**
 * @fileoverview Tests for the SocrataService fetch layer — SODA error-shape
 * detection in fetchJson (both `code` and `errorCode` families, app-token 403
 * discrimination), the keyless degradation + retry on an invalid app token, the
 * Discovery portal scope in findDatasets (alias join + search_context), the
 * bounded `$query` recount in queryDataset, the TTL-cached per-portal dataset
 * counts in listPortals (same scope), row-count derivation from column-level
 * cachedContents in getDataset, status-based 404/429 classification with Retry-After honoring,
 * the not_found cross-portal Discovery lookup, domain normalization, and hosts
 * that do not serve the SODA API (DNS ENOTFOUND, gateway 403s, redirects to a
 * body that is not the dataset or row array requested) against the retry boundary.
 * Stubs `globalThis.fetch` so the real classification and retry paths execute.
 * @module tests/services/socrata-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { portalsResource } from '@/mcp-server/resources/definitions/portals.resource.js';
import { listPortals } from '@/mcp-server/tools/definitions/list-portals.tool.js';
import {
  normalizeDomain,
  resetPortalCountCache,
  SocrataService,
} from '@/services/socrata/socrata-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(),
}));

import { getServerConfig } from '@/config/server-config.js';

const mockGetServerConfig = getServerConfig as ReturnType<typeof vi.fn>;

/** Build a JSON Response with the given status. */
function jsonResponse(
  body: unknown,
  status: number,
  statusText: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** An HTML page like the ones non-Socrata hosts answer with. */
const HTML_PAGE =
  '<!DOCTYPE html>\n<html lang="en"><head><title>Page</title></head><body>x</body></html>';

/** Build an HTML Response with the given status. */
function htmlResponse(status: number, statusText: string, headers: Record<string, string> = {}) {
  return new Response(HTML_PAGE, {
    status,
    statusText,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  });
}

/**
 * A Response as `fetch` returns it after following redirects to `finalUrl`.
 * The constructor cannot set `url`/`redirected`, so they are defined on the
 * real Response instance.
 */
function redirectedResponse(res: Response, finalUrl: string): Response {
  Object.defineProperty(res, 'url', { value: finalUrl });
  Object.defineProperty(res, 'redirected', { value: true });
  return res;
}

/** Origin of a recorded fetch input — compared exactly, never by prefix. */
const originOf = (input: unknown) => new URL(String(input)).origin;

const DISCOVERY_ORIGIN = 'https://api.us.socrata.com';

/** A Discovery `?ids=` response naming the portal that holds a dataset. */
function discoveryIdsResponse(domain?: string, id = 'erm2-nwe9'): Response {
  return jsonResponse(
    {
      results: domain ? [{ resource: { id, name: 'X' }, metadata: { domain } }] : [],
      resultSetSize: domain ? 1 : 0,
    },
    200,
    'OK',
  );
}

/** Capture the rejection of a promise as an McpError. */
async function rejectionOf(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof McpError) return err;
    throw new Error(`Expected an McpError, got ${String(err)}`);
  }
  throw new Error('Expected the promise to reject.');
}

describe('SocrataService.fetchJson error classification', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('characterizes generic row permission failures without probing Discovery', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          { code: 'permission_denied', error: true, message: 'Permission denied' },
          403,
          'Forbidden',
        ),
      ),
    );
    const err = await rejectionOf(
      svc.queryDataset(
        { domain: 'data.cityofnewyork.us', datasetId: 'smk3-tmxj' },
        createMockContext(),
      ),
    );
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.data?.reason).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('classifies the non-tabular HTTP 403 marker without a retry (#42)', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          { error: true, message: 'no row or column access to non-tabular tables' },
          403,
          'Forbidden',
        ),
      ),
    );
    const err = await rejectionOf(
      svc.queryDataset(
        { domain: 'data.cityofnewyork.us', datasetId: 'smk3-tmxj' },
        createMockContext(),
      ),
    );
    expect(err.data).toMatchObject({ reason: 'not_tabular', status: 403 });
    expect(err.message).toContain('no queryable rows');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('maps a 400 query-coordinator body (errorCode key) to soql_error with the upstream message', async () => {
    // Real upstream shape from data.cityofchicago.org — this family uses `errorCode`.
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          message:
            'Query coordinator error: query.soql.no-such-column; No such column: no_such_column',
          errorCode: 'query.soql.no-such-column',
          data: { column: 'no_such_column' },
        },
        400,
        'Bad Request',
      ),
    );

    const ctx = createMockContext();
    await expect(
      svc.queryDataset(
        { domain: 'data.cityofchicago.org', datasetId: 'ijzp-q8t2', where: 'no_such_column = 1' },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('No such column: no_such_column'),
      data: { reason: 'soql_error', socrataCode: 'query.soql.no-such-column' },
    });
  });

  it('maps a 400 compiler body (code key) to soql_error with the upstream message', async () => {
    // Real upstream shape — the SoQL compiler family uses `code`.
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          code: 'query.compiler.malformed',
          error: true,
          message: 'Could not parse SoQL query "select * where INVALID SOQL"',
          data: {},
        },
        400,
        'Bad Request',
      ),
    );

    const ctx = createMockContext();
    await expect(
      svc.queryDataset(
        { domain: 'data.cityofchicago.org', datasetId: 'ijzp-q8t2', where: 'INVALID SOQL' },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('Could not parse SoQL query'),
      data: { reason: 'soql_error', socrataCode: 'query.compiler.malformed' },
    });
  });

  it('keeps the generic Forbidden path for a 403 permission_denied that does not mention the app token', async () => {
    const body = {
      code: 'permission_denied',
      error: true,
      message: 'You do not have permission to view this dataset',
    };
    fetchSpy.mockResolvedValue(jsonResponse(body, 403, 'Forbidden'));

    const ctx = createMockContext();
    let thrown: McpError | undefined;
    try {
      await svc.getDataset('data.cityofchicago.org', 'ijzp-q8t2', ctx);
    } catch (err) {
      thrown = err as McpError;
    }

    if (!(thrown instanceof McpError)) throw new Error('Expected an McpError.');
    expect(thrown.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(thrown.data).toMatchObject({
      status: 403,
      body: JSON.stringify(body),
    });
    expect((thrown.data as Record<string, unknown>).reason).toBeUndefined();
  });
});

describe('SocrataService.fetchJson keyless degradation on invalid app token (#23)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const sentinelToken = 'secret-sentinel-token-abc123';

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({
      appToken: sentinelToken,
      defaultDomain: 'data.seattle.gov',
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  /** Read the X-App-Token header off a recorded fetch call. */
  function tokenHeaderOf(call: unknown[]): string | undefined {
    const headers = (call[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    return headers?.['X-App-Token'];
  }

  const invalidTokenResponse = () =>
    jsonResponse(
      { code: 'permission_denied', error: true, message: 'Invalid app_token specified' },
      403,
      'Forbidden',
    );

  it('degrades to keyless and retries when the configured token is rejected — the call succeeds', async () => {
    // Fresh instance so appTokenDisabled starts false.
    const svc = new SocrataService();
    // First (tokened) attempt is rejected; the keyless retry succeeds.
    fetchSpy
      .mockResolvedValueOnce(invalidTokenResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          { id: 'kzjm-xkqj', name: 'Seattle Real Time Fire 911 Calls', columns: [] },
          200,
          'OK',
        ),
      );

    const ctx = createMockContext();
    const warnSpy = vi.spyOn(ctx.log, 'warning');

    // Before the fix this rejected with a configurationError; now it resolves keyless.
    const meta = await svc.getDataset('data.seattle.gov', 'kzjm-xkqj', ctx);
    expect(meta.datasetId).toBe('kzjm-xkqj');

    // Two fetches: the rejected tokened attempt, then the keyless retry.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(tokenHeaderOf(fetchSpy.mock.calls[0] ?? [])).toBe(sentinelToken);
    expect(tokenHeaderOf(fetchSpy.mock.calls[1] ?? [])).toBeUndefined();

    // Exactly one WARN, and it never carries the token value.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(sentinelToken);
  });

  it('warns once and stays keyless across later calls after the token is disabled', async () => {
    const svc = new SocrataService();
    // Any tokened attempt is rejected; any keyless attempt succeeds.
    fetchSpy.mockImplementation((_url, init) => {
      const headers = (init as RequestInit | undefined)?.headers as
        | Record<string, string>
        | undefined;
      return Promise.resolve(
        headers?.['X-App-Token']
          ? invalidTokenResponse()
          : jsonResponse({ id: 'kzjm-xkqj', name: 'X', columns: [] }, 200, 'OK'),
      );
    });

    const ctx = createMockContext();
    const warnSpy = vi.spyOn(ctx.log, 'warning');

    await svc.getDataset('data.seattle.gov', 'kzjm-xkqj', ctx);
    await svc.getDataset('data.seattle.gov', 'kzjm-xkqj', ctx);
    await svc.getDataset('data.seattle.gov', 'kzjm-xkqj', ctx);

    // First call disables the token (one 403 + one keyless retry); every later
    // request skips the token outright, so no further 403 and no second warning.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const tokenedCalls = fetchSpy.mock.calls.filter((c) => tokenHeaderOf(c) !== undefined);
    expect(tokenedCalls).toHaveLength(1);
  });

  it('leaves a keyless request (no configured token) on the generic Forbidden path', async () => {
    // No token configured: an app-token 403 is a genuine permissions failure, not
    // a degradable optional credential — it must surface, not silently retry.
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    const svc = new SocrataService();
    fetchSpy.mockResolvedValue(invalidTokenResponse());

    const ctx = createMockContext();
    const warnSpy = vi.spyOn(ctx.log, 'warning');

    await expect(svc.getDataset('data.seattle.gov', 'kzjm-xkqj', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
    });
    // No token to degrade → no retry, no degradation warning.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('SocrataService.findDatasets Discovery domain alias expansion (#21)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  /** The `domains` query param on the recorded Discovery request. */
  function domainsParam(): string | null {
    return new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.get('domains');
  }

  it('comma-joins the known alias so a Seattle-scoped search covers both tenants', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ results: [], resultSetSize: 0 }, 200, 'OK'));

    const ctx = createMockContext();
    await svc.findDatasets({ domain: 'data.seattle.gov', query: 'fire' }, ctx);

    // Before the fix this was just 'data.seattle.gov' (zero Discovery members);
    // the alias join is what surfaces cos-data.seattle.gov's datasets.
    expect(domainsParam()).toBe('data.seattle.gov,cos-data.seattle.gov');
  });

  it('passes a domain with no known alias through unchanged', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ results: [], resultSetSize: 0 }, 200, 'OK'));

    const ctx = createMockContext();
    await svc.findDatasets({ domain: 'data.cityofchicago.org' }, ctx);

    expect(domainsParam()).toBe('data.cityofchicago.org');
  });

  it('omits the domains filter entirely for an unscoped search', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ results: [], resultSetSize: 0 }, 200, 'OK'));

    const ctx = createMockContext();
    await svc.findDatasets({ query: 'fire' }, ctx);

    expect(domainsParam()).toBeNull();
    expect(
      new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.get('search_context'),
    ).toBeNull();
  });

  it.each(['data.austintexas.gov', 'data.illinois.gov', 'data.mesaaz.gov', 'data.sf.gov'])(
    'sets search_context so a scoped search covers what %s federates (#36)',
    async (domain) => {
      // Live 2026-09-22: `domains=<domain>&only=dataset` alone answers 0 (Austin,
      // Illinois), 18 (Mesa), 4 (SF); adding `search_context=<domain>` answers
      // 710, 297, 321, 666 — the datasets each portal federates from its data-hub
      // tenant, reported under the portal's own domain.
      fetchSpy.mockResolvedValue(jsonResponse({ results: [], resultSetSize: 0 }, 200, 'OK'));

      await svc.findDatasets({ domain, query: 'permits' }, createMockContext());

      const params = new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams;
      expect(params.get('search_context')).toBe(domain);
      // The domains filter itself is unchanged for an unaliased portal.
      expect(params.get('domains')).toBe(domain);
    },
  );

  it('sets search_context to the caller domain, not an alias, on an aliased portal', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ results: [], resultSetSize: 0 }, 200, 'OK'));

    await svc.findDatasets({ domain: 'https://DATA.SEATTLE.GOV/' }, createMockContext());

    const params = new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams;
    expect(params.get('domains')).toBe('data.seattle.gov,cos-data.seattle.gov');
    expect(params.get('search_context')).toBe('data.seattle.gov');
  });

  it('surfaces results Discovery reports under the alias domain', async () => {
    // The wanted dataset is indexed under cos-data.seattle.gov even though the
    // caller scoped to data.seattle.gov — the alias join is what returns it.
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          results: [
            {
              resource: { id: 'kzjm-xkqj', name: 'Seattle Real Time Fire 911 Calls' },
              metadata: { domain: 'cos-data.seattle.gov' },
              classification: {},
            },
          ],
          resultSetSize: 1,
        },
        200,
        'OK',
      ),
    );

    const ctx = createMockContext();
    const { results, totalCount } = await svc.findDatasets(
      { domain: 'data.seattle.gov', query: 'fire' },
      ctx,
    );

    expect(totalCount).toBe(1);
    expect(results[0]?.datasetId).toBe('kzjm-xkqj');
    expect(results[0]?.domain).toBe('cos-data.seattle.gov');
  });
});

describe('SocrataService.queryDataset recount of the query as written (#50, #52)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const atLimitRows = Array.from({ length: 5 }, (_, i) => ({
    primary_type: `TYPE_${i}`,
    n: String(1000 - i),
  }));

  const ok = (body: unknown) => jsonResponse(body, 200, 'OK');

  /** The query-string params of the `index`th request the call sent. */
  const sentParams = (index: number) =>
    new URL(String(fetchSpy.mock.calls[index]?.[0])).searchParams;

  const NYC = { domain: 'data.cityofnewyork.us', datasetId: '43nn-pn8j' };

  it.each([
    [
      'a distinct select',
      { select: 'distinct boro' },
      'SELECT distinct boro |> SELECT count(*) AS n',
    ],
    [
      'an ungrouped aggregate',
      { select: 'count(*) as n' },
      'SELECT count(*) as n |> SELECT count(*) AS n',
    ],
    [
      'a grouped query with where, having, and order',
      {
        select: 'boro, count(*) AS n',
        where: "grade='A'",
        group: 'boro',
        having: 'n > 1000',
        order: 'n DESC',
      },
      "SELECT boro, count(*) AS n WHERE grade='A' GROUP BY boro HAVING n > 1000 |> SELECT count(*) AS n",
    ],
    [
      'a plain row query, select omitted',
      { where: "boro='Manhattan'", order: 'camis' },
      "SELECT * WHERE boro='Manhattan' |> SELECT count(*) AS n",
    ],
    [
      'a search, its apostrophe doubled',
      { search: "mcdonald's", where: "boro='Queens'" },
      "SELECT * WHERE boro='Queens' SEARCH 'mcdonald''s' |> SELECT count(*) AS n",
    ],
  ])(
    'recounts %s through one $query pipe, without $q, $order, $limit, or $offset',
    async (_l, clauses, query) => {
      fetchSpy.mockResolvedValueOnce(ok(atLimitRows)).mockResolvedValueOnce(ok([{ n: '6' }]));

      const result = await svc.queryDataset(
        { ...NYC, ...clauses, limit: 5, offset: 10 },
        createMockContext(),
      );

      expect(result.totalCount).toBe(6);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(new URL(String(fetchSpy.mock.calls[1]?.[0])).pathname).toBe(
        '/resource/43nn-pn8j.json',
      );
      expect([...sentParams(1).keys()]).toEqual(['$query']);
      expect(sentParams(1).get('$query')).toBe(query);
    },
  );

  it('returns the count even when it equals the rows returned (#50 repro 2)', async () => {
    fetchSpy.mockResolvedValueOnce(ok([{ n: '294578' }])).mockResolvedValueOnce(ok([{ n: '1' }]));

    const result = await svc.queryDataset(
      { ...NYC, select: 'count(*) as n', limit: 1 },
      createMockContext(),
    );

    expect(result).toMatchObject({ rowCount: 1, totalCount: 1 });
  });

  it('recounts an empty page past offset 0 (#52)', async () => {
    fetchSpy.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok([{ n: '108992' }]));

    const result = await svc.queryDataset(
      { ...NYC, where: "boro='Manhattan'", limit: 2, offset: 999_999 },
      createMockContext(),
    );

    expect(result).toMatchObject({ rowCount: 0, totalCount: 108_992 });
    expect(sentParams(1).get('$query')).toBe(
      "SELECT * WHERE boro='Manhattan' |> SELECT count(*) AS n",
    );
  });

  it('reports a zero count on an empty page past offset 0', async () => {
    fetchSpy.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok([{ n: '0' }]));

    const result = await svc.queryDataset(
      { ...NYC, where: "boro='Atlantis'", limit: 2, offset: 10 },
      createMockContext(),
    );

    expect(result).toMatchObject({ rowCount: 0, totalCount: 0 });
  });

  it.each([
    ['an empty page at offset 0', [], { where: "boro='Atlantis'", limit: 2 }],
    ['a page under the limit', [{ boro: 'Bronx' }], { limit: 2, offset: 4 }],
  ])('sends no recount for %s', async (_l, rows, clauses) => {
    fetchSpy.mockResolvedValue(ok(rows));

    const result = await svc.queryDataset({ ...NYC, ...clauses }, createMockContext());

    expect(result.totalCount).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('omits the count when the recount answers without a numeric n', async () => {
    fetchSpy.mockResolvedValueOnce(ok(atLimitRows)).mockResolvedValueOnce(ok([]));

    const result = await svc.queryDataset({ ...NYC, limit: 5 }, createMockContext());

    expect(result.rowCount).toBe(5);
    expect(result.totalCount).toBeUndefined();
  });

  describe('bounds: one attempt, min(15 s, the call deadline), cancellation kept', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('makes one recount attempt on a 503 and returns the query without a count', async () => {
      fetchSpy
        .mockResolvedValueOnce(ok(atLimitRows))
        .mockImplementation(() =>
          Promise.resolve(new Response('busy', { status: 503, statusText: 'Busy' })),
        );

      const { state, outcome } = track(svc.queryDataset({ ...NYC, limit: 5 }, createMockContext()));
      await vi.advanceTimersByTimeAsync(0);

      expect(state.settled).toBe(true);
      const { value } = await outcome;
      expect(value).toMatchObject({ rowCount: 5 });
      expect(value).not.toHaveProperty('totalCount');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('repeats a recount whose app token is refused once, keyless, with no retries', async () => {
      mockGetServerConfig.mockReturnValue({
        appToken: 'sentinel-token',
        defaultDomain: 'data.seattle.gov',
      });
      // A fresh instance, so the token starts enabled.
      const tokened = new SocrataService();
      fetchSpy
        .mockResolvedValueOnce(ok(atLimitRows))
        .mockResolvedValueOnce(
          jsonResponse(
            { code: 'permission_denied', error: true, message: 'Invalid app_token specified' },
            403,
            'Forbidden',
          ),
        )
        .mockImplementation(() =>
          Promise.resolve(new Response('busy', { status: 503, statusText: 'Busy' })),
        );

      const { state, outcome } = track(
        tokened.queryDataset({ ...NYC, limit: 5 }, createMockContext()),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(state.settled).toBe(true);
      const { value } = await outcome;
      expect(value).toMatchObject({ rowCount: 5 });
      expect(value).not.toHaveProperty('totalCount');
      await vi.advanceTimersByTimeAsync(30_000);
      // The page, the refused recount, and its one keyless repeat.
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      const keyless = fetchSpy.mock.calls[2]?.[1] as RequestInit | undefined;
      expect(keyless?.headers).not.toHaveProperty('X-App-Token');
      expect(sentParams(2).has('$query')).toBe(true);
    });

    it('cuts a hung recount at 15 s and returns the query without a count', async () => {
      fetchSpy.mockResolvedValueOnce(ok(atLimitRows)).mockImplementation(hangUntilAborted);

      const { state, outcome } = track(svc.queryDataset({ ...NYC, limit: 5 }, createMockContext()));
      await vi.advanceTimersByTimeAsync(14_999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(state.settled).toBe(true);
      const { value } = await outcome;
      expect(value).toMatchObject({ rowCount: 5 });
      expect(value).not.toHaveProperty('totalCount');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('cuts the recount at what is left of the call deadline when that is under 15 s', async () => {
      // The page takes 40 s, leaving the recount 10 s.
      fetchSpy
        .mockImplementationOnce(answerAfter(40_000, () => ok(atLimitRows)))
        .mockImplementation(hangUntilAborted);

      const { state, outcome } = track(svc.queryDataset({ ...NYC, limit: 5 }, createMockContext()));
      await vi.advanceTimersByTimeAsync(49_999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(state.settled).toBe(true);
      const { value } = await outcome;
      expect(value).toMatchObject({ rowCount: 5 });
      expect(value).not.toHaveProperty('totalCount');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('fails as cancelled when the caller aborts during the recount', async () => {
      const controller = new AbortController();
      const cancellation = new DOMException('Caller cancelled the recount', 'AbortError');
      fetchSpy.mockResolvedValueOnce(ok(atLimitRows)).mockImplementation((input, init) => {
        controller.abort(cancellation);
        return hangUntilAborted(input, init);
      });

      const { outcome } = track(
        svc.queryDataset({ ...NYC, limit: 5 }, createMockContext({ signal: controller.signal })),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect((await outcome).error).toBe(cancellation);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});

describe('SocrataService.queryDataset assembledQuery paging (#24)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    // One row under a limit of 2 — no recount request, so every call is the data page.
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse([{ id: '28545', primary_type: 'THEFT', year: '2025' }], 200, 'OK'),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const repro = {
    domain: 'data.cityofchicago.org',
    datasetId: 'ijzp-q8t2',
    select: 'id,primary_type,year',
    where: 'year=2025',
    order: 'id ASC',
    limit: 2,
  };

  /** The outbound data-page URL, decoded for readable assertions. */
  const dataUrl = () =>
    decodeURIComponent(String(fetchSpy.mock.calls[0]?.[0])).replaceAll('+', ' ');

  it('ends with $limit and $offset when offset > 0', async () => {
    const result = await svc.queryDataset({ ...repro, offset: 2 }, createMockContext());

    expect(result.assembledQuery).toBe(
      '$select=id,primary_type,year $where=year=2025 $order=id ASC $limit=2 $offset=2',
    );
    expect(dataUrl()).toContain('$offset=2');
  });

  it('omits $offset when offset is 0 or omitted — never $offset=0', async () => {
    const zero = await svc.queryDataset({ ...repro, offset: 0 }, createMockContext());
    const omitted = await svc.queryDataset(repro, createMockContext());

    for (const result of [zero, omitted]) {
      expect(result.assembledQuery).toBe(
        '$select=id,primary_type,year $where=year=2025 $order=id ASC $limit=2',
      );
    }
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain('offset');
    }
  });

  it('reports $limit and $offset rather than the default placeholder when offset is the only clause', async () => {
    const result = await svc.queryDataset(
      { domain: 'data.cityofchicago.org', datasetId: 'ijzp-q8t2', limit: 2, offset: 4 },
      createMockContext(),
    );

    expect(result.assembledQuery).toBe('$limit=2 $offset=4');
  });

  it('keeps the default placeholder when no clause and no offset is sent (regression)', async () => {
    const result = await svc.queryDataset(
      { domain: 'data.cityofchicago.org', datasetId: 'ijzp-q8t2', limit: 2 },
      createMockContext(),
    );

    expect(result.assembledQuery).toBe('(default — all columns, up to limit)');
  });

  it('carries $offset alongside $group/$having on a grouped query; the recount sends none', async () => {
    const result = await svc.queryDataset(
      {
        domain: 'data.cityofchicago.org',
        datasetId: 'ijzp-q8t2',
        select: 'primary_type, count(*) as n',
        group: 'primary_type',
        having: 'count(*) > 10',
        order: 'n DESC',
        limit: 1,
        offset: 5,
      },
      createMockContext(),
    );

    expect(result.assembledQuery).toBe(
      '$select=primary_type, count(*) as n $group=primary_type $having=count(*) > 10 $order=n DESC $limit=1 $offset=5',
    );
    expect(dataUrl()).toContain('$offset=5');
    // The page filled limit 1, so the group count follows: one $query, no paging params.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect([...new URL(String(fetchSpy.mock.calls[1]?.[0])).searchParams.keys()]).toEqual([
      '$query',
    ]);
  });
});

describe('SocrataService.queryDataset SODA field types (#25)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const rows = [{ id: '1', primary_type: 'HOMICIDE', year: '2025' }];
  const query = () =>
    svc.queryDataset(
      { domain: 'data.cityofchicago.org', datasetId: 'ijzp-q8t2', limit: 10 },
      createMockContext(),
    );

  it('maps each X-SODA2-Fields name to its X-SODA2-Types type, aliases and aggregates included', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(rows, 200, 'OK', {
        'X-SODA2-Fields': '["id","primary_type","year","date","arrest","n"]',
        'X-SODA2-Types': '["number","text","number","floating_timestamp","boolean","number"]',
      }),
    );

    const result = await query();

    expect(result.fieldTypes).toEqual(
      new Map([
        ['id', 'number'],
        ['primary_type', 'text'],
        ['year', 'number'],
        ['date', 'floating_timestamp'],
        ['arrest', 'boolean'],
        ['n', 'number'],
      ]),
    );
  });

  it('leaves fieldTypes unset when X-SODA2-Types is missing', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(rows, 200, 'OK', { 'X-SODA2-Fields': '["id","primary_type","year"]' }),
    );

    const result = await query();

    expect(result.fieldTypes).toBeUndefined();
    expect(result.rows).toEqual(rows);
  });

  it('leaves fieldTypes unset when the field and type counts differ', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(rows, 200, 'OK', {
        'X-SODA2-Fields': '["id","primary_type","year"]',
        'X-SODA2-Types': '["number","text"]',
      }),
    );

    expect((await query()).fieldTypes).toBeUndefined();
  });

  it('leaves fieldTypes unset when a header is not a JSON string array', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(rows, 200, 'OK', {
        'X-SODA2-Fields': 'id,primary_type,year',
        'X-SODA2-Types': '["number","text","number"]',
      }),
    );

    expect((await query()).fieldTypes).toBeUndefined();
  });
});

describe('SocrataService.listPortals portal-count cache', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  /**
   * Counts keyed by the exact Discovery `domains` param. Chicago observed live
   * (2026-07-04); Seattle's alias join observed live (2026-09-22) with
   * `only=dataset&limit=0` — `data.seattle.gov` alone answers 0. The zero count
   * sits on a domain with no alias entry, so the 0-vs-null distinction is
   * exercised without depending on the alias map.
   */
  const liveCounts: Record<string, number> = {
    'data.cityofchicago.org': 909,
    'data.seattle.gov': 0,
    'data.seattle.gov,cos-data.seattle.gov': 147,
    'data.energystar.gov': 0,
  };

  const countResponder = (input: unknown): Promise<Response> => {
    const domain = new URL(String(input)).searchParams.get('domains') ?? '';
    return Promise.resolve(
      jsonResponse(
        { results: [], resultSetSize: liveCounts[domain] ?? 42, timings: {}, warnings: [] },
        200,
        'OK',
      ),
    );
  };

  beforeEach(() => {
    resetPortalCountCache();
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    resetPortalCountCache();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('fetches one dataset-only count per domain and maps real values through', async () => {
    fetchSpy.mockImplementation(countResponder);

    const ctx = createMockContext();
    const portals = await svc.listPortals(ctx);

    expect(portals).toHaveLength(39);
    expect(fetchSpy).toHaveBeenCalledTimes(39);
    // Count query is scoped to dataset-type assets, count-only.
    for (const call of fetchSpy.mock.calls) {
      const url = String(call[0]);
      expect(url).toContain('only=dataset');
      expect(url).toContain('limit=0');
    }
    const chicago = portals.find((p) => p.domain === 'data.cityofchicago.org');
    expect(chicago?.datasetCount).toBe(909);
    // data.iowa.gov left Socrata: Discovery answers "Domain not found" and its
    // views endpoint is an HTML 404 — it is no longer a curated member.
    expect(portals.map((p) => p.domain)).not.toContain('data.iowa.gov');
  });

  it('states the curated portal count in the list_portals tool and portals resource descriptions', async () => {
    fetchSpy.mockImplementation(countResponder);

    const { length } = await svc.listPortals(createMockContext());

    for (const description of [listPortals.description, portalsResource.description]) {
      expect(description).toContain(`curated list of ${length} well-known portals`);
    }
  });

  it('preserves a genuine zero count on an unaliased domain — 0 is real data, not missing', async () => {
    fetchSpy.mockImplementation(countResponder);

    const ctx = createMockContext();
    const portals = await svc.listPortals(ctx);

    const energystar = portals.find((p) => p.domain === 'data.energystar.gov');
    expect(energystar?.datasetCount).toBe(0);
    expect(energystar?.datasetCount).not.toBeNull();
  });

  it('counts an aliased portal across its catalog tenants (#32)', async () => {
    fetchSpy.mockImplementation(countResponder);

    const portals = await svc.listPortals(createMockContext());

    const domainsParams = fetchSpy.mock.calls.map((c) =>
      new URL(String(c[0])).searchParams.get('domains'),
    );
    // Same alias join findDatasets applies; unaliased domains pass through unchanged.
    expect(domainsParams).toContain('data.seattle.gov,cos-data.seattle.gov');
    expect(domainsParams).not.toContain('data.seattle.gov');
    expect(domainsParams).toContain('data.cityofchicago.org');
    expect(portals.find((p) => p.domain === 'data.seattle.gov')?.datasetCount).toBe(147);
  });

  it('counts each portal in its own search_context so federated catalogs are included (#36)', async () => {
    /**
     * Live 2026-09-22 `only=dataset&limit=0` counts: without `search_context`
     * these portals answer 0 / 0 / 18 / 4; with it, 710 / 297 / 321 / 666.
     */
    const federated: Record<string, number> = {
      'data.austintexas.gov': 710,
      'data.illinois.gov': 297,
      'data.mesaaz.gov': 321,
      'data.sf.gov': 666,
    };
    fetchSpy.mockImplementation((input) => {
      const params = new URL(String(input)).searchParams;
      const domain = params.get('domains') ?? '';
      const count = params.get('search_context') === domain ? (federated[domain] ?? 42) : 0;
      return Promise.resolve(jsonResponse({ results: [], resultSetSize: count }, 200, 'OK'));
    });

    const portals = await svc.listPortals(createMockContext());

    for (const [domain, count] of Object.entries(federated)) {
      expect(portals.find((p) => p.domain === domain)?.datasetCount).toBe(count);
    }
    // Every count request is scoped to the portal's own domain as search context.
    for (const call of fetchSpy.mock.calls) {
      const params = new URL(String(call[0])).searchParams;
      expect(params.get('search_context')).toBe(params.get('domains')?.split(',')[0]);
    }
  });

  it('lists San Francisco under data.sf.gov, the host data.sfgov.org redirects to (#36)', async () => {
    fetchSpy.mockImplementation(countResponder);

    const domains = (await svc.listPortals(createMockContext())).map((p) => p.domain);

    expect(domains).toContain('data.sf.gov');
    expect(domains).not.toContain('data.sfgov.org');
  });

  it('serves the second call from cache — no additional upstream requests', async () => {
    fetchSpy.mockImplementation(countResponder);

    const ctx = createMockContext();
    await svc.listPortals(ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(39);

    const again = await svc.listPortals(ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(39);
    expect(again.find((p) => p.domain === 'data.cityofchicago.org')?.datasetCount).toBe(909);
  });

  it('degrades a failed domain to datasetCount null without failing the listing', async () => {
    fetchSpy.mockImplementation((input) => {
      const domain = new URL(String(input)).searchParams.get('domains') ?? '';
      if (domain === 'data.wa.gov') {
        // Non-SODA-shaped 404 → NotFound → non-transient, fails fast.
        return Promise.resolve(jsonResponse({ error: 'not found' }, 404, 'Not Found'));
      }
      return countResponder(input);
    });

    const ctx = createMockContext();
    const portals = await svc.listPortals(ctx);

    expect(portals).toHaveLength(39);
    expect(portals.find((p) => p.domain === 'data.wa.gov')?.datasetCount).toBeNull();
    expect(portals.find((p) => p.domain === 'data.cityofchicago.org')?.datasetCount).toBe(909);
  });

  it('fails a cancelled refresh as cancelled and leaves the counts to the next call (#59)', async () => {
    const controller = new AbortController();
    const cancellation = new DOMException('Caller cancelled the listing', 'AbortError');
    fetchSpy.mockImplementation((input, init) => {
      controller.abort(cancellation);
      return hangUntilAborted(input, init);
    });

    await expect(svc.listPortals(createMockContext({ signal: controller.signal }))).rejects.toBe(
      cancellation,
    );

    // The cancelled refresh did not mark the cache fresh: the next call counts every portal.
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(countResponder);
    const portals = await svc.listPortals(createMockContext());
    expect(fetchSpy).toHaveBeenCalledTimes(39);
    expect(portals.find((p) => p.domain === 'data.cityofchicago.org')?.datasetCount).toBe(909);
  });

  it('serves the counts it has to a call waiting on another call whose refresh was cancelled (#59)', async () => {
    const controller = new AbortController();
    const cancellation = new DOMException('Caller cancelled the listing', 'AbortError');
    fetchSpy.mockImplementation(hangUntilAborted);

    const first = svc.listPortals(createMockContext({ signal: controller.signal }));
    const second = svc.listPortals(createMockContext());
    controller.abort(cancellation);

    await expect(first).rejects.toBe(cancellation);
    const portals = await second;
    expect(portals).toHaveLength(39);
    expect(portals.every((p) => p.datasetCount === null)).toBe(true);
    // One refresh for both calls: only its first chunk of 8 was asked before the abort.
    expect(fetchSpy).toHaveBeenCalledTimes(8);
  });
});

describe('SocrataService.getDataset row-count derivation', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('derives row_count from column cachedContents when the top-level key is absent (live Chicago shape)', async () => {
    // Real views-API shape from data.cityofchicago.org/ijzp-q8t2 (2026-07-04):
    // no top-level cachedContents; column-level count/non_null are numeric strings.
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          id: 'ijzp-q8t2',
          name: 'Crimes - 2001 to Present',
          columns: [
            {
              fieldName: 'id',
              dataTypeName: 'number',
              cachedContents: { count: '8585919', non_null: '8585919', null: '0' },
            },
            {
              fieldName: 'case_number',
              dataTypeName: 'text',
              cachedContents: { count: '8585919', non_null: '8585915', null: '4' },
            },
          ],
        },
        200,
        'OK',
      ),
    );

    const ctx = createMockContext();
    const meta = await svc.getDataset('data.cityofchicago.org', 'ijzp-q8t2', ctx);

    expect(meta.rowCount).toBe(8585919);
    expect(meta.rowCountSource).toBe('column_cached_contents');
  });

  it('derives from count, not non_null — count = non_null + null (live Seattle shape)', async () => {
    // data.seattle.gov/kzjm-xkqj address column (2026-07-04):
    // count 2182753 = non_null 2182743 + null 10.
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          id: 'kzjm-xkqj',
          name: 'Seattle Real Time Fire 911 Calls',
          columns: [
            {
              fieldName: 'address',
              dataTypeName: 'text',
              cachedContents: { count: '2182753', non_null: '2182743', null: '10' },
            },
          ],
        },
        200,
        'OK',
      ),
    );

    const ctx = createMockContext();
    const meta = await svc.getDataset('data.seattle.gov', 'kzjm-xkqj', ctx);

    expect(meta.rowCount).toBe(2182753);
    expect(meta.rowCountSource).toBe('column_cached_contents');
    expect(meta.columns[0]?.nonNullCount).toBe(2182743);
  });

  it('prefers the top-level cachedContents count and marks the source accordingly', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          id: 'aaaa-1111',
          name: 'Direct Count Dataset',
          cachedContents: { total_rows: '150000' },
          columns: [
            {
              fieldName: 'id',
              dataTypeName: 'number',
              cachedContents: { count: '149000', non_null: '149000' },
            },
          ],
        },
        200,
        'OK',
      ),
    );

    const ctx = createMockContext();
    const meta = await svc.getDataset('data.example.gov', 'aaaa-1111', ctx);

    expect(meta.rowCount).toBe(150000);
    expect(meta.rowCountSource).toBe('top_level_cached_contents');
  });

  it('falls through to column derivation when top-level cachedContents exists but has no count fields', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          id: 'bbbb-2222',
          name: 'Empty Top-Level Cache',
          cachedContents: {},
          columns: [
            {
              fieldName: 'id',
              dataTypeName: 'number',
              cachedContents: { count: '777', non_null: '777' },
            },
          ],
        },
        200,
        'OK',
      ),
    );

    const ctx = createMockContext();
    const meta = await svc.getDataset('data.example.gov', 'bbbb-2222', ctx);

    expect(meta.rowCount).toBe(777);
    expect(meta.rowCountSource).toBe('column_cached_contents');
  });

  it('omits row_count and row_count_source when no usable count exists anywhere', async () => {
    // Garbage shapes must never coerce to a fabricated number: 'n/a' → NaN,
    // whitespace-only and non-string/number values would Number()-coerce to 0.
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          id: 'cccc-3333',
          name: 'No Counts Anywhere',
          columns: [
            {
              fieldName: 'id',
              dataTypeName: 'number',
              cachedContents: { count: 'n/a', non_null: 'n/a' },
            },
            { fieldName: 'pad', dataTypeName: 'text', cachedContents: { count: '   ' } },
            { fieldName: 'odd', dataTypeName: 'text', cachedContents: { count: [] } },
            { fieldName: 'note', dataTypeName: 'text' },
          ],
        },
        200,
        'OK',
      ),
    );

    const ctx = createMockContext();
    const meta = await svc.getDataset('data.example.gov', 'cccc-3333', ctx);

    expect(meta.rowCount).toBeUndefined();
    expect(meta.rowCountSource).toBeUndefined();
    // Unparseable non_null is omitted rather than becoming a NaN count.
    expect(meta.columns[0]?.nonNullCount).toBeUndefined();
  });
});

describe('SocrataService.fetchStagingRows — one request per canvas copy (#51)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('sends the caller clauses and $offset with $limit = maxRows, and no tiebreaker', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        Array.from({ length: 12 }, (_, i) => ({ id: String(i), primary_type: 'THEFT' })),
        200,
        'OK',
      ),
    );

    const rows = await svc.fetchStagingRows(
      {
        domain: 'data.cityofchicago.org',
        datasetId: 'ijzp-q8t2',
        select: 'id, primary_type',
        where: 'year=2025',
        order: 'primary_type',
        offset: 10,
      },
      50_000,
      createMockContext(),
    );

    expect(rows).toHaveLength(12);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams)).toEqual({
      $select: 'id, primary_type',
      $where: 'year=2025',
      $order: 'primary_type',
      $limit: '50000',
      $offset: '10',
    });
  });

  it('asks once even when the answer is 5,000 rows, the old page size', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        Array.from({ length: 5000 }, (_, i) => ({ id: String(i) })),
        200,
        'OK',
      ),
    );

    const rows = await svc.fetchStagingRows(
      { domain: 'data.seattle.gov', datasetId: 'kzjm-xkqj', group: 'type', select: 'type' },
      50_000,
      createMockContext(),
    );

    expect(rows).toHaveLength(5000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const params = new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams;
    expect(params.get('$limit')).toBe('50000');
    expect(params.has('$offset')).toBe(false);
  });

  it('throws invalid_id before any fetch for a malformed dataset id', async () => {
    await expect(
      svc.fetchStagingRows(
        { domain: 'data.seattle.gov', datasetId: 'bad!!' },
        100,
        createMockContext(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_id' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('SocrataService.fetchJson 404/429 classification (#27)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  /** Route SODA requests to `soda`, Discovery requests to an empty `?ids=` answer. */
  function routeSoda(soda: () => Response) {
    fetchSpy.mockImplementation((input) =>
      Promise.resolve(originOf(input) === DISCOVERY_ORIGIN ? discoveryIdsResponse() : soda()),
    );
  }

  it('maps a codeless SODA 404 ({"error":true,"message":"Not found"}) to not_found', async () => {
    // Live shape: data.seattle.gov/resource/erm2-nwe9.json — no `code` key.
    routeSoda(() => jsonResponse({ error: true, message: 'Not found' }, 404, 'Not Found'));

    const err = await rejectionOf(
      svc.queryDataset({ domain: 'data.seattle.gov', datasetId: 'erm2-nwe9' }, createMockContext()),
    );

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'not_found' });
  });

  it('keeps a SODA 404 with code dataset.missing on not_found (regression)', async () => {
    routeSoda(() =>
      jsonResponse(
        { code: 'dataset.missing', error: true, message: 'Not found', data: { id: 'zzzz-9999' } },
        404,
        'Not Found',
      ),
    );

    const err = await rejectionOf(
      svc.queryDataset({ domain: 'data.cdc.gov', datasetId: 'zzzz-9999' }, createMockContext()),
    );
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'not_found' });
  });

  it('keeps a views-API 404 with code not_found on not_found (regression)', async () => {
    routeSoda(() =>
      jsonResponse(
        { code: 'not_found', error: true, message: 'Cannot find view with id erm2-nwe9' },
        404,
        'Not Found',
      ),
    );

    const err = await rejectionOf(
      svc.getDataset('data.seattle.gov', 'erm2-nwe9', createMockContext()),
    );
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'not_found' });
  });

  it('maps an HTML 404 (not a Socrata portal) to unknown_domain without echoing the page', async () => {
    fetchSpy.mockResolvedValue(htmlResponse(404, 'Not Found'));

    const err = await rejectionOf(svc.getDataset('data.gov', 'zzzz-9999', createMockContext()));

    expect(err.data).toMatchObject({ reason: 'unknown_domain' });
    expect(err.message).toContain('data.gov');
    expect(err.message).not.toContain('<');
    expect(JSON.stringify(err.data)).not.toContain('DOCTYPE');
    // Not-a-portal is deterministic: one request, no retries.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('maps an HTML 404 on the query path to unknown_domain too', async () => {
    fetchSpy.mockResolvedValue(htmlResponse(404, 'Not Found'));

    const err = await rejectionOf(
      svc.queryDataset({ domain: 'data.ohio.gov', datasetId: 'zzzz-9999' }, createMockContext()),
    );
    expect(err.data).toMatchObject({ reason: 'unknown_domain' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('maps a SODA request redirected off-host to an HTML page to unknown_domain on the first attempt', async () => {
    // Live: data.indy.gov/resource/… 302 → hub.arcgis.com/legacy 200 text/html.
    fetchSpy.mockImplementation(() =>
      Promise.resolve(redirectedResponse(htmlResponse(200, 'OK'), 'https://hub.arcgis.com/legacy')),
    );

    const err = await rejectionOf(
      svc.queryDataset({ domain: 'data.indy.gov', datasetId: 'zzzz-9999' }, createMockContext()),
    );

    expect(err.data).toMatchObject({ reason: 'unknown_domain' });
    expect(err.message).toContain('data.indy.gov');
    expect(err.message).toContain('hub.arcgis.com');
    // Before the fix: transient ServiceUnavailable retried to exhaustion (4 fetches).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps HTML on a 200 from the requested host itself on the transient ServiceUnavailable path (regression)', async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(() => Promise.resolve(htmlResponse(200, 'OK')));

    const settled = rejectionOf(
      svc.getDataset('data.seattle.gov', 'kzjm-xkqj', createMockContext()),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await settled;

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err.data as Record<string, unknown>).reason).toBeUndefined();
    // Transient: withRetry spends every attempt (1 + 3 retries).
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('maps a Discovery "Domain not found" 404 to unknown_domain, carrying the upstream message', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: 'Domain not found: data.sandiego.gov' }, 404, 'Not Found'),
    );

    const err = await rejectionOf(
      svc.findDatasets({ domain: 'data.sandiego.gov', query: 'crime' }, createMockContext()),
    );

    expect(err.data).toMatchObject({ reason: 'unknown_domain' });
    expect(err.message).toContain('Domain not found: data.sandiego.gov');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'JSON SODA',
      () =>
        jsonResponse({ code: 'too_many', message: 'Slow down' }, 429, 'Too Many Requests', {
          'Retry-After': '0',
        }),
    ],
    ['HTML', () => htmlResponse(429, 'Too Many Requests', { 'Retry-After': '0' })],
    [
      'empty',
      () =>
        new Response(null, {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Retry-After': '0' },
        }),
    ],
  ])('maps a 429 with a %s body to rate_limited and retries it', async (_label, make) => {
    fetchSpy.mockImplementation(() => Promise.resolve(make()));

    const err = await rejectionOf(
      svc.queryDataset({ domain: 'data.cdc.gov', datasetId: 'bi63-dtpu' }, createMockContext()),
    );

    expect(err.data).toMatchObject({ reason: 'rate_limited', retryAfter: '0' });
    expect(JSON.stringify(err.data)).not.toContain('DOCTYPE');
    // Retryable: every attempt is spent (Retry-After: 0 keeps the waits at zero).
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('carries Retry-After onto data.retryAfter and waits that long instead of exponential backoff', async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ code: 'too_many', message: 'Slow down' }, 429, 'Too Many Requests', {
          'Retry-After': '7',
        }),
      ),
    );

    const settled = rejectionOf(
      svc.queryDataset({ domain: 'data.cdc.gov', datasetId: 'bi63-dtpu' }, createMockContext()),
    );

    await vi.advanceTimersByTimeAsync(6_999);
    // Exponential backoff (500 ms base) would already have retried several times.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    const err = await settled;
    expect(err.data).toMatchObject({ reason: 'rate_limited', retryAfter: '7' });
  });

  it('maps a 400 without a SODA body to the generic InvalidParams path (regression)', async () => {
    fetchSpy.mockResolvedValue(htmlResponse(400, 'Bad Request'));

    const err = await rejectionOf(
      svc.queryDataset({ domain: 'data.cdc.gov', datasetId: 'bi63-dtpu' }, createMockContext()),
    );
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((err.data as Record<string, unknown>).reason).toBeUndefined();
  });
});

describe('SocrataService not_found enrichment and cross-portal lookup (#28)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const sodaNotFound = () =>
    jsonResponse(
      { code: 'not_found', error: true, message: 'Cannot find view with id erm2-nwe9' },
      404,
      'Not Found',
    );

  /** SODA answers 404; Discovery answers with `discovery()`. */
  function route(discovery: () => Promise<Response> | Response) {
    fetchSpy.mockImplementation((input) =>
      originOf(input) === DISCOVERY_ORIGIN
        ? Promise.resolve(discovery())
        : Promise.resolve(sodaNotFound()),
    );
  }

  const discoveryCalls = () =>
    fetchSpy.mock.calls.filter((c) => originOf(c[0]) === DISCOVERY_ORIGIN);

  it('names the ID and queried domain, and the portal Discovery says holds the ID', async () => {
    route(() => discoveryIdsResponse('data.cityofnewyork.us'));

    const err = await rejectionOf(
      svc.getDataset('data.seattle.gov', 'erm2-nwe9', createMockContext()),
    );

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe('Dataset erm2-nwe9 not found on data.seattle.gov.');
    expect(err.data).toMatchObject({
      reason: 'not_found',
      domain: 'data.seattle.gov',
      dataset_id: 'erm2-nwe9',
      found_on_domain: 'data.cityofnewyork.us',
    });
    // Exactly one Discovery lookup, by ID.
    expect(discoveryCalls()).toHaveLength(1);
    expect(new URL(String(discoveryCalls()[0]?.[0])).searchParams.get('ids')).toBe('erm2-nwe9');
  });

  it('enriches the query path the same way', async () => {
    fetchSpy.mockImplementation((input) =>
      Promise.resolve(
        originOf(input) === DISCOVERY_ORIGIN
          ? discoveryIdsResponse('data.cityofnewyork.us')
          : jsonResponse({ error: true, message: 'Not found' }, 404, 'Not Found'),
      ),
    );

    const err = await rejectionOf(
      svc.queryDataset({ domain: 'data.seattle.gov', datasetId: 'erm2-nwe9' }, createMockContext()),
    );
    expect(err.message).toBe('Dataset erm2-nwe9 not found on data.seattle.gov.');
    expect(err.data).toMatchObject({
      reason: 'not_found',
      domain: 'data.seattle.gov',
      dataset_id: 'erm2-nwe9',
      found_on_domain: 'data.cityofnewyork.us',
    });
  });

  it('claims no other portal when Discovery does not index the ID', async () => {
    route(() => discoveryIdsResponse(undefined, 'zzzz-9999'));

    const err = await rejectionOf(svc.getDataset('data.cdc.gov', 'zzzz-9999', createMockContext()));

    expect(err.message).toBe('Dataset zzzz-9999 not found on data.cdc.gov.');
    expect(err.data).toMatchObject({ domain: 'data.cdc.gov', dataset_id: 'zzzz-9999' });
    expect((err.data as Record<string, unknown>).found_on_domain).toBeUndefined();
  });

  it('claims no mismatch when Discovery reports the queried domain or its catalog alias', async () => {
    route(() => discoveryIdsResponse('cos-data.seattle.gov', 'kzjm-xkqj'));

    const err = await rejectionOf(
      svc.getDataset('data.seattle.gov', 'kzjm-xkqj', createMockContext()),
    );
    expect((err.data as Record<string, unknown>).found_on_domain).toBeUndefined();

    route(() => discoveryIdsResponse('data.cdc.gov', 'bi63-dtpu'));
    const same = await rejectionOf(
      svc.getDataset('data.cdc.gov', 'bi63-dtpu', createMockContext()),
    );
    expect((same.data as Record<string, unknown>).found_on_domain).toBeUndefined();
  });

  it.each([
    ['a 5xx', () => new Response('oops', { status: 503, statusText: 'Service Unavailable' })],
    [
      'a 429',
      () => jsonResponse({ message: 'slow' }, 429, 'Too Many Requests', { 'Retry-After': '0' }),
    ],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
    ['a malformed body', () => new Response('not json', { status: 200 })],
  ])(
    'returns the original not_found when the lookup fails with %s — one attempt only',
    async (_l, discovery) => {
      route(discovery);

      const err = await rejectionOf(
        svc.getDataset('data.seattle.gov', 'erm2-nwe9', createMockContext()),
      );

      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.message).toBe('Dataset erm2-nwe9 not found on data.seattle.gov.');
      expect((err.data as Record<string, unknown>).found_on_domain).toBeUndefined();
      expect(discoveryCalls()).toHaveLength(1);
    },
  );

  it('abandons a hung lookup after its own short timeout and returns the original not_found', async () => {
    vi.useFakeTimers();
    // The Discovery fetch never settles on its own — only the lookup's abort ends it.
    fetchSpy.mockImplementation((input, init) => {
      if (originOf(input) !== DISCOVERY_ORIGIN) return Promise.resolve(sodaNotFound());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    const settled = rejectionOf(
      svc.getDataset('data.seattle.gov', 'erm2-nwe9', createMockContext()),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await settled;

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect((err.data as Record<string, unknown>).found_on_domain).toBeUndefined();
    expect(discoveryCalls()).toHaveLength(1);
  });

  it('issues no Discovery request when get or query succeeds (regression)', async () => {
    fetchSpy.mockImplementation((input) =>
      Promise.resolve(
        new URL(String(input)).pathname.startsWith('/api/views/')
          ? jsonResponse({ id: 'kzjm-xkqj', name: 'X', columns: [] }, 200, 'OK')
          : jsonResponse([{ a: '1' }], 200, 'OK'),
      ),
    );

    const ctx = createMockContext();
    await svc.getDataset('data.seattle.gov', 'kzjm-xkqj', ctx);
    await svc.queryDataset({ domain: 'data.seattle.gov', datasetId: 'kzjm-xkqj' }, ctx);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(discoveryCalls()).toHaveLength(0);
  });

  it('does not look up Discovery for an unknown_domain failure', async () => {
    fetchSpy.mockResolvedValue(htmlResponse(404, 'Not Found'));

    await rejectionOf(svc.getDataset('data.gov', 'zzzz-9999', createMockContext()));
    expect(discoveryCalls()).toHaveLength(0);
  });
});

describe('normalizeDomain and URL-shaped domains (#35)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each([
    'data.cdc.gov',
    'https://data.cdc.gov',
    'http://data.cdc.gov/',
    'DATA.CDC.GOV',
    'data.cdc.gov/browse',
    ' https://data.cdc.gov/resource/bi63-dtpu.json?$limit=1 ',
    // Fully qualified form: SODA serves it (live 200), so the root dot is dropped.
    'data.cdc.gov.',
    'https://data.cdc.gov.:443/',
  ])('reduces %j to data.cdc.gov', (input) => {
    expect(normalizeDomain(input)).toBe('data.cdc.gov');
  });

  it('accepts an internationalized domain in its punycode form', () => {
    expect(normalizeDomain('данные.рф')).toBe('xn--80ahe5aa8f.xn--p1ai');
  });

  it.each([
    'not a host',
    '',
    '   ',
    'https://',
    'localhost',
    '10.0.0.1',
    'ftp://data.cdc.gov',
    'data..cdc.gov',
    'data.cdc.gov..',
  ])('rejects %j as invalid_domain naming the input', (input) => {
    let thrown: unknown;
    try {
      normalizeDomain(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
    expect((thrown as McpError).data).toMatchObject({ reason: 'invalid_domain', domain: input });
    expect((thrown as McpError).message).toContain(JSON.stringify(input));
  });

  it('builds the views URL from a URL-shaped domain', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ id: 'bi63-dtpu', name: 'X', columns: [] }, 200, 'OK'),
    );

    const meta = await svc.getDataset('https://data.cdc.gov', 'bi63-dtpu', createMockContext());

    expect(originOf(fetchSpy.mock.calls[0]?.[0])).toBe('https://data.cdc.gov');
    expect(meta.domain).toBe('data.cdc.gov');
  });

  it('reports the normalized domain from queryDataset and builds every request URL from it', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse([{ a: '1' }], 200, 'OK')));

    const ctx = createMockContext();
    const result = await svc.queryDataset(
      { domain: 'HTTPS://Data.CDC.gov/browse', datasetId: 'bi63-dtpu' },
      ctx,
    );
    const staged = await svc.fetchStagingRows(
      { domain: 'https://data.cdc.gov/', datasetId: 'bi63-dtpu' },
      10,
      ctx,
    );

    expect(result.domain).toBe('data.cdc.gov');
    expect(staged).toHaveLength(1);
    for (const call of fetchSpy.mock.calls) expect(originOf(call[0])).toBe('https://data.cdc.gov');
  });

  it('sends the normalized domain to Discovery, alias join included', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ results: [], resultSetSize: 0 }, 200, 'OK'));

    await svc.findDatasets({ domain: 'https://DATA.SEATTLE.GOV/' }, createMockContext());

    expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.get('domains')).toBe(
      'data.seattle.gov,cos-data.seattle.gov',
    );
  });

  it('fails an unparseable domain before any request — no retries', async () => {
    const ctx = createMockContext();

    for (const call of [
      svc.getDataset('not a host', 'bi63-dtpu', ctx),
      svc.queryDataset({ domain: 'not a host', datasetId: 'bi63-dtpu' }, ctx),
      svc.findDatasets({ domain: 'not a host' }, ctx),
    ]) {
      const err = await rejectionOf(call);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'invalid_domain', domain: 'not a host' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Live-captured SoQL error bodies from data.cityofnewyork.us/resource/43nn-pn8j
 * (2026-09-22). The query-coordinator family echoes the fully expanded SELECT
 * and a caret line inside `; position: Map(…)`; the SELECT list is shortened
 * here, the shape is not.
 */
const EXPANDED_SELECT = 'SELECT `camis`, `dba`, `boro`, `grade` WHERE `boro` = `Manhattan` LIMIT 1';
const SOQL_BODIES = {
  malformed: {
    code: 'query.compiler.malformed',
    error: true,
    message:
      "Could not parse SoQL query \"select DBA, BORO, CUISINE DESCRIPTION, GRADE limit 2\" at line 1 character 27: Expected one of end of input, `,', or `AS', but got `DESCRIPTION'",
    data: { query: 'select DBA, BORO, CUISINE DESCRIPTION, GRADE limit 2', position: {} },
  },
  noSuchColumn: {
    message: `Query coordinator error: query.soql.no-such-column; No such column: Manhattan; position: Map(row -> 1, column -> 59, line -> "${EXPANDED_SELECT}\\n                                                          ^")`,
    errorCode: 'query.soql.no-such-column',
    data: {
      column: 'Manhattan',
      dataset: 'foxtrot.15649',
      position: { row: 1, column: 59, line: `${EXPANDED_SELECT}\n${' '.repeat(58)}^` },
    },
  },
  typeMismatch: {
    message: `Query coordinator error: query.soql.type-mismatch; Type mismatch for op$=, is number; position: Map(row -> 1, column -> 59, line -> "${EXPANDED_SELECT}\\n                                                          ^")`,
    errorCode: 'query.soql.type-mismatch',
    data: { function: 'op$=', type: 'number', dataset: 'foxtrot.15649', position: { row: 1 } },
  },
} as const;

describe('SocrataService soql_error message and data (#29)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const query = () =>
    rejectionOf(
      svc.queryDataset(
        { domain: 'data.cityofnewyork.us', datasetId: '43nn-pn8j', where: 'boro=Manhattan' },
        createMockContext(),
      ),
    );

  it('drops the position: Map(…) echo and carries data.column from upstream', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(SOQL_BODIES.noSuchColumn, 400, 'Bad Request'));

    const err = await query();

    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.message).toBe(
      'SoQL error: Query coordinator error: query.soql.no-such-column; No such column: Manhattan',
    );
    expect(err.message).not.toContain('position: Map(');
    expect(err.data).toEqual({
      reason: 'soql_error',
      socrataCode: 'query.soql.no-such-column',
      column: 'Manhattan',
    });
  });

  it('trims a type-mismatch message and omits column when upstream supplies none', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(SOQL_BODIES.typeMismatch, 400, 'Bad Request'));

    const err = await query();

    expect(err.message).toBe(
      'SoQL error: Query coordinator error: query.soql.type-mismatch; Type mismatch for op$=, is number',
    );
    expect(err.data).toEqual({ reason: 'soql_error', socrataCode: 'query.soql.type-mismatch' });
  });

  it('keeps a compiler message (no position echo) whole', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(SOQL_BODIES.malformed, 400, 'Bad Request'));

    const err = await query();

    expect(err.message).toBe(`SoQL error: ${SOQL_BODIES.malformed.message}`);
    expect(err.data).toEqual({ reason: 'soql_error', socrataCode: 'query.compiler.malformed' });
  });

  it('keeps a 400 without a SODA body on the generic InvalidParams path (regression)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ oops: 'nope' }, 400, 'Bad Request'));

    const err = await query();

    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((err.data as Record<string, unknown>).reason).toBeUndefined();
  });
});

describe('SocrataService.findDatasets column_names mapping (#29)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  /** One Discovery result; `resource` fields as the live catalog returns them. */
  function discoveryWith(resource: Record<string, unknown>): Response {
    return jsonResponse(
      {
        results: [
          {
            resource: { id: '43nn-pn8j', name: 'DOHMH Restaurant Inspections', ...resource },
            metadata: { domain: 'data.cityofnewyork.us' },
            classification: {},
          },
        ],
        resultSetSize: 1,
      },
      200,
      'OK',
    );
  }

  it('maps columns_field_name — the SoQL identifiers — and drops :@computed_region_* entries', async () => {
    // Index-aligned pair as live Discovery returns it for 43nn-pn8j (subset).
    fetchSpy.mockResolvedValue(
      discoveryWith({
        columns_name: ['BIN', 'CUISINE DESCRIPTION', 'Census Tract', 'GRADE DATE', 'DBA', ''],
        columns_field_name: [
          'bin',
          'cuisine_description',
          'census_tract',
          'grade_date',
          ':@computed_region_f5dn_yrer',
          'dba',
        ],
      }),
    );

    const { results } = await svc.findDatasets(
      { domain: 'data.cityofnewyork.us', query: 'DOHMH restaurant inspection results' },
      createMockContext(),
    );

    expect(results[0]?.columnNames).toEqual([
      'bin',
      'cuisine_description',
      'census_tract',
      'grade_date',
      'dba',
    ]);
  });

  it('returns an empty list when a sparse result has no columns_field_name — labels are never a fallback', async () => {
    fetchSpy.mockResolvedValue(discoveryWith({ columns_name: ['BIN', 'CUISINE DESCRIPTION'] }));

    const { results } = await svc.findDatasets({ query: 'x' }, createMockContext());

    expect(results[0]?.columnNames).toEqual([]);
  });

  it('skips non-string entries in columns_field_name', async () => {
    fetchSpy.mockResolvedValue(discoveryWith({ columns_field_name: ['a', null, 7, 'b'] }));

    const { results } = await svc.findDatasets({ query: 'x' }, createMockContext());

    expect(results[0]?.columnNames).toEqual(['a', 'b']);
  });
});

describe('SocrataService.findDatasets Discovery request params (#54, #55)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    // Answers the Discovery host only; any other request fails the test.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (new URL(String(input)).hostname === 'api.us.socrata.com') {
        return jsonResponse({ results: [], resultSetSize: 0 }, 200, 'OK');
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  /** The single Discovery request the search sent. */
  function sentUrl(): string {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    return String(fetchSpy.mock.calls[0]?.[0]);
  }

  it('sends one categories param per category, which Discovery ORs (#54)', async () => {
    // Live 2026-10-30, NYC: Public Safety 141 + Transportation 373 → 514 as
    // repeated params; the comma-joined form reads as one category name → 0.
    await svc.findDatasets(
      {
        domain: 'data.cityofnewyork.us',
        categories: ['Public Safety', 'Transportation'],
        limit: 1,
      },
      createMockContext(),
    );

    const url = sentUrl();
    expect(new URL(url).searchParams.getAll('categories')).toEqual([
      'Public Safety',
      'Transportation',
    ]);
    expect(url).toContain('categories=Public+Safety&categories=Transportation');
  });

  it('sends one tags param per tag and keeps a comma inside a tag intact (#54)', async () => {
    await svc.findDatasets({ tags: ['doe', 'education', 'a,b'] }, createMockContext());

    expect(new URL(sentUrl()).searchParams.getAll('tags')).toEqual(['doe', 'education', 'a,b']);
  });

  it('sends a single category or tag as one param', async () => {
    await svc.findDatasets(
      { categories: ['Public Safety'], tags: ['covid19'] },
      createMockContext(),
    );

    const params = new URL(sentUrl()).searchParams;
    expect(params.getAll('categories')).toEqual(['Public Safety']);
    expect(params.getAll('tags')).toEqual(['covid19']);
  });

  it('sends limit and offset as given, omitting a zero offset', async () => {
    // The tool bounds limit to the per-call cap and the 10,000-match window
    // before calling; the service sends the page it is asked for.
    await svc.findDatasets({ only: 'datasets', limit: 50, offset: 9950 }, createMockContext());
    const paged = new URL(sentUrl()).searchParams;
    expect(paged.get('limit')).toBe('50');
    expect(paged.get('offset')).toBe('9950');

    fetchSpy.mockClear();
    await svc.findDatasets({ query: 'x', limit: 10, offset: 0 }, createMockContext());
    const first = new URL(sentUrl()).searchParams;
    expect(first.get('limit')).toBe('10');
    expect(first.has('offset')).toBe(false);
  });
});

/**
 * A `fetch` rejection in the shape Bun 1.4 raises for a failed request: a
 * TypeError carrying the errno code on the error itself (live, Bun 1.4.0:
 * `getaddrinfo ENOTFOUND www.data.cityofnewyork.us`, code/errno/syscall/hostname).
 */
function bunFetchError(code: string, hostname: string): TypeError {
  return Object.assign(new TypeError(`getaddrinfo ${code} ${hostname}`), {
    code,
    errno: 4,
    syscall: 'getaddrinfo',
    hostname,
    path: `https://${hostname}/`,
  });
}

/** The same failure as Node's undici raises it: `fetch failed`, the errno on `cause` (live, Node 26). */
function nodeFetchError(code: string, hostname: string): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), {
      code,
      errno: -3008,
      syscall: 'getaddrinfo',
      hostname,
    }),
  });
}

/** Live 403 from data.cityofberkeley.info's FortiWeb gateway (client IP redacted): not valid JSON. */
const GATEWAY_403_BODY =
  '{"page_title":"Web Page Blocked!","display_message":"The page cannot be displayed. Please contact the administrator for additional information.","client_IP":"192.0.2.1","URL":"data.cityofberkeley.info/api/views/zzzz-9999.json","attack_ID":"20000009","message_ID":"001003870154",}';

const gateway403 = () =>
  new Response(GATEWAY_403_BODY, {
    status: 403,
    statusText: 'Forbidden',
    headers: { 'Content-Type': 'text/html' },
  });

/** Live 200 from oxnardca.opengov.com/data after data.oxnard.org redirects every SODA path there. */
const OPENGOV_PAGE_JSON = {
  entryScript: '/reporting-classic-app/assets/javascripts/rapp_standalone.js',
  athenaStyles: '/reporting-classic-app/assets/stylesheets/rapp_standalone.css',
};

const opengovRedirect = () =>
  redirectedResponse(
    jsonResponse(OPENGOV_PAGE_JSON, 200, 'OK'),
    'https://oxnardca.opengov.com/data',
  );

describe('hosts that do not serve the SODA API (#37, #38, #39)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const discoveryCalls = () =>
    fetchSpy.mock.calls.filter((c) => originOf(c[0]) === DISCOVERY_ORIGIN);
  const sodaCalls = () => fetchSpy.mock.calls.filter((c) => originOf(c[0]) !== DISCOVERY_ORIGIN);

  /** Run a call under fake timers so every retry backoff elapses; return its McpError-or-Error. */
  async function settledUnderFakeTimers(run: () => Promise<unknown>): Promise<unknown> {
    vi.useFakeTimers();
    const settled = run().then(
      () => new Error('expected a rejection'),
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    return settled;
  }

  describe('transient request failures keep retrying (regression)', () => {
    it.each([
      ['EAI_AGAIN (Bun)', () => bunFetchError('EAI_AGAIN', 'data.cdc.gov')],
      ['EAI_AGAIN (Node)', () => nodeFetchError('EAI_AGAIN', 'data.cdc.gov')],
      [
        'ECONNRESET (Bun)',
        () =>
          Object.assign(new TypeError('The socket connection was closed unexpectedly.'), {
            code: 'ECONNRESET',
          }),
      ],
      ['a fetch timeout', () => new DOMException('The operation timed out.', 'TimeoutError')],
    ])('%s is retried to exhaustion — 4 attempts', async (_l, make) => {
      fetchSpy.mockImplementation(() => Promise.reject(make()));

      await settledUnderFakeTimers(() =>
        svc.getDataset('data.cdc.gov', 'bi63-dtpu', createMockContext()),
      );

      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it('ENOTFOUND for the Discovery host itself is this server’s network, not the portal — retried', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.reject(bunFetchError('ENOTFOUND', 'api.us.socrata.com')),
      );

      await settledUnderFakeTimers(() =>
        svc.findDatasets({ domain: 'data.cdc.gov', query: 'x' }, createMockContext()),
      );

      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });
  });

  it('keeps data.sfgov.org → data.sf.gov (a real Socrata host) succeeding (regression)', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        redirectedResponse(
          jsonResponse({ id: 'wg3w-h783', name: 'Police Incidents', columns: [] }, 200, 'OK'),
          'https://data.sf.gov/api/views/wg3w-h783.json',
        ),
      ),
    );

    const meta = await svc.getDataset('data.sfgov.org', 'wg3w-h783', createMockContext());

    expect(meta.name).toBe('Police Incidents');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  describe('a portal hostname that does not resolve (#37)', () => {
    const host = 'www.data.cityofnewyork.us';

    it.each([
      ['Bun', () => bunFetchError('ENOTFOUND', host)],
      ['Node', () => nodeFetchError('ENOTFOUND', host)],
    ])(
      'getDataset maps ENOTFOUND (%s shape) to unknown_domain on the first attempt',
      async (_l, make) => {
        fetchSpy.mockImplementation(() => Promise.reject(make()));

        const err = await settledUnderFakeTimers(() =>
          svc.getDataset(host, 'erm2-nwe9', createMockContext()),
        );

        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
        expect((err as McpError).data).toMatchObject({ reason: 'unknown_domain', host });
        expect((err as McpError).message).toContain(host);
        expect((err as McpError).message).not.toContain('attempts');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      },
    );

    it('queryDataset and fetchStagingRows map it the same way', async () => {
      fetchSpy.mockImplementation(() => Promise.reject(bunFetchError('ENOTFOUND', host)));

      const queried = await settledUnderFakeTimers(() =>
        svc.queryDataset({ domain: host, datasetId: 'erm2-nwe9' }, createMockContext()),
      );
      expect((queried as McpError).data).toMatchObject({ reason: 'unknown_domain' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const staged = await settledUnderFakeTimers(() =>
        svc.fetchStagingRows({ domain: host, datasetId: 'erm2-nwe9' }, 100, createMockContext()),
      );
      expect((staged as McpError).data).toMatchObject({ reason: 'unknown_domain' });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('a views or resource response that is not the dataset requested (#38)', () => {
    it('getDataset: an off-host redirect to a non-Socrata JSON page is unknown_domain on the first attempt', async () => {
      fetchSpy.mockImplementation(() => Promise.resolve(opengovRedirect()));

      const err = await rejectionOf(
        svc.getDataset('data.oxnard.org', 'zzzz-9999', createMockContext()),
      );

      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.data).toMatchObject({
        reason: 'unknown_domain',
        host: 'data.oxnard.org',
        redirectedTo: 'oxnardca.opengov.com',
      });
      expect(err.message).toContain('data.oxnard.org');
      expect(err.message).toContain('oxnardca.opengov.com');
      // Deterministic: one request, and no Discovery ID lookup (not a not_found).
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('getDataset: a same-host views response without the requested id is not_found, not an empty success', async () => {
      fetchSpy.mockImplementation((input) =>
        Promise.resolve(
          originOf(input) === DISCOVERY_ORIGIN
            ? discoveryIdsResponse(undefined, 'zzzz-9999')
            : jsonResponse({ columns: [] }, 200, 'OK'),
        ),
      );

      const err = await rejectionOf(
        svc.getDataset('data.cdc.gov', 'zzzz-9999', createMockContext()),
      );

      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.message).toBe('Dataset zzzz-9999 not found on data.cdc.gov.');
      expect(err.data).toMatchObject({ reason: 'not_found', domain: 'data.cdc.gov' });
      expect(sodaCalls()).toHaveLength(1);
      expect(discoveryCalls()).toHaveLength(1);
    });

    it('queryDataset: an off-host redirect to a non-array JSON page is unknown_domain on the first attempt', async () => {
      fetchSpy.mockImplementation(() => Promise.resolve(opengovRedirect()));

      const err = await rejectionOf(
        svc.queryDataset(
          { domain: 'data.oxnard.org', datasetId: 'zzzz-9999' },
          createMockContext(),
        ),
      );

      expect(err.data).toMatchObject({
        reason: 'unknown_domain',
        redirectedTo: 'oxnardca.opengov.com',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('fetchStagingRows: a non-array answer is unknown_domain on the first attempt', async () => {
      fetchSpy.mockImplementation(() => Promise.resolve(opengovRedirect()));

      const err = await rejectionOf(
        svc.fetchStagingRows(
          { domain: 'data.oxnard.org', datasetId: 'zzzz-9999' },
          100,
          createMockContext(),
        ),
      );

      expect(err.data).toMatchObject({ reason: 'unknown_domain' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('an off-host redirect to a 200 that is neither JSON nor HTML is unknown_domain, not a retried parse error', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          redirectedResponse(
            new Response('plain text landing page', {
              status: 200,
              headers: { 'Content-Type': 'text/plain' },
            }),
            'https://parked.example.net/',
          ),
        ),
      );

      const err = await settledUnderFakeTimers(() =>
        svc.getDataset('data.parked.example', 'zzzz-9999', createMockContext()),
      );

      expect((err as McpError).data).toMatchObject({ reason: 'unknown_domain' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('a 403 from a gateway instead of the SODA API (#39)', () => {
    it.each(['select', 'where', 'search', 'group', 'having', 'order'] as const)(
      'diagnoses a gateway rejection of %s with one bare control (#45)',
      async (clause) => {
        fetchSpy.mockImplementation((input) => {
          const url = new URL(String(input));
          if (url.origin === DISCOVERY_ORIGIN)
            return Promise.resolve(discoveryIdsResponse('data.cityofnewyork.us'));
          return Promise.resolve(
            url.search === '?%24limit=1' ? jsonResponse([], 200, 'OK') : gateway403(),
          );
        });
        const err = await rejectionOf(
          svc.queryDataset(
            {
              domain: 'data.cityofnewyork.us',
              datasetId: 'erm2-nwe9',
              [clause]: 'x',
              limit: 5,
              offset: 10,
            },
            createMockContext(),
          ),
        );
        expect(err.data?.reason).toBe('query_rejected');
        expect(err.message).toContain('query text');
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(new URL(String(fetchSpy.mock.calls[2]![0])).searchParams.toString()).toBe(
          '%24limit=1',
        );
      },
    );

    it.each([403, 429, 500, 200])(
      'preserves unknown_domain after an inconclusive/refused diagnostic HTTP %s (#45)',
      async (status) => {
        fetchSpy.mockImplementation((input) => {
          const url = new URL(String(input));
          if (url.origin === DISCOVERY_ORIGIN)
            return Promise.resolve(discoveryIdsResponse('data.cityofnewyork.us'));
          return Promise.resolve(
            url.search === '?%24limit=1'
              ? jsonResponse({ not: 'rows' }, status, 'Control')
              : gateway403(),
          );
        });
        const err = await rejectionOf(
          svc.queryDataset(
            { domain: 'data.cityofnewyork.us', datasetId: 'erm2-nwe9', select: 'x' },
            createMockContext(),
          ),
        );
        expect(err.data?.reason).toBe('unknown_domain');
        expect(err.cause).toMatchObject({
          code: JsonRpcErrorCode.NotFound,
          data: { reason: 'not_found', status: 403, host: 'data.cityofnewyork.us' },
          message:
            'data.cityofnewyork.us refused the request with HTTP 403 and a gateway page instead of a Socrata error.',
        });
        expect(fetchSpy).toHaveBeenCalledTimes(3);
      },
    );

    it.each(['discovery', 'diagnostic'])(
      'propagates caller cancellation during %s (#45)',
      async (seam) => {
        const controller = new AbortController();
        const cancellation = new DOMException('Caller cancelled the query', 'AbortError');
        fetchSpy.mockImplementation((input) => {
          const url = new URL(String(input));
          if (
            (seam === 'discovery' && url.origin === DISCOVERY_ORIGIN) ||
            (seam === 'diagnostic' && url.search === '?%24limit=1')
          ) {
            controller.abort(cancellation);
            return Promise.reject(cancellation);
          }
          return Promise.resolve(
            url.origin === DISCOVERY_ORIGIN
              ? discoveryIdsResponse('data.cityofnewyork.us')
              : gateway403(),
          );
        });
        await expect(
          svc.queryDataset(
            { domain: 'data.cityofnewyork.us', datasetId: 'erm2-nwe9', select: 'x' },
            createMockContext({ signal: controller.signal }),
          ),
        ).rejects.toBe(cancellation);
        expect(fetchSpy).toHaveBeenCalledTimes(seam === 'discovery' ? 2 : 3);
      },
    );

    it.each(['discovery', 'diagnostic'] as const)(
      'preserves cancellation when %s returns refused headers (#45)',
      async (seam) => {
        const controller = new AbortController();
        const cancellation = new DOMException('Caller cancelled at response headers', 'AbortError');
        fetchSpy.mockImplementation((input) => {
          const url = new URL(String(input));
          if (
            (seam === 'discovery' && url.origin === DISCOVERY_ORIGIN) ||
            (seam === 'diagnostic' && url.search === '?%24limit=1')
          ) {
            controller.abort(cancellation);
            return Promise.resolve(gateway403());
          }
          return Promise.resolve(
            url.origin === DISCOVERY_ORIGIN
              ? discoveryIdsResponse('data.cityofnewyork.us')
              : gateway403(),
          );
        });
        await expect(
          svc.queryDataset(
            { domain: 'data.cityofnewyork.us', datasetId: 'erm2-nwe9', select: 'x' },
            createMockContext({ signal: controller.signal }),
          ),
        ).rejects.toBe(cancellation);
        expect(fetchSpy).toHaveBeenCalledTimes(seam === 'discovery' ? 2 : 3);
      },
    );

    it('bounds a stalled diagnostic without retrying (#45)', async () => {
      vi.useFakeTimers();
      fetchSpy.mockImplementation((input, init) => {
        const url = new URL(String(input));
        if (url.origin === DISCOVERY_ORIGIN)
          return Promise.resolve(discoveryIdsResponse('data.cityofnewyork.us'));
        if (url.search === '?%24limit=1')
          return new Promise((_resolve, reject) =>
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
              once: true,
            }),
          );
        return Promise.resolve(gateway403());
      });
      const pending = rejectionOf(
        svc.queryDataset(
          { domain: 'data.cityofnewyork.us', datasetId: 'erm2-nwe9', select: 'x' },
          createMockContext(),
        ),
      );
      await vi.advanceTimersByTimeAsync(2500);
      const err = await pending;
      expect(err.data?.reason).toBe('unknown_domain');
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
    it('characterizes a refused bare row request with offset as unknown_domain', async () => {
      route('data.cityofberkeley.info');
      const err = await rejectionOf(
        svc.queryDataset(
          { domain: 'data.cityofberkeley.info', datasetId: 'zzzz-9999', limit: 1, offset: 2 },
          createMockContext(),
        ),
      );
      expect(err.data?.reason).toBe('unknown_domain');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
    /** SODA answers the gateway 403; Discovery places the ID on `holder` (nowhere when omitted). */
    function route(holder?: string) {
      fetchSpy.mockImplementation((input) =>
        Promise.resolve(
          originOf(input) === DISCOVERY_ORIGIN
            ? discoveryIdsResponse(holder, 'zzzz-9999')
            : gateway403(),
        ),
      );
    }

    it('is a dataset not_found on the first attempt when Discovery does not know the ID (live: Berkeley bogus IDs)', async () => {
      route();

      const err = await rejectionOf(
        svc.getDataset('data.cityofberkeley.info', 'zzzz-9999', createMockContext()),
      );

      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.data).toMatchObject({
        reason: 'not_found',
        domain: 'data.cityofberkeley.info',
        dataset_id: 'zzzz-9999',
        status: 403,
      });
      expect(err.message).toContain('Dataset zzzz-9999 not found on data.cityofberkeley.info');
      expect(err.message).toContain('HTTP 403');
      expect(JSON.stringify(err.data)).not.toContain('Web Page Blocked');
      expect(sodaCalls()).toHaveLength(1);
    });

    it('names the portal holding the ID when Discovery places it elsewhere', async () => {
      route('data.cityofnewyork.us');

      const err = await rejectionOf(
        svc.queryDataset(
          { domain: 'data.cityofberkeley.info', datasetId: 'zzzz-9999' },
          createMockContext(),
        ),
      );

      expect(err.data).toMatchObject({
        reason: 'not_found',
        found_on_domain: 'data.cityofnewyork.us',
      });
      expect(sodaCalls()).toHaveLength(1);
    });

    it('is unknown_domain when Discovery lists the ID on the refusing host itself', async () => {
      route('data.cityofberkeley.info');

      const err = await rejectionOf(
        svc.getDataset('data.cityofberkeley.info', 'zzzz-9999', createMockContext()),
      );

      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.data).toMatchObject({
        reason: 'unknown_domain',
        host: 'data.cityofberkeley.info',
      });
      expect(err.message).toContain('HTTP 403');
      expect(sodaCalls()).toHaveLength(1);
    });
  });

  it('a JSON 404 that is not a SODA error body is unknown_domain (live: catalog.data.gov)', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse({ detail: {}, message: 'Not Found' }, 404, 'Not Found')),
    );

    const err = await rejectionOf(
      svc.getDataset('catalog.data.gov', 'zzzz-9999', createMockContext()),
    );

    expect(err.data).toMatchObject({ reason: 'unknown_domain', host: 'catalog.data.gov' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * A `fetch` that never answers on its own: it settles only when its signal
 * aborts, rejecting with the signal's reason, as a hung upstream does once the
 * request is cut.
 */
function hangUntilAborted(_input: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** A `fetch` that answers with `make()` after `delayMs` unless its signal aborts first. */
function answerAfter(delayMs: number, make: () => Response) {
  return (_input: unknown, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const signal = init?.signal;
      const timer = setTimeout(() => resolve(make()), delayMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
}

/** Follow a call under fake timers: `state.settled` flips when it settles; `outcome` holds its value or error. */
function track(promise: Promise<unknown>) {
  const state = { settled: false };
  const outcome = promise.then(
    (value: unknown) => {
      state.settled = true;
      return { value, error: undefined as unknown };
    },
    (error: unknown) => {
      state.settled = true;
      return { value: undefined as unknown, error };
    },
  );
  return { state, outcome };
}

describe('SocrataService per-call deadline (#59)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const svc = new SocrataService();

  beforeEach(() => {
    vi.useFakeTimers();
    resetPortalCountCache();
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPortalCountCache();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  type Ctx = ReturnType<typeof createMockContext>;

  /** Each entry point that reaches an upstream: its first host, and the requests a hung upstream sees. */
  const entryPoints: ReadonlyArray<[string, string, number, (ctx: Ctx) => Promise<unknown>]> = [
    [
      'getDataset',
      'data.cityofnewyork.us',
      1,
      (ctx) => svc.getDataset('data.cityofnewyork.us', 'erm2-nwe9', ctx),
    ],
    [
      'queryDataset',
      'data.cityofnewyork.us',
      1,
      (ctx) =>
        svc.queryDataset(
          { domain: 'data.cityofnewyork.us', datasetId: 'erm2-nwe9', order: 'borough' },
          ctx,
        ),
    ],
    ['findDatasets', 'api.us.socrata.com', 1, (ctx) => svc.findDatasets({ query: 'crime' }, ctx)],
    // The count refresh asks in chunks of 8; the first chunk never answers.
    ['listPortals', 'api.us.socrata.com', 8, (ctx) => svc.listPortals(ctx)],
    [
      'fetchStagingRows',
      'data.cityofnewyork.us',
      1,
      (ctx) =>
        svc.fetchStagingRows(
          { domain: 'data.cityofnewyork.us', datasetId: 'erm2-nwe9', order: 'borough' },
          50_000,
          ctx,
        ),
    ],
  ];

  // listPortals degrades at the deadline instead of failing (#31): tested on its own below.
  it.each(entryPoints.filter(([name]) => name !== 'listPortals'))(
    '%s fails with Timeout retry_deadline_exceeded at 50 s when the upstream never answers',
    async (_name, host, requests, call) => {
      fetchSpy.mockImplementation(hangUntilAborted);

      const { state, outcome } = track(call(createMockContext()));
      await vi.advanceTimersByTimeAsync(49_999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const { error } = await outcome;
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(JsonRpcErrorCode.Timeout);
      expect((error as McpError).message).toBe(
        `The request to ${host} did not complete within this call's 50-second time limit.`,
      );
      expect((error as McpError).data).toEqual({
        reason: 'retry_deadline_exceeded',
        host,
        deadlineMs: 50_000,
        retryable: true,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(requests);
    },
  );

  it.each(entryPoints)(
    '%s keeps a caller abort in flight a cancellation, not a timeout',
    async (_name, _host, _requests, call) => {
      const controller = new AbortController();
      const cancellation = new DOMException('Caller cancelled the request', 'AbortError');
      fetchSpy.mockImplementation((input, init) => {
        controller.abort(cancellation);
        return hangUntilAborted(input, init);
      });

      const { outcome } = track(call(createMockContext({ signal: controller.signal })));
      await vi.advanceTimersByTimeAsync(0);

      expect((await outcome).error).toBe(cancellation);
    },
  );

  /** A Discovery count answer for every portal: 42 datasets each. */
  const countOf42 = () => Promise.resolve(jsonResponse({ resultSetSize: 42 }, 200, 'OK'));

  it('listPortals serves the catalog with null counts when the deadline cuts the refresh, and leaves the counts due (#31, #59)', async () => {
    fetchSpy.mockImplementation(hangUntilAborted);

    const { state, outcome } = track(svc.listPortals(createMockContext()));
    await vi.advanceTimersByTimeAsync(49_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(state.settled).toBe(true);
    const { value, error } = await outcome;
    expect(error).toBeUndefined();
    const portals = value as { domain: string; datasetCount: number | null }[];
    expect(portals).toHaveLength(39);
    expect(portals.every((p) => p.datasetCount === null)).toBe(true);
    // Only the first chunk of 8 was asked; nothing is sent once the deadline has passed.
    expect(fetchSpy).toHaveBeenCalledTimes(8);

    // The cut refresh did not mark the cache fresh: the next call counts every portal.
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(countOf42);
    const next = await svc.listPortals(createMockContext());
    expect(fetchSpy).toHaveBeenCalledTimes(39);
    expect(next.every((p) => p.datasetCount === 42)).toBe(true);
  });

  it('listPortals keeps the counts that resolved before the deadline cut the refresh (#59)', async () => {
    let asked = 0;
    // The first chunk of 8 answers at once; every later request hangs.
    fetchSpy.mockImplementation((input, init) =>
      asked++ < 8 ? countOf42() : hangUntilAborted(input, init),
    );

    const { outcome } = track(svc.listPortals(createMockContext()));
    await vi.advanceTimersByTimeAsync(50_000);

    const { value, error } = await outcome;
    expect(error).toBeUndefined();
    const counts = (value as { datasetCount: number | null }[]).map((p) => p.datasetCount);
    expect(counts.slice(0, 8)).toEqual(Array(8).fill(42));
    expect(counts.slice(8).every((c) => c === null)).toBe(true);
    // Chunks one and two were asked; the rest were not sent after the deadline.
    expect(fetchSpy).toHaveBeenCalledTimes(16);
  });

  it('stops a 5xx retry ladder at the deadline instead of running it out', async () => {
    // Every attempt answers 503 after 20 s: four attempts would run past 80 s;
    // the third starts near 41 s and is cut at 50 s.
    fetchSpy.mockImplementation(
      answerAfter(20_000, () => new Response('busy', { status: 503, statusText: 'Busy' })),
    );

    const { state, outcome } = track(
      svc.getDataset('data.cdc.gov', 'bi63-dtpu', createMockContext()),
    );
    await vi.advanceTimersByTimeAsync(49_999);
    expect(state.settled).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    const { error } = await outcome;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', host: 'data.cdc.gov' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('reports the 429, not the deadline, when the attempt the deadline cut followed a rate limit', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ message: 'Slow down' }, 429, 'Too Many Requests', { 'Retry-After': '1' }),
      )
      .mockImplementation(hangUntilAborted);

    const { outcome } = track(
      svc.queryDataset({ domain: 'data.cdc.gov', datasetId: 'bi63-dtpu' }, createMockContext()),
    );
    await vi.advanceTimersByTimeAsync(50_000);

    const { error } = await outcome;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: '1' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('bounds the Discovery ID lookup by what is left of the deadline, not its own 2.5 s', async () => {
    fetchSpy.mockImplementation((input, init) =>
      originOf(input) === DISCOVERY_ORIGIN
        ? hangUntilAborted(input, init)
        : answerAfter(49_000, () =>
            jsonResponse(
              { code: 'not_found', error: true, message: 'Not found' },
              404,
              'Not Found',
            ),
          )(input, init),
    );

    const { state, outcome } = track(
      svc.getDataset('data.seattle.gov', 'erm2-nwe9', createMockContext()),
    );
    await vi.advanceTimersByTimeAsync(49_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const { error } = await outcome;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'Dataset erm2-nwe9 not found on data.seattle.gov.',
      data: { reason: 'not_found', dataset_id: 'erm2-nwe9' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('bounds the gateway diagnostic by what is left of the deadline, not its own 2.5 s', async () => {
    fetchSpy.mockImplementation((input, init) => {
      const url = new URL(String(input));
      if (url.origin === DISCOVERY_ORIGIN)
        return Promise.resolve(discoveryIdsResponse('data.cityofnewyork.us'));
      if (url.search === '?%24limit=1') return hangUntilAborted(input, init);
      return answerAfter(48_000, gateway403)(input, init);
    });

    const { state, outcome } = track(
      svc.queryDataset(
        { domain: 'data.cityofnewyork.us', datasetId: 'erm2-nwe9', select: 'x' },
        createMockContext(),
      ),
    );
    await vi.advanceTimersByTimeAsync(49_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const { error } = await outcome;
    expect(error).toMatchObject({ data: { reason: 'unknown_domain' } });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('shares one deadline across the requests of a call, and starts a fresh one per call', async () => {
    const ctx = createMockContext();
    fetchSpy
      .mockImplementationOnce(answerAfter(30_000, () => jsonResponse([{ a: '1' }], 200, 'OK')))
      .mockImplementation(hangUntilAborted);

    // One row under limit 2: no recount, so the query is one request taking 30 s.
    const query = track(
      svc.queryDataset({ domain: 'data.cdc.gov', datasetId: 'bi63-dtpu', limit: 2 }, ctx),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await query.outcome).value).toMatchObject({ rowCount: 1 });

    // Staging gets the 20 s the query left.
    const staging = track(
      svc.fetchStagingRows({ domain: 'data.cdc.gov', datasetId: 'bi63-dtpu' }, 50_000, ctx),
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(staging.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await staging.outcome).error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded' },
    });

    // Past the deadline, the same call sends nothing more.
    const late = await rejectionOf(
      svc.fetchStagingRows({ domain: 'data.cdc.gov', datasetId: 'bi63-dtpu' }, 50_000, ctx),
    );
    expect(late.data).toMatchObject({ reason: 'retry_deadline_exceeded' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // A new call has its own 50 s.
    const fresh = track(svc.getDataset('data.cdc.gov', 'bi63-dtpu', createMockContext()));
    await vi.advanceTimersByTimeAsync(49_999);
    expect(fresh.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await fresh.outcome).error).toMatchObject({
      data: { reason: 'retry_deadline_exceeded' },
    });
  });
});
