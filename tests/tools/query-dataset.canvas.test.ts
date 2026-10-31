/**
 * @fileoverview End-to-end spill tests over a real DuckDB DataCanvas (the
 * CANVAS_PROVIDER_TYPE=duckdb path): the real SocrataService behind a fetch
 * fake that answers like SODA — X-SODA2-Fields / X-SODA2-Types headers
 * included — feeding socrata_query_dataset, then socrata_dataframe_describe and
 * socrata_dataframe_query against the staged table.
 * @module tests/tools/query-dataset.canvas.test
 */

import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dataframeDescribe } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { initSocrataService } from '@/services/socrata/socrata-service.js';
import { contentText } from './content-text.js';

/**
 * 150 Chicago-shaped rows as SODA 2.1 returns them: numbers as strings, booleans
 * as JSON booleans, null-valued keys omitted — `latitude` is null in the first
 * 100 rows, so a 100-row sniff never sees it.
 */
const CRIMES = Array.from({ length: 150 }, (_, i) => ({
  id: String(i + 1),
  primary_type: i % 2 === 0 ? 'HOMICIDE' : 'THEFT',
  year: String(2015 + (i % 10)),
  date: `2025-01-02T03:04:${String(i % 60).padStart(2, '0')}.000`,
  arrest: i % 3 === 0,
  ...(i >= 100 ? { latitude: String(41.8 + i / 1000) } : {}),
}));

const CRIME_HEADERS = {
  'X-SODA2-Fields': '["id","primary_type","year","date","arrest","latitude"]',
  'X-SODA2-Types': '["number","text","number","floating_timestamp","boolean","number"]',
};

let fetchMock: FetchMockHarness;
let canvas: DataCanvas;

/** The `$query` recount's answer: `rows` is the whole result the query matches. */
const recountOf = (rows: unknown[]) => Response.json([{ n: String(rows.length) }]);

/**
 * Answer every SODA resource request: the `$query` recount with the total,
 * any other request with the `$offset`/`$limit` slice of `rows` and `headers`.
 */
function serveSoda(
  rows: Record<string, unknown>[],
  headers: Record<string, string>,
  datasetId = 'ijzp-q8t2',
) {
  fetchMock = createFetchMock([
    {
      match: (request) => new URL(request.url).pathname === `/resource/${datasetId}.json`,
      respond: (request) => {
        const params = new URL(request.url).searchParams;
        if (params.has('$query')) return recountOf(rows);
        const offset = Number(params.get('$offset') ?? 0);
        const limit = Number(params.get('$limit'));
        return Response.json(rows.slice(offset, offset + limit), { headers });
      },
    },
  ]);
  fetchMock.install();
}

/**
 * Answer the main query from `rows`, the `$query` recount with `recount` (their
 * total by default), and every later request — the staging copy — with `staging`.
 */
function serveWithStaging(
  rows: Record<string, unknown>[],
  staging: (request: Request) => Promise<Response> | Response,
  recount: (request: Request) => Promise<Response> | Response = () => recountOf(rows),
) {
  let answered = 0;
  fetchMock = createFetchMock([
    {
      match: (request) => new URL(request.url).pathname === '/resource/ijzp-q8t2.json',
      respond: (request) => {
        const params = new URL(request.url).searchParams;
        if (params.has('$query')) return recount(request);
        if (answered++ > 0) return staging(request);
        return Response.json(rows.slice(0, Number(params.get('$limit'))), {
          headers: CRIME_HEADERS,
        });
      },
    },
  ]);
  fetchMock.install();
}

/** Never answer: reject only when the request's signal aborts. */
function hang(request: Request): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const { signal } = request;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Run socrata_query_dataset and return its output plus the context it ran under. */
async function spill(args: Record<string, unknown>) {
  const ctx = createMockContext({ errors: queryDataset.errors });
  const result = await queryDataset.handler(
    queryDataset.input.parse({
      domain: 'data.cityofchicago.org',
      dataset_id: 'ijzp-q8t2',
      ...args,
    }),
    ctx,
  );
  return { result, ctx };
}

/** Column name → DuckDB type, as socrata_dataframe_describe reports it. */
async function describeTypes(canvasId: string) {
  const described = await dataframeDescribe.handler(
    dataframeDescribe.input.parse({ canvas_id: canvasId }),
    createMockContext({ errors: dataframeDescribe.errors }),
  );
  return Object.fromEntries(described.tables[0]!.columns.map((c) => [c.name, c.type]));
}

