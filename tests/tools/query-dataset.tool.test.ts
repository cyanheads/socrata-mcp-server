/**
 * @fileoverview Tests for the query-dataset tool.
 * @module tests/tools/query-dataset.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { contentText } from './content-text.js';
import { readCodeEcho } from './read-code-echo.js';

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi
    .fn()
    .mockReturnValue({ defaultDomain: 'data.seattle.gov', clampLimits: true }),
}));

import { getServerConfig } from '@/config/server-config.js';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

const mockQueryDataset = vi.fn();
const mockFetchStagingRows = vi.fn();
const mockService = { queryDataset: mockQueryDataset, fetchStagingRows: mockFetchStagingRows };

beforeEach(() => {
  vi.clearAllMocks();
  (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
  // Default: nothing to stage unless a canvas test supplies rows.
  mockFetchStagingRows.mockResolvedValue([]);
});

afterEach(() => {
  setCanvas(undefined);
});

/** The text of a `format()` result. */
function formatText(output: Parameters<NonNullable<typeof queryDataset.format>>[0]): string {
  return (queryDataset.format!(output)[0] as { text?: string }).text ?? '';
}

/**
 * A fresh copy of the tool built with SOCRATA_CLAMP_LIMITS = `clampLimits`:
 * the switch is read once, at import, to set the `limit` maximum.
 */
