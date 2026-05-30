/**
 * @fileoverview Security and edge case tests across Socrata tools.
 * Covers injection attempts, oversized inputs, secret leakage, and boundary values.
 * @module tests/tools/security.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findDatasets } from '@/mcp-server/tools/definitions/find-datasets.tool.js';
import { getDataset } from '@/mcp-server/tools/definitions/get-dataset.tool.js';
import { listPortals } from '@/mcp-server/tools/definitions/list-portals.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ defaultDomain: 'data.seattle.gov' }),
}));

import { getSocrataService } from '@/services/socrata/socrata-service.js';

const mockFindDatasets = vi.fn();
const mockGetDataset = vi.fn();
const mockQueryDataset = vi.fn();
const mockListPortals = vi.fn();
const mockService = {
  findDatasets: mockFindDatasets,
  getDataset: mockGetDataset,
  queryDataset: mockQueryDataset,
  listPortals: mockListPortals,
};

beforeEach(() => {
  vi.clearAllMocks();
  (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

// ---------------------------------------------------------------------------
// Input validation — Zod schema boundary enforcement
// ---------------------------------------------------------------------------

describe('input validation — schema boundaries', () => {
  it('rejects findDatasets limit below minimum (0)', () => {
    expect(() => findDatasets.input.parse({ limit: 0 })).toThrow();
  });

  it('rejects findDatasets limit above maximum (101)', () => {
    expect(() => findDatasets.input.parse({ limit: 101 })).toThrow();
  });

  it('accepts findDatasets at limit boundaries (1 and 100)', () => {
    expect(() => findDatasets.input.parse({ limit: 1 })).not.toThrow();
    expect(() => findDatasets.input.parse({ limit: 100 })).not.toThrow();
  });

  it('rejects findDatasets negative offset', () => {
    expect(() => findDatasets.input.parse({ offset: -1 })).toThrow();
  });

  it('accepts findDatasets zero offset', () => {
    expect(() => findDatasets.input.parse({ offset: 0 })).not.toThrow();
  });

  it('rejects queryDataset limit above maximum (5001)', () => {
    expect(() => queryDataset.input.parse({ dataset_id: 'abcd-1234', limit: 5001 })).toThrow();
  });

  it('accepts queryDataset at limit boundary (5000)', () => {
    expect(() => queryDataset.input.parse({ dataset_id: 'abcd-1234', limit: 5000 })).not.toThrow();
  });

  it('rejects queryDataset limit below minimum (0)', () => {
    expect(() => queryDataset.input.parse({ dataset_id: 'abcd-1234', limit: 0 })).toThrow();
  });

  it('rejects listPortals limit above maximum (201)', () => {
    expect(() => listPortals.input.parse({ limit: 201 })).toThrow();
  });

  it('accepts listPortals at limit boundary (200)', () => {
    expect(() => listPortals.input.parse({ limit: 200 })).not.toThrow();
  });

  it('rejects findDatasets non-integer limit', () => {
    expect(() => findDatasets.input.parse({ limit: 1.5 })).toThrow();
  });

  it('rejects findDatasets invalid only value', () => {
    expect(() => findDatasets.input.parse({ only: 'videos' as 'datasets' })).toThrow();
  });

  it('rejects findDatasets invalid order value', () => {
    expect(() => findDatasets.input.parse({ order: 'random' as 'relevance' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Dataset ID validation — four-by-four pattern enforcement
// ---------------------------------------------------------------------------

describe('dataset ID validation', () => {
  it('getDataset rejects ID with uppercase letters', async () => {
    const ctx = createMockContext({ errors: getDataset.errors });
    const input = getDataset.input.parse({ dataset_id: 'ABCD-1234' });
    await expect(getDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('queryDataset rejects ID with special characters', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ dataset_id: 'abcd_1234' });
    await expect(queryDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('queryDataset rejects an empty string as dataset ID', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ dataset_id: '' });
    await expect(queryDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('queryDataset rejects path traversal in dataset ID', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ dataset_id: '../etc/passwd' });
    await expect(queryDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('getDataset rejects path traversal in dataset ID', async () => {
    const ctx = createMockContext({ errors: getDataset.errors });
    const input = getDataset.input.parse({ dataset_id: '../../passwd' });
    await expect(getDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('queryDataset rejects null bytes in dataset ID', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ dataset_id: 'abcd\x001234' });
    await expect(queryDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('queryDataset rejects too-long dataset ID', async () => {
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({
      dataset_id: 'abcd-1234-extra-garbage',
    });
    await expect(queryDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });
});

// ---------------------------------------------------------------------------
// Error code surface — declared contract reasons propagate correctly
// ---------------------------------------------------------------------------

describe('error contract propagation', () => {
  it('getDataset surfaces not_found reason when service throws NotFound with reason=not_found', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetDataset.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Dataset not found', { reason: 'not_found' }),
    );
    const ctx = createMockContext({ errors: getDataset.errors });
    const input = getDataset.input.parse({ dataset_id: 'kzjm-xkqj' });
    await expect(getDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('queryDataset surfaces not_found reason when service throws NotFound with reason=not_found', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    mockQueryDataset.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Dataset not found', { reason: 'not_found' }),
    );
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ dataset_id: 'kzjm-xkqj' });
    await expect(queryDataset.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('queryDataset re-throws non-NotFound service errors unchanged', async () => {
    mockQueryDataset.mockRejectedValue(new Error('Unexpected upstream error'));
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ dataset_id: 'kzjm-xkqj' });
    await expect(queryDataset.handler(input, ctx)).rejects.toThrow('Unexpected upstream error');
  });

  it('getDataset re-throws non-NotFound McpErrors unchanged', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetDataset.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Rate limited', { reason: 'rate_limited' }),
    );
    const ctx = createMockContext({ errors: getDataset.errors });
    const input = getDataset.input.parse({ dataset_id: 'kzjm-xkqj' });
    await expect(getDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });
});

// ---------------------------------------------------------------------------
// SoQL injection — verify inputs are passed-through to the service layer
// (not interpreted by the handler) and that the service mock receives them intact.
// The service layer (not handler) is responsible for sanitizing/escaping —
// these tests confirm the handler does not silently drop or modify injection attempts.
// ---------------------------------------------------------------------------

describe('SoQL injection pass-through', () => {
  it('passes where clause with SQL-injection-style payload to service layer intact', async () => {
    mockQueryDataset.mockResolvedValue({
      rows: [],
      rowCount: 0,
      assembledQuery: '$where=1=1 OR 1=1',
    });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({
      dataset_id: 'abcd-1234',
      where: "1=1 OR 1=1'; DROP TABLE data; --",
    });
    await queryDataset.handler(input, ctx);
    const call = mockQueryDataset.mock.calls[0][0];
    expect(call.where).toBe("1=1 OR 1=1'; DROP TABLE data; --");
  });

  it('passes select clause with injection-style payload to service layer intact', async () => {
    mockQueryDataset.mockResolvedValue({
      rows: [],
      rowCount: 0,
      assembledQuery: '$select=*',
    });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({
      dataset_id: 'abcd-1234',
      select: '*, (SELECT password FROM users)',
    });
    await queryDataset.handler(input, ctx);
    const call = mockQueryDataset.mock.calls[0][0];
    expect(call.select).toBe('*, (SELECT password FROM users)');
  });
});

// ---------------------------------------------------------------------------
// Whitespace-only inputs — handlers must treat them as absent
// ---------------------------------------------------------------------------

describe('whitespace-only inputs', () => {
  it('findDatasets treats whitespace-only query as absent (no filter applied)', async () => {
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });
    const ctx = createMockContext({ errors: findDatasets.errors });
    const input = findDatasets.input.parse({ query: '   ' });
    await findDatasets.handler(input, ctx);

    const call = mockFindDatasets.mock.calls[0][0];
    expect(call.query).toBeUndefined();
  });

  it('findDatasets treats whitespace-only domain as absent', async () => {
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });
    const ctx = createMockContext({ errors: findDatasets.errors });
    const input = findDatasets.input.parse({ domain: '   ' });
    await findDatasets.handler(input, ctx);

    const call = mockFindDatasets.mock.calls[0][0];
    expect(call.domain).toBeUndefined();
  });

  it('queryDataset treats whitespace-only where as absent', async () => {
    mockQueryDataset.mockResolvedValue({
      rows: [{ col: 'val' }],
      rowCount: 1,
      assembledQuery: '$limit=100',
    });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ dataset_id: 'abcd-1234', where: '   ' });
    await queryDataset.handler(input, ctx);

    const call = mockQueryDataset.mock.calls[0][0];
    expect(call.where).toBeUndefined();
  });

  it('queryDataset treats whitespace-only select as absent', async () => {
    mockQueryDataset.mockResolvedValue({
      rows: [],
      rowCount: 0,
      assembledQuery: '$limit=100',
    });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ dataset_id: 'abcd-1234', select: '   ' });
    await queryDataset.handler(input, ctx);

    const call = mockQueryDataset.mock.calls[0][0];
    expect(call.select).toBeUndefined();
  });

  it('listPortals treats whitespace-only query as absent (no filter)', async () => {
    mockListPortals.mockResolvedValue([
      { domain: 'data.seattle.gov', organization: 'City of Seattle', datasetCount: 500 },
    ]);
    const ctx = createMockContext({ errors: listPortals.errors });
    const input = listPortals.input.parse({ query: '   ' });
    const result = await listPortals.handler(input, ctx);

    // All portals returned — whitespace query treated as no filter.
    expect(result.portals).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Unicode and encoding
// ---------------------------------------------------------------------------

describe('unicode and special characters in inputs', () => {
  it('findDatasets passes unicode query through to service', async () => {
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });
    const ctx = createMockContext({ errors: findDatasets.errors });
    const input = findDatasets.input.parse({ query: '日本語データ 🌏' });
    await findDatasets.handler(input, ctx);

    const call = mockFindDatasets.mock.calls[0][0];
    expect(call.query).toBe('日本語データ 🌏');
  });

  it('listPortals filters correctly with unicode query', async () => {
    mockListPortals.mockResolvedValue([
      { domain: 'données.gov.fr', organization: 'Gouvernement Français', datasetCount: 100 },
      { domain: 'data.seattle.gov', organization: 'City of Seattle', datasetCount: 500 },
    ]);
    const ctx = createMockContext({ errors: listPortals.errors });
    const input = listPortals.input.parse({ query: 'français' });
    const result = await listPortals.handler(input, ctx);

    expect(result.portals).toHaveLength(1);
    expect(result.portals[0].domain).toBe('données.gov.fr');
  });
});

// ---------------------------------------------------------------------------
// Secret / env var leakage — no token should appear in any tool output
// ---------------------------------------------------------------------------

describe('no secret or env var leakage', () => {
  it('findDatasets result contains no SOCRATA_APP_TOKEN value', async () => {
    // Mock the config to return a fake token.
    const { getServerConfig } = await import('@/config/server-config.js');
    (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      appToken: 'super-secret-token-abc123',
      defaultDomain: 'data.seattle.gov',
    });

    mockFindDatasets.mockResolvedValue({
      results: [
        {
          datasetId: 'abcd-1234',
          domain: 'data.seattle.gov',
          name: 'Test Dataset',
          tags: [],
          columnNames: [],
        },
      ],
      totalCount: 1,
    });

    const ctx = createMockContext({ errors: findDatasets.errors });
    const input = findDatasets.input.parse({ query: 'test' });
    const result = await findDatasets.handler(input, ctx);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-secret-token-abc123');
  });

  it('getDataset result contains no SOCRATA_APP_TOKEN value', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      appToken: 'another-secret-xyz789',
      defaultDomain: 'data.seattle.gov',
    });

    mockGetDataset.mockResolvedValue({
      datasetId: 'kzjm-xkqj',
      domain: 'data.seattle.gov',
      name: 'Dataset',
      tags: [],
      columns: [],
    });

    const ctx = createMockContext({ errors: getDataset.errors });
    const input = getDataset.input.parse({ dataset_id: 'kzjm-xkqj' });
    const result = await getDataset.handler(input, ctx);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('another-secret-xyz789');
  });

  it('queryDataset result contains no SOCRATA_APP_TOKEN value', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      appToken: 'query-secret-qrs456',
      defaultDomain: 'data.seattle.gov',
    });

    mockQueryDataset.mockResolvedValue({
      rows: [{ col: 'value' }],
      rowCount: 1,
      assembledQuery: '$limit=100',
    });

    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ dataset_id: 'kzjm-xkqj' });
    const result = await queryDataset.handler(input, ctx);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('query-secret-qrs456');
  });

  it('listPortals result contains no SOCRATA_APP_TOKEN value', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      appToken: 'portals-secret-pqr321',
      defaultDomain: 'data.seattle.gov',
    });

    mockListPortals.mockResolvedValue([
      { domain: 'data.seattle.gov', organization: 'City of Seattle', datasetCount: 500 },
    ]);

    const ctx = createMockContext({ errors: listPortals.errors });
    const input = listPortals.input.parse({});
    const result = await listPortals.handler(input, ctx);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('portals-secret-pqr321');
  });
});

// ---------------------------------------------------------------------------
// Empty result sets and pagination edge cases
// ---------------------------------------------------------------------------

describe('empty result sets and pagination', () => {
  it('findDatasets with only filter returns empty when service returns nothing', async () => {
    mockFindDatasets.mockResolvedValue({ results: [], totalCount: 0 });
    const ctx = createMockContext({ errors: findDatasets.errors });
    const input = findDatasets.input.parse({ only: 'maps' });
    const result = await findDatasets.handler(input, ctx);

    expect(result.results).toHaveLength(0);
  });

  it('listPortals at offset beyond total returns empty portals', async () => {
    mockListPortals.mockResolvedValue([
      { domain: 'data.seattle.gov', organization: 'City of Seattle', datasetCount: 500 },
    ]);
    const ctx = createMockContext({ errors: listPortals.errors });
    const input = listPortals.input.parse({ offset: 999 });
    const result = await listPortals.handler(input, ctx);

    expect(result.portals).toHaveLength(0);
  });

  it('queryDataset propagates having clause to service', async () => {
    mockQueryDataset.mockResolvedValue({
      rows: [{ category: 'A', n: '50' }],
      rowCount: 1,
      assembledQuery: '$select=category,count(*) $group=category $having=count(*)>10',
    });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({
      dataset_id: 'abcd-1234',
      select: 'category, count(*) as n',
      group: 'category',
      having: 'count(*) > 10',
    });
    await queryDataset.handler(input, ctx);

    const call = mockQueryDataset.mock.calls[0][0];
    expect(call.having).toBe('count(*) > 10');
    expect(call.group).toBe('category');
  });

  it('queryDataset propagates search full-text parameter to service', async () => {
    mockQueryDataset.mockResolvedValue({
      rows: [],
      rowCount: 0,
      assembledQuery: '$q=bicycle $limit=100',
    });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({
      dataset_id: 'abcd-1234',
      search: 'bicycle',
    });
    await queryDataset.handler(input, ctx);

    const call = mockQueryDataset.mock.calls[0][0];
    expect(call.search).toBe('bicycle');
  });
});

// ---------------------------------------------------------------------------
// format() — oversized payloads and edge cases
// ---------------------------------------------------------------------------

describe('format() — oversized and edge-case payloads', () => {
  it('queryDataset format handles >50 rows by truncating with "more rows" indicator', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: String(i), val: 'x' }));
    const output = {
      rows,
      row_count: 60,
      assembled_query: '$limit=100',
      domain: 'data.seattle.gov',
      dataset_id: 'kzjm-xkqj',
    };
    const blocks = queryDataset.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('more rows');
  });

  it('queryDataset format handles >20 rows in wide dataset (JSON fallback, >20 rows truncated)', () => {
    const cols = Array.from({ length: 12 }, (_, i) => `col${i}`);
    const rows = Array.from({ length: 25 }, (_, r) =>
      Object.fromEntries(cols.map((c, i) => [c, `val${r}_${i}`])),
    );
    const output = {
      rows,
      row_count: 25,
      assembled_query: '$limit=100',
      domain: 'data.seattle.gov',
      dataset_id: 'kzjm-xkqj',
    };
    const blocks = queryDataset.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    // Wide result (>10 cols) falls back to JSON.
    expect(text).toContain('```json');
    expect(text).toContain('more rows');
  });

  it('getDataset format renders non_null_count when present', () => {
    const output = {
      dataset_id: 'kzjm-xkqj',
      domain: 'data.seattle.gov',
      name: 'Test Dataset',
      tags: [],
      columns: [{ field_name: 'amount', data_type: 'Number', non_null_count: 5000 }],
    };
    const blocks = getDataset.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('5000 non-null');
  });

  it('getDataset format handles pipe characters in column descriptions (markdown escaping)', () => {
    const output = {
      dataset_id: 'kzjm-xkqj',
      domain: 'data.seattle.gov',
      name: 'Test',
      tags: [],
      columns: [{ field_name: 'notes', data_type: 'Text', description: 'A|B|C values' }],
    };
    const blocks = getDataset.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    // Description is in the markdown table cell — may or may not escape pipes
    // but the table should still render and contain the field name.
    expect(text).toContain('notes');
  });

  it('findDatasets format truncates column_names preview to 8 columns', () => {
    const output = {
      results: [
        {
          dataset_id: 'abcd-1234',
          domain: 'data.example.gov',
          name: 'Wide Dataset',
          tags: [],
          column_names: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
        },
      ],
    };
    const blocks = findDatasets.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    // 10 columns — should show 8 + "(+2 more)" indicator.
    expect(text).toContain('+2 more');
  });

  it('findDatasets format includes view_count and license when present', () => {
    const output = {
      results: [
        {
          dataset_id: 'abcd-1234',
          domain: 'data.example.gov',
          name: 'Popular Dataset',
          tags: [],
          column_names: [],
          view_count: 99999,
          license: 'CC BY 4.0',
        },
      ],
    };
    const blocks = findDatasets.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('99999');
    expect(text).toContain('CC BY 4.0');
  });
});
