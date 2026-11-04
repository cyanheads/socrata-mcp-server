/**
 * @fileoverview Tests for the SOCRATA_DATAFRAME_DROP_ENABLED gate on
 * socrata_dataframe_drop: listed as disabled with the enable hint while the flag
 * is off or invalid, a plain (callable) definition when it is on — read at
 * import from the environment or, before createApp() loads it, the working
 * directory's `.env`.
 * @module tests/tools/dataframe-drop.flag.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The marker `disabledTool()` attaches — the framework's registry skips a
 * definition carrying it, and the landing page lists it as disabled.
 */
const DISABLED_KEY = '__mcpDisabled';

/**
 * Import a fresh copy of the tool module under the given flag value. `''` rather
 * than a deleted key for "unset": the import loads `.env`, which refills a
 * deleted key but never overrides a set one.
 */
async function loadDropTool(flag: string | undefined) {
  vi.stubEnv('SOCRATA_DATAFRAME_DROP_ENABLED', flag);
  vi.resetModules();
  const { dataframeDrop } = await import('@/mcp-server/tools/definitions/dataframe-drop.tool.js');
  return dataframeDrop as typeof dataframeDrop & Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('socrata_dataframe_drop opt-in flag', () => {
  it.each([
    ['unset', ''],
    ['false', 'false'],
    ['invalid (setup() then stops startup naming it)', 'maybe'],
  ])('is listed as disabled with the enable hint when the flag is %s', async (_label, flag) => {
    const dataframeDrop = await loadDropTool(flag);

    expect(dataframeDrop.name).toBe('socrata_dataframe_drop');
    expect(dataframeDrop[DISABLED_KEY]).toEqual({
      reason: 'Dropping DataCanvas data is turned off in this deployment.',
      hint: 'SOCRATA_DATAFRAME_DROP_ENABLED=true',
    });
    // The wrapper keeps the full definition, so re-enabling needs no other change.
    expect(typeof dataframeDrop.handler).toBe('function');
    expect(dataframeDrop.annotations).toMatchObject({ destructiveHint: true });
  });

  it('is a plain, registrable definition when the flag is true', async () => {
    const dataframeDrop = await loadDropTool('true');

    expect(dataframeDrop.name).toBe('socrata_dataframe_drop');
    expect(dataframeDrop[DISABLED_KEY]).toBeUndefined();
  });
});

describe('socrata_dataframe_drop flag set only in .env (#61)', () => {
  const startDir = process.cwd();
  let envDir: string | undefined;

  afterEach(async () => {
    process.chdir(startDir);
    if (envDir) await rm(envDir, { recursive: true, force: true });
    envDir = undefined;
  });

  it('reads the flag from the working directory .env when the environment lacks it', async () => {
    envDir = await mkdtemp(join(tmpdir(), 'socrata-drop-env-'));
    await writeFile(join(envDir, '.env'), 'SOCRATA_DATAFRAME_DROP_ENABLED=true\n');
    process.chdir(envDir);

    const dataframeDrop = await loadDropTool(undefined);

    expect(process.env.SOCRATA_DATAFRAME_DROP_ENABLED).toBe('true');
    expect(dataframeDrop[DISABLED_KEY]).toBeUndefined();
  });

  it('keeps a value set in the environment over the .env one', async () => {
    envDir = await mkdtemp(join(tmpdir(), 'socrata-drop-env-'));
    await writeFile(join(envDir, '.env'), 'SOCRATA_DATAFRAME_DROP_ENABLED=true\n');
    process.chdir(envDir);

    const dataframeDrop = await loadDropTool('false');

    expect(dataframeDrop[DISABLED_KEY]).toBeDefined();
  });
});
