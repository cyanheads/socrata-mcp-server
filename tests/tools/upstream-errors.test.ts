/**
 * @fileoverview End-to-end error and domain handling for the Socrata tools: the
 * real SocrataService behind each tool's real handler, contract, and format(),
 * with only `globalThis.fetch` stubbed. Asserts both client surfaces — the
 * `structuredContent.error` JSON and the `content[]` text — for the upstream
 * failure shapes the service classifies (#27, #28, #37, #38, #39) and URL-shaped
 * domains (#35).
 * @module tests/tools/upstream-errors.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { datasetResource } from '@/mcp-server/resources/definitions/dataset.resource.js';
import { findDatasets } from '@/mcp-server/tools/definitions/find-datasets.tool.js';
import { getDataset } from '@/mcp-server/tools/definitions/get-dataset.tool.js';
import { listPortals } from '@/mcp-server/tools/definitions/list-portals.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { initSocrataService } from '@/services/socrata/socrata-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ defaultDomain: 'data.seattle.gov' }),
}));

const DISCOVERY_ORIGIN = 'https://api.us.socrata.com';
const originOf = (input: unknown) => new URL(String(input)).origin;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const html = (status: number) =>
  new Response('<!DOCTYPE html>\n<html><body>Page not found</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  });

/** Discovery `?ids=` answer naming the portal that holds the ID (none when omitted). */
const idsAnswer = (domain?: string) =>
  json({
    results: domain ? [{ resource: { id: 'x' }, metadata: { domain } }] : [],
    resultSetSize: domain ? 1 : 0,
  });

type ErrorEnvelope = {
  code: number;
  message: string;
  data: Record<string, unknown> & { recovery?: { hint?: string } };
};

