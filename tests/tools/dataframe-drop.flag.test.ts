/**
 * @fileoverview Tests for the SOCRATA_DATAFRAME_DROP_ENABLED gate on
 * socrata_dataframe_drop: listed as disabled with the enable hint while the flag
 * is off, a plain (callable) definition when it is on.
 * @module tests/tools/dataframe-drop.flag.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The marker `disabledTool()` attaches — the framework's registry skips a
 * definition carrying it, and the landing page lists it as disabled.
 */
const DISABLED_KEY = '__mcpDisabled';

/**
 * Import a fresh copy of the tool module under the given flag value. `''` rather
 * than a deleted key for "unset": importing the framework config re-reads
 * `.env`, which refills a deleted key but never overrides a set one.
 */
async function loadDropTool(flag: string) {
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
