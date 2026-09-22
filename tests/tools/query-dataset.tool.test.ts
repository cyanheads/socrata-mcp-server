/**
 * @fileoverview Tests for the query-dataset tool.
 * @module tests/tools/query-dataset.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ defaultDomain: 'data.seattle.gov' }),
}));

import { getSocrataService } from '@/services/socrata/socrata-service.js';

const mockQueryDataset = vi.fn();
const mockStreamDatasetRows = vi.fn();
const mockService = { queryDataset: mockQueryDataset, streamDatasetRows: mockStreamDatasetRows };

/** Build a fresh async generator over the given rows — mirrors streamDatasetRows. */
function streamOf(rows: Record<string, unknown>[]) {
  return (async function* () {
    for (const r of rows) yield r;
  })();
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
  // Default: nothing to stream unless a canvas test supplies paginated rows.
  mockStreamDatasetRows.mockImplementation(() => streamOf([]));
});

afterEach(() => {
  setCanvas(undefined);
});

describe('queryDataset', () => {
  it('states that SoQL takes the API field name in the description and clause describes (#29)', () => {
    expect(queryDataset.description).toContain('API field name');
    const { shape } = queryDataset.input;
    for (const clause of [shape.select, shape.where, shape.group, shape.order]) {
      expect(clause.description).toMatch(/field names?/);
    }
    expect(queryDataset.errors?.find((e) => e.reason === 'soql_error')?.recovery).toContain(
      'field_name',
    );
  });

  it('throws invalid_id for malformed dataset ID', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });

    const input = queryDataset.input.parse({ dataset_id: 'not-valid!!' });
    await expect(queryDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('returns rows and assembled query for valid input', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    mockQueryDataset.mockResolvedValue({
      rows: [{ incident_type: 'Theft', year: '2023' }],
      rowCount: 1,
      domain: 'data.seattle.gov',
      assembledQuery: '$where=year=2023 $limit=100',
    });

    const input = queryDataset.input.parse({
      dataset_id: 'kzjm-xkqj',
      where: 'year=2023',
    });
    const result = await queryDataset.handler(input, ctx);

    expect(result.rows).toHaveLength(1);
    expect(result.row_count).toBe(1);
    expect(result.assembled_query).toBe('$where=year=2023 $limit=100');
    expect(result.domain).toBe('data.seattle.gov');
    expect(result.dataset_id).toBe('kzjm-xkqj');
  });

  it('includes total_count when result is truncated', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    mockQueryDataset.mockResolvedValue({
      rows: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })),
      rowCount: 100,
      domain: 'data.seattle.gov',
      totalCount: 5000,
      assembledQuery: '$limit=100',
    });

    const input = queryDataset.input.parse({ dataset_id: 'abcd-1234', limit: 100 });
    const result = await queryDataset.handler(input, ctx);

    expect(result.total_count).toBe(5000);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(String(enrichment.notice)).toContain('exact count in total_count');
  });

  it('omits total_count and the exact-count guidance for grouped queries at the limit', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    // Grouped query: service skips the recount, so totalCount is absent.
    mockQueryDataset.mockResolvedValue({
      rows: Array.from({ length: 5 }, (_, i) => ({ primary_type: `TYPE_${i}`, n: String(i) })),
      rowCount: 5,
      domain: 'data.seattle.gov',
      assembledQuery: '$select=primary_type, count(*) as n $group=primary_type $limit=5',
    });

    const input = queryDataset.input.parse({
      dataset_id: 'ijzp-q8t2',
      select: 'primary_type, count(*) as n',
      group: 'primary_type',
      limit: 5,
    });
    const result = await queryDataset.handler(input, ctx);

    expect(result.total_count).toBeUndefined();
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toBeDefined();
    expect(String(enrichment.notice)).not.toContain('total_count');
  });

  it('strips Socrata system columns from the canvas projection but keeps them in inline rows', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    // Sparse SODA shape: system keys appear on some rows only.
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      primary_type: 'THEFT',
      ...(i % 2 === 0 ? { ':@computed_region_awaf_s7ux': String(40 + i) } : {}),
    }));
    // Inline page keeps system columns; the paginated drain feeds the canvas.
    mockQueryDataset.mockResolvedValue({
      rows,
      rowCount: 5,
      domain: 'data.seattle.gov',
      assembledQuery: '$limit=5',
    });
    mockStreamDatasetRows.mockImplementation(() => streamOf(rows));
    const registerTable = vi.fn().mockResolvedValue({ tableName: 'ijzp_q8t2_rows', rowCount: 5 });
    const mockCanvas = {
      acquire: vi.fn().mockResolvedValue({ canvasId: 'abc1234567', registerTable }),
    };
    setCanvas(mockCanvas as unknown as DataCanvas);

    const input = queryDataset.input.parse({ dataset_id: 'ijzp-q8t2', limit: 5 });
    const result = await queryDataset.handler(input, ctx);

    // Spilled — table registered under the dataset-derived name.
    expect(registerTable).toHaveBeenCalledTimes(1);
    expect(registerTable.mock.calls[0]?.[0]).toBe('ijzp_q8t2_rows');
    // Canvas projection carries no `:`-prefixed keys.
    const spilled = registerTable.mock.calls[0]?.[1] as Record<string, unknown>[];
    expect(spilled).toHaveLength(5);
    expect(spilled.every((row) => Object.keys(row).every((k) => !k.startsWith(':')))).toBe(true);
    expect(spilled[0]).toEqual({ id: '0', primary_type: 'THEFT' });
    // Inline rows keep every column, system keys included.
    expect(result.rows[0]!).toHaveProperty(':@computed_region_awaf_s7ux');
    expect(result.canvas_id).toBe('abc1234567');
    expect(result.canvas_row_count).toBe(5);
  });

  it('stages the full paginated set on the canvas, not just the inline page', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    // Inline page: exactly the caller's limit (triggers spill), with a large total.
    mockQueryDataset.mockResolvedValue({
      rows: Array.from({ length: 5 }, (_, i) => ({ id: String(i) })),
      rowCount: 5,
      domain: 'data.seattle.gov',
      totalCount: 2183186,
      assembledQuery: '$limit=5',
    });
    // The paginated drain walks past one page — 12 rows, more than the inline 5.
    const paged = Array.from({ length: 12 }, (_, i) => ({ id: String(i) }));
    mockStreamDatasetRows.mockImplementation(() => streamOf(paged));
    const registerTable = vi.fn().mockResolvedValue({ tableName: 'abcd_1234_rows', rowCount: 12 });
    setCanvas({
      acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas1234', registerTable }),
    } as unknown as DataCanvas);

    const input = queryDataset.input.parse({ dataset_id: 'abcd-1234', limit: 5, offset: 0 });
    const result = await queryDataset.handler(input, ctx);

    // Canvas holds the paginated set (12), not the 5-row inline page.
    expect(registerTable).toHaveBeenCalledTimes(1);
    const staged = registerTable.mock.calls[0]?.[1] as unknown[];
    expect(staged).toHaveLength(12);
    expect(result.canvas_row_count).toBe(12);
    // Inline rows stay bounded by the caller's limit.
    expect(result.rows).toHaveLength(5);
    // The drain was asked to fetch up to the safety cap, scoped to the same dataset.
    expect(mockStreamDatasetRows).toHaveBeenCalledTimes(1);
    const [streamOpts, maxRows] = mockStreamDatasetRows.mock.calls[0] as [
      Record<string, unknown>,
      number,
    ];
    expect(maxRows).toBe(50_000);
    expect(streamOpts).toMatchObject({ datasetId: 'abcd-1234' });
  });

  it('format renders every row — no render-only cap beyond the caller limit (#19)', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: String(i), type: 'X' }));
    const output = {
      rows,
      row_count: 60,
      assembled_query: '$limit=60',
      domain: 'data.seattle.gov',
      dataset_id: 'kzjm-xkqj',
    };
    const blocks = queryDataset.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    // The 60th row is rendered and there is no "N more rows" summary marker.
    expect(text).toContain('| 59 | X |');
    expect(text).not.toMatch(/more rows/);
    const dataRows = text.split('\n').filter((l) => /^\| \d+ \| X \|$/.test(l));
    expect(dataRows).toHaveLength(60);
  });

  it('re-throws a service soql_error with the declared recovery hint attached', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    mockQueryDataset.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'SoQL error: Query coordinator error: query.soql.no-such-column; No such column: no_such_column',
        { reason: 'soql_error', socrataCode: 'query.soql.no-such-column' },
      ),
    );

    const input = queryDataset.input.parse({
      dataset_id: 'ijzp-q8t2',
      where: 'no_such_column = 1',
    });
    await expect(queryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('No such column: no_such_column'),
      data: {
        reason: 'soql_error',
        socrataCode: 'query.soql.no-such-column',
        recovery: { hint: expect.stringContaining('socrata_get_dataset') },
      },
    });
  });

  it('passes through optional SoQL clauses to service', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    mockQueryDataset.mockResolvedValue({
      rows: [],
      rowCount: 0,
      domain: 'data.seattle.gov',
      assembledQuery: '$select=category,count(*) $group=category $order=n DESC $limit=50',
    });

    const input = queryDataset.input.parse({
      dataset_id: 'abcd-1234',
      select: 'category, count(*) as n',
      group: 'category',
      order: 'n DESC',
      limit: 50,
    });
    await queryDataset.handler(input, ctx);

    const call = mockQueryDataset.mock.calls[0]![0];
    expect(call.select).toBe('category, count(*) as n');
    expect(call.group).toBe('category');
    expect(call.order).toBe('n DESC');
  });

  it('formats rows as markdown table when columns fit', () => {
    const output = {
      rows: [
        { incident_type: 'Theft', year: '2023' },
        { incident_type: 'Assault', year: '2023' },
      ],
      row_count: 2,
      assembled_query: '$where=year=2023',
      domain: 'data.seattle.gov',
      dataset_id: 'kzjm-xkqj',
    };
    const blocks = queryDataset.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('kzjm-xkqj');
    expect(text).toContain('data.seattle.gov');
    expect(text).toContain('Theft');
  });

  it('formats empty result set without rows', () => {
    const output = {
      rows: [],
      row_count: 0,
      assembled_query: '$where=year=9999',
      domain: 'data.seattle.gov',
      dataset_id: 'kzjm-xkqj',
    };
    const blocks = queryDataset.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('No rows returned');
  });

  it('populates enrichment notice when query returns empty rows', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    mockQueryDataset.mockResolvedValue({
      rows: [],
      rowCount: 0,
      domain: 'data.seattle.gov',
      assembledQuery: '$where=year=9999 $limit=100',
    });

    const input = queryDataset.input.parse({ dataset_id: 'kzjm-xkqj', where: 'year=9999' });
    const result = await queryDataset.handler(input, ctx);

    expect(result.rows).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No rows returned');
  });

  describe('spill discovery: table_name and the truncation notice (#30)', () => {
    /** Wire a canvas whose registerTable resolves with the given table name and row count. */
    function spillCanvas(tableName: string, rowCount: number) {
      const registerTable = vi.fn().mockResolvedValue({ tableName, rowCount, columns: [] });
      setCanvas({
        acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas1234', registerTable }),
      } as unknown as DataCanvas);
      return registerTable;
    }

    /** A query result whose page fills `limit`. */
    function fullPage(limit: number, totalCount?: number) {
      mockQueryDataset.mockResolvedValue({
        rows: Array.from({ length: limit }, (_, i) => ({ id: String(i) })),
        rowCount: limit,
        domain: 'data.seattle.gov',
        ...(totalCount != null ? { totalCount } : {}),
        assembledQuery: `$limit=${limit}`,
      });
      mockStreamDatasetRows.mockImplementation(() =>
        streamOf(Array.from({ length: 40 }, (_, i) => ({ id: String(i) }))),
      );
    }

    it('returns the registered table name and names it plus both dataframe tools in the notice', async () => {
      const ctx = createMockContext({ errors: queryDataset.errors });
      fullPage(5, 2183186);
      spillCanvas('tazs_3rd5_rows', 40);

      const result = await queryDataset.handler(
        queryDataset.input.parse({ dataset_id: 'tazs-3rd5', limit: 5 }),
        ctx,
      );

      expect(result.table_name).toBe('tazs_3rd5_rows');
      expect(result.canvas_id).toBe('canvas1234');
      const enrichment = getEnrichment(ctx);
      expect(enrichment).toMatchObject({ truncated: true, shown: 5, cap: 5 });
      expect(enrichment.notice).toBe(
        'Rows filled the limit — more rows may match (exact count in total_count). Staged 40 rows as table "tazs_3rd5_rows" on canvas canvas1234: list its columns with socrata_dataframe_describe, then run SQL with socrata_dataframe_query. The staged copy stops at 50,000 rows; page with offset for rows beyond it.',
      );
      expect(String(enrichment.notice)).not.toContain('CANVAS_PROVIDER_TYPE');
    });

    it('drops the exact-count clause from the spilled notice when total_count is absent', async () => {
      const ctx = createMockContext({ errors: queryDataset.errors });
      fullPage(5);
      spillCanvas('tazs_3rd5_rows', 40);

      await queryDataset.handler(
        queryDataset.input.parse({ dataset_id: 'tazs-3rd5', limit: 5 }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toMatch(/^Rows filled the limit — more rows may match\. Staged 40 rows/);
      expect(notice).not.toContain('total_count');
    });

    it('limit 1 on a large match returns one inline row with the staged copy', async () => {
      const ctx = createMockContext({ errors: queryDataset.errors });
      fullPage(1, 1137734);
      spillCanvas('tazs_3rd5_rows', 40);

      const result = await queryDataset.handler(
        queryDataset.input.parse({ dataset_id: 'tazs-3rd5', limit: 1 }),
        ctx,
      );

      expect(result.rows).toHaveLength(1);
      expect(result).toMatchObject({
        canvas_id: 'canvas1234',
        canvas_row_count: 40,
        table_name: 'tazs_3rd5_rows',
      });
    });

    it('with the canvas disabled: no table_name, no canvas_id, and the notice names neither dataframe tool', async () => {
      const ctx = createMockContext({ errors: queryDataset.errors });
      fullPage(5, 2183186);

      const result = await queryDataset.handler(
        queryDataset.input.parse({ dataset_id: 'tazs-3rd5', limit: 5 }),
        ctx,
      );

      expect(result.table_name).toBeUndefined();
      expect(result.canvas_id).toBeUndefined();
      const enrichment = getEnrichment(ctx);
      expect(enrichment).toMatchObject({ truncated: true, shown: 5, cap: 5 });
      expect(enrichment.notice).toBe(
        'Rows filled the limit — more rows may match (exact count in total_count). Page with offset or raise limit (max 5000).',
      );
      expect(String(enrichment.notice)).not.toMatch(/socrata_dataframe_|CANVAS_PROVIDER_TYPE/);
    });

    it('when the spill fails: no table_name, no canvas_id, and the notice names neither dataframe tool', async () => {
      const ctx = createMockContext({ errors: queryDataset.errors });
      fullPage(5);
      spillCanvas('tazs_3rd5_rows', 40).mockRejectedValue(new Error('DuckDB out of memory'));

      const result = await queryDataset.handler(
        queryDataset.input.parse({ dataset_id: 'tazs-3rd5', limit: 5 }),
        ctx,
      );

      expect(result.table_name).toBeUndefined();
      expect(result.canvas_id).toBeUndefined();
      expect(getEnrichment(ctx).notice).toBe(
        'Rows filled the limit — more rows may match. Page with offset or raise limit (max 5000).',
      );
    });

    it('a result under the limit carries no table_name and no truncation notice', async () => {
      const ctx = createMockContext({ errors: queryDataset.errors });
      mockQueryDataset.mockResolvedValue({
        rows: [{ id: '1' }],
        rowCount: 1,
        domain: 'data.seattle.gov',
        assembledQuery: '$limit=5',
      });
      const registerTable = spillCanvas('tazs_3rd5_rows', 1);

      const result = await queryDataset.handler(
        queryDataset.input.parse({ dataset_id: 'tazs-3rd5', limit: 5 }),
        ctx,
      );

      expect(registerTable).not.toHaveBeenCalled();
      expect(result.table_name).toBeUndefined();
      expect(getEnrichment(ctx).notice).toBeUndefined();
      expect(getEnrichment(ctx).truncated).toBeUndefined();
    });

    it('format names table_name and both dataframe tools on the canvas line', () => {
      const blocks = queryDataset.format!({
        rows: [{ id: '1' }],
        row_count: 1,
        assembled_query: '$limit=1',
        domain: 'data.seattle.gov',
        dataset_id: 'tazs-3rd5',
        canvas_id: 'canvas1234',
        canvas_row_count: 40,
        table_name: 'tazs_3rd5_rows',
      });
      const text = (blocks[0] as { text?: string }).text ?? '';
      const canvasLine = text.split('\n').find((l) => l.startsWith('**Canvas ID:**')) ?? '';

      expect(canvasLine).toContain('canvas1234');
      expect(canvasLine).toContain('`tazs_3rd5_rows`');
      expect(canvasLine).toContain('40 rows');
      expect(canvasLine).toContain('socrata_dataframe_describe');
      expect(canvasLine).toContain('socrata_dataframe_query');
    });

    it('tells callers in the description and the limit describe that a small limit still stages the copy', () => {
      expect(queryDataset.description).toContain(
        'When CANVAS_PROVIDER_TYPE=duckdb and rows fill limit, up to 50,000 matching rows spill to a DataCanvas table whatever the limit: list its columns with socrata_dataframe_describe, then run SQL with socrata_dataframe_query.',
      );
      expect(queryDataset.input.shape.limit.description).toContain(
        'pass a small limit (e.g. 10) to stage a large match without a large inline page',
      );
      expect(queryDataset.output.shape.table_name.description).toContain('socrata_dataframe_query');
    });
  });

  describe('typed spill schema from the SODA field-type headers (#25)', () => {
    /** Spill `staged` rows with the given header field types; return the options registerTable saw. */
    async function spillWith(
      staged: Record<string, unknown>[],
      fieldTypes: Map<string, string> | undefined,
      ctx = createMockContext({ errors: queryDataset.errors }),
    ) {
      mockQueryDataset.mockResolvedValue({
        rows: staged.slice(0, 2),
        rowCount: 2,
        domain: 'data.cityofchicago.org',
        assembledQuery: '$limit=2',
        ...(fieldTypes ? { fieldTypes } : {}),
      });
      mockStreamDatasetRows.mockImplementation(() => streamOf(staged));
      const registerTable = vi
        .fn()
        .mockResolvedValue({ tableName: 'ijzp_q8t2_rows', rowCount: staged.length, columns: [] });
      setCanvas({
        acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas1234', registerTable }),
      } as unknown as DataCanvas);

      const result = await queryDataset.handler(
        queryDataset.input.parse({ dataset_id: 'ijzp-q8t2', limit: 2 }),
        ctx,
      );
      return { result, registerTable, options: registerTable.mock.calls[0]?.[2] };
    }

    it('registers SODA number columns and number-typed aggregate aliases as DOUBLE, others as inferred', async () => {
      const staged = [
        {
          id: '1',
          primary_type: 'HOMICIDE',
          year: '2025',
          date: '2025-01-02T03:04:05.000',
          arrest: true,
          n: '7',
        },
        {
          id: '2',
          primary_type: 'HOMICIDE',
          year: '2025',
          date: '2025-01-03T00:00:00.000',
          arrest: false,
          n: '3',
        },
      ];
      const { options, registerTable } = await spillWith(
        staged,
        new Map([
          ['id', 'number'],
          ['primary_type', 'text'],
          ['year', 'number'],
          ['date', 'floating_timestamp'],
          ['arrest', 'boolean'],
          ['n', 'number'],
        ]),
      );

      expect(options?.schema).toEqual([
        { name: 'id', type: 'DOUBLE', nullable: true },
        { name: 'primary_type', type: 'VARCHAR', nullable: true },
        { name: 'year', type: 'DOUBLE', nullable: true },
        { name: 'date', type: 'VARCHAR', nullable: true },
        { name: 'arrest', type: 'BOOLEAN', nullable: true },
        { name: 'n', type: 'DOUBLE', nullable: true },
      ]);
      // Row payload is untouched: SODA strings go to the canvas as-is.
      expect(registerTable.mock.calls[0]?.[1]).toEqual(staged);
    });

    it('adds a header field absent from every staged row, and skips `:`-prefixed system fields', async () => {
      const { options } = await spillWith(
        [{ id: '1' }, { id: '2' }],
        new Map([
          ['id', 'number'],
          ['latitude', 'number'],
          [':@computed_region_awaf_s7ux', 'number'],
        ]),
      );

      expect(options?.schema).toEqual([
        { name: 'id', type: 'DOUBLE', nullable: true },
        { name: 'latitude', type: 'DOUBLE', nullable: true },
      ]);
    });

    it('infers columns over every staged row, not a 100-row sniff', async () => {
      const staged = Array.from({ length: 150 }, (_, i) => ({
        id: String(i),
        ...(i === 140 ? { latitude: '41.8' } : {}),
      }));
      const { options } = await spillWith(staged, new Map([['id', 'number']]));

      expect(options?.schema?.map((c: { name: string }) => c.name)).toEqual(['id', 'latitude']);
    });

    it('falls back to inferred types with a warning when the headers are missing', async () => {
      const ctx = createMockContext({ errors: queryDataset.errors });
      const { result, options } = await spillWith(
        [
          { id: '1', year: '2025' },
          { id: '2', year: '2024' },
        ],
        undefined,
        ctx,
      );

      expect(options?.schema).toEqual([
        { name: 'id', type: 'VARCHAR', nullable: true },
        { name: 'year', type: 'VARCHAR', nullable: true },
      ]);
      expect(result.canvas_id).toBe('canvas1234');
      const log = ctx.log as MockContextLogger;
      expect(log.calls.some((c) => c.level === 'warning' && /X-SODA2/.test(c.msg))).toBe(true);
    });
  });

  it('format shows canvas_id when spilled to canvas', () => {
    const output = {
      rows: [],
      row_count: 0,
      assembled_query: '$limit=100',
      domain: 'data.seattle.gov',
      dataset_id: 'kzjm-xkqj',
      canvas_id: 'abc1234567',
    };
    const blocks = queryDataset.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('abc1234567');
  });
});
