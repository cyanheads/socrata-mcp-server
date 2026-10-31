/**
 * @fileoverview Tests for the find-datasets tool.
 * @module tests/tools/find-datasets.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { findDatasets } from '@/mcp-server/tools/definitions/find-datasets.tool.js';
import { contentText } from './content-text.js';

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: vi.fn(),
}));

import { getSocrataService } from '@/services/socrata/socrata-service.js';

const mockFindDatasets = vi.fn();
const mockService = { findDatasets: mockFindDatasets };

beforeEach(() => {
  vi.clearAllMocks();
  (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Import a fresh copy of the tool with SOCRATA_CLAMP_LIMITS set to `flag`, its
 * service accessor returning `service`. The schema reads the flag at import, so
 * each mode needs its own module instance. `''` reads as unset: importing the
 * config loads `.env`, which refills a deleted key but never overrides a set one.
 */
async function loadFindDatasets(flag: string, service: unknown = mockService) {
  vi.stubEnv('SOCRATA_CLAMP_LIMITS', flag);
  vi.resetModules();
  const accessor = await import('@/services/socrata/socrata-service.js');
  (accessor.getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(service);
  return (await import('@/mcp-server/tools/definitions/find-datasets.tool.js')).findDatasets;
}

/** `count` service-shaped Discovery results, numbered from `start`. */
function discoveryResults(count: number, start = 0) {
  return Array.from({ length: count }, (_, i) => ({
    datasetId: `abcd-${String(start + i).padStart(4, '0')}`,
    domain: 'data.cityofnewyork.us',
    name: `Dataset ${start + i}`,
    tags: [],
    columnNames: [],
  }));
}

const WINDOW_TAIL =
  'The Discovery catalog serves only the first 10,000 matches of a search, so no later page exists; narrow the search with domain, categories, tags, query, or only to reach the rest.';

describe('findDatasets', () => {
  it('escapes caller filters in authored notices while retaining the raw query echo', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });
    await findDatasets.handler(
      findDatasets.input.parse({ query: '[x](https://example.com)', tags: ['*tag*'] }),
      ctx,
    );
    expect(getEnrichment(ctx)).toEqual({
      totalCount: 0,
      effectiveQuery: '[x](https://example.com)',
      notice:
        'No datasets matched with query="\\[x\\](https://example.com)", tags=\\*tag\\*. Try broader search terms, remove category/tag filters, or omit domain to search all portals.',
    });
  });

  it('returns results for a basic query', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({
      results: [
        {
          datasetId: 'kzjm-xkqj',
          domain: 'data.seattle.gov',
          name: 'Seattle 911 Incidents',
          tags: ['public safety', '911'],
          columnNames: ['incident_type', 'date'],
        },
      ],
      totalCount: 1,
    });

    const input = findDatasets.input.parse({ query: '911' });
    const result = await findDatasets.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!).toMatchObject({
      dataset_id: 'kzjm-xkqj',
      domain: 'data.seattle.gov',
      name: 'Seattle 911 Incidents',
    });
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.effectiveQuery).toBe('911');
  });

  it('returns empty results with enrichment notice when no datasets found', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });

    const input = findDatasets.input.parse({ query: 'xyzabcnotreal' });
    const result = await findDatasets.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No datasets matched');
  });

  it('names the offset as past the end of the matches on an empty page past offset 0 (#52)', async () => {
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 25 });

    const result = await runToolContract(findDatasets, {
      domain: 'data.cityofnewyork.us',
      query: 'restaurant',
      offset: 5000,
    });

    const notice =
      'The offset 5000 is past the end of the 25 matching datasets. Page with an offset below 25.';
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.totalCount).toBe(25);
    expect(sc.notice).toBe(notice);
    expect(contentText(result)).toContain(`> ${notice}`);
    expect(contentText(result)).not.toContain('Try broader search terms');
  });

  it('uses the singular for a match of one dataset (#52)', async () => {
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 1 });

    const result = await runToolContract(findDatasets, { query: 'restaurant', offset: 10 });

    expect((result.structuredContent as Record<string, unknown>).notice).toBe(
      'The offset 10 is past the end of the 1 matching dataset. Page with an offset below 1.',
    );
  });

  it('keeps the empty-result notice past offset 0 when nothing matches (#52)', async () => {
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });

    const result = await runToolContract(findDatasets, { query: 'xyzabcnotreal', offset: 20 });

    expect((result.structuredContent as Record<string, unknown>).notice).toBe(
      'No datasets matched with query="xyzabcnotreal". Try broader search terms, remove category/tag filters, or omit domain to search all portals.',
    );
  });

  it('applies domain scoping when provided', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });

    const input = findDatasets.input.parse({ domain: 'data.seattle.gov' });
    await findDatasets.handler(input, ctx);

    const call = mockFindDatasets.mock.calls[0]![0];
    expect(call.domain).toBe('data.seattle.gov');
  });

  it('echoes query in enrichment when provided', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({
      results: [
        {
          datasetId: 'abcd-efgh',
          domain: 'data.cityofnewyork.us',
          name: 'NYC Tree Census',
          tags: [],
          columnNames: ['tree_id'],
        },
      ],
      totalCount: 1,
    });

    const input = findDatasets.input.parse({ query: 'trees' });
    await findDatasets.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('trees');
  });

  it('handles sparse upstream result (no optional fields)', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({
      results: [
        {
          datasetId: 'aaaa-1111',
          domain: 'data.example.gov',
          name: 'Minimal Dataset',
          tags: [],
          columnNames: [],
          // description, category, license, dataUpdatedAt, viewCount all absent
        },
      ],
      totalCount: 1,
    });

    const input = findDatasets.input.parse({});
    const result = await findDatasets.handler(input, ctx);

    expect(result.results[0]!).toMatchObject({
      dataset_id: 'aaaa-1111',
      name: 'Minimal Dataset',
    });
    expect(result.results[0]!.description).toBeUndefined();
    expect(result.results[0]!.license).toBeUndefined();
    expect(result.results[0]!.view_count).toBeUndefined();
  });

  it('formats results with dataset IDs and names', () => {
    const output = {
      results: [
        {
          dataset_id: 'kzjm-xkqj',
          domain: 'data.seattle.gov',
          name: 'Seattle 911 Incidents',
          tags: ['911', 'public safety'],
          column_names: ['incident_type', 'date'],
        },
      ],
    };
    const blocks = findDatasets.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('kzjm-xkqj');
    expect(text).toContain('Seattle 911 Incidents');
    expect(text).toContain('data.seattle.gov');
    expect(text).toContain('**Columns (field names):** incident_type, date');
  });

  it('describes column_names as SoQL field names, not labels or a preview (#29)', () => {
    const describe = findDatasets.output.shape.results.element.shape.column_names.description ?? '';
    expect(describe).toContain('API field names');
    expect(describe).not.toMatch(/preview/i);
    expect(findDatasets.description).toContain('column_names');
    expect(findDatasets.description).not.toContain('columnNames');
  });

  it('formats empty results as empty text', () => {
    const output = { results: [] };
    const blocks = findDatasets.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
  });

  it('format renders the whole description past the old 2,000-character cap, blockquoted (#19)', () => {
    const description = `${'a'.repeat(1500)}\n${'b'.repeat(960)}Z`;
    const output = {
      results: [
        {
          dataset_id: 'ijzp-q8t2',
          domain: 'data.cityofchicago.org',
          name: 'Crimes - 2001 to Present',
          tags: [],
          description,
          column_names: ['id'],
        },
      ],
    };
    const text = (findDatasets.format!(output)[0] as { text?: string }).text ?? '';

    expect(description).toHaveLength(2462);
    expect(text).toContain(
      `**Upstream dataset description:**\n> ${'a'.repeat(1500)}\n> ${'b'.repeat(960)}Z\n\n`,
    );
    expect(text).not.toContain('[truncated]');
  });

  it('format renders every column name — no 8-column render cap (#19)', () => {
    const columnNames = Array.from({ length: 12 }, (_, i) => `col_${i}`);
    const output = {
      results: [
        {
          dataset_id: 'kzjm-xkqj',
          domain: 'data.seattle.gov',
          name: 'Wide Dataset',
          tags: [],
          column_names: columnNames,
        },
      ],
    };
    const blocks = findDatasets.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    // All 12 columns render; no "(+N more)" summary marker replaces the tail.
    for (const c of columnNames) expect(text).toContain(c);
    expect(text).not.toMatch(/\+\d+ more/);
  });
});

