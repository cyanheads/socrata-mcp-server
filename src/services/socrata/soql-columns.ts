/**
 * @fileoverview Column hints for a failed SoQL query, matched against the
 * fields a `/resource` response names in its `X-SODA2-Fields` / `X-SODA2-Types`
 * headers: the fields a query's clauses reference ({@link referencedColumns}),
 * and the field names that resemble an unknown column ({@link similarColumns}).
 * Both scans run over caller-written text and stay linear in its length.
 * @module services/socrata/soql-columns
 */

/** A field a query references, with its SODA type (also its SoQL cast name). */
export interface ReferencedColumn {
  field_name: string;
  type: string;
}

/** Most edits (insert, delete, substitute, transpose) a similar field name may differ by. */
const MAX_EDITS = 2;

/** Shortest unknown column the edit-distance arm considers; a shorter token is near every short name. */
const MIN_EDIT_TOKEN_LENGTH = 4;

/** True for `A`–`Z`, `a`–`z`, or `_`. */
function isIdentifierStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/** True for an identifier start or `0`–`9`. */
function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || (code >= 48 && code <= 57);
}

/** True for a space, tab, or line break (`\t`–`\r`). */
function isWhitespace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/** Index of the first character at or after `from` that cannot continue an identifier. */
function identifierEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && isIdentifierPart(text.charCodeAt(end))) end++;
  return end;
}

/**
 * Every identifier `text` names outside its single- and double-quoted
 * literals, lowercased: bare names (`district`), backtick-quoted names, and
 * system fields with their `:` / `:@` prefix (`:id`, `:@computed_region_x`),
 * so a cast suffix (`::number`) never reads as a field named `number`. A bare
 * name followed by `(` is a function call and a name right after `AS` is an
 * alias, so neither is read as a field of that name. A `''` inside a
 * single-quoted literal reads as two adjacent literals, which skips the same
 * text. A run that starts with a digit is a number, not a name. An unclosed
 * quote or backtick ends the scan. One pass: every index is visited at most
 * twice.
 */
function identifiersIn(text: string, into: Set<string>): void {
  let afterAs = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (isWhitespace(code)) {
      i++;
      continue;
    }
    const alias = afterAs;
    afterAs = false;
    if (ch === "'" || ch === '"') {
      const close = text.indexOf(ch, i + 1);
      if (close === -1) return;
      i = close + 1;
    } else if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close === -1) return;
      if (!alias) into.add(text.slice(i + 1, close).toLowerCase());
      i = close + 1;
    } else if (ch === ':') {
      const at = text[i + 1] === '@' ? i + 2 : i + 1;
      if (at < text.length && isIdentifierStart(text.charCodeAt(at))) {
        const end = identifierEnd(text, at + 1);
        into.add(text.slice(i, end).toLowerCase());
        i = end;
      } else {
        i++;
      }
    } else if (isIdentifierStart(code)) {
      const end = identifierEnd(text, i + 1);
      const name = text.slice(i, end).toLowerCase();
      let next = end;
      while (next < text.length && isWhitespace(text.charCodeAt(next))) next++;
      if (!alias && text[next] !== '(') into.add(name);
      afterAs = name === 'as';
      i = end;
    } else {
      i = isIdentifierPart(code) ? identifierEnd(text, i + 1) : i + 1;
    }
  }
}

/**
 * The fields of `fieldTypes` that `clauses` name as a whole identifier,
 * matched case-insensitively, in header order. A name that is not a field (a
 * keyword) matches nothing, and a function name or select alias is never read
 * as a field even when one shares it; a field named like a keyword (`date`,
 * `year`) is listed when the query uses the word.
 */
export function referencedColumns(
  clauses: readonly (string | undefined)[],
  fieldTypes: ReadonlyMap<string, string>,
): ReferencedColumn[] {
  const named = new Set<string>();
  for (const clause of clauses) if (clause) identifiersIn(clause, named);
  return [...fieldTypes]
    .filter(([field]) => named.has(field.toLowerCase()))
    .map(([field_name, type]) => ({ field_name, type }));
}

/** The `_`-separated words of `name` with two or more characters, lowercased. */
function wordsOf(name: string): string[] {
  return name
    .toLowerCase()
    .split('_')
    .filter((word) => word.length >= 2);
}

/**
 * True when the optimal-string-alignment distance (insert, delete,
 * substitute, or transpose adjacent characters) between `a` and `b` is at
 * most {@link MAX_EDITS}. Only the diagonal band the bound allows is filled,
 * and a length gap past it answers at once, so the cost is linear in the
 * shorter string.
 */
function withinEdits(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > MAX_EDITS) return false;
  const over = MAX_EDITS + 1;
  const width = b.length + 1;
  // Three rotating rows of the distance table; a cell outside the band reads as `over`.
  let before = new Uint8Array(width);
  let prev = Uint8Array.from({ length: width }, (_, j) => Math.min(j, over));
  let row = new Uint8Array(width);
  for (let i = 1; i <= a.length; i++) {
    const lo = Math.max(1, i - MAX_EDITS);
    const hi = Math.min(b.length, i + MAX_EDITS);
    row[lo - 1] = lo === 1 ? Math.min(i, over) : over;
    if (hi < b.length) row[hi + 1] = over;
    let best = row[lo - 1] as number;
    for (let j = lo; j <= hi; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, (before[j - 2] as number) + 1);
      }
      row[j] = Math.min(d, over);
      best = Math.min(best, row[j] as number);
    }
    if (best > MAX_EDITS) return false;
    [before, prev, row] = [prev, row, before];
  }
  return (prev[b.length] as number) <= MAX_EDITS;
}

/**
 * The field names, in header order and without `:`-prefixed system fields,
 * that resemble the unknown column `column`: each shares a `_`-separated word
 * of two or more characters with it, or, when `column` has four or more
 * characters, is within two edits of it. Case-insensitive.
 */
export function similarColumns(column: string, fields: Iterable<string>): string[] {
  const token = column.toLowerCase();
  const words = new Set(wordsOf(token));
  const byEdits = token.length >= MIN_EDIT_TOKEN_LENGTH;
  const similar: string[] = [];
  for (const field of fields) {
    if (field.startsWith(':')) continue;
    if (
      wordsOf(field).some((word) => words.has(word)) ||
      (byEdits && withinEdits(token, field.toLowerCase()))
    ) {
      similar.push(field);
    }
  }
  return similar;
}
