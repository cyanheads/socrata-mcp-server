/**
 * @fileoverview Tests for the get-dataset tool.
 * @module tests/tools/get-dataset.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetTypeSchema } from '@/mcp-server/asset-type-schema.js';
import { getDataset } from '@/mcp-server/tools/definitions/get-dataset.tool.js';
import { expectLinearCost } from '../linear-cost.js';
import { contentText } from './content-text.js';

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ defaultDomain: 'data.seattle.gov' }),
}));

import { getSocrataService } from '@/services/socrata/socrata-service.js';

const mockGetDataset = vi.fn();
const mockService = { getDataset: mockGetDataset };

beforeEach(() => {
  vi.clearAllMocks();
  (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

describe('getDataset', () => {
  it('rejects a malformed dataset ID at input validation, naming the four-by-four form', () => {
    const parsed = getDataset.input.safeParse({ dataset_id: 'not-valid-id' });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ['dataset_id'],
        message: expect.stringContaining('four-by-four'),
      }),
    ]);
  });

  it('returns full dataset metadata for valid ID', async () => {
    const ctx = createMockContext({ errors: getDataset.errors });
    mockGetDataset.mockResolvedValue({
      datasetId: 'kzjm-xkqj',
      domain: 'data.seattle.gov',
      name: 'Seattle 911 Incidents',
      tags: ['public safety'],
      rowCount: 150000,
      columns: [
        { fieldName: 'incident_type', dataType: 'Text' },
        { fieldName: 'incident_date', dataType: 'Calendar date' },
      ],
    });

    const input = getDataset.input.parse({ dataset_id: 'kzjm-xkqj' });
    const result = await getDataset.handler(input, ctx);

    expect(result.dataset_id).toBe('kzjm-xkqj');
    expect(result.name).toBe('Seattle 911 Incidents');
    expect(result.columns).toHaveLength(2);
    expect(result.columns[0]!).toMatchObject({ field_name: 'incident_type', data_type: 'Text' });
  });

  it('handles sparse upstream metadata (no optional fields)', async () => {
    const ctx = createMockContext({ errors: getDataset.errors });
    mockGetDataset.mockResolvedValue({
      datasetId: 'aaaa-1111',
      domain: 'data.example.gov',
      name: 'Minimal Dataset',
      tags: [],
      columns: [],
      // rowCount, rowCountSource, description, category, dataUpdatedAt, license absent
    });

    const input = getDataset.input.parse({ dataset_id: 'aaaa-1111' });
    const result = await getDataset.handler(input, ctx);

    expect(result.dataset_id).toBe('aaaa-1111');
    expect(result.row_count).toBeUndefined();
    expect(result.row_count_source).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it('maps a derived row count and its source through to the output', async () => {
    const ctx = createMockContext({ errors: getDataset.errors });
    mockGetDataset.mockResolvedValue({
      datasetId: 'ijzp-q8t2',
      domain: 'data.cityofchicago.org',
      name: 'Crimes - 2001 to Present',
      tags: [],
      rowCount: 8585919,
      rowCountSource: 'column_cached_contents',
      columns: [],
    });

    const input = getDataset.input.parse({ dataset_id: 'ijzp-q8t2' });
    const result = await getDataset.handler(input, ctx);

    expect(result.row_count).toBe(8585919);
    expect(result.row_count_source).toBe('column_cached_contents');
  });

  it('format renders the row count with its source', () => {
    const output = {
      dataset_id: 'ijzp-q8t2',
      domain: 'data.cityofchicago.org',
      name: 'Crimes - 2001 to Present',
      tags: [],
      row_count: 8585919,
      row_count_source: 'column_cached_contents' as const,
      columns: [],
    };
    const blocks = getDataset.format!(output);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('8,585,919');
    expect(text).toContain('source: column_cached_contents');
  });

  describe('renders upstream text in full, still framed (#19)', () => {
    // Two lines, 2,462 characters in all — past the old 2,000-character blockquote cap.
    const longDescription = `${'a'.repeat(1500)}\n${'b'.repeat(960)}Z`;
    // 417 characters with a pipe and a newline — past the old 400-character cell cap.
    const longColumnDescription = `${'c'.repeat(300)} x|y \n${'d'.repeat(110)}W`;
    const output = {
      dataset_id: 'ijzp-q8t2',
      domain: 'data.cityofchicago.org',
      name: 'Crimes - 2001 to Present',
      tags: [],
      description: longDescription,
      columns: [
        { field_name: 'census_block_2020', data_type: 'Text', description: longColumnDescription },
      ],
    };
    const text = () => (getDataset.format!(output)[0] as { text?: string }).text ?? '';

    it('carries the whole dataset description, every line blockquoted', () => {
      expect(longDescription).toHaveLength(2462);
      expect(text()).toContain(`> ${'a'.repeat(1500)}\n> ${'b'.repeat(960)}Z`);
      expect(text()).not.toContain('[truncated]');
    });

    it('carries the whole column description with pipes and newlines escaped', () => {
      expect(longColumnDescription).toHaveLength(417);
      expect(text()).toContain(`${'c'.repeat(300)} x\\|y&#32;&#10;${'d'.repeat(110)}W |`);
      expect(text()).not.toContain('[truncated]');
    });

    it('carries the whole dataset name in the heading, newlines collapsed', () => {
      const longName = `${'n'.repeat(250)}\nEND`;
      const rendered =
        (getDataset.format!({ ...output, name: longName })[0] as { text?: string }).text ?? '';
      expect(rendered).toContain(`## "${'n'.repeat(250)} END"`);
      expect(rendered).not.toContain('[truncated]');
    });
  });

  it('formats output with ID, domain, column table', () => {
    const output = {
      dataset_id: 'kzjm-xkqj',
      domain: 'data.seattle.gov',
      name: 'Seattle 911 Incidents',
      tags: ['public safety'],
      columns: [
        { field_name: 'incident_type', data_type: 'Text' },
        { field_name: 'year', data_type: 'Number' },
      ],
    };
    const blocks = getDataset.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text?: string }).text ?? '';
    expect(text).toContain('kzjm-xkqj');
    expect(text).toContain('data.seattle.gov');
    expect(text).toContain('incident_type');
    expect(text).toContain('Text');
  });
});

/** The rendered text for one column named `fieldName`. */
const render = (fieldName: string) =>
  (
    getDataset.format!({
      dataset_id: 'aaaa-1111',
      domain: 'data.example.gov',
      name: 'x',
      tags: [],
      columns: [{ field_name: fieldName, data_type: 'Text' }],
    })[0] as { text?: string }
  ).text ?? '';

