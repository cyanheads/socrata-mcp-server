/**
 * @fileoverview Framing helpers for upstream-controlled free text rendered into
 * `content[]` markdown. Socrata dataset names, descriptions, column descriptions,
 * and row values are portal-author-controlled — these helpers give them an
 * explicit data boundary (labeled blockquotes, escaped table cells, breakout-proof
 * JSON fences) so upstream text reads as quoted data, never as instructions.
 * `structuredContent` is untouched — framing applies only to the rendered twin.
 * @module mcp-server/tools/upstream-text
 */

/** Character cap for a blockquoted dataset description. */
export const UPSTREAM_BLOCK_MAX_CHARS = 2000;
/** Character cap for a table-cell description. */
export const UPSTREAM_CELL_MAX_CHARS = 400;
/** Character cap for an inline-rendered name. */
export const UPSTREAM_INLINE_MAX_CHARS = 200;

const TRUNCATION_MARKER = '… [truncated]';

/** Truncate to `maxChars`, appending a continuation marker when cut. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}${TRUNCATION_MARKER}`;
}

/**
 * Render upstream text as inline data: whitespace runs (including newlines)
 * collapse to single spaces so the value cannot break out of its line, then
 * truncate. Use for names and other short fields interpolated into prose.
 */
export function inlineUpstream(text: string, maxChars: number = UPSTREAM_INLINE_MAX_CHARS): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), maxChars);
}

/**
 * Escape upstream text for a markdown table cell: newlines collapse to spaces
 * (a raw newline ends the row), and backslashes then pipes are backslash-escaped
 * (a raw pipe splits the cell; GFM pairs `\` with the following character during
 * cell splitting, so an upstream `\|` would otherwise re-arm the pipe as a
 * delimiter). Optionally truncates long cell content.
 */
export function escapeTableCell(value: string, maxChars?: number): string {
  const escaped = value
    .replace(/\r\n|[\r\n]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
  return maxChars != null ? truncate(escaped, maxChars) : escaped;
}

/**
 * Frame upstream free text as a labeled blockquote — the data boundary for
 * multi-line descriptions. Normalizes CRLF, truncates, and prefixes every line
 * with `> ` so the whole block reads as quoted upstream data.
 */
export function upstreamBlockquote(
  label: string,
  text: string,
  maxChars: number = UPSTREAM_BLOCK_MAX_CHARS,
): string[] {
  const normalized = truncate(text.replace(/\r\n|\r/g, '\n').trim(), maxChars);
  const quoted = normalized.split('\n').map((line) => (line.length > 0 ? `> ${line}` : '>'));
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