describe('findDatasets limit schema and SOCRATA_CLAMP_LIMITS (#55)', () => {
  /** The advertised JSON Schema of the `limit` input. */
  function limitSchema(def: typeof findDatasets) {
    const { properties } = z.toJSONSchema(def.input);
    return properties?.limit as { maximum?: number; description?: string };
  }

  it.each([
    ['unset', ''],
    ['true', 'true'],
  ])(
    'with the switch %s, advertises the 10,000 ceiling and accepts an over-cap limit',
    async (_l, flag) => {
      const def = await loadFindDatasets(flag);

      expect(limitSchema(def)).toMatchObject({
        maximum: 10_000,
        description:
          'Number of results to return (1–10,000). One call returns at most 100 results: a larger limit is served as 100, with a notice naming the offset that continues. Default 10.',
      });
      expect(def.input.parse({ limit: 101 }).limit).toBe(101);
      expect(def.input.parse({ limit: 10_000 }).limit).toBe(10_000);
      expect(() => def.input.parse({ limit: 10_001 })).toThrow();
      expect(() => def.input.parse({ limit: 0 })).toThrow();
    },
  );

  it('with the switch false, restores 100 as the schema maximum and rejects an over-cap limit', async () => {
    const def = await loadFindDatasets('false');

    expect(limitSchema(def)).toMatchObject({
      maximum: 100,
      description: 'Number of results to return (1–100). Default 10.',
    });
    expect(def.input.parse({ limit: 100 }).limit).toBe(100);
    expect(() => def.input.parse({ limit: 101 })).toThrow();
    const result = await runToolContract(def, { limit: 101 });
    expect(result.isError).toBe(true);
    expect(mockFindDatasets).not.toHaveBeenCalled();
  });
});

