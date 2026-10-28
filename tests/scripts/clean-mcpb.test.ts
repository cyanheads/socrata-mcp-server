/**
 * @fileoverview Bundle cleaning preserves runtime skills modules while removing agent documentation.
 * @module tests/scripts/clean-mcpb.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

// Load the copied script at runtime: its framework-repository fallback is not a consumer import.
const { checkBundleEntries } = await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
);

describe('MCPB agent documentation filtering', () => {
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@scope/outer/node_modules/inner/dist/skills/loader.js',
    'skills/socrata-guide/SKILL.md',
  ])('preserves runtime or published skill file %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(checkBundleEntries([entry], 'fixture.mcpb')).toEqual([]);
  });

  it.each([
    'node_modules/example/skills/guide/reference.md',
    'node_modules/@scope/example/skills/guide/reference.md',
    'node_modules/outer/node_modules/inner/skills/guide/reference.md',
    'node_modules/@scope/outer/node_modules/@scope/inner/skills/guide/reference.md',
    'node_modules/example/framework-skills/add-tool/SKILL.md',
    'node_modules/example/.claude/settings.json',
    'node_modules/example/.agents/skills/guide/SKILL.md',
    'node_modules/example/docs/SKILL.md',
  ])('removes dependency agent documentation %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(checkBundleEntries([entry], 'fixture.mcpb')).toEqual([
      expect.stringContaining('contains 1 node_modules agent-doc entries'),
    ]);
  });
});
