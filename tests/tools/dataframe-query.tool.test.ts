/**
 * @fileoverview Tests for the dataframe-query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { contentText } from './content-text.js';
import { readCodeEcho } from './read-code-echo.js';

afterEach(() => {
  setCanvas(undefined);
  vi.unstubAllEnvs();
});

/** The error envelope a contract run returns — carries the framework's declared-hint fill. */
async function contractError(input: { canvas_id: string; sql: string }) {
  const result = await runToolContract(dataframeQuery, input);
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: { code: number; data: Record<string, unknown> } })
    .error;
}

/**
 * Import a fresh copy of the tool with SOCRATA_CLAMP_LIMITS set to `flag`, with
 * the canvas accessor that copy reads. The `limit` schema reads the flag at
 * import, so each mode needs its own module instance. `''` reads as unset:
 * importing the config loads `.env`, which refills a deleted key but never
 * overrides a set one.
 */
async function loadDataframeQuery(flag: string) {
  vi.stubEnv('SOCRATA_CLAMP_LIMITS', flag);
  vi.resetModules();
  const { dataframeQuery: def } = await import(
    '@/mcp-server/tools/definitions/dataframe-query.tool.js'
  );
  const accessor = await import('@/services/canvas-accessor.js');
  return { def, setCanvas: accessor.setCanvas };
}

/** The advertised JSON Schema of the `limit` input. */
function limitSchema(def: typeof dataframeQuery) {
  const { properties } = z.toJSONSchema(def.input);
  return properties?.limit as { maximum?: number; description?: string };
}

/** The SQL a CommonMark reader takes from the `**SQL:**` echo in `text`. */
const readSqlEcho = (text: string) => readCodeEcho(text, 'SQL');