/** Pull both error surfaces off a CallToolResult. */
function errorOf(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).toBe(true);
  const error = (result.structuredContent as { error: ErrorEnvelope }).error;
  const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
  return { error, text };
}

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  initSocrataService();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('not_found names the ID, the domain queried, and the portal holding it (#28)', () => {
  /** SODA 404s (codeless body, as live); Discovery places the ID on `holder`. */
  function route(holder?: string) {
    fetchSpy.mockImplementation((input) =>
      Promise.resolve(
        originOf(input) === DISCOVERY_ORIGIN
          ? idsAnswer(holder)
          : json({ error: true, message: 'Not found' }, 404),
      ),
    );
  }

  it.each([
    ['socrata_get_dataset', getDataset],
    ['socrata_query_dataset', queryDataset],
  ] as const)(
    '%s on the default domain with another portal’s ID points at that portal',
    async (_name, def) => {
      route('data.cityofnewyork.us');

      const { error, text } = errorOf(
        await runToolContract(def as typeof getDataset, { dataset_id: 'erm2-nwe9' }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toBe('Dataset erm2-nwe9 not found on data.seattle.gov.');
      expect(error.data).toMatchObject({
        reason: 'not_found',
        domain: 'data.seattle.gov',
        dataset_id: 'erm2-nwe9',
        found_on_domain: 'data.cityofnewyork.us',
      });
      expect(error.data.recovery?.hint).toContain('data.cityofnewyork.us');
      // content[] carries the same message, hint, and reason.
      expect(text).toContain('Dataset erm2-nwe9 not found on data.seattle.gov.');
      expect(text).toContain('Recovery:');
      expect(text).toContain('data.cityofnewyork.us');
      expect(text).toContain('reason not_found');
    },
  );

  it('falls back to the static mismatch-or-retired hint when Discovery does not know the ID', async () => {
    route();

    const { error, text } = errorOf(
      await runToolContract(getDataset, { domain: 'data.cdc.gov', dataset_id: 'zzzz-9999' }),
    );

    expect(error.message).toBe('Dataset zzzz-9999 not found on data.cdc.gov.');
    expect(error.data.found_on_domain).toBeUndefined();
    const hint = error.data.recovery?.hint ?? '';
    // Leads with the portal mismatch, not retirement.
    expect(hint).toMatch(/^The ID may belong to a different portal/);
    expect(hint).toContain('socrata_find_datasets');
    expect(text).toContain(hint);
  });

  it('declares a not_found recovery on both tools that leads with the portal mismatch', () => {
    for (const def of [getDataset, queryDataset]) {
      const entry = def.errors?.find((e) => e.reason === 'not_found');
      expect(entry?.recovery).toMatch(/^The ID may belong to a different portal/);
    }
  });
});

describe('unknown_domain for hosts that are not Socrata portals (#27)', () => {
  it.each([
    ['socrata_get_dataset', getDataset],
    ['socrata_query_dataset', queryDataset],
  ] as const)('%s maps an HTML 404 to unknown_domain without echoing the page', async (_n, def) => {
    fetchSpy.mockImplementation(() => Promise.resolve(html(404)));

    const { error, text } = errorOf(
      await runToolContract(def as typeof getDataset, {
        domain: 'data.gov',
        dataset_id: 'zzzz-9999',
      }),
    );

    expect(error.data.reason).toBe('unknown_domain');
    expect(error.data.recovery?.hint).toContain('socrata_list_portals');
    expect(JSON.stringify(error)).not.toContain('DOCTYPE');
    expect(text).not.toContain('DOCTYPE');
    expect(text).toContain('reason unknown_domain');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('socrata_find_datasets maps Discovery "Domain not found" to unknown_domain with the upstream message', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(json({ error: 'Domain not found: data.sandiego.gov' }, 404)),
    );

    const { error, text } = errorOf(
      await runToolContract(findDatasets, { domain: 'data.sandiego.gov', query: 'crime' }),
    );

    expect(error.data.reason).toBe('unknown_domain');
    expect(error.message).toContain('Domain not found: data.sandiego.gov');
    expect(error.data.recovery?.hint).toContain('socrata_list_portals');
    expect(text).toContain('Domain not found: data.sandiego.gov');
    expect(text).toContain('socrata_list_portals');
  });
});

describe('rate_limited on every tool that declares it (#27)', () => {
  it.each([
    ['socrata_find_datasets', () => runToolContract(findDatasets, { query: 'crime' })],
    ['socrata_query_dataset', () => runToolContract(queryDataset, { dataset_id: 'bi63-dtpu' })],
  ] as const)('%s maps an HTML 429 to rate_limited with the recovery hint', async (_n, call) => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response('<html><body>Too many</body></html>', {
          status: 429,
          headers: { 'Retry-After': '0' },
        }),
      ),
    );

    const { error, text } = errorOf(await call());

    expect(error.data).toMatchObject({ reason: 'rate_limited', retryable: true, retryAfter: '0' });
    expect(error.data.recovery?.hint).toContain('SOCRATA_APP_TOKEN');
    expect(text).toContain('reason rate_limited');
    expect(text).toContain('retryable');
  });
});

