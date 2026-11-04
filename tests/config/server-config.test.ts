/**
 * @fileoverview Tests for the server-specific environment config — env var
 * mapping, defaults, the config input schemas read before setup() parses it,
 * and the `.env` pre-load for reads made before createApp().
 * @module tests/config/server-config.test
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SERVER_ENV_VARS = [
  'SOCRATA_APP_TOKEN',
  'SOCRATA_DEFAULT_DOMAIN',
  'SOCRATA_DATAFRAME_DROP_ENABLED',
  'SOCRATA_CLAMP_LIMITS',
] as const;

type ServerEnv = Partial<Record<(typeof SERVER_ENV_VARS)[number], string>>;

/**
 * A fresh copy of the config module under the given env. Unlisted variables
 * are stubbed to `''` rather than deleted: a `.env` load refills a deleted key
 * but never overrides one that is set. `parseEnvConfig` reads `''` as unset.
 */
async function freshConfigModule(env: ServerEnv) {
  for (const name of SERVER_ENV_VARS) vi.stubEnv(name, env[name] ?? '');
  vi.resetModules();
  return await import('@/config/server-config.js');
}

async function loadConfig(env: ServerEnv) {
  return (await freshConfigModule(env)).getServerConfig();
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

  it('parses only the server variables, leaving an invalid framework variable to createApp()', async () => {
    vi.stubEnv('MCP_LOG_LEVEL', 'nonsense');
    const config = await loadConfig({ SOCRATA_DEFAULT_DOMAIN: 'data.cityofchicago.org' });
    expect(config.defaultDomain).toBe('data.cityofchicago.org');
  });
});

describe('activeServerConfig', () => {
  it('reads the schema defaults before setup() parses, without reading the environment', async () => {
    const { activeServerConfig } = await freshConfigModule({
      SOCRATA_CLAMP_LIMITS: 'false',
      SOCRATA_DATAFRAME_DROP_ENABLED: 'maybe',
      SOCRATA_DEFAULT_DOMAIN: 'data.cityofchicago.org',
    });

    expect(activeServerConfig()).toEqual({
      defaultDomain: 'data.seattle.gov',
      dataframeDropEnabled: false,
      clampLimits: true,
    });
  });

  it('reads what getServerConfig() parsed once setup() has run', async () => {
    const { activeServerConfig, getServerConfig } = await freshConfigModule({
      SOCRATA_CLAMP_LIMITS: 'false',
      SOCRATA_DEFAULT_DOMAIN: 'data.cityofchicago.org',
    });

    const parsed = getServerConfig();

    expect(activeServerConfig()).toBe(parsed);
    expect(activeServerConfig()).toMatchObject({
      clampLimits: false,
      defaultDomain: 'data.cityofchicago.org',
    });
  });
});

describe('preloadEnvFile and a setting supplied only through .env (#61)', () => {
  const startDir = process.cwd();
  let envDir: string | undefined;

  /** An empty working directory, `.env` written as `contents` when given. */
  async function enterDir(contents?: string) {
    envDir = await mkdtemp(join(tmpdir(), 'socrata-env-'));
    if (contents !== undefined) await writeFile(join(envDir, '.env'), contents);
    process.chdir(envDir);
    return envDir;
  }

  afterEach(async () => {
    process.chdir(startDir);
    if (envDir) await rm(envDir, { recursive: true, force: true });
    envDir = undefined;
  });

  it('loads a value set only in the working directory .env', async () => {
    const { preloadEnvFile } = await freshConfigModule({});
    vi.stubEnv('SOCRATA_DEFAULT_DOMAIN', undefined);
    await enterDir('SOCRATA_DEFAULT_DOMAIN=data.cityofchicago.org\n');

    preloadEnvFile();

    expect(process.env.SOCRATA_DEFAULT_DOMAIN).toBe('data.cityofchicago.org');
  });

  it('never overrides a value already set in the environment', async () => {
    const { preloadEnvFile } = await freshConfigModule({
      SOCRATA_DEFAULT_DOMAIN: 'data.cityofnewyork.us',
    });
    await enterDir('SOCRATA_DEFAULT_DOMAIN=data.cityofchicago.org\n');

    preloadEnvFile();

    expect(process.env.SOCRATA_DEFAULT_DOMAIN).toBe('data.cityofnewyork.us');
  });

  it('leaves a missing .env to createApp() without throwing', async () => {
    const { preloadEnvFile } = await freshConfigModule({});
    await enterDir();

    expect(() => preloadEnvFile()).not.toThrow();
  });

  it('leaves an unreadable .env (a directory) to createApp() without throwing', async () => {
    const { preloadEnvFile } = await freshConfigModule({});
    const dir = await enterDir();
    await mkdir(join(dir, '.env'));

    expect(() => preloadEnvFile()).not.toThrow();
  });
});
