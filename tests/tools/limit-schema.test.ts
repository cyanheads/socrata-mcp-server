/**
 * @fileoverview The `limit` input of the three tools with a per-call cap
 * (socrata_find_datasets, socrata_query_dataset, socrata_dataframe_query): the
 * maximum and description it advertises and the cap it enforces follow the
 * SOCRATA_CLAMP_LIMITS value setup() parses, not one read at import (#62).
 * @module tests/tools/limit-schema.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SERVER_ENV_VARS = [
  'SOCRATA_APP_TOKEN',
  'SOCRATA_DEFAULT_DOMAIN',
  'SOCRATA_DATAFRAME_DROP_ENABLED',
  'SOCRATA_CLAMP_LIMITS',
] as const;

const QUERY_SPILL =
  'When the server has a canvas and more rows match past a full page, up to 50,000 matching rows are staged on it whatever the limit — pass a small limit (e.g. 10) to stage a large match without a large inline page, or stage false to return the page without staging.';

type AnyTool = { input: z.ZodObject; name: string };

/**
 * Each tool's `limit` JSON Schema as `tools/list` emitted it at 0.6.0 — with
 * clamping on (the default) and with SOCRATA_CLAMP_LIMITS=false. The
 * socrata_query_dataset spill sentence has since gained the stage opt-out (#69).
 */
const LIMITS = [
  {
    tool: 'socrata_find_datasets',
    load: async (): Promise<AnyTool> =>
      (await import('@/mcp-server/tools/definitions/find-datasets.tool.js')).findDatasets,
    base: {},
    clamped: {
      type: 'integer',
      minimum: 1,
      maximum: 10_000,
      default: 10,
      description:
        'Number of results to return (1–10,000). One call returns at most 100 results: a larger limit is served as 100, with a notice naming the offset that continues. Default 10.',
    },
    strict: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 10,
      description: 'Number of results to return (1–100). Default 10.',
    },
  },
  {
    tool: 'socrata_query_dataset',
    load: async (): Promise<AnyTool> =>
      (await import('@/mcp-server/tools/definitions/query-dataset.tool.js')).queryDataset,
    base: { dataset_id: 'kzjm-xkqj' },
    clamped: {
      type: 'integer',
      minimum: 1,
      maximum: 50_000,
      default: 100,
      description: `Max rows to return (1–50,000). One call returns at most 5,000 rows: a larger limit is served as 5,000, with a notice naming the offset that continues when more rows match. Default 100. Use with offset for pagination. ${QUERY_SPILL}`,
    },
    strict: {
      type: 'integer',
      minimum: 1,
      maximum: 5000,
      default: 100,
      description: `Max rows to return (1–5000). Default 100. Use with offset for pagination. ${QUERY_SPILL}`,
    },
  },
  {
    tool: 'socrata_dataframe_query',
    load: async (): Promise<AnyTool> =>
      (await import('@/mcp-server/tools/definitions/dataframe-query.tool.js')).dataframeQuery,
    base: { canvas_id: 'abc1234567', sql: 'SELECT 1' },
    clamped: {
      type: 'integer',
      minimum: 1,
      maximum: 50_000,
      default: 1000,
      description:
        'Max rows to return (1–50,000). One call returns at most 10,000 rows: a larger limit is served as 10,000, with a notice naming how to page through the rest when more rows match. Default 1000.',
    },
    strict: {
      type: 'integer',
      minimum: 1,
      maximum: 10_000,
      default: 1000,
      description: 'Max rows to return (1–10000). Default 1000.',
    },
  },
];

/** The `limit` JSON Schema, converted the way `tools/list` converts an input schema. */
function limitSchema(def: AnyTool) {
  const { properties } = z.toJSONSchema(def.input, { io: 'input', target: 'draft-2020-12' });
  return properties?.limit;
}

/**
 * Every server variable unset (`''`, which the config reads as unset and a
 * `.env` load never overwrites), then SOCRATA_CLAMP_LIMITS = `flag`.
 */
function stubServerEnv(flag: string) {
  for (const name of SERVER_ENV_VARS) vi.stubEnv(name, '');
  vi.stubEnv('SOCRATA_CLAMP_LIMITS', flag);
  vi.resetModules();
}

/** setup()'s first step: parse the server config. */
async function runSetup() {
  (await import('@/config/server-config.js')).getServerConfig();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('limit schema with SOCRATA_CLAMP_LIMITS parsed in setup()', () => {
  it.each(LIMITS)(
    '$tool advertises the 0.6.0 limit schema with no server variable set',
    async ({ load, clamped }) => {
      stubServerEnv('');
      const def = await load();
      await runSetup();

      expect(limitSchema(def)).toStrictEqual(clamped);
    },
  );

  it.each(LIMITS)(
    '$tool advertises the 0.6.0 limit schema with SOCRATA_CLAMP_LIMITS=false',
    async ({ load, strict }) => {
      stubServerEnv('false');
      const def = await load();
      await runSetup();

      expect(limitSchema(def)).toStrictEqual(strict);
    },
  );

  it.each(LIMITS)(
    '$tool reads no switch at import, then advertises and enforces the one setup() parses',
    async ({ load, base, clamped, strict }) => {
      stubServerEnv('false');
      const def = await load();

      // Before setup(): the schema defaults (clamping on), whatever the environment says.
      expect(limitSchema(def)).toStrictEqual(clamped);
      expect(def.input.parse({ ...base, limit: clamped.maximum }).limit).toBe(clamped.maximum);

      await runSetup();

      expect(limitSchema(def)).toStrictEqual(strict);
      expect(def.input.parse({ ...base, limit: strict.maximum }).limit).toBe(strict.maximum);
      const over = def.input.safeParse({ ...base, limit: strict.maximum + 1 });
      expect(over.success).toBe(false);
      expect(over.error?.issues).toEqual([
        expect.objectContaining({
          code: 'too_big',
          maximum: strict.maximum,
          path: ['limit'],
          message: `Too big: expected number to be <=${strict.maximum}`,
        }),
      ]);
    },
  );

  it.each(LIMITS)(
    '$tool rejects a limit past the ceiling and below 1 with clamping on',
    async ({ load, base, clamped }) => {
      stubServerEnv('true');
      const def = await load();
      await runSetup();

      expect(def.input.safeParse({ ...base, limit: clamped.maximum + 1 }).error?.issues).toEqual([
        expect.objectContaining({ code: 'too_big', maximum: clamped.maximum, path: ['limit'] }),
      ]);
      expect(def.input.safeParse({ ...base, limit: 0 }).success).toBe(false);
      expect(def.input.safeParse({ ...base, limit: 1.5 }).success).toBe(false);
      expect(def.input.parse(base).limit).toBe(clamped.default);
    },
  );
});