async function loadQueryDataset(clampLimits: boolean) {
  (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({
    defaultDomain: 'data.seattle.gov',
    clampLimits,
  });
  vi.resetModules();
  return (await import('@/mcp-server/tools/definitions/query-dataset.tool.js')).queryDataset;
}

describe('queryDataset', () => {
  it('escapes Markdown in an empty-result WHERE notice without changing the executed query', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    mockQueryDataset.mockResolvedValue({
      rows: [],
      rowCount: 0,
      domain: 'data.seattle.gov',
      assembledQuery: "$where=name='*none*'",
    });
    const result = await queryDataset.handler(
      queryDataset.input.parse({ dataset_id: 'kzjm-xkqj', where: "name='*none*'" }),
      ctx,
    );
    expect(result.assembled_query).toBe("$where=name='*none*'");
    expect(getEnrichment(ctx).notice).toBe(
      'No rows returned for dataset "kzjm-xkqj" with WHERE name=\'\\*none\\*\'. Check field names and quoting with socrata_get_dataset, or broaden the filter.',
    );
    expect(mockQueryDataset.mock.calls[0]?.[0].where).toBe("name='*none*'");
  });

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

  describe('total_count and truncated follow the recount (#11, #50)', () => {
    const groupedInput = {
      dataset_id: 'ijzp-q8t2',
      select: 'primary_type, count(*) as n',
      group: 'primary_type',
      limit: 5,
    };

    /** A grouped page of five groups, with the service's recount when it produced one. */
    function groupedPage(totalCount?: number) {
      mockQueryDataset.mockResolvedValue({
        rows: Array.from({ length: 5 }, (_, i) => ({ primary_type: `TYPE_${i}`, n: String(i) })),
        rowCount: 5,
        domain: 'data.cityofchicago.org',
        ...(totalCount != null ? { totalCount } : {}),
        assembledQuery: '$select=primary_type, count(*) as n $group=primary_type $limit=5',
      });
    }

    it('reports the group count of a grouped query at the limit as total_count', async () => {
      groupedPage(34);

      const result = await runToolContract(queryDataset, groupedInput);

      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total_count).toBe(34);
      expect(sc.truncated).toBe(true);
      expect(sc.notice).toBe(
        'Rows filled the limit — more rows may match (exact count in total_count). Page with offset or raise limit (max 5000).',
      );
      expect(contentText(result)).toContain('_Total matching rows: 34 — ');
    });

    it('claims no exact count when the recount failed (#11)', async () => {
      groupedPage();

      const result = await runToolContract(queryDataset, groupedInput);

      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc).not.toHaveProperty('total_count');
      expect(sc.truncated).toBe(true);
      expect(sc.notice).toBe(
        'Rows filled the limit — more rows may match. Page with offset or raise limit (max 5000).',
      );
      expect(contentText(result)).not.toContain('total_count');
      expect(contentText(result)).not.toContain('Total matching rows');
    });

    it('reports no total_count, truncated, notice, or spill when the count equals the rows returned (#50 repro 2)', async () => {
      mockQueryDataset.mockResolvedValue({
        rows: [{ n: '294578' }],
        rowCount: 1,
        domain: 'data.cityofnewyork.us',
        totalCount: 1,
        assembledQuery: '$select=count(*) as n $limit=1',
      });
      const registerTable = vi.fn();
      setCanvas({
        acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas1234', registerTable }),
      } as unknown as DataCanvas);

      const result = await runToolContract(queryDataset, {
        domain: 'data.cityofnewyork.us',
        dataset_id: '43nn-pn8j',
        select: 'count(*) as n',
        limit: 1,
      });

      const sc = result.structuredContent as Record<string, unknown>;
      for (const key of ['total_count', 'truncated', 'notice', 'shown', 'cap', 'canvas_id']) {
        expect(sc).not.toHaveProperty(key);
      }
      expect(mockFetchStagingRows).not.toHaveBeenCalled();
      expect(registerTable).not.toHaveBeenCalled();
      expect(contentText(result)).not.toContain('Total matching rows');
      expect(contentText(result)).not.toContain('Rows filled the limit');
    });

    it('keeps total_count but neither truncated nor a spill on the last page of an offset walk', async () => {
      mockQueryDataset.mockResolvedValue({
        rows: [{ camis: '1' }, { camis: '2' }],
        rowCount: 2,
        domain: 'data.cityofnewyork.us',
        totalCount: 108_992,
        assembledQuery: "$where=boro='Manhattan' $limit=2 $offset=108990",
      });
      const registerTable = vi.fn();
      setCanvas({
        acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas1234', registerTable }),
      } as unknown as DataCanvas);

      const result = await runToolContract(queryDataset, {
        domain: 'data.cityofnewyork.us',
        dataset_id: '43nn-pn8j',
        where: "boro='Manhattan'",
        limit: 2,
        offset: 108_990,
      });

      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total_count).toBe(108_992);
      for (const key of ['truncated', 'notice', 'canvas_id']) {
        expect(sc).not.toHaveProperty(key);
      }
      expect(mockFetchStagingRows).not.toHaveBeenCalled();
      expect(contentText(result)).toContain('_Total matching rows: 108,992 — ');
    });
  });

  describe('an empty page past offset 0 (#52)', () => {
    /** An empty page at `offset`, with the service's recount when it produced one. */
    function emptyPage(offset: number, totalCount?: number) {
      mockQueryDataset.mockResolvedValue({
        rows: [],
        rowCount: 0,
        domain: 'data.cityofnewyork.us',
        ...(totalCount != null ? { totalCount } : {}),
        assembledQuery: `$where=boro='Manhattan' $limit=2 $offset=${offset}`,
      });
    }

    const args = (offset: number, where = "boro='Manhattan'") => ({
      domain: 'data.cityofnewyork.us',
      dataset_id: '43nn-pn8j',
      where,
      limit: 2,
      offset,
    });

    it('names the offset as past the end of the counted rows and returns the count', async () => {
      emptyPage(999_999, 108_992);

      const result = await runToolContract(queryDataset, args(999_999));

      const notice =
        'The offset 999999 is past the end of the 108992 matching rows. Page with an offset below 108992.';
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total_count).toBe(108_992);
      expect(sc.notice).toBe(notice);
      expect(sc).not.toHaveProperty('truncated');
      const text = contentText(result);
      expect(text).toContain(`> ${notice}`);
      expect(text).toContain('_Total matching rows: 108,992 — ');
      expect(text).not.toContain('Check field names');
    });

    it('uses the singular for a match of one row', async () => {
      emptyPage(2, 1);

      const result = await runToolContract(queryDataset, args(2));

      expect((result.structuredContent as Record<string, unknown>).notice).toBe(
        'The offset 2 is past the end of the 1 matching row. Page with an offset below 1.',
      );
    });

    it('says the offset may be past the end when the rows could not be counted', async () => {
      emptyPage(50);

      const result = await runToolContract(queryDataset, args(50));

      const notice =
        'No rows returned at offset 50; the offset may be past the end of the matching rows, which could not be counted. Rerun with offset 0 to tell that apart from a filter that matches nothing.';
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc).not.toHaveProperty('total_count');
      expect(sc.notice).toBe(notice);
      expect(contentText(result)).toContain(`> ${notice}`);
    });

    it('keeps the filter-review notice, without a total, when the count is zero', async () => {
      emptyPage(10, 0);

      const result = await runToolContract(queryDataset, args(10, "boro='Atlantis'"));

      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc).not.toHaveProperty('total_count');
      expect(sc.notice).toBe(
        'No rows returned for dataset "43nn-pn8j" with WHERE boro=\'Atlantis\'. Check field names and quoting with socrata_get_dataset, or broaden the filter.',
      );
    });

    it('keeps the filter-review notice byte-identical at offset 0', async () => {
      emptyPage(0);

      const result = await runToolContract(queryDataset, args(0, "boro='Atlantis'"));

      expect((result.structuredContent as Record<string, unknown>).notice).toBe(
        'No rows returned for dataset "43nn-pn8j" with WHERE boro=\'Atlantis\'. Check field names and quoting with socrata_get_dataset, or broaden the filter.',
      );
    });
  });

  it('strips Socrata system columns from the canvas projection but keeps them in inline rows', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    // Sparse SODA shape: system keys appear on some rows only.
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      primary_type: 'THEFT',
      ...(i % 2 === 0 ? { ':@computed_region_awaf_s7ux': String(40 + i) } : {}),
    }));
    // Inline page keeps system columns; the staging request feeds the canvas.
    mockQueryDataset.mockResolvedValue({
      rows,
      rowCount: 5,
      domain: 'data.seattle.gov',
      assembledQuery: '$limit=5',
    });
    mockFetchStagingRows.mockResolvedValue(rows);
    const registerTable = vi.fn().mockResolvedValue({ tableName: 'ijzp_q8t2_rows', rowCount: 5 });
    const mockCanvas = {
      acquire: vi.fn().mockResolvedValue({ canvasId: 'abc1234567', isNew: true, registerTable }),
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

  it('stages the wider matching set on the canvas, not just the inline page', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    // Inline page: exactly the caller's limit (triggers spill), with a large total.
    mockQueryDataset.mockResolvedValue({
      rows: Array.from({ length: 5 }, (_, i) => ({ id: String(i) })),
      rowCount: 5,
      domain: 'data.seattle.gov',
      totalCount: 2183186,
      assembledQuery: '$limit=5',
    });
    // The staging request answers with more rows than the inline 5.
    mockFetchStagingRows.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ id: String(i) })),
    );
    const registerTable = vi.fn().mockResolvedValue({ tableName: 'abcd_1234_rows', rowCount: 12 });
    setCanvas({
      acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas1234', isNew: true, registerTable }),
    } as unknown as DataCanvas);

    const input = queryDataset.input.parse({
      dataset_id: 'abcd-1234',
      where: 'year=2025',
      order: 'primary_type',
      limit: 5,
      offset: 20,
    });
    const result = await queryDataset.handler(input, ctx);

    // Canvas holds the staged set (12), not the 5-row inline page.
    expect(registerTable).toHaveBeenCalledTimes(1);
    const staged = registerTable.mock.calls[0]?.[1] as unknown[];
    expect(staged).toHaveLength(12);
    expect(result.canvas_row_count).toBe(12);
    // Inline rows stay bounded by the caller's limit.
    expect(result.rows).toHaveLength(5);
    // One staging request up to the safety cap, under the caller's clauses and offset, on the same ctx.
    expect(mockFetchStagingRows).toHaveBeenCalledTimes(1);
    expect(mockFetchStagingRows).toHaveBeenCalledWith(
      {
        domain: 'data.seattle.gov',
        datasetId: 'abcd-1234',
        where: 'year=2025',
        order: 'primary_type',
        offset: 20,
      },
      50_000,
      ctx,
    );
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
    /** Wire a fresh canvas whose registerTable resolves with the given table name and row count. */
    function spillCanvas(tableName: string, rowCount: number) {
      const registerTable = vi.fn().mockResolvedValue({ tableName, rowCount, columns: [] });
      setCanvas({
        acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas1234', isNew: true, registerTable }),
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
      mockFetchStagingRows.mockResolvedValue(
        Array.from({ length: 40 }, (_, i) => ({ id: String(i) })),
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

    it('when the spill fails: no table_name, no canvas_id, and the notice says nothing was staged without naming a dataframe tool', async () => {
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
        'Rows filled the limit — more rows may match. The matching rows were not staged on the canvas. Page with offset or raise limit (max 5000).',
      );
    });

    it('when staging outlasts the deadline: the inline page stands and the notice names the faster query shapes (#51)', async () => {
      const ctx = createMockContext({ errors: queryDataset.errors });
      fullPage(5, 2183186);
      const registerTable = spillCanvas('tazs_3rd5_rows', 40);
      mockFetchStagingRows.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.Timeout,
          'The request to data.seattle.gov did not complete.',
          {
            reason: 'retry_deadline_exceeded',
            host: 'data.seattle.gov',
          },
        ),
      );

      const result = await queryDataset.handler(
        queryDataset.input.parse({ dataset_id: 'tazs-3rd5', limit: 5 }),
        ctx,
      );

      expect(registerTable).not.toHaveBeenCalled();
      expect(result.rows).toHaveLength(5);
      expect(result.canvas_id).toBeUndefined();
      expect(result.table_name).toBeUndefined();
      expect(getEnrichment(ctx).notice).toBe(
        "Rows filled the limit — more rows may match (exact count in total_count). The matching rows were not staged on the canvas within the call's 50-second time limit; a narrower where, or no order, stages faster. Page with offset or raise limit (max 5000).",
      );
    });

    it.each([
      [
        'its reason',
        new McpError(JsonRpcErrorCode.RateLimited, 'Socrata rate limited the request.', {
          reason: 'rate_limited',
        }),
        'rate_limited',
      ],
      [
        'its error code when it carries no reason',
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Socrata API request failed: 503.'),
        'ServiceUnavailable',
      ],
    ])('when the staging request fails: the notice names %s (#51)', async (_l, failure, label) => {
      const ctx = createMockContext({ errors: queryDataset.errors });
      fullPage(5);
      spillCanvas('tazs_3rd5_rows', 40);
      mockFetchStagingRows.mockRejectedValue(failure);

      const result = await queryDataset.handler(
        queryDataset.input.parse({ dataset_id: 'tazs-3rd5', limit: 5 }),
        ctx,
      );

      expect(result.canvas_id).toBeUndefined();
      expect(getEnrichment(ctx).notice).toBe(
        `Rows filled the limit — more rows may match. The matching rows were not staged on the canvas (${label}). Page with offset or raise limit (max 5000).`,
      );
    });

    it('a caller abort during staging fails the call as cancelled instead of returning the inline page (#51)', async () => {
      const controller = new AbortController();
      const cancellation = new DOMException('Caller cancelled the query', 'AbortError');
      const ctx = createMockContext({ errors: queryDataset.errors, signal: controller.signal });
      fullPage(5);
      spillCanvas('tazs_3rd5_rows', 40);
      mockFetchStagingRows.mockImplementation(() => {
        controller.abort(cancellation);
        return Promise.reject(cancellation);
      });

      await expect(
        queryDataset.handler(queryDataset.input.parse({ dataset_id: 'tazs-3rd5', limit: 5 }), ctx),
      ).rejects.toBe(cancellation);
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
        'When the server has a canvas and more rows match past a full page, up to 50,000 matching rows spill to a DataCanvas table whatever the limit: list its columns with socrata_dataframe_describe, then run SQL with socrata_dataframe_query.',
      );
      expect(queryDataset.input.shape.limit.description).toContain(
        'When the server has a canvas and more rows match past a full page, up to 50,000 matching rows are staged on it whatever the limit — pass a small limit (e.g. 10) to stage a large match without a large inline page.',
      );
      expect(queryDataset.output.shape.table_name.description).toContain('socrata_dataframe_query');
    });

    it('describes the spill by behavior: no advertised text names a configuration variable', () => {
      const advertised = JSON.stringify([
        queryDataset.description,
        z.toJSONSchema(queryDataset.input, { io: 'input' }),
        z.toJSONSchema(queryDataset.output),
      ]);

      expect(advertised).not.toContain('CANVAS_PROVIDER_TYPE');
      // The spill needs more rows past the page, not only a full page.
      expect(advertised).not.toMatch(/fills? limit, up to 50,000/);
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
      mockFetchStagingRows.mockResolvedValue(staged);
      const registerTable = vi
        .fn()
        .mockResolvedValue({ tableName: 'ijzp_q8t2_rows', rowCount: staged.length, columns: [] });
      setCanvas({
        acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas1234', isNew: true, registerTable }),
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

const CHICAGO = { domain: 'data.cityofchicago.org', dataset_id: 'ijzp-q8t2' };

/** The error envelope of a contract result that failed. */
function errorOf(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: { code: number; message: string } }).error;
}

describe('a limit above the 5,000-row per-call cap (#55)', () => {
  /** A page of `served` rows, with the service's recount when it produced one. */
  function servedPage(served: number, totalCount?: number) {
    mockQueryDataset.mockResolvedValue({
      rows: Array.from({ length: served }, (_, i) => ({ id: String(i) })),
      rowCount: served,
      domain: 'data.cityofchicago.org',
      ...(totalCount != null ? { totalCount } : {}),
      assembledQuery: `$limit=${served}`,
    });
  }

  /** The advertised JSON Schema of a tool copy's `limit` input. */
  function limitSchema(def: typeof queryDataset) {
    const { properties } = z.toJSONSchema(def.input, { io: 'input' });
    return properties?.limit as { maximum?: number; description?: string };
  }

  it('serves limit 8000 as 5000 and names the requested limit, the served limit, and the offset that continues', async () => {
    servedPage(5000, 238_183);

    const result = await runToolContract(queryDataset, { ...CHICAGO, limit: 8000 });

    expect(mockQueryDataset).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5000, offset: 0 }),
      expect.anything(),
    );
    const notice =
      'The requested limit 8000 was served as 5000: the per-call cap is 5000, and more rows may match (exact count in total_count). Continue with offset 5000.';
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.rows).toHaveLength(5000);
    expect(sc).toMatchObject({
      total_count: 238_183,
      truncated: true,
      shown: 5000,
      cap: 5000,
      notice,
    });
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it('continues from the caller offset and claims no exact count when the recount failed', async () => {
    servedPage(5000);

    const result = await runToolContract(queryDataset, {
      ...CHICAGO,
      limit: 50_000,
      offset: 20_000,
    });

    expect((result.structuredContent as Record<string, unknown>).notice).toBe(
      'The requested limit 50000 was served as 5000: the per-call cap is 5000, and more rows may match. Continue with offset 25000.',
    );
  });

  it('stages the match when the served page is full and more rows match', async () => {
    servedPage(5000, 238_183);
    mockFetchStagingRows.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ id: String(i) })),
    );
    const registerTable = vi
      .fn()
      .mockResolvedValue({ tableName: 'ijzp_q8t2_rows', rowCount: 12, columns: [] });
    setCanvas({
      acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas1234', isNew: true, registerTable }),
    } as unknown as DataCanvas);

    const result = await runToolContract(queryDataset, { ...CHICAGO, limit: 8000 });

    expect(registerTable).toHaveBeenCalledTimes(1);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      canvas_id: 'canvas1234',
      canvas_row_count: 12,
      table_name: 'ijzp_q8t2_rows',
    });
    expect(sc.notice).toBe(
      'The requested limit 8000 was served as 5000: the per-call cap is 5000, and more rows may match (exact count in total_count). Continue with offset 5000. Staged 12 rows as table "ijzp_q8t2_rows" on canvas canvas1234: list its columns with socrata_dataframe_describe, then run SQL with socrata_dataframe_query. The staged copy stops at 50,000 rows; page with offset for rows beyond it.',
    );
  });

  it.each([
    ['the match ends inside the served page', 3000, undefined],
    ['the count equals the served page', 5000, 5000],
  ])(
    'adds no notice and stages nothing when %s: the cut held no rows back',
    async (_l, served, totalCount) => {
      servedPage(served, totalCount);
      const registerTable = vi.fn();
      setCanvas({
        acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas1234', isNew: true, registerTable }),
      } as unknown as DataCanvas);

      const result = await runToolContract(queryDataset, { ...CHICAGO, limit: 8000 });

      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.rows).toHaveLength(served);
      for (const key of ['notice', 'truncated', 'canvas_id']) {
        expect(sc).not.toHaveProperty(key);
      }
      expect(registerTable).not.toHaveBeenCalled();
    },
  );

  it('drops the raise-limit advice at the cap, where a larger limit serves no more rows', async () => {
    servedPage(5000, 238_183);

    const result = await runToolContract(queryDataset, { ...CHICAGO, limit: 5000 });

    expect((result.structuredContent as Record<string, unknown>).notice).toBe(
      'Rows filled the limit — more rows may match (exact count in total_count). Page with offset.',
    );
  });

  it('keeps the raise-limit advice byte-identical below the cap', async () => {
    servedPage(4999, 238_183);

    const result = await runToolContract(queryDataset, { ...CHICAGO, limit: 4999 });

    expect((result.structuredContent as Record<string, unknown>).notice).toBe(
      'Rows filled the limit — more rows may match (exact count in total_count). Page with offset or raise limit (max 5000).',
    );
  });

  it('with the switch on, advertises the 50,000 ceiling and the 5,000-row cut', () => {
    expect(limitSchema(queryDataset)).toMatchObject({
      maximum: 50_000,
      description:
        'Max rows to return (1–50,000). One call returns at most 5,000 rows: a larger limit is served as 5,000, with a notice naming the offset that continues when more rows match. Default 100. Use with offset for pagination. When the server has a canvas and more rows match past a full page, up to 50,000 matching rows are staged on it whatever the limit — pass a small limit (e.g. 10) to stage a large match without a large inline page.',
    });
  });

  it('with the switch off, keeps 5,000 as the schema maximum and rejects limit 8000 as invalid arguments', async () => {
    const clampOff = await loadQueryDataset(false);

    expect(limitSchema(clampOff)).toMatchObject({
      maximum: 5000,
      description:
        'Max rows to return (1–5000). Default 100. Use with offset for pagination. When the server has a canvas and more rows match past a full page, up to 50,000 matching rows are staged on it whatever the limit — pass a small limit (e.g. 10) to stage a large match without a large inline page.',
    });
    const error = errorOf(await runToolContract(clampOff, { ...CHICAGO, limit: 8000 }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });
});

