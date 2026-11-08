/**
 * @fileoverview Literal Markdown rendering of portal-controlled text.
 * @module tests/tools/upstream-text.test
 */

import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { escapeTableCell, upstreamBlockquote } from '@/mcp-server/tools/upstream-text.js';
import { expectLinearCost } from '../linear-cost.js';

const markdownIt = new MarkdownIt();

/**
 * The cells of every table row a CommonMark parse (markdown-it, GFM tables)
 * reads from `markdown`, each as its inline text: a text token as its content,
 * any other inline token (emphasis, a link, code, raw HTML, a line break) as
 * `⟨type⟩`, so a value that parses as syntax never reads back as itself.
 */
function readTable(markdown: string): string[][] {
  const rows: string[][] = [];
  const tokens = markdownIt.parse(markdown, {});
  tokens.forEach((token, i) => {
    if (token.type === 'tr_open') rows.push([]);
    const opener = tokens[i - 1]?.type;
    if (token.type !== 'inline' || (opener !== 'th_open' && opener !== 'td_open')) return;
    const children = token.children ?? [];
    rows
      .at(-1)
      ?.push(children.map((c) => (c.type === 'text' ? c.content : `⟨${c.type}⟩`)).join(''));
  });
  return rows;
}

/** `cell` as the middle cell of a three-column table's header row and of its one body row. */
const tableAround = (cell: string) =>
  `| a | ${cell} | b |\n| --- | --- | --- |\n| c | ${cell} | d |`;

describe('upstream text rendering', () => {
  it('keeps Markdown links, emphasis, and table delimiters literal in cells', () => {
    expect(
      escapeTableCell('[source](https://example.com) *value* | x\\y <b>x</b> &copy;\r\nnext'),
    ).toBe(
      '\\[source\\](https://example.com) \\*value\\* \\| x\\y \\<b>x\\</b> \\&copy;&#13;&#10;next',
    );
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

describe('escapeTableCell reads back as the value it holds', () => {
  it.each([
    ['plain text', 'Brooklyn'],
    ['an empty value', ''],
    ['pipes', 'x | y|z'],
    ['backslashes', 'C:\\Users\\x a\\|b trailing\\'],
    ['entity-shaped text', '&#10; &#13; &copy; AT&T'],
    ['markup', '<b>x</b> <=50 <1@b.io> <https://x.io>'],
    ['edge whitespace', ' \t lead and trail\u00a0 '],
    ['a heading marker', '# x'],
    ['a list marker', '- y'],
    ['an ordered list marker', '1. z'],
    ['a quote marker and a rule', '> q ---'],
    ['emphasis, code, links, and strikethrough', '*e* _f_ __g__ `c` [a](b) ![i](j) ~s~'],
  ])('on one line: %s', (_label, value) => {
    expect(readTable(tableAround(escapeTableCell(value)))).toEqual([
      ['a', value, 'b'],
      ['c', value, 'd'],
    ]);
  });

  it.each([
    ['a line feed (#71)', 'l1\nl2'],
    ['CRLF and a final line feed', 'l1\r\nl2\n'],
    ['a lone CR', 'a\rb'],
    ['a leading break', '\nlead'],
    ['a trailing CRLF', 'trail\r\n'],
    ['only a break', '\n'],
    ['a blank line', 'a\n\nb'],
    ['edge whitespace on every line', '  sp  \n\tsp2\u00a0\r\n x '],
    ['pipes and a trailing backslash', 'x | y\nz\\'],
    ['a backslash before a break', 'a\\\nb'],
    ['entity-shaped text around a break', '&#10; &copy;\n&#13;\r&\n#10;'],
    ['markup across a break', '<b>x\n</b> <\nb> <1\n@b.io>'],
    ['block markers after a break', 'x\n# h\n- y\n1. z\n> q\n---\n===\n:--'],
    ['emphasis split across a break', '*e\n* a_\n_b `c\n`'],
  ])('across line breaks: %s', (_label, value) => {
    expect(readTable(tableAround(escapeTableCell(value)))).toEqual([
      ['a', value, 'b'],
      ['c', value, 'd'],
    ]);
  });
});

describe('escapeTableCell cost', () => {
  it.each([
    ['a long digit run', (n: number) => '1'.repeat(n)],
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['a CRLF after every two spaces', (n: number) => '  \r\n'.repeat(n / 4)],
    ['a lone CR at every character', (n: number) => '\r'.repeat(n)],
    ['a heading marker after every break', (n: number) => '\n#'.repeat(n / 2)],
  ])('escapes %s in linear time', (_label, make) => {
    expectLinearCost((size) => {
      const text = make(size);
      return () => escapeTableCell(text);
    });
  });
});
