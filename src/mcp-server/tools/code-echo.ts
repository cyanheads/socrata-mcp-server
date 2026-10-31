/**
 * @fileoverview Labeled echo of caller-authored text (an assembled SoQL query,
 * executed SQL) as a CommonMark code literal in `content[]`, so the value reads
 * back byte-identical to its `structuredContent` twin.
 * @module mcp-server/tools/code-echo
 */

import { markdown } from '@cyanheads/mcp-ts-core/utils';

/**
 * `**label:**` and `text` as a sized code literal, as lines to push. A code
 * span reads a line break back as a space, and a later line can open a list or
 * block quote that ends the span, so text holding a line break is fenced on
 * the lines after the label.
 */
export function codeEcho(label: string, text: string, language?: string): string[] {
  return /[\r\n]/.test(text)
    ? [`**${label}:**`, markdown().codeBlock(text, language).build()]
    : [`**${label}:** ${markdown().inlineCode(text).build()}`];
}