describe('the Columns table Field cell reads back as the column’s field_name', () => {
  const markdownIt = new MarkdownIt();

  /** The inline tokens of the first cell of each Columns body row, as markdown-it 15 parses `markdown`. */
  function fieldCells(markdown: string): { type: string; content: string }[][] {
    const cells: { type: string; content: string }[][] = [];
    const tokens = markdownIt.parse(markdown, {});
    let inBody = false;
    tokens.forEach((token, i) => {
      if (token.type === 'tbody_open') inBody = true;
      if (token.type === 'tbody_close') inBody = false;
      if (
        inBody &&
        token.type === 'inline' &&
        tokens[i - 1]?.type === 'td_open' &&
        tokens[i - 2]?.type === 'tr_open'
      ) {
        cells.push((token.children ?? []).map(({ type, content }) => ({ type, content })));
      }
    });
    return cells;
  }

  it.each([
    ['a SoQL field name', 'incident_type'],
    ['a computed-region name', ':@computed_region_afba_4m32'],
    ['a pipe', 'a|b'],
  ])('as a code span: %s (characterization)', (_l, name) => {
    expect(fieldCells(render(name))).toEqual([[{ type: 'code_inline', content: name }]]);
  });

  it.each([
    ['doubled underscores', 'a__b'],
    ['an asterisk', 'x*y'],
    ['a leading underscore', '_lead'],
    ['a backtick', 'tick`x'],
    ['only a backtick', '`'],
    ['edge spaces', ' sp '],
    ['only spaces', '   '],
    ['a trailing backslash', 'end\\'],
    ['entity-shaped text', '&#10; &amp;'],
    ['markup', '<b>x</b>'],
  ])('as a code span: %s', (_l, name) => {
    expect(fieldCells(render(name))).toEqual([[{ type: 'code_inline', content: name }]]);
  });

  it.each([
    ['a line feed', 'two\nlines'],
    ['CRLF', 'a\r\nb'],
    ['a lone CR', 'a\rb'],
    ['markup across a break', '*x\n*|y'],
    // GFM parsers differ on whether `\\|` splits a cell, so no code span carries it.
    ['a backslash before a pipe', 'a\\|b'],
  ])('as escaped text when a code span cannot carry it: %s', (_l, name) => {
    expect(fieldCells(render(name))).toEqual([[{ type: 'text', content: name }]]);
  });
});

describe('the Columns table Field cell cost', () => {
  it.each([
    ['a long digit run', (n: number) => '1'.repeat(n)],
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['a CRLF after every two spaces', (n: number) => '  \r\n'.repeat(n / 4)],
    ['a backslash run with no pipe', (n: number) => '\\'.repeat(n)],
    ['a pipe at every character', (n: number) => '|'.repeat(n)],
    ['a backtick run', (n: number) => '`'.repeat(n)],
    ['pipes ending in a backslash and a pipe', (n: number) => `${'|'.repeat(n - 2)}\\|`],
  ])('renders a field name of %s in linear time', (_label, make) => {
    expectLinearCost((size) => {
      const name = make(size);
      return () => render(name);
    });
  });
});

