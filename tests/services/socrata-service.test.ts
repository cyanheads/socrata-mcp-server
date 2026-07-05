/**
 * @fileoverview Tests for the SocrataService fetch layer — SODA error-shape
 * detection in fetchJson (both `code` and `errorCode` families, app-token 403
 * discrimination), the grouped-query recount skip in queryDataset, the
 * TTL-cached per-portal dataset counts in listPortals, and row-count
 * derivation from column-level cachedContents in getDataset.
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

  it('maps a 403 app-token rejection to invalid_app_token without leaking the token value', async () => {
    const sentinelToken = 'secret-sentinel-token-abc123';
    mockGetServerConfig.mockReturnValue({
      appToken: sentinelToken,
      defaultDomain: 'data.seattle.gov',
    });
    // Real upstream shape for an invalid X-App-Token.
    fetchSpy.mockResolvedValue(
      jsonResponse(
        { code: 'permission_denied', error: true, message: 'Invalid app_token specified' },
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
    expect(thrown).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringContaining('Invalid app_token specified'),
      data: { reason: 'invalid_app_token', socrataCode: 'permission_denied' },
    });
    // The configured token value must never appear in the error payload.
    expect(thrown?.message).not.toContain(sentinelToken);
    expect(JSON.stringify(thrown?.data ?? {})).not.toContain(sentinelToken);
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