describe('findDatasets per-call cap and the 10,000-match window (#53, #55)', () => {
  let def: typeof findDatasets;

  beforeEach(async () => {
    def = await loadFindDatasets('true');
  });

  it('serves an over-cap limit at the 100-result cap and names the offset that continues', async () => {
    mockFindDatasets.mockResolvedValue({ results: discoveryResults(100), totalCount: 5000 });

    const result = await runToolContract(def, { only: 'datasets', limit: 1000 });

    expect(mockFindDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, offset: 0 }),
      expect.anything(),
    );
    const notice =
      'The requested limit 1000 was served as 100: the per-call cap is 100. Continue with offset 100.';
    const sc = result.structuredContent as Record<string, unknown> & { results: unknown[] };
    expect(sc.results).toHaveLength(100);
    expect(sc.notice).toBe(notice);
    expect(sc).not.toHaveProperty('totalCountCapped');
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it('continues from the offset it was given', async () => {
    mockFindDatasets.mockResolvedValue({ results: discoveryResults(100, 200), totalCount: 5000 });

    const result = await runToolContract(def, { limit: 250, offset: 200 });

    expect(mockFindDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, offset: 200 }),
      expect.anything(),
    );
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'The requested limit 250 was served as 100: the per-call cap is 100. Continue with offset 300.',
    );
  });

  it('adds no notice for a limit at the cap', async () => {
    mockFindDatasets.mockResolvedValue({ results: discoveryResults(100), totalCount: 5000 });

    const result = await runToolContract(def, { limit: 100 });

    expect(mockFindDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
      expect.anything(),
    );
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('adds no notice when an over-cap page already holds every match', async () => {
    mockFindDatasets.mockResolvedValue({ results: discoveryResults(25), totalCount: 25 });

    const result = await runToolContract(def, { limit: 1000 });

    expect(mockFindDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
      expect.anything(),
    );
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('was served as');
  });

  it('cuts the limit to the matches left in the window (offset 9995, limit 10 → 5)', async () => {
    mockFindDatasets.mockResolvedValue({ results: discoveryResults(5, 9995), totalCount: 10_000 });

    const result = await runToolContract(def, { only: 'datasets', limit: 10, offset: 9995 });

    expect(mockFindDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, offset: 9995 }),
      expect.anything(),
    );
    const notice = `The requested limit 10 was served as 5: this page ends at match 10,000. ${WINDOW_TAIL}`;
    const sc = result.structuredContent as Record<string, unknown> & { results: unknown[] };
    expect(sc.results).toHaveLength(5);
    expect(sc.notice).toBe(notice);
    expect(sc.totalCountCapped).toBe(true);
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it('combines the cap and the window into one limit and one notice (offset 9950, limit 1000 → 50)', async () => {
    mockFindDatasets.mockResolvedValue({ results: discoveryResults(50, 9950), totalCount: 10_000 });

    const result = await runToolContract(def, { limit: 1000, offset: 9950 });

    expect(mockFindDatasets).toHaveBeenCalledTimes(1);
    expect(mockFindDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, offset: 9950 }),
      expect.anything(),
    );
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      `The requested limit 1000 was served as 50: the per-call cap is 100, and this page ends at match 10,000. ${WINDOW_TAIL}`,
    );
  });

  it('names the window, not offset 10,000, when a capped page ends at the last match', async () => {
    mockFindDatasets.mockResolvedValue({
      results: discoveryResults(100, 9900),
      totalCount: 10_000,
    });

    const result = await runToolContract(def, { limit: 1000, offset: 9900 });

    expect(mockFindDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, offset: 9900 }),
      expect.anything(),
    );
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toBe(
      `The requested limit 1000 was served as 100: the per-call cap is 100, and this page ends at match 10,000. ${WINDOW_TAIL}`,
    );
    expect(notice).not.toContain('Continue with offset');
  });

  it('serves an in-window page unchanged (offset 9990, limit 10)', async () => {
    mockFindDatasets.mockResolvedValue({ results: discoveryResults(10, 9990), totalCount: 10_000 });

    const result = await runToolContract(def, { only: 'datasets', limit: 10, offset: 9990 });

    expect(mockFindDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 9990 }),
      expect.anything(),
    );
    const sc = result.structuredContent as Record<string, unknown> & { results: unknown[] };
    expect(sc.results).toHaveLength(10);
    expect(sc).not.toHaveProperty('notice');
  });

  it('adds no window notice when the matches end before match 10,000', async () => {
    mockFindDatasets.mockResolvedValue({ results: discoveryResults(3, 9995), totalCount: 9998 });

    const result = await runToolContract(def, { limit: 10, offset: 9995 });

    expect(mockFindDatasets).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
      expect.anything(),
    );
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(result.structuredContent).not.toHaveProperty('totalCountCapped');
  });

  it.each([10_000, 25_000])(
    'rejects offset %i with result_window_exceeded before any request',
    async (offset) => {
      const result = await runToolContract(def, { only: 'datasets', offset });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { code: number; data: Record<string, unknown> };
      };
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'result_window_exceeded',
        offset,
        recovery: {
          hint: 'Narrow the search with domain, categories, tags, query, or only so the matches you need fall within the first 10,000, then page with an offset below 10,000.',
        },
      });
      expect(contentText(result)).toContain(
        `offset ${offset} is past the Discovery result window: the catalog serves only the first 10,000 matches of a search.`,
      );
      expect(mockFindDatasets).not.toHaveBeenCalled();
    },
  );

  it('flags totalCount as a lower bound when it reaches 10,000', async () => {
    mockFindDatasets.mockResolvedValue({ results: discoveryResults(1), totalCount: 10_000 });

    const result = await runToolContract(def, { only: 'datasets', limit: 1 });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.totalCount).toBe(10_000);
    expect(sc.totalCountCapped).toBe(true);
    expect(sc).not.toHaveProperty('notice');
    expect(contentText(result)).toContain('**totalCountCapped:** true');
  });

  it('carries no totalCountCapped and no notice below 10,000 matches', async () => {
    // Live 2026-10-30: { domain: data.cityofnewyork.us, query: restaurant } → 25 matches.
    mockFindDatasets.mockResolvedValue({ results: discoveryResults(10), totalCount: 25 });

    const result = await runToolContract(def, {
      domain: 'data.cityofnewyork.us',
      query: 'restaurant',
    });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.totalCount).toBe(25);
    expect(sc).not.toHaveProperty('totalCountCapped');
    expect(sc).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('totalCountCapped');
  });

  it('gives an empty over-cap page only the empty-result notice', async () => {
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });

    const result = await runToolContract(def, { query: 'xyzabcnotreal', limit: 1000 });

    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'No datasets matched with query="xyzabcnotreal". Try broader search terms, remove category/tag filters, or omit domain to search all portals.',
    );
  });

  it('describes the multi-value filters as ORed and the offset bound', () => {
    expect(def.input.shape.categories.description).toBe(
      'Filter by domain categories (e.g. ["Public Safety", "Transportation"]). Multiple values are ORed: a dataset in any listed category matches.',
    );
    expect(def.input.shape.tags.description).toBe(
      'Filter by tags (e.g. ["covid19", "permits"]). Multiple values are ORed: a dataset carrying any listed tag matches.',
    );
    expect(def.input.shape.offset.description).toBe(
      'Pagination offset. Default 0. Must be below 10,000: the Discovery catalog serves only the first 10,000 matches of a search.',
    );
  });
});

