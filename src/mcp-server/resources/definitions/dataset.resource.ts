/**
 * @fileoverview Dataset metadata resource — addressable by stable URI for clients that support resources.
 * Same payload as socrata_get_dataset tool.
 * @module mcp-server/resources/definitions/dataset.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import { DATASET_ID_PATTERN } from '@/services/socrata/types.js';

export const datasetResource = resource('socrata://datasets/{domain}/{datasetId}', {
  name: 'socrata-dataset',
  title: 'Socrata Dataset Metadata',
  description:
    'Fetch full metadata and column schema for a Socrata dataset addressable by stable URI. Same payload as socrata_get_dataset. URI format: socrata://datasets/{domain}/{datasetId} (e.g. socrata://datasets/data.seattle.gov/kzjm-xkqj).',
  mimeType: 'application/json',
  params: z.object({
    domain: z.string().describe('Portal domain (e.g. data.seattle.gov).'),
    datasetId: z
      .string()
      .describe('Four-by-four dataset ID (e.g. kzjm-xkqj). Obtain from socrata_find_datasets.'),
  }),

  async handler(params, ctx) {
    if (!DATASET_ID_PATTERN.test(params.datasetId)) {
      throw validationError(
        `Invalid dataset ID format: "${params.datasetId}". Expected pattern like kzjm-xkqj.`,
        { datasetId: params.datasetId },
      );
    }

    ctx.log.debug('Fetching dataset resource', {
      domain: params.domain,
      datasetId: params.datasetId,
    });

    const svc = getSocrataService();
    const meta = await svc.getDataset(params.domain, params.datasetId, ctx);

    if (!meta.name) {
      throw notFound(`Dataset ${params.datasetId} not found on ${params.domain}.`, {
        domain: params.domain,
        datasetId: params.datasetId,
      });
    }

    return {
      dataset_id: meta.datasetId,
      domain: meta.domain,
      name: meta.name,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.category ? { category: meta.category } : {}),
      tags: meta.tags,
      ...(meta.rowCount != null ? { row_count: meta.rowCount } : {}),
      ...(meta.dataUpdatedAt ? { data_updated_at: meta.dataUpdatedAt } : {}),
      ...(meta.license ? { license: meta.license } : {}),
      columns: meta.columns.map((c) => ({
        field_name: c.fieldName,
        data_type: c.dataType,
        ...(c.description ? { description: c.description } : {}),
        ...(c.nonNullCount != null ? { non_null_count: c.nonNullCount } : {}),
      })),
    };
  },

  list: () => ({
    resources: [
      {
        uri: 'socrata://datasets/data.seattle.gov/kzjm-xkqj',
        name: 'Seattle 911 Incidents (example)',
        mimeType: 'application/json',
      },
    ],
  }),
});