describe('table_name names the staged table (#58)', () => {
  /** A one-row page of a 441-row match, with the rows to stage. */
  function largeMatch() {
    mockQueryDataset.mockResolvedValue({
      rows: [{ id: '1' }],
      rowCount: 1,
      domain: 'data.cityofchicago.org',
      totalCount: 441,
      assembledQuery: "$where=primary_type='HOMICIDE' AND year=2025 $limit=1",
    });
    mockFetchStagingRows.mockResolvedValue(
      Array.from({ length: 441 }, (_, i) => ({ id: String(i) })),
    );
  }

  /**
   * Wire a canvas that registers what it is given. `existing` is the table the
   * canvas reports under the name being written, when it already holds one.
   */
  function wireCanvas(isNew: boolean, existing?: { name: string; rowCount: number }) {
    const registerTable = vi.fn((tableName: string, rows: unknown[]) =>
      Promise.resolve({ tableName, rowCount: rows.length, columns: [] }),
    );
    const describeTables = vi
      .fn()
      .mockResolvedValue(existing ? [{ ...existing, kind: 'table', columns: [] }] : []);
    setCanvas({
      acquire: vi.fn().mockResolvedValue({
        canvasId: 'canvas1234',
        isNew,
        registerTable,
        describe: describeTables,
      }),
    } as unknown as DataCanvas);
    return { registerTable, describeTables };
  }

  it('stages under the caller name, lowercased, and returns that name on both surfaces', async () => {
    largeMatch();
    const { registerTable } = wireCanvas(true);

    const result = await runToolContract(queryDataset, {
      ...CHICAGO,
      where: "primary_type='HOMICIDE' AND year=2025",
      limit: 1,
      table_name: 'H2025',
    });

    expect(registerTable.mock.calls[0]?.[0]).toBe('h2025');
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ table_name: 'h2025', canvas_row_count: 441 });
    expect(String(sc.notice)).toContain('Staged 441 rows as table "h2025" on canvas canvas1234');
    expect(contentText(result)).toContain('441 rows staged as table `h2025`');
  });

  it.each([
    ['omitted', {}, 'data.cityofchicago.org', 'ijzp-q8t2', 'ijzp_q8t2_rows'],
    ['empty', { table_name: '' }, 'data.cityofchicago.org', 'ijzp-q8t2', 'ijzp_q8t2_rows'],
    ['empty', { table_name: '' }, 'data.cityofnewyork.us', '43nn-pn8j', 't_43nn_pn8j_rows'],
  ])(
    'stages under the derived name when table_name is %s (%s → %s)',
    async (_l, extra, domain, datasetId, derived) => {
      largeMatch();
      const { registerTable } = wireCanvas(true);

      const result = await runToolContract(queryDataset, {
        domain,
        dataset_id: datasetId,
        limit: 1,
        ...extra,
      });

      expect(result.isError).toBeFalsy();
      expect(registerTable.mock.calls[0]?.[0]).toBe(derived);
      expect((result.structuredContent as Record<string, unknown>).table_name).toBe(derived);
    },
  );

  it.each([
    ['a leading digit', '2025'],
    ['a hyphen', 'a-b'],
    ['a space', 'h 2025'],
    ['64 characters', `t${'x'.repeat(63)}`],
  ])(
    'rejects a name with %s before any upstream request, naming the accepted pattern',
    async (_l, name) => {
      largeMatch();

      const error = errorOf(await runToolContract(queryDataset, { ...CHICAGO, table_name: name }));

      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toContain('^[a-z_][a-z0-9_]{0,62}$');
      expect(mockQueryDataset).not.toHaveBeenCalled();
    },
  );

  it.each(['select', 'Order'])(
    'rejects %s, a SQL keyword the canvas refuses as a table name, before any upstream request',
    async (name) => {
      largeMatch();

      const error = errorOf(await runToolContract(queryDataset, { ...CHICAGO, table_name: name }));

      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toContain(`"${name.toLowerCase()}" is a SQL keyword`);
      expect(mockQueryDataset).not.toHaveBeenCalled();
    },
  );

  it('advertises a pattern the raw mixed-case name passes, with no regex flag', () => {
    const schema = z.toJSONSchema(queryDataset.input, { io: 'input' }).properties?.table_name as {
      type?: string;
      pattern?: string;
    };

    expect(schema).toMatchObject({ type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,62}$' });
    expect(new RegExp(schema.pattern ?? '').test('H2025')).toBe(true);
    expect(new RegExp(schema.pattern ?? '').test('2025')).toBe(false);
  });

  it('names the replaced table and its previous row count when the canvas already holds one by that name', async () => {
    largeMatch();
    const { describeTables } = wireCanvas(false, { name: 'ijzp_q8t2_rows', rowCount: 353 });

    const result = await runToolContract(queryDataset, {
      ...CHICAGO,
      limit: 1,
      canvas_id: 'canvas1234',
    });

    expect(describeTables).toHaveBeenCalledWith({ tableName: 'ijzp_q8t2_rows' });
    const notice =
      'Rows filled the limit — more rows may match (exact count in total_count). Staged 441 rows as table "ijzp_q8t2_rows" on canvas canvas1234: list its columns with socrata_dataframe_describe, then run SQL with socrata_dataframe_query. Replaced table "ijzp_q8t2_rows" (previously 353 rows). The staged copy stops at 50,000 rows; page with offset for rows beyond it.';
    expect((result.structuredContent as Record<string, unknown>).notice).toBe(notice);
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it.each([
    ['a canvas this call minted', true],
    ['a canvas without a table of that name', false],
  ])('adds no replacement sentence on %s', async (_l, isNew) => {
    largeMatch();
    const { describeTables, registerTable } = wireCanvas(isNew);

    const result = await runToolContract(queryDataset, {
      ...CHICAGO,
      limit: 1,
      table_name: 'h2026',
    });

    expect(registerTable).toHaveBeenCalledTimes(1);
    expect(describeTables).toHaveBeenCalledTimes(isNew ? 0 : 1);
    expect(String((result.structuredContent as Record<string, unknown>).notice)).not.toContain(
      'Replaced',
    );
  });

  /** A page holding the whole match from offset: `rowCount` rows under a limit of 100, no count. */
  function wholeMatch(rowCount: number) {
    mockQueryDataset.mockResolvedValue({
      rows: Array.from({ length: rowCount }, (_, i) => ({ id: String(i) })),
      rowCount,
      domain: 'data.cityofchicago.org',
      assembledQuery: "$where=primary_type='HOMICIDE' AND year=2026 $limit=100",
    });
  }

  it.each([
    [
      3,
      'Nothing was staged as table "h2026": no rows match past this page, and only a match that runs past the page is staged. Rerun with a limit below 3 to stage these rows.',
    ],
    [
      1,
      'Nothing was staged as table "h2026": no rows match past this page, and only a match that runs past the page is staged.',
    ],
  ])(
    'says why a named table was not staged when the %i-row match fits the page',
    async (rowCount, notice) => {
      wholeMatch(rowCount);
      const { registerTable } = wireCanvas(true);

      const result = await runToolContract(queryDataset, {
        ...CHICAGO,
        where: "primary_type='HOMICIDE' AND year=2026",
        table_name: 'H2026',
      });

      expect(registerTable).not.toHaveBeenCalled();
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc).not.toHaveProperty('canvas_id');
      expect(sc).not.toHaveProperty('truncated');
      expect(sc.notice).toBe(notice);
      expect(contentText(result)).toContain(`> ${notice}`);
    },
  );

  it('adds no notice when the match fits the page and no table was named', async () => {
    wholeMatch(3);
    wireCanvas(true);

    const result = await runToolContract(queryDataset, CHICAGO);

    expect(result.structuredContent as Record<string, unknown>).not.toHaveProperty('notice');
  });

  it.each([
    [
      'when the match fits the page',
      () => wholeMatch(3),
      100,
      'Nothing was staged as table "h2026": this server has no DataCanvas.',
    ],
    [
      'beside the paging guidance when more rows match',
      largeMatch,
      1,
      'Rows filled the limit — more rows may match (exact count in total_count). Nothing was staged as table "h2026": this server has no DataCanvas. Page with offset or raise limit (max 5000).',
    ],
  ])(
    'says a named table was not staged on a server without a canvas, %s',
    async (_l, serve, limit, notice) => {
      serve();

      const result = await runToolContract(queryDataset, {
        ...CHICAGO,
        limit,
        table_name: 'h2026',
      });

      expect(mockFetchStagingRows).not.toHaveBeenCalled();
      expect((result.structuredContent as Record<string, unknown>).notice).toBe(notice);
    },
  );
});

