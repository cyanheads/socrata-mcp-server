/**
 * @fileoverview Dataset schema and metadata retrieval tool.
 * @module mcp-server/tools/definitions/get-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import type { DatasetMetadata } from '@/services/socrata/types.js';
import { DATASET_ID_PATTERN } from '@/services/socrata/types.js';

export const getDataset = tool('socrata_get_dataset', {
  title: 'Get Dataset Schema',
  description:
    "Fetch full metadata and column schema for a Socrata dataset by ID. Returns field names, data types, descriptions, row count, and licensing. Always call this before writing a socrata_query_dataset — the column types determine correct WHERE clause syntax: Number columns accept bare literals (year=2023) while Text columns require single-quoted strings (year='2023').",
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    domain: z
      .string()
      .optional()
      .describe(
        'Portal domain (e.g. data.seattle.gov). Defaults to SOCRATA_DEFAULT_DOMAIN env var or data.seattle.gov.',
      ),
    dataset_id: z
      .string()
      .describe(
        'Four-by-four dataset ID matching pattern like kzjm-xkqj. Obtain from socrata_find_datasets.',
      ),
  }),
  output: z.object({
    dataset_id: z.string().describe('Four-by-four dataset ID.'),
    domain: z.string().describe('Portal domain hosting this dataset.'),
    name: z.string().describe('Dataset display name.'),
    description: z.string().optional().describe('Dataset description when available.'),
    category: z.string().optional().describe('Domain category when available.'),
    tags: z.array(z.string()).describe('Associated tags.'),
    row_count: z.number().optional().describe('Approximate row count when available.'),
    data_updated_at: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of last data update when available.'),
    license: z.string().optional().describe('License name when available.'),
    columns: z
      .array(
        z
          .object({
            field_name: z.string().describe('Column field name as used in SoQL queries.'),
            data_type: z
              .string()
              .describe(
                'Socrata data type (e.g. Number, Text, Calendar date). Determines WHERE clause quoting: Number → bare literal, Text → single-quoted string.',
              ),
            description: z.string().optional().describe('Column description when available.'),
            non_null_count: z
              .number()
              .optional()
              .describe('Non-null row count for this column when available.'),
          })
          .describe('A single column in the dataset schema.'),
      )
      .describe(
        'Column schema. Computed region columns (:@computed_region_*) are excluded to reduce noise.',
      ),
  }),

  errors: [
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Dataset ID does not match the four-by-four pattern.',
      recovery:
        'Dataset IDs are always 9 characters like kzjm-xkqj. Obtain from socrata_find_datasets.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Valid ID format but dataset does not exist on this domain.',
      recovery:
        'Use socrata_find_datasets to search again — the dataset may have been retired or replaced.',
    },
  ],

  async handler(input, ctx) {
    const domain =
      input.domain && input.domain.trim() ? input.domain.trim() : getServerConfig().defaultDomain;

    if (!DATASET_ID_PATTERN.test(input.dataset_id)) {
      throw ctx.fail(
        'invalid_id',
        `Invalid dataset ID "${input.dataset_id}". Expected pattern like kzjm-xkqj.`,
        { ...ctx.recoveryFor('invalid_id') },
      );
    }

    ctx.log.info('Fetching dataset metadata', { domain, datasetId: input.dataset_id });

    const svc = getSocrataService();
    let meta: DatasetMetadata;
    try {
      meta = await svc.getDataset(domain, input.dataset_id, ctx);
    } catch (err) {
      if (
        err instanceof McpError &&
        err.code === JsonRpcErrorCode.NotFound &&
        (err.data as Record<string, unknown> | undefined)?.reason === 'not_found'
      ) {
        throw ctx.fail('not_found', err.message, { ...ctx.recoveryFor('not_found') });
      }
      throw err;
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

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.name}`);
    lines.push(`**ID:** ${result.dataset_id} | **Domain:** ${result.domain}`);
    if (result.category) lines.push(`**Category:** ${result.category}`);
    if (result.tags.length) lines.push(`**Tags:** ${result.tags.join(', ')}`);
    if (result.row_count != null) lines.push(`**Rows:** ${result.row_count.toLocaleString()}`);
    if (result.data_updated_at) lines.push(`**Last updated:** ${result.data_updated_at}`);
    if (result.license) lines.push(`**License:** ${result.license}`);
    if (result.description) {
      lines.push('');
      lines.push(result.description);
    }
    lines.push('');
    lines.push(`### Columns (${result.columns.length})`);
    lines.push('');
    lines.push('| Field | Type | Description |');
    lines.push('|:------|:-----|:------------|');
    for (const col of result.columns) {
      const desc = col.description ?? '';
      const nullInfo = col.non_null_count != null ? ` (${col.non_null_count} non-null)` : '';
      lines.push(`| \`${col.field_name}\` | ${col.data_type}${nullInfo} | ${desc} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