describe('URL-shaped and malformed domains (#35)', () => {
  it('socrata_query_dataset reports the normalized domain on both surfaces', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(json([{ a: '1' }])));

    const result = await runToolContract(queryDataset, {
      domain: 'HTTPS://Data.CDC.gov/browse?x=1',
      dataset_id: 'bi63-dtpu',
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { domain: string }).domain).toBe('data.cdc.gov');
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(text).toContain('on data.cdc.gov');
    expect(text).not.toContain('HTTPS://');
    expect(originOf(fetchSpy.mock.calls[0]?.[0])).toBe('https://data.cdc.gov');
  });

  it('socrata_get_dataset reports the normalized domain on both surfaces', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(json({ id: 'bi63-dtpu', name: 'Leading Causes of Death', columns: [] })),
    );

    const result = await runToolContract(getDataset, {
      domain: 'https://data.cdc.gov/',
      dataset_id: 'bi63-dtpu',
    });

    expect((result.structuredContent as { domain: string }).domain).toBe('data.cdc.gov');
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(text).toContain('**Domain:** data.cdc.gov');
  });

  it('socrata_find_datasets scopes Discovery to the bare host', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(json({ results: [], resultSetSize: 0 })));

    await runToolContract(findDatasets, { domain: 'https://data.cdc.gov/', query: 'vaccination' });

    expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.get('domains')).toBe(
      'data.cdc.gov',
    );
  });

  it.each([
    ['socrata_find_datasets', () => runToolContract(findDatasets, { domain: 'not a host' })],
    [
      'socrata_get_dataset',
      () => runToolContract(getDataset, { domain: 'not a host', dataset_id: 'bi63-dtpu' }),
    ],
    [
      'socrata_query_dataset',
      () => runToolContract(queryDataset, { domain: 'not a host', dataset_id: 'bi63-dtpu' }),
    ],
  ] as const)(
    '%s fails an unparseable domain as invalid_domain before any request',
    async (_n, call) => {
      const { error, text } = errorOf(await call());

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({ reason: 'invalid_domain', domain: 'not a host' });
      expect(error.message).toContain('"not a host"');
      expect(error.data.recovery?.hint).toContain('socrata_list_portals');
      expect(text).toContain('reason invalid_domain');
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

describe('socrata_list_portals advertises no error contract (#31)', () => {
  it('has no errors field at all', () => {
    expect(listPortals.errors).toBeUndefined();
    expect('errors' in listPortals).toBe(false);
  });
});

describe('socrata://datasets/{domain}/{datasetId} inherits the service classification', () => {
  it('normalizes the domain segment before building the request', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(json({ id: 'bi63-dtpu', name: 'Leading Causes of Death', columns: [] })),
    );

    const params = datasetResource.params!.parse({
      domain: 'DATA.CDC.GOV',
      datasetId: 'bi63-dtpu',
    });
    const result = await datasetResource.handler(params, createMockContext());

    expect(result.domain).toBe('data.cdc.gov');
    expect(originOf(fetchSpy.mock.calls[0]?.[0])).toBe('https://data.cdc.gov');
  });

  it('fails a cross-portal ID as not_found naming the ID, domain, and holding portal', async () => {
    fetchSpy.mockImplementation((input) =>
      Promise.resolve(
        originOf(input) === DISCOVERY_ORIGIN
          ? idsAnswer('data.cityofnewyork.us')
          : json({ code: 'not_found', error: true, message: 'Not found' }, 404),
      ),
    );

    const params = datasetResource.params!.parse({
      domain: 'data.seattle.gov',
      datasetId: 'erm2-nwe9',
    });
    await expect(datasetResource.handler(params, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'Dataset erm2-nwe9 not found on data.seattle.gov.',
      data: {
        reason: 'not_found',
        domain: 'data.seattle.gov',
        dataset_id: 'erm2-nwe9',
        found_on_domain: 'data.cityofnewyork.us',
      },
    });
  });
});

