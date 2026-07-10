/**
 * @fileoverview Dataset schema and metadata retrieval tool.
 * @module mcp-server/tools/definitions/get-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import {
  escapeTableCell,
  inlineUpstream,
  UPSTREAM_CELL_MAX_CHARS,
  upstreamBlockquote,
} from '@/mcp-server/tools/upstream-text.js';
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
    row_count: z
      .number()
      .optional()
      .describe('Approximate row count when available. See row_count_source for provenance.'),
    row_count_source: z
      .enum(['top_level_cached_contents', 'column_cached_contents'])
      .optional()
      .describe(
        "How row_count was obtained: 'top_level_cached_contents' — reported directly by the portal's views metadata; 'column_cached_contents' — derived as the maximum per-column cached count when the top-level value is absent. Absent when row_count is absent.",
      ),
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
      code: JsonRpcErrorCode.ValidationError,
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
    const domain = input.domain?.trim() ? input.domain.trim() : getServerConfig().defaultDomain;

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
      // Re-throw service failures that map to declared contract reasons via
      // ctx.fail so the contract recovery hint reaches the wire.
      if (err instanceof McpError) {
        const reason = (err.data as Record<string, unknown> | undefined)?.reason;
        if (reason === 'not_found') {
          throw ctx.fail(reason, err.message, {
            ...(err.data as Record<string, unknown>),
            ...ctx.recoveryFor(reason),
          });
        }
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

  format: (result) => {
    const lines: string[] = [];
    // Dataset name, description, and column descriptions are upstream-controlled —
    // render the name quoted on a single line, the description as a labeled
    // blockquote, and table cells escaped for pipes and newlines.
    lines.push(`## "${inlineUpstream(result.name)}"`);
    lines.push(`**ID:** ${result.dataset_id} | **Domain:** ${result.domain}`);
    if (result.category) lines.push(`**Category:** ${result.category}`);
    if (result.tags.length) lines.push(`**Tags:** ${result.tags.join(', ')}`);
    if (result.row_count != null) {
      const source = result.row_count_source ? ` (source: ${result.row_count_source})` : '';
      lines.push(`**Rows (approx.):** ${result.row_count.toLocaleString()}${source}`);
    }
    if (result.data_updated_at) lines.push(`**Last updated:** ${result.data_updated_at}`);
    if (result.license) lines.push(`**License:** ${result.license}`);
    if (result.description) {
      lines.push('');
      lines.push(...upstreamBlockquote('Upstream dataset description', result.description));
    }
    lines.push('');
    lines.push(`### Columns (${result.columns.length})`);
    lines.push('');
    lines.push('| Field | Type | Description (upstream) |');
    lines.push('|:------|:-----|:-----------------------|');
    for (const col of result.columns) {
      const desc = col.description ? escapeTableCell(col.description, UPSTREAM_CELL_MAX_CHARS) : '';
      const nullInfo = col.non_null_count != null ? ` (${col.non_null_count} non-null)` : '';
      lines.push(
        `| \`${escapeTableCell(col.field_name)}\` | ${escapeTableCell(col.data_type)}${nullInfo} | ${desc} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
