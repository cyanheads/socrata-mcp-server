/**
 * @fileoverview Tests for the `soql_error` column hints: which fields a
 * query's clauses reference, which field names resemble an unknown column, and
 * that both scans cost time linear in the caller's text.
 * @module tests/services/soql-columns.test
 */

import { describe, expect, it } from 'vitest';
import { referencedColumns, similarColumns } from '@/services/socrata/soql-columns.js';
import { expectLinearCost } from '../linear-cost.js';
import { IJZP_FIELDS, IJZP_TYPES } from './soql-captures.js';

/** `ijzp-q8t2`'s field types as its bare row request reports them. */
const IJZP = new Map(IJZP_FIELDS.map((field, i) => [field, IJZP_TYPES[i] as string]));

const referenced = (clauses: (string | undefined)[], fieldTypes = IJZP) =>
  referencedColumns(clauses, fieldTypes).map((c) => c.field_name);

describe('referencedColumns', () => {
  it('pairs each referenced field with its SODA type', () => {
    expect(referencedColumns(["id like '13%' and district = 11"], IJZP)).toEqual([
      { field_name: 'id', type: 'number' },
      { field_name: 'district', type: 'text' },
    ]);
  });

  it.each([
    ['a comparison', ['district = 11'], ['district']],
    ['a function argument', ['date_extract_y(date) as yr'], ['date']],
    ['any letter case', ['DISTRICT = 11 AND Ward = 3'], ['district', 'ward']],
    ['header order, not query order', ['year, ward, id'], ['id', 'ward', 'year']],
    ['a backtick-quoted name', ['`district` = 11'], ['district']],
    [
      'every clause given, skipping an absent one',
      ['ward', undefined, 'district'],
      ['district', 'ward'],
    ],
    ['a single-quoted value as a value', ["primary_type = 'district ward'"], ['primary_type']],
    ["a '' escape inside a value", ["block = 'it''s ward' and beat = 1"], ['block', 'beat']],
    ['a double-quoted value as a value', ['block = "ward"'], ['block']],
    ['whole identifiers only', ['district_2 = 1 or xdistrict = 2 or 11district = 3'], []],
    ['a number literal as a number', ['1e5 = 2.5'], []],
    [
      'a system field with its prefix',
      [':@computed_region_awaf_s7ux = 1 and :id = 2'],
      [':@computed_region_awaf_s7ux'],
    ],
    ['text after an unclosed quote as unread', ["district = 'x and ward = 1"], ['district']],
  ])('reads %s', (_label, clauses, fields) => {
    expect(referenced(clauses)).toEqual(fields);
  });

  it('never reads a cast suffix as a field of that name', () => {
    const fieldTypes = new Map([
      ['district', 'text'],
      ['number', 'number'],
      ['text', 'text'],
    ]);

    expect(referenced(['district::number = 11 or district::text = text'], fieldTypes)).toEqual([
      'district',
      'text',
    ]);
  });

  it('never reads a function name or a select alias as a field of that name', () => {
    const fieldTypes = new Map([
      ['count', 'number'],
      ['case', 'text'],
      ['year', 'number'],
      ['date', 'floating_timestamp'],
      ['zip', 'text'],
    ]);

    expect(
      referenced(
        ["count(*) AS n, date_extract_y(date) as year, case (zip = '1', 1) As\n  Year", 'zip'],
        fieldTypes,
      ),
    ).toEqual(['date', 'zip']);
  });

  it('is empty when no field is named', () => {
    expect(referencedColumns(["'a' || 1 as x"], IJZP)).toEqual([]);
    expect(referencedColumns([], IJZP)).toEqual([]);
  });
});

describe('similarColumns', () => {
  it.each([
    ['primary_description', ['primary_type', 'description', 'location_description']],
    ['case_num', ['case_number']],
    ['comunity_area', ['community_area']],
    ['crime_type', ['primary_type']],
    ['distrct', ['district']],
    ['latitud', ['latitude']],
    ['primarytype', ['primary_type']],
    ['x_coord', []],
    ['Manhattan', []],
  ])('%s → %j on ijzp-q8t2', (token, similar) => {
    expect(similarColumns(token, IJZP_FIELDS)).toEqual(similar);
  });

  it.each([
    ['any letter case', 'DISTRCT', ['district']],
    ['a transposition as one edit', 'distirct', ['district']],
    ['two edits', 'dstrct', ['district']],
    ['two extra characters as two edits', 'districtxx', ['district']],
    ['an extra character at each end as two edits', 'xdistricty', ['district']],
    ['three edits as too many', 'dstrc', []],
    ['a two-letter word as a shared word', 'case_id', ['id', 'case_number']],
    ['a token under four characters by shared words only', 'war', []],
    ['a one-character word as no word', 'x_y', []],
  ])('counts %s', (_label, token, similar) => {
    expect(similarColumns(token, IJZP_FIELDS)).toEqual(similar);
  });

  it('leaves out :-prefixed system fields', () => {
    expect(similarColumns('computed_region', IJZP_FIELDS)).toEqual([]);
    expect(similarColumns(':@computed_region_awaf_s7u', IJZP_FIELDS)).toEqual([]);
  });

  it('keeps header order across both rules', () => {
    expect(similarColumns('year_ward', ['ward', 'beat', 'yaer', 'year'])).toEqual(['ward', 'year']);
    expect(similarColumns('beta', ['ward', 'beat', 'year'])).toEqual(['beat']);
  });
});

describe('soql column scan cost', () => {
  it.each([
    ['a long digit run', (n: number) => '1'.repeat(n)],
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['a CRLF after every two spaces', (n: number) => '  \r\n'.repeat(n / 4)],
    ['one unclosed quote', (n: number) => `'${'a'.repeat(n - 1)}`],
    ['a quote at every character', (n: number) => "'".repeat(n)],
    ['a backtick before every name', (n: number) => '`a'.repeat(n / 2)],
    ['a colon at every character', (n: number) => ':'.repeat(n)],
    ['a system-field prefix after every name', (n: number) => ':@a'.repeat(n / 3)],
    ['one long identifier', (n: number) => 'a'.repeat(n)],
    [
      'distinct names',
      (n: number) => Array.from({ length: n / 8 }, (_, i) => `c${i}`.padEnd(8)).join(''),
    ],
  ])('referencedColumns reads %s in linear time', (_label, make) => {
    expectLinearCost((size) => {
      const clause = make(size);
      return () => referencedColumns([clause], IJZP);
    });
  });

  it.each([
    ['a long digit run', (n: number) => '1'.repeat(n)],
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['a CRLF after every two spaces', (n: number) => '  \r\n'.repeat(n / 4)],
    ['a two-letter word after every separator', (n: number) => 'ab_'.repeat(n / 3)],
  ])('similarColumns matches %s against the fields in linear time', (_label, make) => {
    expectLinearCost((size) => {
      const token = make(size);
      return () => similarColumns(token, IJZP_FIELDS);
    });
  });

  it.each([
    ['one substitution from the token', (n: number) => `b${'a'.repeat(n - 1)}`],
    ['two characters longer', (n: number) => 'a'.repeat(n + 2)],
    ['one transposition at its end', (n: number) => `${'a'.repeat(n - 2)}ba`],
    ['two characters shorter, then different', (n: number) => `${'a'.repeat(n - 3)}c`],
  ])('similarColumns compares a field %s in linear time', (_label, makeField) => {
    expectLinearCost((size) => {
      const token = `${'a'.repeat(size - 1)}b`;
      const fields = [...IJZP_FIELDS, makeField(size)];
      return () => similarColumns(token, fields);
    });
  });
});
