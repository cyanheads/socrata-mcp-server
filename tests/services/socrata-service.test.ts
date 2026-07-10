/**
 * @fileoverview Tests for the SocrataService fetch layer — SODA error-shape
 * detection in fetchJson (both `code` and `errorCode` families, app-token 403
 * discrimination), the keyless degradation + retry on an invalid app token, the
 * Discovery domain-alias expansion in findDatasets, the grouped-query recount
 * skip in queryDataset, the TTL-cached per-portal dataset counts in listPortals,
 * and row-count derivation from column-level cachedContents in getDataset.
 * Stubs `globalThis.fetch` so the real classification path executes.
 * @module tests/services/socrata-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPortalCountCache, SocrataService } from '@/services/socrata/socrata-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(),
}));

import { getServerConfig } from '@/config/server-config.js';

const mockGetServerConfig = getServerConfig as ReturnType<typeof vi.fn>;

/** Build a JSON Response with the given status. */
function jsonResponse(body: unknown, status: number, statusText: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SocrataService.fetchJson error classification', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
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
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          code: 'permission_denied',
          error: true,
          message: 'You do not have permission to view this dataset',
        },
        403,
        'Forbidden',
      ),
    );

    const ctx = createMockContext();
    let thrown: McpError | undefined;
    try {
      await svc.getDataset('data.cityofchicago.org', 'ijzp-q8t2', ctx);
    } catch (err) {
      thrown = err as McpError;
    }

    expect(thrown).toBeInstanceOf(McpError);
    expect(thrown?.code).toBe(JsonRpcErrorCode.Forbidden);
    expect((thrown?.data as Record<string, unknown> | undefined)?.reason).toBeUndefined();
  });
});

describe('SocrataService.fetchJson keyless degradation on invalid app token (#23)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
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
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
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

describe('SocrataService.queryDataset total-count recount', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
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

  it('skips the recount entirely for grouped queries — no total_count, single request', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(atLimitRows, 200, 'OK'));

    const ctx = createMockContext();
    const result = await svc.queryDataset(
      {
        domain: 'data.cityofchicago.org',
        datasetId: 'ijzp-q8t2',
        select: 'primary_type, count(*) as n',
        group: 'primary_type',
        order: 'n DESC',
        limit: 5,
      },
      ctx,
    );

    expect(result.rowCount).toBe(5);
    expect(result.totalCount).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('still recounts ungrouped queries at the limit — total_count present, count request issued', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(atLimitRows, 200, 'OK'))
      .mockResolvedValueOnce(jsonResponse([{ count: '8582001' }], 200, 'OK'));

    const ctx = createMockContext();
    const result = await svc.queryDataset(
      {
        domain: 'data.cityofchicago.org',
        datasetId: 'ijzp-q8t2',
        where: "primary_type = 'THEFT'",
        limit: 5,
      },
      ctx,
    );

    expect(result.rowCount).toBe(5);
    expect(result.totalCount).toBe(8582001);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // URLSearchParams encodes spaces as '+'; normalize before asserting.
    const countUrl = decodeURIComponent(String(fetchSpy.mock.calls[1]?.[0])).replaceAll('+', ' ');
    expect(countUrl).toContain('$select=count(*)');
    expect(countUrl).toContain("$where=primary_type = 'THEFT'");
  });
});