describe('socrata_query_dataset soql_error recovery chosen per upstream code (#29)', () => {
  /** Live-captured 400 bodies (43nn-pn8j), expanded SELECT shortened. */
  const echo = (clause: string) =>
    `position: Map(row -> 1, column -> 40, line -> "SELECT \`camis\`, \`dba\`, \`boro\` ${clause} LIMIT 2\\n                                       ^")`;
  const bodies = {
    malformed: {
      code: 'query.compiler.malformed',
      error: true,
      message:
        "Could not parse SoQL query \"select DBA, BORO, CUISINE DESCRIPTION, GRADE limit 2\" at line 1 character 27: Expected one of end of input, `,', or `AS', but got `DESCRIPTION'",
      data: { query: 'select DBA, BORO, CUISINE DESCRIPTION, GRADE limit 2', position: {} },
    },
    noSuchColumn: {
      message: `Query coordinator error: query.soql.no-such-column; No such column: Manhattan; ${echo('WHERE `boro` = `Manhattan`')}`,
      errorCode: 'query.soql.no-such-column',
      data: { column: 'Manhattan', dataset: 'foxtrot.15649', position: { row: 1, column: 40 } },
    },
    typeMismatch: {
      message: `Query coordinator error: query.soql.type-mismatch; Type mismatch for op$=, is number; ${echo('WHERE `boro` = 5')}`,
      errorCode: 'query.soql.type-mismatch',
      data: { function: 'op$=', type: 'number', dataset: 'foxtrot.15649' },
    },
    notInGroupBy: {
      message: `Query coordinator error: query.soql.column-not-in-group-bys; Column 'boro' is not in group by; ${echo('')}`,
      errorCode: 'query.soql.column-not-in-group-bys',
      data: { column: 'boro', dataset: 'foxtrot.15649' },
    },
  } as const;

  async function querying(body: unknown, input: Record<string, unknown>) {
    fetchSpy.mockImplementation(() => Promise.resolve(json(body, 400)));
    const result = errorOf(
      await runToolContract(queryDataset, {
        domain: 'data.cityofnewyork.us',
        dataset_id: '43nn-pn8j',
        limit: 2,
        ...input,
      }),
    );
    expect(result.error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(result.error.data.reason).toBe('soql_error');
    expect(result.error.message).not.toContain('position: Map(');
    expect(result.text).not.toContain('position: Map(');
    expect(result.text).toContain('reason soql_error');
    expect(result.text).toContain(result.error.data.recovery?.hint ?? '<no hint>');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    return result;
  }

  it('a display label in select (parse error) points at API field names', async () => {
    const { error } = await querying(bodies.malformed, {
      select: 'DBA, BORO, CUISINE DESCRIPTION, GRADE',
    });

    expect(error.data.socrataCode).toBe('query.compiler.malformed');
    expect(error.data.column).toBeUndefined();
    const hint = error.data.recovery?.hint ?? '';
    expect(hint).toMatch(/^Reference columns by API field name/);
    expect(hint).toContain('field_name');
    expect(hint).toContain('socrata_get_dataset');
    expect(hint).toContain('cuisine_description');
  });

  it('an unquoted text value names the token and gives both fixes', async () => {
    const { error, text } = await querying(bodies.noSuchColumn, { where: 'boro=Manhattan' });

    expect(error.data.socrataCode).toBe('query.soql.no-such-column');
    expect(error.data.column).toBe('Manhattan');
    expect(error.message).toContain('No such column: Manhattan');
    const hint = error.data.recovery?.hint ?? '';
    expect(hint).toContain('"Manhattan" is not a column');
    // Fix 1: use a field_name. Fix 2: single-quote the text value.
    expect(hint).toContain('field_name');
    expect(hint).toContain("'Manhattan'");
    expect(text).toContain('No such column: Manhattan');
  });

  it('a bare number against a Text column gets the quoting rule', async () => {
    const { error } = await querying(bodies.typeMismatch, { where: 'boro=5' });

    expect(error.data.socrataCode).toBe('query.soql.type-mismatch');
    const hint = error.data.recovery?.hint ?? '';
    expect(hint).toContain('data_type');
    expect(hint).toContain("single-quoted strings (year='2020')");
    expect(hint).toContain('bare literals (year=2020)');
  });

  it('an unmapped code falls back to the declared generic recovery', async () => {
    const { error } = await querying(bodies.notInGroupBy, { select: 'boro, count(*)' });

    expect(error.data.socrataCode).toBe('query.soql.column-not-in-group-bys');
    expect(error.data.column).toBe('boro');
    const declared = queryDataset.errors?.find((e) => e.reason === 'soql_error')?.recovery;
    expect(declared).toBeDefined();
    expect(error.data.recovery?.hint).toBe(declared);
  });

  it('a no-such-column without data.column still names field names and quoting', async () => {
    const { data: _dropped, ...codeOnly } = bodies.noSuchColumn;
    const { error } = await querying(codeOnly, { select: 'problem' });

    expect(error.data.column).toBeUndefined();
    const hint = error.data.recovery?.hint ?? '';
    // The code-specific hint, not the declared generic one (which also names both).
    expect(hint).toMatch(/^An identifier is not a column/);
    expect(hint).toContain('field_name');
    expect(hint).toContain('single-quote');
  });
});

describe('socrata_get_dataset declares rate_limited', () => {
  it('maps a 429 to rate_limited with the recovery hint on both surfaces', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response('<html><body>Too many</body></html>', {
          status: 429,
          headers: { 'Retry-After': '0' },
        }),
      ),
    );

    const { error, text } = errorOf(
      await runToolContract(getDataset, { domain: 'data.cdc.gov', dataset_id: 'bi63-dtpu' }),
    );

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'rate_limited', retryable: true, retryAfter: '0' });
    expect(error.data.recovery?.hint).toContain('SOCRATA_APP_TOKEN');
    expect(text).toContain('reason rate_limited');
    expect(text).toContain('SOCRATA_APP_TOKEN');
  });

  it('declares the same rate_limited contract entry as the other upstream tools', () => {
    const entryOf = (def: typeof getDataset | typeof queryDataset | typeof findDatasets) =>
      def.errors?.find((e) => e.reason === 'rate_limited');
    const entry = entryOf(getDataset);
    expect(entry).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable, retryable: true });
    expect(entry?.recovery).toBe(entryOf(queryDataset)?.recovery);
  });
});