describe('getDataset asset_type from the views response, through the real service (#68)', () => {
  beforeEach(async () => {
    const { SocrataService } = await vi.importActual<
      typeof import('@/services/socrata/socrata-service.js')
    >('@/services/socrata/socrata-service.js');
    (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(new SocrataService());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Answer the views request with live-shaped metadata plus `extra`. */
  function serveViews(id: string, extra: Record<string, unknown>) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(Response.json({ id, name: 'NJ asset', columns: [], ...extra })),
    );
  }

  it.each([
    ['a7mk-8suc', 'map'],
    ['t6tk-mr48', 'dataset'],
  ])('reports %s as %s on both surfaces', async (datasetId, assetType) => {
    serveViews(datasetId, { assetType });

    const result = await runToolContract(getDataset, {
      domain: 'data.nj.gov',
      dataset_id: datasetId,
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { asset_type?: string }).asset_type).toBe(assetType);
    expect(contentText(result)).toContain(
      `**ID:** ${datasetId} | **Domain:** data.nj.gov | **Type:** ${assetType}\n`,
    );
  });

  it('omits asset_type and the Type label when the views response carries none', async () => {
    serveViews('a7mk-8suc', {});

    const result = await runToolContract(getDataset, {
      domain: 'data.nj.gov',
      dataset_id: 'a7mk-8suc',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('asset_type');
    expect(contentText(result)).toContain('**ID:** a7mk-8suc | **Domain:** data.nj.gov\n');
    expect(contentText(result)).not.toContain('**Type:**');
  });

  it('describes asset_type with the shared catalog asset-type text', () => {
    expect(getDataset.output.shape.asset_type.description).toBe(AssetTypeSchema.description);
    expect(AssetTypeSchema.description).toContain(
      'Only dataset and filter answer socrata_query_dataset with rows',
    );
  });
});

describe('getDataset canonical_dataset_id for an alias ID, through the real service (#70)', () => {
  beforeEach(async () => {
    const { SocrataService } = await vi.importActual<
      typeof import('@/services/socrata/socrata-service.js')
    >('@/services/socrata/socrata-service.js');
    (getSocrataService as ReturnType<typeof vi.fn>).mockReturnValue(new SocrataService());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** data.nj.gov `/api/views/5it6-gc2r.json` (live 2026-11-08, trimmed): same host, `t6tk-mr48`'s `id`. */
  function serveViews(id: string) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        Response.json({
          id,
          name: 'Vehicle Inspection Facility Locations',
          assetType: 'dataset',
          columns: [
            { fieldName: 'geocoded_column', dataTypeName: 'point' },
            { fieldName: 'geocoded_column_address', dataTypeName: 'text' },
          ],
        }),
      ),
    );
  }

  it('returns the requested ID with the record’s own beside it, on both surfaces', async () => {
    serveViews('t6tk-mr48');

    const result = await runToolContract(getDataset, {
      domain: 'data.nj.gov',
      dataset_id: '5it6-gc2r',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      dataset_id: '5it6-gc2r',
      canonical_dataset_id: 't6tk-mr48',
      name: 'Vehicle Inspection Facility Locations',
      columns: [
        { field_name: 'geocoded_column', data_type: 'point' },
        { field_name: 'geocoded_column_address', data_type: 'text' },
      ],
    });
    expect(contentText(result)).toContain(
      '**ID:** 5it6-gc2r | **Domain:** data.nj.gov | **Type:** dataset | **Canonical ID:** t6tk-mr48\n',
    );
  });

  it('omits canonical_dataset_id and the Canonical ID label when the record echoes the requested ID', async () => {
    serveViews('5it6-gc2r');

    const result = await runToolContract(getDataset, {
      domain: 'data.nj.gov',
      dataset_id: '5it6-gc2r',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('canonical_dataset_id');
    expect(contentText(result)).toContain(
      '**ID:** 5it6-gc2r | **Domain:** data.nj.gov | **Type:** dataset\n',
    );
    expect(contentText(result)).not.toContain('**Canonical ID:**');
  });

  it('renders a canonical_dataset_id in format() alone', () => {
    const text =
      (
        getDataset.format!({
          dataset_id: '5it6-gc2r',
          canonical_dataset_id: 't6tk-mr48',
          domain: 'data.nj.gov',
          name: 'x',
          tags: [],
          columns: [],
        })[0] as { text?: string }
      ).text ?? '';

    expect(text).toContain(
      '**ID:** 5it6-gc2r | **Domain:** data.nj.gov | **Canonical ID:** t6tk-mr48\n',
    );
  });
});
