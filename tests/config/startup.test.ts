/**
 * @fileoverview Startup under an invalid environment value: nothing reads the
 * config when a definition module is imported, and the server process exits
 * through createApp()'s configuration banner, naming the variable, rather than
 * on a raw stack trace (#62).
 * @module tests/config/startup.test
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SRC = new URL('../../src/', import.meta.url).pathname;
const BANNER = 'Configuration error — server failed to start';

/** One invalid value per config layer: the two server switches and a framework variable. */
const INVALID_VALUES = [
  ['SOCRATA_DATAFRAME_DROP_ENABLED', 'maybe'],
  ['SOCRATA_CLAMP_LIMITS', 'sometimes'],
  ['MCP_LOG_LEVEL', 'nonsense'],
] as const;

/**
 * Runs `bun src/index.ts` over stdio with only `env` beyond PATH and HOME, from
 * an empty directory so no `.env` is read, and closes its stdin at once: a
 * server that starts shuts down on that EOF.
 */
async function startServer(env: Record<string, string>) {
  const cwd = await mkdtemp(join(tmpdir(), 'socrata-startup-'));
  try {
    const child = spawn('bun', [join(SRC, 'index.ts')], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        MCP_TRANSPORT_TYPE: 'stdio',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.resume();
    child.stdin.end();
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, stderr };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('starting the server', () => {
  it('starts and shuts down cleanly on stdin EOF with a valid environment', async () => {
    const { code, stderr } = await startServer({});
    expect(code).toBe(0);
    expect(stderr).not.toContain(BANNER);
  }, 60_000);

  it.each(INVALID_VALUES)(
    'exits 1 for %s=%s through the startup banner naming the variable and its accepted values, with no stack trace',
    async (name, value) => {
      const { code, stderr } = await startServer({ [name]: value });

      expect(code).toBe(1);
      expect(stderr).toContain(BANNER);
      expect(stderr).toMatch(
        new RegExp(`\\n {2}- ${name} \\(\\w+\\): Invalid option: expected one of "`),
      );
      expect(stderr).not.toMatch(/^\s+at /m);
      expect(stderr).not.toContain('McpError');
    },
    60_000,
  );
});

describe('importing the definition modules', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Every `*.ts` definition file under src/mcp-server/{tools,resources,prompts}/definitions. */
  async function definitionFiles() {
    const files: string[] = [];
    for (const kind of ['tools', 'resources', 'prompts']) {
      const dir = join(SRC, 'mcp-server', kind, 'definitions');
      for (const name of await readdir(dir)) {
        if (name.endsWith('.ts')) files.push(join(dir, name));
      }
    }
    return files;
  }

  it.each(INVALID_VALUES)(
    'reads no config with %s=%s: every module imports and every tool emits its input schema',
    async (name, value) => {
      vi.stubEnv(name, value);
      vi.resetModules();
      const files = await definitionFiles();
      expect(files).toHaveLength(10);

      let tools = 0;
      for (const file of files) {
        const exports: Record<string, unknown> = await import(file);
        for (const def of Object.values(exports)) {
          if (!(def && typeof def === 'object' && 'input' in def)) continue;
          const { properties } = z.toJSONSchema(def.input as z.ZodObject, { io: 'input' });
          expect(properties).toBeDefined();
          tools += 1;
        }
      }
      expect(tools).toBe(7);
    },
  );
});
