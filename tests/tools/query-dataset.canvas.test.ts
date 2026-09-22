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
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  getEnrichment,
  type MockContextLogger,
} from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dataframeDescribe } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { initSocrataService } from '@/services/socrata/socrata-service.js';

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

/**
 * Answer every SODA resource request: the `count(*)` recount with the total,
 * any other request with the `$offset`/`$limit` slice of `rows` and `headers`.
 */
function serveSoda(rows: Record<string, unknown>[], headers: Record<string, string>) {
  fetchMock = createFetchMock([
    {
      match: /\/resource\/ijzp-q8t2\.json/,
      respond: (request) => {
        const params = new URL(request.url).searchParams;
        if (params.get('$select') === 'count(*)') {
          return Response.json([{ count: String(rows.length) }]);
        }
        const offset = Number(params.get('$offset') ?? 0);
        const limit = Number(params.get('$limit'));
        return Response.json(rows.slice(offset, offset + limit), { headers });
      },
    },
  ]);
  fetchMock.install();
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