/** Run SQL through socrata_dataframe_query. */
function sql(canvasId: string, statement: string) {
  return dataframeQuery.handler(
    dataframeQuery.input.parse({ canvas_id: canvasId, sql: statement }),
    createMockContext({ errors: dataframeQuery.errors }),
  );
}

beforeAll(() => {
  initSocrataService();
  const created = createCanvasService(parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' }));
  if (!created) throw new Error('CANVAS_PROVIDER_TYPE=duckdb did not produce a canvas.');
  canvas = created;
  setCanvas(canvas);
});

afterEach(() => {
  fetchMock.restore();
});

afterAll(async () => {
  setCanvas(undefined);
  await canvas.shutdown(requestContextService.createRequestContext({ operation: 'test' }));
});

describe('socrata_query_dataset spill on a DuckDB canvas', () => {
  it('stages a second page after a nonzero offset under the digit prefix (#44)', async () => {
    serveSoda(
      Array.from({ length: 5002 }, (_, i) => ({ id: String(i + 1) })),
      { 'X-SODA2-Fields': '["id"]', 'X-SODA2-Types': '["number"]' },
      '43nn-pn8j',
    );
    const { result } = await spill({ dataset_id: '43nn-pn8j', offset: 1, limit: 1 });
    expect(result.rows).toEqual([{ id: '2' }]);
    expect(result.canvas_row_count).toBe(5001);
    const bounds = await sql(
      result.canvas_id!,
      `SELECT min(id) as lo, max(id) as hi, count(*) as n FROM t_43nn_pn8j_rows`,
    );
    expect(bounds.rows[0]).toEqual({ lo: 2, hi: 5002, n: '5001' });
  });
  it.each([
    ['43nn-pn8j', 't_43nn_pn8j_rows'],
    ['ijzp-q8t2', 'ijzp_q8t2_rows'],
  ])(
    'stages %s with a stable valid name and preserves system-field projection (#44)',
    async (datasetId, tableName) => {
      const rows = [
        { id: '1', ':@computed_region_x': '9' },
        { id: '2', ':@computed_region_x': '8' },
      ];
      serveSoda(
        rows,
        {
          'X-SODA2-Fields': '["id",":@computed_region_x"]',
          'X-SODA2-Types': '["number","number"]',
        },
        datasetId,
      );
      const { result } = await spill({ dataset_id: datasetId, limit: 1 });
      expect(result.table_name).toBe(tableName);
      expect(result.rows).toEqual([rows[0]]);
      expect(result.canvas_row_count).toBe(2);
      expect(await describeTypes(result.canvas_id!)).toEqual({ id: 'DOUBLE' });
      const counted = await sql(result.canvas_id!, `SELECT count(*) as n FROM ${tableName}`);
      expect(String(counted.rows[0]!.n)).toBe('2');
      const text = queryDataset.format!(result)
        .map((c) => ('text' in c ? c.text : ''))
        .join('\n');
      expect(text).toContain(tableName);
      expect(text).toContain(':@computed_region_x');
    },
  );
  it('spills neither a below-limit page nor an offset past the end, which names the count (#52)', async () => {
    serveSoda([{ id: '1' }], { 'X-SODA2-Fields': '["id"]', 'X-SODA2-Types': '["number"]' });
    const full = await spill({ limit: 2 });
    expect(full.result.rows).toEqual([{ id: '1' }]);
    expect(full.result.canvas_id).toBeUndefined();
    const empty = await spill({ limit: 1, offset: 2 });
    expect(empty.result.rows).toEqual([]);
    expect(empty.result.canvas_id).toBeUndefined();
    expect(empty.result.total_count).toBe(1);
    expect(getEnrichment(empty.ctx).notice).toBe(
      'The offset 2 is past the end of the 1 matching row. Page with an offset below 1.',
    );
  });
  it('stages SODA number columns as DOUBLE, so numeric comparisons need no cast (#25)', async () => {
    serveSoda(CRIMES, CRIME_HEADERS);
    const { result } = await spill({ limit: 2 });

    expect(result.canvas_row_count).toBe(150);
    expect(await describeTypes(result.canvas_id!)).toEqual({
      id: 'DOUBLE',
      primary_type: 'VARCHAR',
      year: 'DOUBLE',
      date: 'VARCHAR',
      arrest: 'BOOLEAN',
      latitude: 'DOUBLE',
    });
    const recent = await sql(
      result.canvas_id!,
      `SELECT count(*) AS n FROM ${result.table_name} WHERE year > 2020`,
    );
    expect(String(recent.rows[0]!.n)).toBe(
      String(CRIMES.filter((r) => Number(r.year) > 2020).length),
    );
    // Inline rows keep the SODA strings.
    expect(result.rows[0]).toMatchObject({ id: '1', year: '2015' });
  });

  it('keeps a column null in the first 100 staged rows (#25)', async () => {
    serveSoda(CRIMES, CRIME_HEADERS);
    const { result } = await spill({ limit: 2 });

    const counted = await sql(
      result.canvas_id!,
      `SELECT count(latitude) AS c FROM ${result.table_name}`,
    );
    expect(String(counted.rows[0]!.c)).toBe('50');
  });

  it('leaves floating timestamps VARCHAR: a numeric compare fails, a CAST keeps wall-clock time (#25)', async () => {
    serveSoda(CRIMES, CRIME_HEADERS);
    const { result } = await spill({ limit: 2 });

    await expect(
      sql(result.canvas_id!, `SELECT count(*) FROM ${result.table_name} WHERE date > 2020`),
    ).rejects.toMatchObject({ data: { reason: 'invalid_sql' } });
    const cast = await sql(
      result.canvas_id!,
      `SELECT CAST(date AS TIMESTAMP) AS ts FROM ${result.table_name} WHERE id = 1`,
    );
    expect(cast.rows[0]!.ts).toBe('2025-01-02 03:04:00');
  });

  it('stages a number-typed aggregate alias as DOUBLE (#25)', async () => {
    const groups = Array.from({ length: 30 }, (_, i) => ({
      primary_type: `TYPE_${i}`,
      n: String(1000 - i),
    }));
    serveSoda(groups, {
      'X-SODA2-Fields': '["primary_type","n"]',
      'X-SODA2-Types': '["text","number"]',
    });
    const { result } = await spill({
      select: 'primary_type, count(*) as n',
      group: 'primary_type',
      limit: 5,
    });

    expect(await describeTypes(result.canvas_id!)).toEqual({
      primary_type: 'VARCHAR',
      n: 'DOUBLE',
    });
    const top = await sql(
      result.canvas_id!,
      `SELECT sum(n) AS total FROM ${result.table_name} WHERE n > 990`,
    );
    expect(top.rows[0]!.total).toBe(groups.slice(0, 10).reduce((s, g) => s + Number(g.n), 0));
  });

  it('falls back to inferred types with a warning when the type headers are missing (#25)', async () => {
    serveSoda(CRIMES, { 'X-SODA2-Fields': CRIME_HEADERS['X-SODA2-Fields'] });
    const { result, ctx } = await spill({ limit: 2 });

    expect(result.canvas_row_count).toBe(150);
    expect((await describeTypes(result.canvas_id!)).year).toBe('VARCHAR');
    const log = ctx.log as MockContextLogger;
    expect(log.calls.some((c) => c.level === 'warning' && /X-SODA2/.test(c.msg))).toBe(true);
  });

  it('names the staged table so the first SQL call against it succeeds (#30)', async () => {
    serveSoda(CRIMES, CRIME_HEADERS);
    const { result, ctx } = await spill({ limit: 1 });

    expect(result.rows).toHaveLength(1);
    expect(result.table_name).toBe('ijzp_q8t2_rows');
    expect(String(getEnrichment(ctx).notice)).toContain(`as table "${result.table_name}"`);
    const counted = await sql(result.canvas_id!, `SELECT count(*) AS n FROM ${result.table_name}`);
    expect(String(counted.rows[0]!.n)).toBe('150');
  });
});

describe('socrata_query_dataset staging: one bounded SODA request (#51)', () => {
  it('stages every matching row once under a non-unique order, in one request', async () => {
    // 12,000 rows over three primary_type values. As on SODA, each request
    // breaks ties its own way, so 5,000-row pages under order=primary_type overlap.
    const types = ['ARSON', 'BATTERY', 'THEFT'];
    const rows = Array.from({ length: 12_000 }, (_, i) => ({
      id: String(i + 1),
      primary_type: types[i % 3]!,
    }));
    let answered = 0;
    fetchMock = createFetchMock([
      {
        match: (request) => new URL(request.url).pathname === '/resource/ijzp-q8t2.json',
        respond: (request) => {
          const params = new URL(request.url).searchParams;
          if (params.has('$query')) return recountOf(rows);
          const tieOrder = answered++ % 2 === 0 ? 1 : -1;
          const ordered = rows.toSorted(
            (a, b) =>
              a.primary_type.localeCompare(b.primary_type) ||
              tieOrder * (Number(a.id) - Number(b.id)),
          );
          const offset = Number(params.get('$offset') ?? 0);
          return Response.json(ordered.slice(offset, offset + Number(params.get('$limit'))), {
            headers: {
              'X-SODA2-Fields': '["id","primary_type"]',
              'X-SODA2-Types': '["number","text"]',
            },
          });
        },
      },
    ]);
    fetchMock.install();

    const { result } = await spill({ select: 'id, primary_type', order: 'primary_type', limit: 5 });

    expect(result.canvas_row_count).toBe(12_000);
    const counted = await sql(
      result.canvas_id!,
      `SELECT count(*) AS n, count(DISTINCT id) AS ids FROM ${result.table_name}`,
    );
    expect(String(counted.rows[0]!.n)).toBe('12000');
    expect(String(counted.rows[0]!.ids)).toBe('12000');
    // Main query, recount, and exactly one staging request: the caller's clauses, $limit 50,000, no tiebreaker.
    const staging = fetchMock.calls
      .map((c) => new URL(c.request.url).searchParams)
      .filter((p) => !p.has('$query'))
      .slice(1);
    expect(staging.map((p) => Object.fromEntries(p))).toEqual([
      { $select: 'id, primary_type', $order: 'primary_type', $limit: '50000' },
    ]);
  });

  it('sends the caller offset on the one staging request', async () => {
    serveWithStaging(CRIMES, (request) => {
      const params = new URL(request.url).searchParams;
      return Response.json(CRIMES.slice(Number(params.get('$offset') ?? 0)), {
        headers: CRIME_HEADERS,
      });
    });

    const { result } = await spill({ offset: 30, limit: 2 });

    expect(result.canvas_row_count).toBe(120);
    const staged = fetchMock.calls.map((c) => new URL(c.request.url).searchParams).at(-1)!;
    expect(staged.get('$offset')).toBe('30');
    expect(staged.get('$limit')).toBe('50000');
  });

  it('returns the inline page with the time-bound notice and no canvas_id when staging outlasts the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      serveWithStaging(CRIMES, hang);

      const pending = runToolContract(queryDataset, {
        domain: 'data.cityofchicago.org',
        dataset_id: 'ijzp-q8t2',
        limit: 2,
      });
      // Main query and recount answer at once; the staging request then hangs.
      await vi.waitFor(() => expect(fetchMock.calls).toHaveLength(3));
      await vi.advanceTimersByTimeAsync(50_000);
      const result = await pending;

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.rows).toHaveLength(2);
      expect(structured.canvas_id).toBeUndefined();
      expect(structured.table_name).toBeUndefined();
      const notStaged =
        "The matching rows were not staged on the canvas within the call's 50-second time limit; a narrower where, or no order, stages faster.";
      expect(String(structured.notice)).toContain(notStaged);
      const text = contentText(result);
      expect(text).toContain(notStaged);
      // Main query, recount, and the one staging request the deadline cut.
      expect(fetchMock.calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the failure class when the staging request fails, and keeps the inline page', async () => {
    // A Retry-After past the retry cap fails at once as rate_limited.
    serveWithStaging(
      CRIMES,
      () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }),
    );

    const { result, ctx } = await spill({ limit: 2 });

    expect(result.rows).toHaveLength(2);
    expect(result.canvas_id).toBeUndefined();
    expect(String(getEnrichment(ctx).notice)).toContain(
      'The matching rows were not staged on the canvas (rate_limited).',
    );
  });

  it('fails the call as cancelled when the caller aborts during staging', async () => {
    const controller = new AbortController();
    const cancellation = new DOMException('Caller cancelled the query', 'AbortError');
    serveWithStaging(CRIMES, (request) => {
      controller.abort(cancellation);
      return hang(request);
    });

    await expect(
      queryDataset.handler(
        queryDataset.input.parse({
          domain: 'data.cityofchicago.org',
          dataset_id: 'ijzp-q8t2',
          limit: 2,
        }),
        createMockContext({ errors: queryDataset.errors, signal: controller.signal }),
      ),
    ).rejects.toBe(cancellation);
  });
});