describe('socrata_find_datasets column_names carry SoQL field names (#29)', () => {
  function discovery(resource: Record<string, unknown>) {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        json({
          results: [
            {
              resource: {
                id: '43nn-pn8j',
                name: 'DOHMH Restaurant Inspection Results',
                ...resource,
              },
              metadata: { domain: 'data.cityofnewyork.us' },
              classification: {},
            },
          ],
          resultSetSize: 1,
        }),
      ),
    );
  }

  it('returns field names on structuredContent and content[], without labels or computed regions', async () => {
    discovery({
      columns_name: ['DBA', 'CUISINE DESCRIPTION', 'GRADE DATE', 'Census Tract', ''],
      columns_field_name: [
        'dba',
        'cuisine_description',
        'grade_date',
        'census_tract',
        ':@computed_region_f5dn_yrer',
      ],
    });

    const result = await runToolContract(findDatasets, {
      query: 'DOHMH restaurant inspection results',
      domain: 'data.cityofnewyork.us',
      limit: 1,
    });

    expect(result.isError).toBeFalsy();
    const names = (result.structuredContent as { results: { column_names: string[] }[] }).results[0]
      ?.column_names;
    expect(names).toEqual(['dba', 'cuisine_description', 'grade_date', 'census_tract']);
    for (const n of names ?? []) {
      expect(n).not.toMatch(/[\sA-Z]/);
      expect(n).not.toContain(':@computed_region_');
    }
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(text).toContain(
      '**Columns (field names):** dba, cuisine_description, grade_date, census_tract',
    );
    expect(text).not.toContain('CUISINE DESCRIPTION');
    expect(text).not.toContain(':@computed_region_');
  });

  it('a sparse result without columns_field_name yields column_names: [] and no Columns line', async () => {
    discovery({ columns_name: ['DBA', 'CUISINE DESCRIPTION'] });

    const result = await runToolContract(findDatasets, { query: 'x' });

    const first = (result.structuredContent as { results: { column_names: string[] }[] })
      .results[0];
    expect(first?.column_names).toEqual([]);
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(text).not.toContain('**Columns');
    expect(text).not.toContain('CUISINE DESCRIPTION');
  });
});

