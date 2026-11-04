/**
 * @fileoverview Tests for the find-datasets tool.
 * @module tests/tools/find-datasets.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { AssetTypeSchema } from '@/mcp-server/asset-type-schema.js';
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
 * Import a fresh copy of the tool, its service accessor returning `service`,
 * then parse the config with SOCRATA_CLAMP_LIMITS set to `flag`, as setup()
 * does: the `limit` schema reads the parsed switch. `''` reads as unset and is
 * never overwritten by a `.env` load, as a deleted key would be.
 */
async function loadFindDatasets(flag: string, service: unknown = mockService) {
  vi.stubEnv('SOCRATA_CLAMP_LIMITS', flag);
  vi.resetModules();
  const accessor = await import('@/services/socrata/socrata-service.js');
  (accessor.getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(service);
  const { findDatasets: def } = await import(
    '@/mcp-server/tools/definitions/find-datasets.tool.js'
  );
  (await import('@/config/server-config.js')).getServerConfig();
  return def;
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
  'The Discovery catalog serves only the first 10,000 matches of a search, so no later page exists; narrow the search with domain, query, or only, or with categories or tags alongside domain, to reach the rest.';

describe('findDatasets', () => {
  it('escapes caller filters in authored notices while retaining the raw query echo', async () => {
    const ctx = createMockContext({ errors: findDatasets.errors });
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });
    await findDatasets.handler(
      findDatasets.input.parse({
        query: '[x](https://example.com)',
        domain: 'data.cdc.gov',
        tags: ['*tag*'],
      }),
      ctx,
    );
    expect(getEnrichment(ctx)).toEqual({
      totalCount: 0,
      effectiveQuery: '[x](https://example.com)',
      notice:
        'No datasets matched with query="\\[x\\](https://example.com)", domain=data.cdc.gov, tags=\\*tag\\*. Try broader search terms, remove category/tag filters, or omit domain and those filters to search all portals.',
    });
  });

  it.each([
    [
      { query: 'xyzabcnotreal' },
      'No datasets matched with query="xyzabcnotreal". Try broader search terms.',
    ],
    [
      { domain: 'data.seattle.gov', query: 'xyzabcnotreal' },
      'No datasets matched with query="xyzabcnotreal", domain=data.seattle.gov. Try broader search terms, or omit domain to search all portals.',
    ],
    [
      { domain: 'data.cityofchicago.org', categories: ['Public Safety', 'Transportation'] },
      'No datasets matched with domain=data.cityofchicago.org, categories=Public Safety,Transportation. Try broader search terms, remove category/tag filters, or omit domain and those filters to search all portals.',
    ],
    [
      { domain: '  ', query: 'xyzabcnotreal', tags: [] },
      'No datasets matched with query="xyzabcnotreal". Try broader search terms.',
    ],
  ])(
    'offers only the levers the empty search can pull on both surfaces (%j)',
    async (args, notice) => {
      mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });

      const result = await runToolContract(findDatasets, args);

      expect((result.structuredContent as Record<string, unknown>).notice).toBe(notice);
      expect(contentText(result)).toContain(`> ${notice}`);
    },
  );

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
      'No datasets matched with query="xyzabcnotreal". Try broader search terms.',
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
          hint: 'Narrow the search with domain, query, or only, or with categories or tags alongside domain, so the matches you need fall within the first 10,000, then page with an offset below 10,000.',
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
      'No datasets matched with query="xyzabcnotreal". Try broader search terms.',
    );
  });

  it('describes the multi-value filters as ORed and needing domain, and the offset bound', () => {
    expect(def.input.shape.categories.description).toBe(
      'Filter by the portal\'s own categories (e.g. ["Public Safety", "Transportation"]). Requires domain: each portal assigns its own categories. Multiple values are ORed: a dataset in any listed category matches. Across portals, search with query instead.',
    );
    expect(def.input.shape.tags.description).toBe(
      'Filter by the portal\'s own tags (e.g. ["covid19", "permits"]). Requires domain: each portal assigns its own tags. Multiple values are ORed: a dataset carrying any listed tag matches. Across portals, search with query instead.',
    );
    expect(def.input.shape.domain.description).toContain('Required with categories or tags.');
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

describe('findDatasets categories and tags need domain, through the Discovery client (#65)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let def: typeof findDatasets;

  const RECOVERY =
    'Pass domain to filter one portal by its own categories and tags, or drop categories and tags and use query for a keyword search across every portal.';

  beforeEach(async () => {
    const { SocrataService } = await vi.importActual<
      typeof import('@/services/socrata/socrata-service.js')
    >('@/services/socrata/socrata-service.js');
    def = await loadFindDatasets('true', new SocrataService());
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname !== 'api.us.socrata.com') throw new Error(`Unexpected request: ${url}`);
      return Response.json({ results: [], resultSetSize: 0 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['tags', { tags: ['covid19'] }],
    ['categories', { categories: ['Public Safety'] }],
    ['categories and tags', { categories: ['Public Safety'], tags: ['covid19'], query: 'cases' }],
    ['tags', { tags: ['covid19'], domain: '   ' }],
    ['categories', { categories: ['Public Safety'], tags: [], only: 'datasets' as const }],
  ])(
    'rejects %s without domain as domain_required before any request (%j)',
    async (named, args) => {
      const result = await runToolContract(def, args);

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { code: number; message: string; data: Record<string, unknown> };
      };
      const message = `${named} need domain: categories and tags match one portal's own vocabulary, and without domain the catalog matches them against a different, Socrata-wide taxonomy.`;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(message);
      expect(error.data).toMatchObject({ reason: 'domain_required', recovery: { hint: RECOVERY } });
      const text = contentText(result);
      expect(text).toContain(`Error: ${message}`);
      expect(text).toContain(`Recovery: ${RECOVERY}`);
      expect(text).toContain('reason domain_required');
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('declares domain_required with its recovery in the error contract', () => {
    expect(def.errors?.find((e) => e.reason === 'domain_required')).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      recovery: RECOVERY,
    });
  });

  it('reads empty categories and tags without domain as unset and searches every portal', async () => {
    const result = await runToolContract(def, { query: 'covid', categories: [], tags: [] });

    expect(result.isError).toBeFalsy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sent = new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams;
    expect([...sent.entries()]).toEqual([
      ['q', 'covid'],
      ['limit', '10'],
    ]);
  });

  // A blank entry filters nothing (Discovery ignores an empty `tags=`), so it
  // reads as unset, the way a blank query or domain does.
  it.each([
    [
      { query: 'covid', tags: [''] },
      [
        ['q', 'covid'],
        ['limit', '10'],
      ],
    ],
    [
      { query: 'covid', categories: ['  '], tags: ['', ' '] },
      [
        ['q', 'covid'],
        ['limit', '10'],
      ],
    ],
    [
      { tags: ['covid19', ''], domain: 'data.cdc.gov' },
      [
        ['domains', 'data.cdc.gov'],
        ['search_context', 'data.cdc.gov'],
        ['tags', 'covid19'],
        ['limit', '10'],
      ],
    ],
  ])('reads blank categories and tags entries as unset (%j)', async (args, params) => {
    const result = await runToolContract(def, args);

    expect(result.isError).toBeFalsy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sent = new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams;
    expect([...sent.entries()]).toEqual(params);
  });

  it.each([
    [
      { tags: ['covid19'], domain: 'data.cdc.gov' },
      [
        ['domains', 'data.cdc.gov'],
        ['search_context', 'data.cdc.gov'],
        ['tags', 'covid19'],
        ['limit', '10'],
      ],
    ],
    [
      { categories: ['Public Safety'], domain: 'data.cityofchicago.org' },
      [
        ['domains', 'data.cityofchicago.org'],
        ['search_context', 'data.cityofchicago.org'],
        ['categories', 'Public Safety'],
        ['limit', '10'],
      ],
    ],
  ])('scopes %j to the portal with domains and search_context', async (args, params) => {
    const result = await runToolContract(def, args);

    expect(result.isError).toBeFalsy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sent = new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams;
    expect([...sent.entries()]).toEqual(params);
  });
});

describe('findDatasets asset_type and parent_dataset_ids through the Discovery client (#68)', () => {
  let def: typeof findDatasets;

  /** A story's 21 parents, the most any sampled record listed. */
  const STORY_PARENTS = Array.from({ length: 21 }, (_, i) => `s${String(i).padStart(3, '0')}-abcd`);

  /** One raw Discovery result on data.cityofchicago.org, `resource` as the catalog returns it. */
  const record = (resource: Record<string, unknown>) => ({
    resource,
    metadata: { domain: 'data.cityofchicago.org' },
    classification: {},
  });

  /** Live-shaped records (2026-11-03) plus a sparse one and a 21-parent story. */
  const RECORDS = [
    record({ id: 'dfnk-7re6', name: 'Crimes - Map', type: 'map', parent_fxf: ['x2n5-8w5q'] }),
    record({ id: 'vwwp-7yr9', name: 'Crimes - 2015', type: 'filter', parent_fxf: ['ijzp-q8t2'] }),
    record({ id: 'ijzp-q8t2', name: 'Crimes - 2001 to Present', type: 'dataset', parent_fxf: [] }),
    record({ id: 'zzzz-0001', name: 'Sparse record' }),
    record({ id: 'zzzz-0002', name: 'Crime story', type: 'story', parent_fxf: STORY_PARENTS }),
  ];

  beforeEach(async () => {
    const { SocrataService } = await vi.importActual<
      typeof import('@/services/socrata/socrata-service.js')
    >('@/services/socrata/socrata-service.js');
    def = await loadFindDatasets('true', new SocrataService());
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(Response.json({ results: RECORDS, resultSetSize: RECORDS.length })),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports each result’s asset type and parents on structuredContent, absent when the catalog lists none', async () => {
    const result = await runToolContract(def, {
      domain: 'data.cityofchicago.org',
      query: 'crimes',
    });

    expect(result.isError).toBeFalsy();
    const { results } = result.structuredContent as {
      results: Record<string, unknown>[];
    };
    expect(results.map((r) => [r.dataset_id, r.asset_type, r.parent_dataset_ids])).toEqual([
      ['dfnk-7re6', 'map', ['x2n5-8w5q']],
      ['vwwp-7yr9', 'filter', ['ijzp-q8t2']],
      ['ijzp-q8t2', 'dataset', undefined],
      ['zzzz-0001', undefined, undefined],
      ['zzzz-0002', 'story', STORY_PARENTS],
    ]);
    expect(results[2]).not.toHaveProperty('parent_dataset_ids');
    expect(results[3]).not.toHaveProperty('asset_type');
    expect(results[3]).not.toHaveProperty('parent_dataset_ids');
    // Existing fields are unchanged.
    expect(results[0]).toMatchObject({
      domain: 'data.cityofchicago.org',
      name: 'Crimes - Map',
      tags: [],
      column_names: [],
    });
  });

  it('renders the type on the ID line and every parent on a Built on line in content[]', async () => {
    const result = await runToolContract(def, {
      domain: 'data.cityofchicago.org',
      query: 'crimes',
    });

    const sections = contentText(result).split('\n### ').slice(1);
    expect(sections).toHaveLength(5);
    expect(sections[0]).toContain(
      '**ID:** dfnk-7re6 | **Domain:** data.cityofchicago.org | **Type:** map\n**Built on:** x2n5-8w5q\n',
    );
    expect(sections[1]).toContain('| **Type:** filter\n**Built on:** ijzp-q8t2\n');
    expect(sections[2]).toContain(
      '**ID:** ijzp-q8t2 | **Domain:** data.cityofchicago.org | **Type:** dataset\n',
    );
    expect(sections[2]).not.toContain('**Built on:**');
    expect(sections[3]).toContain('**ID:** zzzz-0001 | **Domain:** data.cityofchicago.org\n');
    expect(sections[3]).not.toContain('**Type:**');
    expect(sections[3]).not.toContain('**Built on:**');
    // All 21 parents, in order: no render-only cut.
    expect(sections[4]).toContain(`**Built on:** ${STORY_PARENTS.join(', ')}\n`);
  });

  it('describes asset_type with the shared catalog asset-type text, and parent_dataset_ids', () => {
    const { shape } = def.output.shape.results.element;
    expect(shape.asset_type.description).toBe(AssetTypeSchema.description);
    expect(shape.parent_dataset_ids.description).toContain('Absent when the catalog lists none');
  });
});