describe('socrata_query_dataset recount through the real service (#50, #52)', () => {
  /** The recount requests the call sent. */
  const recounts = () =>
    fetchMock.calls.map((c) => new URL(c.request.url).searchParams).filter((p) => p.has('$query'));

  it('reports a distinct select’s distinct count, not the source rows, and stages it (#50 repro 1)', async () => {
    const boros = ['Bronx', 'Brooklyn', 'Manhattan', 'Queens', 'Staten Island', '0'].map(
      (boro) => ({ boro }),
    );
    serveSoda(boros, { 'X-SODA2-Fields': '["boro"]', 'X-SODA2-Types': '["text"]' }, '43nn-pn8j');

    const result = await runToolContract(queryDataset, {
      domain: 'data.cityofnewyork.us',
      dataset_id: '43nn-pn8j',
      select: 'distinct boro',
      limit: 3,
    });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.total_count).toBe(6);
    expect(sc.truncated).toBe(true);
    expect(sc.canvas_row_count).toBe(6);
    expect(String(sc.notice)).toMatch(
      /^Rows filled the limit — more rows may match \(exact count in total_count\)\. Staged 6 rows/,
    );
    expect(contentText(result)).toContain('_Total matching rows: 6 — ');
    expect(recounts().map((p) => Object.fromEntries(p))).toEqual([
      { $query: 'SELECT distinct boro |> SELECT count(*) AS n' },
    ]);
  });

  it('reports no total, truncation, notice, or spill when the count equals the page (#50 repro 2)', async () => {
    serveSoda([{ n: '294578' }], { 'X-SODA2-Fields': '["n"]', 'X-SODA2-Types': '["number"]' });

    const result = await runToolContract(queryDataset, {
      domain: 'data.cityofchicago.org',
      dataset_id: 'ijzp-q8t2',
      select: 'count(*) as n',
      limit: 1,
    });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.rows).toEqual([{ n: '294578' }]);
    for (const key of ['total_count', 'truncated', 'notice', 'canvas_id', 'table_name']) {
      expect(sc).not.toHaveProperty(key);
    }
    expect(contentText(result)).not.toContain('Rows filled the limit');
    // The main query and the recount; no staging request.
    expect(fetchMock.calls).toHaveLength(2);
  });

  it('cuts a hung recount at 15 s; the query succeeds without total_count or the exact-count claim', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    setCanvas(undefined);
    try {
      // When the recount was sent, on the fake clock: vi.waitFor advances it while polling.
      let recountSentAt = 0;
      serveWithStaging(
        CRIMES,
        () => Response.json([]),
        (request) => {
          recountSentAt = Date.now();
          return hang(request);
        },
      );

      let settled = false;
      const pending = runToolContract(queryDataset, {
        domain: 'data.cityofchicago.org',
        dataset_id: 'ijzp-q8t2',
        limit: 2,
      }).finally(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(fetchMock.calls).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(14_999 - (Date.now() - recountSentAt));
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(result.isError).toBeFalsy();
      const notice =
        'Rows filled the limit — more rows may match. Page with offset or raise limit (max 5000).';
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.rows).toHaveLength(2);
      expect(sc).not.toHaveProperty('total_count');
      expect(sc.truncated).toBe(true);
      expect(sc.notice).toBe(notice);
      expect(contentText(result)).toContain(`> ${notice}`);
      expect(contentText(result)).not.toContain('total_count');
      expect(fetchMock.calls).toHaveLength(2);
    } finally {
      setCanvas(canvas);
      vi.useRealTimers();
    }
  });

  it('fails the call as cancelled when the caller aborts during the recount', async () => {
    const controller = new AbortController();
    serveWithStaging(CRIMES, hang, (request) => {
      controller.abort(new DOMException('Caller cancelled the recount', 'AbortError'));
      return hang(request);
    });

    const result = await runToolContract(
      queryDataset,
      { domain: 'data.cityofchicago.org', dataset_id: 'ijzp-q8t2', limit: 2 },
      { context: { signal: controller.signal } },
    );

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as { error: { code: number; message: string } };
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.message).toContain('Caller cancelled the recount');
    expect(contentText(result)).toContain('Caller cancelled the recount');
    // The main query and the recount; nothing staged.
    expect(fetchMock.calls).toHaveLength(2);
  });
});

