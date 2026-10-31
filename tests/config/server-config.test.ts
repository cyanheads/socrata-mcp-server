/**
 * @fileoverview Tests for the server-specific environment config — env var
 * mapping, defaults, and a value supplied only through `.env`.
 * @module tests/config/server-config.test
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SERVER_ENV_VARS = [
  'SOCRATA_APP_TOKEN',
  'SOCRATA_DEFAULT_DOMAIN',
  'SOCRATA_DATAFRAME_DROP_ENABLED',
  'SOCRATA_CLAMP_LIMITS',
] as const;

/**
 * Load a fresh copy of the lazily cached config module under the given env.
 * Unlisted variables are stubbed to `''` rather than deleted: getServerConfig()
 * loads `.env` first, which would refill a deleted key but never overrides one
 * that is set. `parseEnvConfig` reads `''` as unset.
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
    expect(config.clampLimits).toBe(true);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['off', false],
  ])('parses SOCRATA_CLAMP_LIMITS=%s as %s', async (raw, expected) => {
    const config = await loadConfig({ SOCRATA_CLAMP_LIMITS: raw });
    expect(config.clampLimits).toBe(expected);
  });

  it('rejects an unrecognized SOCRATA_CLAMP_LIMITS value, naming the variable', async () => {
    await expect(loadConfig({ SOCRATA_CLAMP_LIMITS: 'sometimes' })).rejects.toThrow(
      /SOCRATA_CLAMP_LIMITS/,
    );
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

describe('getServerConfig and a setting supplied only through .env (#61)', () => {
  const startDir = process.cwd();
  let envDir: string | undefined;

  afterEach(async () => {
    vi.doUnmock('@cyanheads/mcp-ts-core/config');
    process.chdir(startDir);
    if (envDir) await rm(envDir, { recursive: true, force: true });
    envDir = undefined;
  });

  it('reads the value from the working directory .env when process.env lacks it', async () => {
    envDir = await mkdtemp(join(tmpdir(), 'socrata-env-'));
    await writeFile(join(envDir, '.env'), 'SOCRATA_DEFAULT_DOMAIN=data.cityofchicago.org\n');
    vi.stubEnv('SOCRATA_DEFAULT_DOMAIN', undefined);
    process.chdir(envDir);
    /**
     * The framework loads `.env` once per instance of its config module, and
     * that module is an external dependency, which vi.resetModules() does not
     * re-evaluate: an earlier case's parse has already spent the load. A fresh
     * instance, imported under its own URL, starts unloaded, as a server
     * process does at its first getServerConfig() call.
     */
    const frameworkConfigUrl = import.meta.resolve('@cyanheads/mcp-ts-core/config');
    vi.doMock(
      '@cyanheads/mcp-ts-core/config',
      () => import(`${frameworkConfigUrl}?instance=${randomUUID()}`),
    );
    vi.resetModules();
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig().defaultDomain).toBe('data.cityofchicago.org');
  });
});