describe('SocrataService.listPortals portal-count cache', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const svc = new SocrataService();

  /** Per-domain counts observed live (2026-07-04) with `only=dataset&limit=0`. */
  const liveCounts: Record<string, number> = {
    'data.cityofchicago.org': 909,
    'data.seattle.gov': 0,
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

    expect(portals).toHaveLength(40);
    expect(fetchSpy).toHaveBeenCalledTimes(40);
    // Count query is scoped to dataset-type assets, count-only.
    for (const call of fetchSpy.mock.calls) {
      const url = String(call[0]);
      expect(url).toContain('only=dataset');
      expect(url).toContain('limit=0');
    }
    const chicago = portals.find((p) => p.domain === 'data.cityofchicago.org');
    expect(chicago?.datasetCount).toBe(909);
  });

  it('preserves a genuine zero count (Seattle) — 0 is real data, not missing', async () => {
    fetchSpy.mockImplementation(countResponder);

    const ctx = createMockContext();
    const portals = await svc.listPortals(ctx);

    const seattle = portals.find((p) => p.domain === 'data.seattle.gov');
    expect(seattle?.datasetCount).toBe(0);
    expect(seattle?.datasetCount).not.toBeNull();
  });

  it('serves the second call from cache — no additional upstream requests', async () => {
    fetchSpy.mockImplementation(countResponder);

    const ctx = createMockContext();
    await svc.listPortals(ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(40);

    const again = await svc.listPortals(ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(40);
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

    expect(portals).toHaveLength(40);
    expect(portals.find((p) => p.domain === 'data.wa.gov')?.datasetCount).toBeNull();
    expect(portals.find((p) => p.domain === 'data.cityofchicago.org')?.datasetCount).toBe(909);
  });
});

describe('SocrataService.getDataset row-count derivation', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
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

describe('SocrataService.streamDatasetRows pagination', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const svc = new SocrataService();

  beforeEach(() => {
    mockGetServerConfig.mockReturnValue({ defaultDomain: 'data.seattle.gov' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function drain(gen: AsyncGenerator<Record<string, unknown>>) {
    const rows: Record<string, unknown>[] = [];
    for await (const row of gen) rows.push(row);
    return rows;
  }

  it('walks $offset across pages until a short page signals exhaustion', async () => {
    // A full first page (5000 = the SODA per-request ceiling) forces a second
    // request; the short second page ends the walk before an empty fetch.
    const page1 = Array.from({ length: 5000 }, (_, i) => ({ id: String(i) }));
    const page2 = Array.from({ length: 10 }, (_, i) => ({ id: String(5000 + i) }));
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(page1, 200, 'OK'))
      .mockResolvedValueOnce(jsonResponse(page2, 200, 'OK'));

    const ctx = createMockContext();
    const rows = await drain(
      svc.streamDatasetRows(
        { domain: 'data.seattle.gov', datasetId: 'kzjm-xkqj', where: "type = 'X'" },
        50_000,
        ctx,
      ),
    );

    // Canvas would stage all 5010 rows — more than a single page's worth.
    expect(rows).toHaveLength(5010);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const url1 = decodeURIComponent(String(fetchSpy.mock.calls[0]?.[0])).replaceAll('+', ' ');
    const url2 = decodeURIComponent(String(fetchSpy.mock.calls[1]?.[0])).replaceAll('+', ' ');
    // First page from offset 0 (no $offset), second continues at 5000.
    expect(url1).toContain('$limit=5000');
    expect(url1).not.toContain('$offset');
    expect(url2).toContain('$offset=5000');
    // The shared where-clause rides every page.
    expect(url1).toContain("$where=type = 'X'");
    expect(url2).toContain("$where=type = 'X'");
  });

  it('clamps the page $limit to the remaining cap and stops at maxRows', async () => {
    // maxRows below the page ceiling — the request must ask for exactly maxRows,
    // and a full page at the cap ends the walk without a second fetch.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        Array.from({ length: 3 }, (_, i) => ({ id: String(i) })),
        200,
        'OK',
      ),
    );

    const ctx = createMockContext();
    const rows = await drain(
      svc.streamDatasetRows({ domain: 'data.seattle.gov', datasetId: 'kzjm-xkqj' }, 3, ctx),
    );

    expect(rows).toHaveLength(3);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(String(fetchSpy.mock.calls[0]?.[0]))).toContain('$limit=3');
  });

  it('throws invalid_id before any fetch for a malformed dataset id', async () => {
    const ctx = createMockContext();
    await expect(
      drain(svc.streamDatasetRows({ domain: 'data.seattle.gov', datasetId: 'bad!!' }, 100, ctx)),
    ).rejects.toMatchObject({ data: { reason: 'invalid_id' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
