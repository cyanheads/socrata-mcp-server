/**
 * @fileoverview CommonMark reader for a labeled code echo in `content[]` text
 * (`**SQL:**`, `**Query:**`): the value a parser takes back from the literal.
 * @module tests/tools/read-code-echo
 */

/**
 * The text a CommonMark reader takes from the `**<label>:**` echo in `text`,
 * or `undefined` when the echo is not one whole code literal. Follows the
 * spec's rules rather than the renderer: an inline code span (§6.1) opens on a
 * backtick run and closes on the next run of exactly that length, and when its
 * content both begins and ends with a space and is not all spaces, one space
 * is stripped from each side; a fenced code block (§4.5) on the lines after
 * the label closes on a backtick run at least as long as its opening fence,
 * its content the lines between.
 */
export function readCodeEcho(text: string, label: string): string | undefined {
  const marker = `**${label}:**`;
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.startsWith(marker));
  if (at === -1) return;
  const rest = (lines[at] ?? '').slice(marker.length);

  if (rest === '') {
    const fence = /^(`{3,})[^`]*$/.exec(lines[at + 1] ?? '')?.[1];
    if (!fence) return;
    const end = lines.findIndex(
      (line, i) => i > at + 1 && new RegExp(`^\`{${fence.length},} *$`).test(line),
    );
    return end === -1 ? undefined : lines.slice(at + 2, end).join('\n');
  }

  const open = /^ (`+)/.exec(rest)?.[1];
  if (!open) return;
  const runs = /`+/g;
  runs.lastIndex = 1 + open.length;
  for (let run = runs.exec(rest); run; run = runs.exec(rest)) {
    if (run[0].length !== open.length) continue;
    // The span must be the whole echo: text after it means the value broke out.
    if (run.index + run[0].length !== rest.length) return;
    const content = rest.slice(1 + open.length, run.index);
    return content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content)
      ? content.slice(1, -1)
      : content;
  }
  return;
}
