/**
 * @fileoverview Live SODA captures (2026-11-08) behind the `soql_error` column
 * hints: the HTTP 400 bodies of five failing queries on `ijzp-q8t2`
 * (data.cityofchicago.org) and `ipu4-2q9a` (data.cityofnewyork.us), and the
 * `X-SODA2-Fields` / `X-SODA2-Types` headers a bare `$limit=0` row request on
 * each dataset answers with (body `[]`).
 * @module tests/services/soql-captures
 */

/** `ijzp-q8t2` `?$limit=0` fields, computed regions included, in header order. */
export const IJZP_FIELDS = [
  'id',
  'case_number',
  'date',
  'block',
  'iucr',
  'primary_type',
  'description',
  'location_description',
  'arrest',
  'domestic',
  'beat',
  'district',
  'ward',
  'community_area',
  'fbi_code',
  'x_coordinate',
  'y_coordinate',
  'year',
  'updated_on',
  'latitude',
  'longitude',
  'location',
  ':@computed_region_awaf_s7ux',
  ':@computed_region_6mkv_f3dw',
  ':@computed_region_vrxf_vc4k',
  ':@computed_region_bdys_3d7i',
  ':@computed_region_43wa_7qmu',
  ':@computed_region_rpca_8um6',
  ':@computed_region_d9mm_jgwp',
  ':@computed_region_d3ds_rm58',
  ':@computed_region_8hcu_yrd4',
];

/** `ijzp-q8t2` `?$limit=0` types, index-aligned with {@link IJZP_FIELDS}. */
export const IJZP_TYPES = [
  'number',
  'text',
  'floating_timestamp',
  'text',
  'text',
  'text',
  'text',
  'text',
  'boolean',
  'boolean',
  'text',
  'text',
  'number',
  'text',
  'text',
  'number',
  'number',
  'number',
  'floating_timestamp',
  'number',
  'number',
  'location',
  ...Array<string>(9).fill('number'),
];

/** `ipu4-2q9a` `?$limit=0` fields in header order. */
export const IPU4_FIELDS = [
  'borough',
  'bin__',
  'house__',
  'street_name',
  'job__',
  'job_doc___',
  'job_type',
  'self_cert',
  'block',
  'lot',
  'community_board',
  'zip_code',
  'bldg_type',
  'residential',
  'special_district_1',
  'special_district_2',
  'work_type',
  'permit_status',
  'filing_status',
  'permit_type',
  'permit_sequence__',
  'permit_subtype',
  'oil_gas',
  'site_fill',
  'filing_date',
  'issuance_date',
  'expiration_date',
  'job_start_date',
  'permittee_s_first_name',
  'permittee_s_last_name',
  'permittee_s_business_name',
  'permittee_s_phone__',
  'permittee_s_license_type',
  'permittee_s_license__',
  'act_as_superintendent',
  'permittee_s_other_title',
  'hic_license',
  'site_safety_mgr_s_first_name',
  'site_safety_mgr_s_last_name',
  'site_safety_mgr_business_name',
  'superintendent_first___last_name',
  'superintendent_business_name',
  'owner_s_business_type',
  'non_profit',
  'owner_s_business_name',
  'owner_s_first_name',
  'owner_s_last_name',
  'owner_s_house__',
  'owner_s_house_street_name',
  'city',
  'state',
  'owner_s_zip_code',
  'permit_si_no',
  'gis_latitude',
  'gis_longitude',
  'gis_council_district',
  'gis_census_tract',
  'bbl',
  'gis_nta_name',
  'dobrundate',
];

/** `ipu4-2q9a` `?$limit=0` types: every field text but `bbl` (number) and `dobrundate` (floating_timestamp). */
export const IPU4_TYPES = IPU4_FIELDS.map((field) =>
  field === 'bbl' ? 'number' : field === 'dobrundate' ? 'floating_timestamp' : 'text',
);

/** The coordinator's expanded SELECT of `ijzp-q8t2`: its 22 fields, computed regions left out. */
const IJZP_SELECT = `SELECT ${IJZP_FIELDS.filter((f) => !f.startsWith(':'))
  .map((f) => `\`${f}\``)
  .join(', ')}`;

/** The coordinator's expanded SELECT of `ipu4-2q9a`. */
const IPU4_SELECT = `SELECT ${IPU4_FIELDS.map((f) => `\`${f}\``).join(', ')}`;

/**
 * A query-coordinator 400 body as live: the message carries the code and the
 * detail, then a `position: Map(…)` echo of the expanded query with a caret
 * under `column`, the echo's quotes and line break backslash-escaped.
 */
function coordinatorError(
  code: string,
  detail: string,
  data: Record<string, unknown>,
  line: string,
  column: number,
) {
  const caretLine = `${line}\n${' '.repeat(column - 1)}^`;
  const echo = caretLine.replaceAll('"', '\\"').replaceAll('\n', '\\n');
  return {
    message: `Query coordinator error: ${code}; ${detail}; position: Map(row -> 1, column -> ${column}, line -> "${echo}")`,
    errorCode: code,
    data: { ...data, position: { row: 1, column, line: caretLine } },
  };
}

/** The five captured 400 bodies, keyed by the query that drew each. */
export const SOQL_400 = {
  /** `ijzp-q8t2` where `district = 11` — `district` is text. */
  districtEquals11: coordinatorError(
    'query.soql.type-mismatch',
    'Type mismatch for op$=, is number',
    { function: 'op$=', type: 'number', dataset: 'foxtrot.7113' },
    `${IJZP_SELECT} WHERE \`district\` = 11 LIMIT 2`,
    298,
  ),
  /** `ijzp-q8t2` where `id like '1234567%'` — `id` is a number. */
  idLike: coordinatorError(
    'query.soql.type-mismatch',
    'Type mismatch for #LIKE, is number',
    { function: '#LIKE', type: 'number', dataset: 'foxtrot.7113' },
    `${IJZP_SELECT} WHERE \`id\` LIKE "1234567%" LIMIT 2`,
    285,
  ),
  /** `ipu4-2q9a` select `date_extract_y(issuance_date) as yr` — `issuance_date` is text. */
  dateExtractOnText: coordinatorError(
    'query.soql.type-mismatch',
    'Type mismatch for date_extract_y, is text',
    { function: 'date_extract_y', type: 'text', dataset: 'foxtrot.15668' },
    `${IPU4_SELECT} |> SELECT date_extract_y(\`issuance_date\`) AS \`yr\` LIMIT 2`,
    1148,
  ),
  /** `ijzp-q8t2` select `substr(case_number, 1, 2) as p` — SoQL has no `substr`. */
  noSuchFunction: coordinatorError(
    'query.soql.no-such-function',
    "No such function 'substr'; arity=3",
    { function: 'substr', arity: 3, dataset: 'foxtrot.7113' },
    'SELECT substr(`case_number`, 1, 2) AS `p` LIMIT 2',
    8,
  ),
  /** `ijzp-q8t2` select `id, primary_description` — no such field. */
  primaryDescription: coordinatorError(
    'query.soql.no-such-column',
    'No such column: primary_description',
    { column: 'primary_description', dataset: 'foxtrot.7113' },
    'SELECT `id`, `primary_description` LIMIT 2',
    14,
  ),
};

/** A no-such-column body for any token, shaped as {@link SOQL_400}'s `primaryDescription`. */
export function noSuchColumn(token: string) {
  return coordinatorError(
    'query.soql.no-such-column',
    `No such column: ${token}`,
    { column: token, dataset: 'foxtrot.7113' },
    `SELECT \`${token}\` LIMIT 2`,
    8,
  );
}