describe('dataframeQuery', () => {
  it('throws when canvas is not enabled', async () => {
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    // No setCanvas call — simulates CANVAS_PROVIDER_TYPE unset
    const input = dataframeQuery.input.parse({
      canvas_id: 'abc1234567',
      sql: 'SELECT * FROM kzjm_xkqj_rows LIMIT 10',
    });
    await expect(dataframeQuery.handler(input, ctx)).rejects.toThrow('DataCanvas is not enabled');
  });

  it('populates enrichment notice when query returns empty rows', async () => {
    const mockInstance = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const mockCanvas = {
      acquire: vi.fn().mockResolvedValue(mockInstance),
    };
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    setCanvas(mockCanvas as unknown as DataCanvas);

    const input = dataframeQuery.input.parse({
      canvas_id: 'abc1234567',
      sql: 'SELECT * FROM kzjm_xkqj_rows WHERE year = 9999',
    });
    const result = await dataframeQuery.handler(input, ctx);

    expect(result.row_count).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('zero rows');
  });

  it('formats rows as markdown table when columns fit', () => {
    const output = {
      rows: [
        { incident_type: 'Theft', year: 2023 },
        { incident_type: 'Assault', year: 2022 },
      ],
      row_count: 2,
      sql: 'SELECT incident_type, year FROM kzjm_xkqj_rows LIMIT 10',
      canvas_id: 'abc1234567',
    };
    const blocks = dataframeQuery.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('abc1234567');
    expect(text).toContain('Theft');
    expect(text).toContain('2 rows');
  });

  it('formats empty result without table rows', () => {
    const output = {
      rows: [],
      row_count: 0,
      sql: 'SELECT * FROM kzjm_xkqj_rows WHERE year = 9999',
      canvas_id: 'abc1234567',
    };
    const blocks = dataframeQuery.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('No rows returned');
    expect(text).toContain('abc1234567');
  });

  it('throws canvas_not_found when canvas.acquire rejects with NotFound', async () => {
    const mockCanvas = {
      acquire: vi
        .fn()
        .mockRejectedValue(
          new McpError(
            JsonRpcErrorCode.NotFound,
            'Canvas not found or expired. Omit canvas_id to start a new canvas.',
            { canvasId: 'zzzz999999' },
          ),
        ),
    };
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    setCanvas(mockCanvas as unknown as DataCanvas);

    const input = dataframeQuery.input.parse({
      canvas_id: 'zzzz999999',
      sql: 'SELECT * FROM some_table LIMIT 10',
    });
    await expect(dataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_not_found' },
    });
  });

  it('rejects a canvas_id that cannot be a minted token at argument validation', () => {
    // CanvasIdSchema puts the minted `^[A-Za-z0-9_-]{10}$` shape in inputSchema,
    // so a malformed token is an argument rejection, never a canvas lookup.
    expect(() =>
      dataframeQuery.input.parse({ canvas_id: 'xxxx-invalid', sql: 'SELECT 1' }),
    ).toThrow();
  });

  it('re-throws non-NotFound errors from canvas.acquire unchanged', async () => {
    const mockCanvas = {
      acquire: vi.fn().mockRejectedValue(new Error('Unexpected internal failure')),
    };
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    setCanvas(mockCanvas as unknown as DataCanvas);

    const input = dataframeQuery.input.parse({
      canvas_id: 'abc1234567',
      sql: 'SELECT * FROM some_table LIMIT 10',
    });
    await expect(dataframeQuery.handler(input, ctx)).rejects.toThrow('Unexpected internal failure');
  });

  /** Wire a canvas whose acquired instance.query() rejects with the given error. */
  function canvasWhereQueryRejects(err: unknown): DataCanvas {
    return {
      acquire: vi.fn().mockResolvedValue({ query: vi.fn().mockRejectedValue(err) }),
    } as unknown as DataCanvas;
  }

  it('re-throws a non-SELECT SQL-gate rejection as sql_rejected with a recovery hint (#22)', async () => {
    // Exactly the repro: the gate throws before DuckDB executes, ValidationError
    // with data.reason: 'non_select_statement' and no recovery hint.
    setCanvas(
      canvasWhereQueryRejects(
        new McpError(
          JsonRpcErrorCode.ValidationError,
          'Canvas query must be SELECT; got DELETE. Mutations must use registerTable, drop, or clear.',
          { reason: 'non_select_statement', statementType: 'DELETE' },
        ),
      ),
    );
    const error = await contractError({
      canvas_id: 'abc1234567',
      sql: 'DELETE FROM kzjm_xkqj_rows',
    });

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'sql_rejected',
        // The original gate reason is preserved as diagnostic context, not clobbered.
        gateReason: 'non_select_statement',
        statementType: 'DELETE',
        recovery: { hint: expect.stringContaining('SELECT') },
      },
    });
  });

  it('maps other SQL-gate rejections (system_catalog_access) to sql_rejected too (#22)', async () => {
    setCanvas(
      canvasWhereQueryRejects(
        new McpError(
          JsonRpcErrorCode.ValidationError,
          'Canvas query references a system catalog: information_schema.',
          { reason: 'system_catalog_access', catalog: 'information_schema' },
        ),
      ),
    );
    const error = await contractError({
      canvas_id: 'abc1234567',
      sql: 'SELECT * FROM information_schema.tables',
    });

    expect(error).toMatchObject({
      data: {
        reason: 'sql_rejected',
        gateReason: 'system_catalog_access',
        catalog: 'information_schema',
        recovery: { hint: expect.stringContaining('SELECT') },
      },
    });
  });

  it('passes invalid_sql through unchanged — a SELECT typo is not a gate rejection (#22)', async () => {
    setCanvas(
      canvasWhereQueryRejects(
        new McpError(
          JsonRpcErrorCode.ValidationError,
          'Canvas query failed to prepare: Referenced column "nope" not found.',
          { reason: 'invalid_sql', binderMessage: 'Referenced column "nope" not found' },
        ),
      ),
    );
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    const input = dataframeQuery.input.parse({
      canvas_id: 'abc1234567',
      sql: 'SELECT nope FROM t',
    });

    // Stays invalid_sql — not remapped to sql_rejected.
    await expect(dataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_sql' },
    });
  });

  it('re-throws a missing_table NotFound as table_not_found with a recovery hint (#22)', async () => {
    setCanvas(
      canvasWhereQueryRejects(
        new McpError(
          JsonRpcErrorCode.NotFound,
          'Canvas table "kzjm_xkqj_rows" does not exist. Re-stage it or call describe().',
          { reason: 'missing_table', tableName: 'kzjm_xkqj_rows' },
        ),
      ),
    );
    const error = await contractError({
      canvas_id: 'abc1234567',
      sql: 'SELECT * FROM kzjm_xkqj_rows',
    });

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'table_not_found',
        recovery: { hint: expect.stringContaining('socrata_dataframe_describe') },
      },
    });
  });

  it('format renders the whole executed SQL past the old 200-character cap (#19)', () => {
    const conditions = Array.from({ length: 12 }, (_, i) => `year <> ${2000 + i}`).join(' AND ');
    const sql = `SELECT primary_type, count(*) AS n FROM ijzp_q8t2_rows WHERE ${conditions} GROUP BY primary_type ORDER BY n DESC`;
    const output = {
      rows: [{ primary_type: 'THEFT', n: 3 }],
      row_count: 1,
      sql,
      canvas_id: 'abc1234567',
    };
    const text = (dataframeQuery.format!(output)[0] as { text?: string }).text ?? '';

    expect(sql.length).toBeGreaterThan(200);
    expect(text).toContain(`**SQL:** \`${sql}\``);
  });

  it('format renders every row in table mode — no 50-row render cap (#19)', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, type: 'X' }));
    const output = { rows, row_count: 60, sql: 'SELECT id, type FROM t', canvas_id: 'abc1234567' };
    const blocks = dataframeQuery.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('| 59 | X |');
    expect(text).not.toMatch(/more rows/);
    const dataRows = text.split('\n').filter((l) => /^\| \d+ \| X \|$/.test(l));
    expect(dataRows).toHaveLength(60);
  });

  it('format renders every row in wide JSON mode — no 20-row render cap (#19)', () => {
    const cols = Array.from({ length: 15 }, (_, i) => `col${i}`);
    const rows = Array.from({ length: 25 }, (_, r) =>
      Object.fromEntries(cols.map((c, i) => [c, `v${r}_${i}`])),
    );
    const output = {
      rows,
      row_count: 25,
      sql: 'SELECT * FROM wide_table',
      canvas_id: 'xyz9876543',
    };
    const blocks = dataframeQuery.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).not.toMatch(/more rows/);
    expect(text).toContain('v24_0'); // last row's marker value is present
    expect((text.match(/```json/g) ?? []).length).toBe(25);
  });

  it('formats wide result set as JSON blocks', () => {
    const cols = Array.from({ length: 15 }, (_, i) => `col${i}`);
    const rows = Array.from({ length: 5 }, (_, r) =>
      Object.fromEntries(cols.map((c, i) => [c, `val${r}_${i}`])),
    );
    const output = {
      rows,
      row_count: 5,
      sql: 'SELECT * FROM wide_table',
      canvas_id: 'xyz9876543',
    };
    const blocks = dataframeQuery.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    // Wide result falls back to JSON blocks
    expect(text).toContain('```json');
    expect(text).toContain('xyz9876543');
  });

  it('escapes upstream row values and column keys in table mode', () => {
    const output = {
      rows: [{ 'weird|key': 'pipe|value', note: 'line1\nline2', slash: 'a\\|b' }],
      row_count: 1,
      sql: 'SELECT * FROM t',
      canvas_id: 'abc1234567',
    };
    const blocks = dataframeQuery.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('weird\\|key');
    expect(text).toContain('pipe\\|value');
    expect(text).not.toMatch(/\n\| [^|\\]*pipe\|value/);
    expect(text).toContain('line1 line2');
    expect(text).toContain('a\\\\\\|b');
  });

  it('sizes wide-mode fences past embedded backtick runs', () => {
    const cols = Array.from({ length: 15 }, (_, i) => `col${i}`);
    const row = Object.fromEntries(cols.map((c) => [c, c === 'col0' ? 'x ``` y' : 'v']));
    const output = {
      rows: [row],
      row_count: 1,
      sql: 'SELECT * FROM wide_table',
      canvas_id: 'xyz9876543',
    };
    const blocks = dataframeQuery.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    const fences = text.match(/`{3,}/g) ?? [];
    const maxFence = Math.max(...fences.map((f) => f.length));
    expect(maxFence).toBeGreaterThanOrEqual(4);
  });
});

/** The truncation notice for a limit at or below the per-call cap, unchanged by #55. */
const TRUNCATION_GUIDANCE =
  'Results were capped at the limit — more rows match. Raise limit (max 10000), or refine the SQL with WHERE/aggregates to narrow the result set.';

/** How to read past a page held to the 10,000-row cap — the tail of both cap notices. */
const PAGING_GUIDANCE =
  'To read every row exactly once, page in the SQL: ORDER BY a unique column (ORDER BY ALL when none is unique), LIMIT 10000, and OFFSET raised by 10000 per call. If this SQL already orders that way, these rows are one such page: continue at OFFSET 10000, or 10000 past the OFFSET it already has. If it does not, start over at OFFSET 0: rows served in any other order do not line up with ordered pages. When the SQL has its own LIMIT, stop once the pages have read that many rows. Or narrow the result with WHERE or aggregates.';

/** The notice for a limit at the 10,000-row cap when more rows match. */
const CAP_GUIDANCE = `Results were capped at the 10000-row per-call cap — more rows match. ${PAGING_GUIDANCE}`;

/**
 * The next pages a caller reads by following `notice` word for word after a
 * first call whose SQL did (`ordered`) or did not order by a unique column:
 * whether the rows already served count as a page, the OFFSET to read next,
 * and the LIMIT and OFFSET step of each page.
 */
function pagingPlan(notice: string, ordered: boolean) {
  const limit = Number(/LIMIT (\d+)/.exec(notice)?.[1]);
  const step = Number(/OFFSET (?:raised )?by (\d+)/.exec(notice)?.[1]);
  const restart = ordered
    ? undefined
    : /If it does not, start over at OFFSET (\d+)/.exec(notice)?.[1];
  const resume = /continue at OFFSET (\d+)/.exec(notice)?.[1] ?? /OFFSET (\d+)/.exec(notice)?.[1];
  return {
    keepServed: restart === undefined,
    offset: Number(restart ?? resume),
    limit,
    step,
  };
}

describe('dataframeQuery limit schema and SOCRATA_CLAMP_LIMITS (#55)', () => {
  const base = { canvas_id: 'abc1234567', sql: 'SELECT 1' };

  it.each([
    ['unset', ''],
    ['true', 'true'],
  ])(
    'with the switch %s, advertises the 50,000 ceiling and accepts an over-cap limit',
    async (_label, flag) => {
      const { def } = await loadDataframeQuery(flag);

      expect(limitSchema(def)).toMatchObject({
        maximum: 50_000,
        description:
          'Max rows to return (1–50,000). One call returns at most 10,000 rows: a larger limit is served as 10,000, with a notice naming how to page through the rest when more rows match. Default 1000.',
      });
      for (const limit of [10_000, 10_001, 20_000, 50_000]) {
        expect(def.input.parse({ ...base, limit }).limit).toBe(limit);
      }
      expect(() => def.input.parse({ ...base, limit: 50_001 })).toThrow();
      expect(() => def.input.parse({ ...base, limit: 0 })).toThrow();
    },
  );

  it("with the switch false, keeps 10,000 as the schema maximum and today's description", async () => {
    const { def } = await loadDataframeQuery('false');

    expect(limitSchema(def)).toMatchObject({
      maximum: 10_000,
      description: 'Max rows to return (1–10000). Default 1000.',
    });
    expect(def.input.parse({ ...base, limit: 10_000 }).limit).toBe(10_000);
    expect(() => def.input.parse({ ...base, limit: 10_001 })).toThrow();
  });

  it.each([
    ['true', 50_001],
    ['true', 0],
    ['false', 10_001],
  ])(
    'with the switch %s, rejects limit %i as invalid arguments before any canvas lookup',
    async (flag, limit) => {
      const { def, setCanvas: setLoadedCanvas } = await loadDataframeQuery(flag);
      const acquire = vi.fn();
      setLoadedCanvas({ acquire } as unknown as DataCanvas);

      const result = await runToolContract(def, { ...base, limit });

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
      expect(acquire).not.toHaveBeenCalled();
    },
  );
});

describe('dataframeQuery over a real DuckDB canvas (#55, #60)', () => {
  /** Rows staged: past the 10,000-row cap, so a capped page withholds 50. */
  const STAGED_ROWS = 10_050;
  const SQL = 'SELECT id FROM big_rows ORDER BY id';
  /** Ids 1–10,050 stored out of id order: 7919 is coprime with 10,050, so this permutes them. */
  const SHUFFLED_IDS = Array.from(
    { length: STAGED_ROWS },
    (_, i) => ((i * 7919) % STAGED_ROWS) + 1,
  );
  /** A column with no unique value: seven groups, repeated. */
  const GROUPS = Array.from({ length: STAGED_ROWS }, (_, i) => i % 7);

  let canvas: DataCanvas;
  let canvasId: string;
  let def: typeof dataframeQuery;

  beforeAll(async () => {
    const created = createCanvasService(parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' }));
    if (!created) throw new Error('CANVAS_PROVIDER_TYPE=duckdb did not produce a canvas.');
    canvas = created;
    const instance = await canvas.acquire(undefined, createMockContext());
    // INTEGER, not the sniffer's BIGINT, so ids read back as numbers.
    await instance.registerTable(
      'big_rows',
      Array.from({ length: STAGED_ROWS }, (_, i) => ({ id: i + 1 })),
      { schema: [{ name: 'id', type: 'INTEGER' }] },
    );
    await instance.registerTable(
      'shuffled_rows',
      SHUFFLED_IDS.map((id) => ({ id })),
      { schema: [{ name: 'id', type: 'INTEGER' }] },
    );
    await instance.registerTable(
      'group_rows',
      GROUPS.map((grp) => ({ grp })),
      { schema: [{ name: 'grp', type: 'INTEGER' }] },
    );
    canvasId = instance.canvasId;
  });

  beforeEach(async () => {
    const loaded = await loadDataframeQuery('true');
    loaded.setCanvas(canvas);
    def = loaded.def;
  });

  afterAll(async () => {
    await canvas.shutdown(requestContextService.createRequestContext({ operation: 'test' }));
  });

  /** A successful contract run and its structuredContent. */
  async function run(input: { sql: string; limit?: number }) {
    const result = await runToolContract(def, { canvas_id: canvasId, ...input });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown> & {
      rows: Record<string, unknown>[];
      row_count: number;
    };
    return { result, sc };
  }

  it('serves limit 20000 as 10,000 rows with a notice naming both limits and the SQL paging lever', async () => {
    const { result, sc } = await run({ sql: SQL, limit: 20_000 });

    const notice = `The requested limit 20000 was served as 10000: the per-call cap is 10000, and more rows match. ${PAGING_GUIDANCE}`;
    expect(sc.rows).toHaveLength(10_000);
    expect(sc.row_count).toBe(10_000);
    expect(sc.rows.at(-1)).toEqual({ id: 10_000 });
    expect(sc).toMatchObject({ truncated: true, shown: 10_000, cap: 10_000, notice });
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it.each([10_001, 50_000])(
    'serves limit %i, between the cap and the ceiling, as 10,000 rows',
    async (limit) => {
      const { sc } = await run({ sql: SQL, limit });

      expect(sc.rows).toHaveLength(10_000);
      expect(sc).toMatchObject({ truncated: true, shown: 10_000, cap: 10_000 });
      expect(sc.notice).toMatch(
        new RegExp(
          `^The requested limit ${limit} was served as 10000: the per-call cap is 10000, and more rows match\\. `,
        ),
      );
    },
  );

  it('for SQL already ordered by a unique column, OFFSET 10000 returns the withheld rows, with no notice', async () => {
    const { result, sc } = await run({ sql: `${SQL} LIMIT 10000 OFFSET 10000`, limit: 20_000 });

    expect(sc.rows).toHaveLength(STAGED_ROWS - 10_000);
    expect(sc.rows[0]).toEqual({ id: 10_001 });
    expect(sc.rows.at(-1)).toEqual({ id: STAGED_ROWS });
    for (const key of ['notice', 'truncated', 'shown', 'cap']) expect(sc).not.toHaveProperty(key);
    expect(contentText(result)).not.toMatch(/^> /m);
  });

  it('adds nothing for an over-cap limit when every row fits under the cap', async () => {
    const { sc } = await run({
      sql: 'SELECT id FROM big_rows WHERE id <= 3 ORDER BY id',
      limit: 20_000,
    });

    expect(sc.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    for (const key of ['notice', 'truncated', 'shown', 'cap']) expect(sc).not.toHaveProperty(key);
  });

  it('keeps the zero-row notice for an over-cap limit', async () => {
    const { sc } = await run({ sql: 'SELECT id FROM big_rows WHERE id < 0', limit: 20_000 });

    expect(sc.rows).toEqual([]);
    expect(sc.notice).toBe(
      'Query returned zero rows. Check table names with socrata_dataframe_describe or adjust the SQL filter.',
    );
    expect(sc).not.toHaveProperty('truncated');
  });

  it('keeps the raise-limit guidance, with no clamp notice, for a limit below the cap', async () => {
    const { result, sc } = await run({ sql: SQL, limit: 5 });

    expect(sc.rows).toHaveLength(5);
    expect(sc).toMatchObject({ truncated: true, shown: 5, cap: 5, notice: TRUNCATION_GUIDANCE });
    expect(contentText(result)).toContain(`> ${TRUNCATION_GUIDANCE}`);
  });

  it('points a limit at the cap to paging, never to raising limit', async () => {
    const { result, sc } = await run({ sql: SQL, limit: 10_000 });

    expect(sc.rows).toHaveLength(10_000);
    expect(sc).toMatchObject({
      truncated: true,
      shown: 10_000,
      cap: 10_000,
      notice: CAP_GUIDANCE,
    });
    expect(sc.notice).not.toMatch(/raise limit/i);
    expect(contentText(result)).toContain(`> ${CAP_GUIDANCE}`);
  });

  /**
   * Read `table` the way `notice` says to after a first page of `served` rows:
   * the served rows when they count as a page, then ordered pages from the
   * OFFSET the notice names until one comes back short. `sqlLimit` is a LIMIT
   * the first call's SQL carried, applied only as far as the notice says to.
   */
  async function followNotice(
    notice: unknown,
    ordered: boolean,
    served: Record<string, unknown>[],
    pageSql: (limit: number, offset: number) => string,
    sqlLimit?: number,
  ) {
    const plan = pagingPlan(String(notice), ordered);
    for (const n of [plan.limit, plan.step, plan.offset]) expect(Number.isInteger(n)).toBe(true);
    const endBound = /stop once the pages have read that many rows/.test(String(notice))
      ? sqlLimit
      : undefined;

    const seen = plan.keepServed ? [...served] : [];
    for (let page = 0, offset = plan.offset; page < 5; page++, offset += plan.step) {
      if (endBound !== undefined && seen.length >= endBound) break;
      const { sc } = await run({ sql: pageSql(plan.limit, offset), limit: plan.limit });
      seen.push(...sc.rows);
      if (sc.rows.length < plan.limit) break;
    }
    return endBound === undefined ? seen : seen.slice(0, endBound);
  }

  it.each([
    ['unordered SQL at an over-cap limit', 'SELECT id FROM shuffled_rows', 20_000, false],
    ['unordered SQL at the cap', 'SELECT id FROM shuffled_rows', 10_000, false],
    ['SQL ordered by the unique column', 'SELECT id FROM shuffled_rows ORDER BY id', 20_000, true],
  ])(
    'following the notice for %s reads every row exactly once',
    async (_label, sql, limit, ordered) => {
      const { sc } = await run({ sql, limit });
      if (!ordered) {
        // The stored order differs from id order: this unordered first page
        // holds ids an ordered first page would not.
        expect(sc.rows.some((row) => (row.id as number) > 10_000)).toBe(true);
      }

      const seen = await followNotice(
        sc.notice,
        ordered,
        sc.rows,
        (pageLimit, offset) =>
          `SELECT id FROM shuffled_rows ORDER BY id LIMIT ${pageLimit} OFFSET ${offset}`,
      );

      const ids = seen.map((row) => row.id as number);
      expect(ids).toHaveLength(STAGED_ROWS);
      expect(new Set(ids).size).toBe(STAGED_ROWS);
      expect(ids.sort((a, b) => a - b)).toEqual(
        Array.from({ length: STAGED_ROWS }, (_, i) => i + 1),
      );
    },
  );

  it('following the notice for SQL with its own LIMIT reads up to that LIMIT and no further', async () => {
    const sqlLimit = 10_030;
    const { sc } = await run({
      sql: `SELECT id FROM shuffled_rows ORDER BY id LIMIT ${sqlLimit}`,
      limit: 20_000,
    });

    const seen = await followNotice(
      sc.notice,
      true,
      sc.rows,
      (pageLimit, offset) =>
        `SELECT id FROM shuffled_rows ORDER BY id LIMIT ${pageLimit} OFFSET ${offset}`,
      sqlLimit,
    );

    expect(seen.map((row) => row.id)).toEqual(Array.from({ length: sqlLimit }, (_, i) => i + 1));
  });

  it('following the notice with ORDER BY ALL reads a table with no unique column exactly once', async () => {
    const { sc } = await run({ sql: 'SELECT grp FROM group_rows', limit: 20_000 });

    const seen = await followNotice(
      sc.notice,
      false,
      sc.rows,
      (pageLimit, offset) =>
        `SELECT grp FROM group_rows ORDER BY ALL LIMIT ${pageLimit} OFFSET ${offset}`,
    );

    const byValue = (a: number, b: number) => a - b;
    expect(seen.map((row) => row.grp as number).sort(byValue)).toEqual([...GROUPS].sort(byValue));
    expect(sc.notice).toContain('ORDER BY ALL when none is unique');
  });

  it.each([
    ["SELECT 'a`b' AS x", [{ x: 'a`b' }]],
    ['SELECT price\n  * 2 AS doubled\nFROM (SELECT 3 AS price) AS t', [{ doubled: 6 }]],
  ])('echoes %j verbatim on both surfaces (#60)', async (sql, rows) => {
    const { result, sc } = await run({ sql });

    expect(sc).toEqual({ rows, row_count: 1, sql, canvas_id: canvasId });
    expect(readSqlEcho(contentText(result))).toBe(sql);
  });
});

describe('dataframeQuery SQL echo (#60)', () => {
  /** The format() text for a one-row result of `sql`. */
  function echoText(sql: string): string {
    const blocks = dataframeQuery.format!({
      rows: [{ x: 1 }],
      row_count: 1,
      sql,
      canvas_id: 'abc1234567',
    });
    return (blocks[0] as { text?: string }).text ?? '';
  }

  it("renders SQL holding a backtick as one code span sized past it (SELECT 'a`b' AS x)", () => {
    const text = echoText("SELECT 'a`b' AS x");

    expect(text).toContain("**SQL:** ``SELECT 'a`b' AS x``");
    expect(readSqlEcho(text)).toBe("SELECT 'a`b' AS x");
  });

  it('renders SQL without backticks or line breaks exactly as before', () => {
    expect(echoText('SELECT 1')).toContain('\n**SQL:** `SELECT 1`\n');
  });

  it('renders SQL with a line break as a fenced sql block on the lines after the label', () => {
    const text = echoText('SELECT price\n  * 2 AS doubled\nFROM t');

    expect(text).toContain('\n**SQL:**\n```sql\nSELECT price\n  * 2 AS doubled\nFROM t\n```\n');
  });

  it.each([
    ['plain text', 'SELECT incident_type, count(*) AS n FROM t GROUP BY 1'],
    ['a backtick', "SELECT 'a`b' AS x"],
    ['a backtick run', "SELECT '``' AS ticks"],
    ['a trailing backtick', 'SELECT 1 AS x -- `'],
    ['a leading backtick', '`SELECT 1'],
    ['a space at each end', ' SELECT 1 '],
    ['Markdown punctuation', "SELECT '*none*' AS a, '[x](y)' AS b, '<b>' AS c"],
    ['line breaks', 'SELECT price\n  * 2 AS doubled\nFROM t'],
    [
      'a blank line and a quote marker',
      'WITH a AS (SELECT 1 AS n)\n\nSELECT n\nFROM a\nWHERE n\n> 0',
    ],
    ['a line break and a backtick run', "SELECT '```' AS fence\nFROM t"],
    ['a trailing line break', 'SELECT 1\n'],
  ])('reads back byte-identical from content[] for SQL with %s', (_label, sql) => {
    expect(readSqlEcho(echoText(sql))).toBe(sql);
  });
});
