/**
 * @fileoverview Dataset metadata resource — addressable by stable URI for clients that support resources.
 * Same payload as socrata_get_dataset tool.
 * @module mcp-server/resources/definitions/dataset.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import { DATASET_ID_PATTERN } from '@/services/socrata/types.js';

export const datasetResource = resource('socrata://datasets/{domain}/{datasetId}', {
  name: 'socrata-dataset',
  title: 'Socrata Dataset Metadata',
  description:
    'Fetch full metadata and column schema for a Socrata dataset addressable by stable URI. Same payload as socrata_get_dataset. Name, description, and column descriptions are upstream-provided portal metadata, not server-authored text. URI format: socrata://datasets/{domain}/{datasetId} (e.g. socrata://datasets/data.seattle.gov/kzjm-xkqj).',
  mimeType: 'application/json',
  params: z.object({
    domain: z
      .string()
      .describe(
        'Portal the dataset lives on, as a bare hostname (e.g. data.seattle.gov); case is normalized.',
      ),
    datasetId: z
      .string()
      .describe(
        'Four-by-four dataset ID (e.g. kzjm-xkqj). IDs are portal-scoped: take it from socrata_find_datasets together with that result’s domain.',
      ),
  }),
  output: z.object({
    dataset_id: z.string().describe('Four-by-four Socrata dataset ID.'),
    domain: z.string().describe('Portal domain hosting the dataset.'),
    name: z.string().describe('Dataset display name.'),
    description: z.string().optional().describe('Dataset description when available.'),
    category: z.string().optional().describe('Dataset category when available.'),
    tags: z.array(z.string()).describe('Dataset tags.'),
    row_count: z.number().optional().describe('Approximate row count when available.'),
    row_count_source: z
      .enum(['top_level_cached_contents', 'column_cached_contents'])
      .optional()
      .describe('Provenance for the approximate row count when available.'),
    data_updated_at: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of the latest data update when available.'),
    license: z.string().optional().describe('Dataset license when available.'),
    columns: z
      .array(
        z
          .object({
            field_name: z.string().describe('Column field name used in SoQL queries.'),
            data_type: z.string().describe('Socrata data type.'),
            description: z.string().optional().describe('Column description when available.'),
            non_null_count: z
              .number()
              .optional()
              .describe('Non-null row count for this column when available.'),
          })
          .describe('A dataset column.'),
      )
      .describe('Typed dataset columns.'),
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
    // getDataset rejects a views answer that is not this dataset, so the
    // resource and socrata_get_dataset classify the same responses alike.
    const meta = await svc.getDataset(params.domain, params.datasetId, ctx);

    return {
      dataset_id: meta.datasetId,
      domain: meta.domain,
      name: meta.name,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.category ? { category: meta.category } : {}),
      tags: meta.tags,
      ...(meta.rowCount != null ? { row_count: meta.rowCount } : {}),
      ...(meta.rowCountSource ? { row_count_source: meta.rowCountSource } : {}),
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
