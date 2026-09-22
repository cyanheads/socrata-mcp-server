/**
 * @fileoverview Framing helpers for upstream-controlled free text rendered into
 * `content[]` markdown. Socrata dataset names, descriptions, column descriptions,
 * and row values are portal-author-controlled — these helpers give them an
 * explicit data boundary (labeled blockquotes, escaped table cells, breakout-proof
 * JSON fences) so upstream text reads as quoted data, never as instructions.
 * The boundary is framing, not a length limit: descriptions and cells render in
 * full, so `content[]` carries the same value `structuredContent` does.
 * `structuredContent` is untouched — framing applies only to the rendered twin.
 * @module mcp-server/tools/upstream-text
 */

const TRUNCATION_MARKER = '… [truncated]';

/**
 * Render upstream text as inline data: whitespace runs (including newlines)
 * collapse to single spaces so the value cannot break out of its line. Names
 * render in full; pass `maxChars` only for text echoed into an error hint that
 * has no `structuredContent` twin.
 */
export function inlineUpstream(text: string, maxChars?: number): string {
  const inline = text.replace(/\s+/g, ' ').trim();
  if (maxChars === undefined || inline.length <= maxChars) return inline;
  return `${inline.slice(0, maxChars).trimEnd()}${TRUNCATION_MARKER}`;
}

/**
 * Escape upstream text for a markdown table cell: newlines collapse to spaces
 * (a raw newline ends the row), and backslashes then pipes are backslash-escaped
 * (a raw pipe splits the cell; GFM pairs `\` with the following character during
 * cell splitting, so an upstream `\|` would otherwise re-arm the pipe as a
 * delimiter).
 */
export function escapeTableCell(value: string): string {
  return value
    .replace(/\r\n|[\r\n]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
}

/**
 * Frame upstream free text as a labeled blockquote — the data boundary for
 * multi-line descriptions. Normalizes CRLF and prefixes every line with `> `
 * so the whole block reads as quoted upstream data.
 */
export function upstreamBlockquote(label: string, text: string): string[] {
  const quoted = text
    .replace(/\r\n|\r/g, '\n')
    .trim()
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'));
  return [`**${label}:**`, ...quoted];
}

/**
 * Wrap a JSON payload in a fenced code block whose fence is always longer than
 * any backtick run inside the payload, so upstream values containing ``` cannot
 * break out of the fence.
 */
export function fencedJson(payload: string): string[] {
  const longestRun = payload.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [`${fence}json`, payload, fence];
}
