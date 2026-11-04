/**
 * @fileoverview The four-by-four dataset ID input on socrata_get_dataset,
 * socrata_query_dataset, and the socrata://datasets/{domain}/{datasetId}
 * resource: the advertised `pattern` accepts exactly what the schema accepts,
 * an accepted ID reaches the handler lowercased, and a malformed one fails
 * argument validation before any upstream request (#67).
 * @module tests/tools/dataset-id-input.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { datasetResource } from '@/mcp-server/resources/definitions/dataset.resource.js';
import { getDataset } from '@/mcp-server/tools/definitions/get-dataset.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { contentText } from './content-text.js';

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: vi.fn(),
}));

import { getSocrataService } from '@/services/socrata/socrata-service.js';

const mockGetDataset = vi.fn();
const mockQueryDataset = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSocrataService).mockReturnValue({
    getDataset: mockGetDataset,
    queryDataset: mockQueryDataset,
  } as unknown as ReturnType<typeof getSocrataService>);
});

const ACCEPTED = ['kzjm-xkqj', 'KZJM-XKQJ', 'Kzjm-xkqj', 'ab12-CD34'];
const REJECTED = [
  ' kzjm-xkqj',
  'kzjm-xkqj ',
  'kzjm_xkqj',
  'kzjmxkqj',
  'kzjm-xkqj1',
  '',
  '../etc/passwd',
];

/** Each surface's dataset ID field: its parent object schema and its key there. */
const FIELDS: [label: string, parent: z.ZodObject, key: string][] = [
  ['socrata_get_dataset dataset_id', getDataset.input, 'dataset_id'],
  ['socrata_query_dataset dataset_id', queryDataset.input, 'dataset_id'],
  ['socrata-dataset resource datasetId', datasetResource.params as z.ZodObject, 'datasetId'],
];

describe.each(FIELDS)('%s', (_label, parent, key) => {
  const field = parent.shape[key] as z.ZodType;
  const emitted = z.toJSONSchema(parent, { io: 'input', target: 'draft-2020-12' }).properties?.[
    key
  ] as { type?: string; pattern?: string };

  it('advertises the four-by-four pattern with both letter cases and no flag to lose', () => {
    expect(emitted).toMatchObject({ type: 'string', pattern: '^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$' });
  });

  it.each([...ACCEPTED, ...REJECTED])(
    'agrees with the emitted pattern, compiled without flags, on %j',
    (value) => {
      const pattern = new RegExp(emitted.pattern as string);
      expect(field.safeParse(value).success).toBe(pattern.test(value));
      expect(pattern.test(value)).toBe(ACCEPTED.includes(value));
    },
  );

  it.each(ACCEPTED)('hands the handler %j lowercased', (value) => {
    expect(field.parse(value)).toBe(value.toLowerCase());
  });
});

describe('a dataset ID on a tool call', () => {
  it('socrata_get_dataset sends an uppercase ID upstream lowercased', async () => {
    mockGetDataset.mockRejectedValue(new Error('stop after the request is built'));

    await runToolContract(getDataset, { dataset_id: 'KZJM-XKQJ' });

    expect(mockGetDataset).toHaveBeenCalledTimes(1);
    expect(mockGetDataset).toHaveBeenCalledWith(expect.any(String), 'kzjm-xkqj', expect.anything());
  });

  it('socrata_query_dataset sends an uppercase ID upstream lowercased', async () => {
    mockQueryDataset.mockRejectedValue(new Error('stop after the request is built'));

    await runToolContract(queryDataset, { dataset_id: 'KZJM-XKQJ' });

    expect(mockQueryDataset).toHaveBeenCalledTimes(1);
    expect(mockQueryDataset).toHaveBeenCalledWith(
      expect.objectContaining({ datasetId: 'kzjm-xkqj' }),
      expect.anything(),
    );
  });

  it.each([
    ['socrata_get_dataset', () => runToolContract(getDataset, { dataset_id: 'kzjm_xkqj' })],
    ['socrata_query_dataset', () => runToolContract(queryDataset, { dataset_id: 'kzjm_xkqj' })],
  ])(
    '%s rejects a malformed ID as invalid arguments naming the form and socrata_find_datasets, before any upstream request',
    async (_tool, call) => {
      const result = await call();

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { code: number; message: string; data: { reason?: string } };
      };
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data.reason).toBe('invalid_arguments');
      expect(error.message).toContain('four-by-four');
      expect(error.message).toContain('socrata_find_datasets');
      expect(contentText(result)).toMatch(/four-by-four.*socrata\\?_find\\?_datasets/);
      expect(mockGetDataset).not.toHaveBeenCalled();
      expect(mockQueryDataset).not.toHaveBeenCalled();
    },
  );

  it.each([getDataset, queryDataset])('$name declares no invalid_id reason', (def) => {
    expect(def.errors?.map((e) => e.reason)).not.toContain('invalid_id');
  });
});