describe('socrata_query_dataset table naming on one canvas (#58)', () => {
  /** Homicide extracts by year, as SODA answers them: the where clause picks the year. */
  const EXTRACTS: Record<string, Record<string, unknown>[]> = {
    '2026': Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), district: '011' })),
    '2025': Array.from({ length: 9 }, (_, i) => ({ id: String(i + 100), district: '007' })),
  };

  /** Answer the main query, the recount, and the staging copy from the year's extract. */
  function serveExtracts() {
    fetchMock = createFetchMock([
      {
        match: (request) => new URL(request.url).pathname === '/resource/ijzp-q8t2.json',
        respond: (request) => {
          const params = new URL(request.url).searchParams;
          const clause = params.get('$query') ?? params.get('$where') ?? '';
          const rows = EXTRACTS[/year=(\d{4})/.exec(clause)?.[1] ?? ''] ?? [];
          if (params.has('$query')) return recountOf(rows);
          const offset = Number(params.get('$offset') ?? 0);
          return Response.json(rows.slice(offset, offset + Number(params.get('$limit'))), {
            headers: {
              'X-SODA2-Fields': '["id","district"]',
              'X-SODA2-Types': '["number","text"]',
            },
          });
        },
      },
    ]);
    fetchMock.install();
  }

  /** One year's extract on a one-row page, which stages the whole match. */
  const extract = (year: string, extra: Record<string, unknown> = {}) =>
    spill({ where: `primary_type='HOMICIDE' AND year=${year}`, limit: 1, ...extra });

  /** Table name → row count, as socrata_dataframe_describe lists the canvas. */
  async function tableCounts(canvasId: string) {
    const described = await dataframeDescribe.handler(
      dataframeDescribe.input.parse({ canvas_id: canvasId }),
      createMockContext({ errors: dataframeDescribe.errors }),
    );
    return Object.fromEntries(described.tables.map((t) => [t.table_id, t.row_count]));
  }

  it('keeps two named extracts side by side on one canvas, the second name lowercased', async () => {
    serveExtracts();

    const first = await extract('2026', { table_name: 'h2026' });
    const second = await extract('2025', {
      table_name: 'H2025',
      canvas_id: first.result.canvas_id,
    });

    expect(first.result.table_name).toBe('h2026');
    expect(second.result).toMatchObject({ canvas_id: first.result.canvas_id, table_name: 'h2025' });
    expect(await tableCounts(first.result.canvas_id!)).toEqual({ h2025: 9, h2026: 7 });
    const joined = await sql(
      first.result.canvas_id!,
      'SELECT count(*) AS n FROM h2025 CROSS JOIN h2026',
    );
    expect(String(joined.rows[0]!.n)).toBe('63');
    expect(String(getEnrichment(second.ctx).notice)).not.toContain('Replaced');
  });

  it('names the table a derived-name spill replaces, with its previous row count; the first spill names none', async () => {
    serveExtracts();

    const first = await extract('2026');
    const second = await extract('2025', { canvas_id: first.result.canvas_id });

    expect(String(getEnrichment(first.ctx).notice)).not.toContain('Replaced');
    expect(String(getEnrichment(second.ctx).notice)).toContain(
      'Staged 9 rows as table "ijzp_q8t2_rows" on canvas',
    );
    expect(String(getEnrichment(second.ctx).notice)).toContain(
      'Replaced table "ijzp_q8t2_rows" (previously 7 rows).',
    );
    expect(await tableCounts(first.result.canvas_id!)).toEqual({ ijzp_q8t2_rows: 9 });
  });
});

