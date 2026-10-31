/**
 * @fileoverview The rendered `content[]` text of a tool contract run, for tests
 * asserting on what an MCP client reading that surface sees.
 * @module tests/tools/content-text
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';

/** Every text block of a contract result's `content[]`, joined. */
export function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
}