describe('format() table columns are the union of every row’s keys (#49)', () => {
  /** The #49 repro’s shape: SODA omits a null `grade`, so rows 0–8 carry none and 9–19 carry A. */
  const REPRO_ROWS = Array.from({ length: 20 }, (_, i) => ({
    camis: i < 10 ? '30191841' : '30075445',
    dba: i < 10 ? 'DJ REYNOLDS PUB' : 'MORRIS PARK BAKE SHOP',
    ...(i >= 9 ? { grade: 'A' } : {}),
    score: String(i),
  }));

  const output = (rows: Record<string, unknown>[]) => ({
    rows,
    row_count: rows.length,
    assembled_query: '$limit=20',
    domain: 'data.cityofnewyork.us',
    dataset_id: '43nn-pn8j',
  });

  it('renders a grade column the first row lacks, with A in the 11 rows that carry it', () => {
    const lines = formatText(output(REPRO_ROWS)).split('\n');

    expect(lines).toContain('| camis | dba | score | grade |');
    expect(lines).toContain('| 30191841 | DJ REYNOLDS PUB | 0 |  |');
    expect(lines).toContain('| 30075445 | MORRIS PARK BAKE SHOP | 19 | A |');
    expect(lines.filter((l) => l.endsWith(' | A |'))).toHaveLength(11);
    expect(lines.filter((l) => l.endsWith(' |  |'))).toHaveLength(9);
  });

  it('adds a column for a key absent from every earlier row, so no value is missing from the table', () => {
    const rows = [{ a: '1' }, { a: '2', b: 'x' }, { c: 'y', a: '3' }];
    const lines = formatText(output(rows)).split('\n');

    expect(lines.slice(lines.indexOf('| a | b | c |'))).toEqual([
      '| a | b | c |',
      '| :--- | :--- | :--- |',
      '| 1 |  |  |',
      '| 2 | x |  |',
      '| 3 |  | y |',
    ]);
  });

  it('falls back to fenced JSON when the union passes 10 columns though the first row has 10', () => {
    const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, String(i)]));
    const text = formatText(output([ten, { ...ten, k10: '10' }]));

    expect(text).not.toContain('| k0 |');
    expect(text).toContain(`\`\`\`json\n${JSON.stringify({ ...ten, k10: '10' })}\n\`\`\``);
  });

  it('renders rows whose keys all match exactly as before', () => {
    const text = formatText(
      output([
        { incident_type: 'Theft', year: '2023' },
        { incident_type: 'Assault', year: '2023' },
      ]),
    );

    expect(text.slice(text.indexOf('| incident_type'))).toBe(
      '| incident_type | year |\n| :--- | :--- |\n| Theft | 2023 |\n| Assault | 2023 |',
    );
  });
});