describe('socrata_query_dataset limit above the per-call cap through the real service (#55)', () => {
  it('serves limit 8000 as one 5,000-row page, names the next offset, and stages the match', async () => {
    serveSoda(
      Array.from({ length: 5002 }, (_, i) => ({ id: String(i + 1) })),
      { 'X-SODA2-Fields': '["id"]', 'X-SODA2-Types': '["number"]' },
    );

    const result = await runToolContract(queryDataset, {
      domain: 'data.cityofchicago.org',
      dataset_id: 'ijzp-q8t2',
      limit: 8000,
    });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.rows).toHaveLength(5000);
    expect(sc).toMatchObject({
      total_count: 5002,
      truncated: true,
      cap: 5000,
      canvas_row_count: 5002,
    });
    expect(String(sc.notice)).toMatch(
      /^The requested limit 8000 was served as 5000: the per-call cap is 5000, and more rows may match \(exact count in total_count\)\. Continue with offset 5000\. Staged 5,002 rows as table "ijzp_q8t2_rows"/,
    );
    const pages = fetchMock.calls
      .map((c) => new URL(c.request.url).searchParams)
      .filter((p) => !p.has('$query'))
      .map((p) => p.get('$limit'));
    expect(pages).toEqual(['5000', '50000']);
  });
});
