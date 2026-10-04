/**
 * @fileoverview Tests for the server-specific environment config — env var
 * mapping and defaults.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const SERVER_ENV_VARS = [
  'SOCRATA_APP_TOKEN',
  'SOCRATA_DEFAULT_DOMAIN',
  'SOCRATA_DATAFRAME_DROP_ENABLED',
] as const;

/**
 * Load a fresh copy of the lazily cached config module under the given env.
 * Unlisted variables are stubbed to `''` rather than deleted: importing the
 * framework config re-reads `.env`, which would refill a deleted key but never
 * overrides one that is set. `parseEnvConfig` reads `''` as unset.
 */
async function loadConfig(env: Partial<Record<(typeof SERVER_ENV_VARS)[number], string>>) {
  for (const name of SERVER_ENV_VARS) vi.stubEnv(name, env[name] ?? '');
  vi.resetModules();
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('getServerConfig', () => {
  it('applies defaults when the server env vars are unset', async () => {
    const config = await loadConfig({});
    expect(config.appToken).toBeUndefined();
    expect(config.defaultDomain).toBe('data.seattle.gov');
    expect(config.dataframeDropEnabled).toBe(false);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('parses SOCRATA_DATAFRAME_DROP_ENABLED=%s as %s', async (raw, expected) => {
    const config = await loadConfig({ SOCRATA_DATAFRAME_DROP_ENABLED: raw });
    expect(config.dataframeDropEnabled).toBe(expected);
  });

  it('rejects an unrecognized SOCRATA_DATAFRAME_DROP_ENABLED value, naming the variable', async () => {
    await expect(loadConfig({ SOCRATA_DATAFRAME_DROP_ENABLED: 'maybe' })).rejects.toThrow(
      /SOCRATA_DATAFRAME_DROP_ENABLED/,
    );
  });

  it('maps SOCRATA_APP_TOKEN and SOCRATA_DEFAULT_DOMAIN onto the config', async () => {
    const config = await loadConfig({
      SOCRATA_APP_TOKEN: 'tok-123',
      SOCRATA_DEFAULT_DOMAIN: 'data.cityofnewyork.us',
    });
    expect(config.appToken).toBe('tok-123');
    expect(config.defaultDomain).toBe('data.cityofnewyork.us');
  });
});
