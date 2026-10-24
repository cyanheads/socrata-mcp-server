/**
 * @fileoverview Literal Markdown rendering of portal-controlled text.
 * @module tests/tools/upstream-text.test
 */

import { describe, expect, it } from 'vitest';
import { escapeTableCell, upstreamBlockquote } from '@/mcp-server/tools/upstream-text.js';

describe('upstream text rendering', () => {
  it('keeps Markdown links, emphasis, and table delimiters literal in cells', () => {
    expect(
      escapeTableCell('[source](https://example.com) *value* | x\\y <b>x</b> &copy;\r\nnext'),
    ).toBe('\\[source\\](https://example.com) \\*value\\* \\| x\\y \\<b>x\\</b> \\&copy; next');
  });

  it('keeps portal-authored Markdown literal within every quoted line', () => {
    expect(
      upstreamBlockquote(
        'Description',
        '**notice**\r\n[link](https://example.com) <b>x</b> &copy;',
      ),
    ).toEqual([
      '**Description:**',
      '> \\*\\*notice\\*\\*',
      '> \\[link\\](https://example.com) \\<b>x\\</b> \\&copy;',
    ]);
  });
});