describe('findDatasets through the Discovery client (#53, #55)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let def: typeof findDatasets;

  /** One raw Discovery result, as the catalog returns it. */
  const rawResult = (n: number) => ({
    resource: { id: `abcd-${String(n).padStart(4, '0')}`, name: `Dataset ${n}` },
    metadata: { domain: 'data.cityofnewyork.us' },
    classification: {},
  });

  beforeEach(async () => {
    const { SocrataService } = await vi.importActual<
      typeof import('@/services/socrata/socrata-service.js')
    >('@/services/socrata/socrata-service.js');
    def = await loadFindDatasets('true', new SocrataService());
    // A saturated catalog: every page within the window is full. Any other host fails the test.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname !== 'api.us.socrata.com') throw new Error(`Unexpected request: ${url}`);
      const limit = Number(url.searchParams.get('limit'));
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const results = Array.from({ length: limit }, (_, i) => rawResult(offset + i));
      return Response.json({ results, resultSetSize: 10_000 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests 50 for offset 9950, limit 1000 and returns them with one notice', async () => {
    const result = await runToolContract(def, { only: 'datasets', limit: 1000, offset: 9950 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sent = new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams;
    expect(sent.get('limit')).toBe('50');
    expect(sent.get('offset')).toBe('9950');
    const sc = result.structuredContent as Record<string, unknown> & {
      results: { dataset_id: string }[];
    };
    expect(sc.results).toHaveLength(50);
    expect(sc.results.at(-1)?.dataset_id).toBe('abcd-9999');
    expect(sc.totalCountCapped).toBe(true);
    expect(sc.notice).toBe(
      `The requested limit 1000 was served as 50: the per-call cap is 100, and this page ends at match 10,000. ${WINDOW_TAIL}`,
    );
  });

  it('sends no request for offset 10,000', async () => {
    const result = await runToolContract(def, { offset: 10_000 });

    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe('result_window_exceeded');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
