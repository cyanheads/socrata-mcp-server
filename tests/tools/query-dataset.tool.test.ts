/**
 * @fileoverview Tests for the query-dataset tool.
 * @module tests/tools/query-dataset.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
    mockQueryDataset.mockResolvedValue({ rows, rowCount: 5, assembledQuery: '$limit=5' });
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
    expect(result.rows[0]).toHaveProperty(':@computed_region_awaf_s7ux');
    expect(result.canvas_id).toBe('abc1234567');
    expect(result.canvas_row_count).toBe(5);
  });

  it('stages the full paginated set on the canvas, not just the inline page', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    // Inline page: exactly the caller's limit (triggers spill), with a large total.
    mockQueryDataset.mockResolvedValue({
      rows: Array.from({ length: 5 }, (_, i) => ({ id: String(i) })),
      rowCount: 5,
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

    const call = mockQueryDataset.mock.calls[0][0];
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
      assembledQuery: '$where=year=9999 $limit=100',
    });

    const input = queryDataset.input.parse({ dataset_id: 'kzjm-xkqj', where: 'year=9999' });
    const result = await queryDataset.handler(input, ctx);

    expect(result.rows).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No rows returned');
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