describe('hosts that do not serve the SODA API reach the caller typed, on the first attempt (#37, #38, #39)', () => {
  /** Live Bun 1.4 shape of a DNS name-not-found `fetch` rejection. */
  const enotfound = (hostname: string) =>
    Object.assign(new TypeError(`getaddrinfo ENOTFOUND ${hostname}`), {
      code: 'ENOTFOUND',
      errno: 4,
      syscall: 'getaddrinfo',
      hostname,
    });

  /** data.oxnard.org 30x → oxnardca.opengov.com/data, 200 application/json (live). */
  const opengov = () => {
    const res = json({ entryScript: '/reporting-classic-app/assets/javascripts/rapp.js' });
    Object.defineProperty(res, 'url', { value: 'https://oxnardca.opengov.com/data' });
    Object.defineProperty(res, 'redirected', { value: true });
    return res;
  };

  /** data.cityofberkeley.info's gateway answer to an unknown dataset ID (live, IP redacted). */
  const gateway403 = () =>
    new Response(
      '{"page_title":"Web Page Blocked!","display_message":"The page cannot be displayed.","client_IP":"192.0.2.1","attack_ID":"20000009",}',
      { status: 403, headers: { 'Content-Type': 'text/html' } },
    );

  const sodaCalls = () => fetchSpy.mock.calls.filter((c) => originOf(c[0]) !== DISCOVERY_ORIGIN);

  it.each([
    ['socrata_get_dataset', getDataset],
    ['socrata_query_dataset', queryDataset],
  ] as const)(
    '%s maps an unresolvable hostname to unknown_domain with the recovery hint',
    async (_n, def) => {
      fetchSpy.mockImplementation(() => Promise.reject(enotfound('www.data.cityofnewyork.us')));

      const { error, text } = errorOf(
        await runToolContract(def as typeof getDataset, {
          domain: 'www.data.cityofnewyork.us',
          dataset_id: 'erm2-nwe9',
        }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('unknown_domain');
      expect(error.message).toContain('www.data.cityofnewyork.us');
      expect(error.data.recovery?.hint).toContain('socrata_list_portals');
      expect(text).toContain('reason unknown_domain');
      expect(text).toContain(error.data.recovery?.hint ?? '<no hint>');
      // Before the fix: 4 attempts over ~4 s and a raw message with no reason.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['socrata_get_dataset', getDataset],
    ['socrata_query_dataset', queryDataset],
  ] as const)(
    '%s maps an off-host redirect to a non-Socrata JSON page to unknown_domain (data.oxnard.org)',
    async (_n, def) => {
      fetchSpy.mockImplementation(() => Promise.resolve(opengov()));

      const { error, text } = errorOf(
        await runToolContract(def as typeof getDataset, {
          domain: 'data.oxnard.org',
          dataset_id: 'zzzz-9999',
        }),
      );

      expect(error.data).toMatchObject({
        reason: 'unknown_domain',
        host: 'data.oxnard.org',
        redirectedTo: 'oxnardca.opengov.com',
      });
      expect(error.data.recovery?.hint).toContain('socrata_list_portals');
      expect(text).toContain('oxnardca.opengov.com');
      expect(text).toContain('reason unknown_domain');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('socrata_get_dataset maps a gateway 403 on an unknown ID to not_found with the recovery hint (data.cityofberkeley.info)', async () => {
    fetchSpy.mockImplementation((input) =>
      Promise.resolve(originOf(input) === DISCOVERY_ORIGIN ? idsAnswer() : gateway403()),
    );

    const { error, text } = errorOf(
      await runToolContract(getDataset, {
        domain: 'data.cityofberkeley.info',
        dataset_id: 'zzzz-9999',
      }),
    );

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'not_found',
      domain: 'data.cityofberkeley.info',
      dataset_id: 'zzzz-9999',
    });
    expect(error.message).toContain('HTTP 403');
    expect(error.data.recovery?.hint).toMatch(/^The ID may belong to a different portal/);
    expect(text).toContain('reason not_found');
    expect(text).toContain('HTTP 403');
    expect(text).not.toContain('Web Page Blocked');
    expect(sodaCalls()).toHaveLength(1);
  });

  it('the dataset resource and socrata_get_dataset agree on the same off-host and same-host answers', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(opengov()));
    const oxnard = datasetResource.params!.parse({
      domain: 'data.oxnard.org',
      datasetId: 'zzzz-9999',
    });
    await expect(datasetResource.handler(oxnard, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'unknown_domain', redirectedTo: 'oxnardca.opengov.com' },
    });

    fetchSpy.mockImplementation((input) =>
      Promise.resolve(originOf(input) === DISCOVERY_ORIGIN ? idsAnswer() : json({ columns: [] })),
    );
    const sameHost = datasetResource.params!.parse({
      domain: 'data.cdc.gov',
      datasetId: 'zzzz-9999',
    });
    await expect(datasetResource.handler(sameHost, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'Dataset zzzz-9999 not found on data.cdc.gov.',
      data: { reason: 'not_found', domain: 'data.cdc.gov', dataset_id: 'zzzz-9999' },
    });
    const { error } = errorOf(
      await runToolContract(getDataset, { domain: 'data.cdc.gov', dataset_id: 'zzzz-9999' }),
    );
    expect(error.data.reason).toBe('not_found');
  });

  it('socrata_get_dataset still follows data.sfgov.org → data.sf.gov to a real dataset (regression)', async () => {
    fetchSpy.mockImplementation(() => {
      const res = json({
        id: 'wg3w-h783',
        name: 'Police Department Incident Reports',
        columns: [],
      });
      Object.defineProperty(res, 'url', { value: 'https://data.sf.gov/api/views/wg3w-h783.json' });
      return Promise.resolve(res);
    });

    const result = await runToolContract(getDataset, {
      domain: 'data.sfgov.org',
      dataset_id: 'wg3w-h783',
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { name: string }).name).toBe(
      'Police Department Incident Reports',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
