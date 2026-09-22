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
        'Portal the dataset lives on, as a bare hostname (e.g. data.cityofnewyork.us); URL forms like https://data.cityofnewyork.us/ are accepted and reduced to the host. Pass the domain from the same socrata_find_datasets result as dataset_id. Defaults to SOCRATA_DEFAULT_DOMAIN or data.seattle.gov, which is wrong for another portal’s ID.',
      ),
    dataset_id: z
      .string()
      .describe(
        'Four-by-four dataset ID matching pattern like kzjm-xkqj. IDs are portal-scoped: take it from socrata_find_datasets together with that result’s domain.',
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
      when: 'Valid ID format but the dataset does not exist on the domain queried — including a gateway HTTP 403 for an ID the portal does not serve.',
      recovery:
        'The ID may belong to a different portal — retry with the domain from the same socrata_find_datasets result, or search again with socrata_find_datasets; the dataset may also have been retired.',
    },
    {
      reason: 'unknown_domain',
      code: JsonRpcErrorCode.NotFound,
      when: 'The domain does not serve the Socrata API to this server: its hostname does not resolve (DNS ENOTFOUND), its API answered HTTP 404 without a Socrata error body, it redirected the request to another host that did not answer with Socrata data, or a gateway refused a dataset the Discovery catalog lists there.',
      recovery:
        'The domain is not serving the Socrata API. Check the hostname for typos and pass a bare portal hostname such as data.cityofnewyork.us, or pick one from socrata_list_portals.',
    },
    {
      reason: 'invalid_domain',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The domain is not a hostname, even after dropping a URL scheme, path, or query.',
      recovery:
        'Pass a bare portal hostname such as data.cityofnewyork.us, or pick one from socrata_list_portals.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'SODA endpoint returned 429.',
      retryable: true,
      recovery: 'Retry after a short delay. Set SOCRATA_APP_TOKEN for higher per-IP rate limits.',
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
      // ctx.fail so a recovery hint reaches the wire. A not_found whose ID the
      // Discovery catalog places on another portal names that portal instead
      // of the static hint.
      if (err instanceof McpError) {
        const data = (err.data ?? {}) as Record<string, unknown>;
        const { reason, found_on_domain: foundOn } = data;
        if (
          reason === 'not_found' ||
          reason === 'unknown_domain' ||
          reason === 'invalid_domain' ||
          reason === 'rate_limited'
        ) {
          const hint =
            reason === 'not_found' && typeof foundOn === 'string'
              ? `${input.dataset_id} is on ${foundOn} — retry with domain "${foundOn}".`
              : undefined;
          throw ctx.fail(
            reason,
            err.message,
            { ...data, ...(hint ? { recovery: { hint } } : ctx.recoveryFor(reason)) },
            { cause: err },
          );
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
      const desc = col.description ? escapeTableCell(col.description) : '';
      const nullInfo = col.non_null_count != null ? ` (${col.non_null_count} non-null)` : '';
      lines.push(
        `| \`${escapeTableCell(col.field_name)}\` | ${escapeTableCell(col.data_type)}${nullInfo} | ${desc} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