describe('the **Query:** echo reads back as the assembled query (#60)', () => {
  const output = (assembled_query: string) => ({
    rows: [{ id: '1' }],
    row_count: 1,
    assembled_query,
    domain: 'data.cityofnewyork.us',
    dataset_id: '43nn-pn8j',
  });

  it('renders text that parses as emphasis inside a code span, read back verbatim', () => {
    const text = formatText(output("$where=dba='*none*' $limit=100"));

    expect(text).toContain("\n**Query:** `$where=dba='*none*' $limit=100`\n");
    expect(readCodeEcho(text, 'Query')).toBe("$where=dba='*none*' $limit=100");
  });

  it('renders a query without Markdown punctuation as the same text inside a code span', () => {
    expect(formatText(output('$where=year=2023 $limit=100'))).toContain(
      '\n**Query:** `$where=year=2023 $limit=100`\n',
    );
  });

  it('fences a query whose where clause holds a line break, read back verbatim', () => {
    const query = "$where=boro='Manhattan'\n- AND grade='A' $limit=100";
    const text = formatText(output(query));

    expect(text).toContain(`\n**Query:**\n\`\`\`\n${query}\n\`\`\`\n`);
    expect(readCodeEcho(text, 'Query')).toBe(query);
  });

  it('sizes the span past a backtick in caller text', () => {
    const text = formatText(output("$where=dba='a`b' $limit=100"));

    expect(readCodeEcho(text, 'Query')).toBe("$where=dba='a`b' $limit=100");
  });

  it('keeps structuredContent.assembled_query byte-identical to the service echo', async () => {
    const assembled = "$where=dba='*none*' $limit=100";
    mockQueryDataset.mockResolvedValue({
      rows: [],
      rowCount: 0,
      domain: 'data.cityofnewyork.us',
      assembledQuery: assembled,
    });

    const result = await runToolContract(queryDataset, {
      domain: 'data.cityofnewyork.us',
      dataset_id: '43nn-pn8j',
      where: "dba='*none*'",
    });

    expect((result.structuredContent as Record<string, unknown>).assembled_query).toBe(assembled);
    expect(readCodeEcho(contentText(result), 'Query')).toBe(assembled);
  });
});
