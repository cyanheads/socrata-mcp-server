/**
 * @fileoverview Tests for the SocrataService fetch layer — SODA error-shape
 * detection in fetchJson (both `code` and `errorCode` families, app-token 403
 * discrimination) and the grouped-query recount skip in queryDataset.
 * Stubs `globalThis.fetch` so the real classification path executes.
 * @module tests/services/socrata-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocrataService } from '@/services/socrata/socrata-service.js';

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
