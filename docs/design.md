---
name: socrata-mcp-server
status: designed
priority: high
difficulty: medium
category: civic-data
api_docs: https://dev.socrata.com/docs/endpoints
---

# Socrata MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `socrata_find_datasets` | Cross-portal dataset discovery via the Socrata Discovery API. Searches across all Socrata-powered portals or scoped to one. Returns dataset IDs, names, column API field names, domains, and update timestamps. Use `socrata_get_dataset` to get the full column schema before querying. | `query`, `domain`, `categories`, `tags`, `only`, `order`, `limit`, `offset` | `readOnlyHint`, `openWorldHint` |
| `socrata_get_dataset` | Fetch full metadata and column schema for a dataset by ID. Returns field names, data types, descriptions, row count, and licensing. | `domain`, `dataset_id` | `readOnlyHint` |
| `socrata_query_dataset` | Execute a SoQL query against any dataset on any Socrata portal. Convenience `search` param for full-text; structured `select`, `where`, `group`, `having`, `order` for full control. Returns rows plus the assembled SoQL string. Clauses reference columns by API field name. All row values are strings in SODA 2.1 — numeric columns require bare literals in `where`, text columns require single-quoted strings. | `domain`, `dataset_id`, `search`, `select`, `where`, `group`, `having`, `order`, `limit`, `offset`, `canvas_id`, `table_name` | `readOnlyHint`, `openWorldHint: false` |
| `socrata_list_portals` | List known Socrata-powered portals with their domain, organization, and dataset count. Backed by a curated portal list with live Discovery counts. | `query`, `limit`, `offset` | `readOnlyHint`, `openWorldHint: false` |
| `socrata_dataframe_query` | Run SQL against a previously registered DataCanvas table. Use after `socrata_query_dataset` spills a large result set to canvas. | `canvas_id`, `sql`, `limit` | `readOnlyHint` |
| `socrata_dataframe_describe` | List registered tables in a DataCanvas — schema, row count, column names. Shows what datasets are available for SQL queries. | `canvas_id` | `readOnlyHint` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `socrata://datasets/{domain}/{datasetId}` | Dataset metadata and column schema, addressable by stable URI. Same payload as `socrata_get_dataset`. | No |
| `socrata://portals` | List of known Socrata portals with org name and dataset count. | Limit/offset, default 50 |

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `explore_open_data` | Structured workflow for investigating a civic data question. Guides: discover relevant datasets on the right portal, inspect schemas, query for baseline data, group/aggregate for trends, synthesize findings with data-freshness caveats. | `topic`, `portal` (optional), `geography` (optional) |

---

## Overview

Wraps the [Socrata SODA API](https://dev.socrata.com/) to expose any of 200+ government open-data portals to LLMs. Portals share a common API surface (SODA 2.1 + the Discovery API), so one server covers city, county, state, and federal datasets — Seattle, Chicago, New York, the CDC, and more.

Core challenge: 10K+ datasets with heterogeneous schemas, spread across independent portals. The server provides a discovery-first workflow — find the portal and dataset, inspect the schema, then query — rather than hardcoding knowledge about any specific dataset.

Target users: civic developers, journalists, researchers, urban planners, and any agent needing government data.

**Auth**: SODA 2.1 is fully public. An optional app token (`X-App-Token` header) raises rate limits. SODA 3.0 requires mandatory auth; design targets SODA 2.1 exclusively.

---

## Requirements

- Read-only — all tools have `readOnlyHint: true`
- Multi-portal: every tool that touches dataset data accepts a `domain` param (e.g., `data.seattle.gov`); default falls back to `SOCRATA_DEFAULT_DOMAIN` env var, then `data.seattle.gov`. The service normalizes every domain to a bare lowercase hostname before building a URL (URL forms like `https://data.cdc.gov/browse` reduce to `data.cdc.gov`); a value that is still not a hostname fails as `invalid_domain` before any request
- Dataset discovery: cross-portal via the Discovery API (`api.us.socrata.com/api/catalog/v1`) and per-portal via `{domain}/api/views.json`
- Schema inspection: column names, types, descriptions before querying
- SoQL: convenience `search` shortcut + full structured-parameter escape hatch (`select`, `where`, `group`, etc.)
- Pagination: `limit`/`offset` for all list operations; DataCanvas spillover for large query results
- No API key required for SODA 2.1; optional `SOCRATA_APP_TOKEN` for higher rate limits
- Response values from SODA 2.1 are always strings, even for numeric/date columns — surfaced to agent via schema type metadata

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `SocrataService` | SODA 2.1 data API + Discovery API + per-portal catalog | All tools |

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `SOCRATA_APP_TOKEN` | No | — | Socrata app token. Free to register at any portal. Without token, requests draw from a shared throttled pool per source IP. |
| `SOCRATA_DEFAULT_DOMAIN` | No | `data.seattle.gov` | Default portal domain when `domain` is omitted from tool calls. |
| `SOCRATA_CLAMP_LIMITS` | No | `true` | Serve a `limit` above a tool's per-call cap at the cap, with a notice naming the offset that continues. `false` rejects it and restores each cap as the schema maximum. |
| `CANVAS_PROVIDER_TYPE` | No | `duckdb` | DataCanvas spillover for large query results; `none` disables it. `@duckdb/node-api` ships as a regular dependency, so no extra install is needed. |

---

## Implementation Order

1. Config (`server-config.ts`) — `SOCRATA_APP_TOKEN`, `SOCRATA_DEFAULT_DOMAIN`
2. `SocrataService` — Discovery API client, per-portal catalog client, SODA query client, retry/backoff layer
3. `socrata_find_datasets` tool
4. `socrata_get_dataset` tool
5. `socrata_query_dataset` tool (with DataCanvas spillover when enabled)
6. `socrata_list_portals` tool
7. `socrata_dataframe_query` and `socrata_dataframe_describe` tools (with a DataCanvas)
8. Resources: `socrata://datasets/{domain}/{datasetId}` and `socrata://portals`
9. `explore_open_data` prompt

Each step is independently testable.

---

## Domain Mapping

### Nouns × Operations → API Endpoints

| Noun | Operations | API |
|:-----|:-----------|:----|
| Portal | list | `GET https://api.us.socrata.com/api/catalog/v1/domains` |
| Dataset (cross-portal) | search/discover | `GET https://api.us.socrata.com/api/catalog/v1?q=...&domains=...` |
| Dataset (per-portal) | list by category/tag | `GET https://{domain}/api/views.json?category=...` |
| Dataset schema | get | `GET https://{domain}/api/views/{datasetId}.json` |
| Dataset rows | query | `GET https://{domain}/resource/{datasetId}.json?$select=...&$where=...` |
| Dataset rows | count | `GET https://{domain}/resource/{datasetId}.json?$select=count(*)` |

---

## Tool Detail

### `socrata_find_datasets`

**Input schema:**

| Field | Type | Description |
|:------|:-----|:------------|
| `query` | `string?` | Full-text search across dataset names and descriptions. |
| `domain` | `string?` | Scope to a single portal by bare hostname (e.g., `data.seattle.gov`); URL forms are reduced to the host. Omit to search all portals. |
| `categories` | `string[]?` | Filter by domain categories (e.g., `["Public Safety", "Transportation"]`). Multiple values are ORed. |
| `tags` | `string[]?` | Filter by tags (e.g., `["covid19", "permits"]`). Multiple values are ORed. |
| `only` | `enum("datasets","maps","files","calendars","stories")?` | Filter by asset type. Default: all. Usually `datasets` is what you want. |
| `order` | `enum("relevance","page_views_total","created_at","updated_at")?` | Sort order for results. Default: `relevance`. Use `updated_at` to surface recently-refreshed datasets. |
| `limit` | `number?` | Results to return. Default 10. Max 10,000 with `SOCRATA_CLAMP_LIMITS` on, but one call returns at most 100: a larger value is served as 100, with a notice naming the offset that continues. With the switch off the schema maximum is 100. |
| `offset` | `number?` | Pagination offset, below 10,000: Discovery serves only the first 10,000 matches of a search. |

**Output:** `{ results: [{ dataset_id, domain, name, description, category, tags, column_names, license, data_updated_at, view_count }] }`, with `totalCount`, `totalCountCapped?`, `effectiveQuery`, and a page `notice` as enrichment. `totalCountCapped` is `true` when `totalCount` reached Discovery's 10,000-match count ceiling, which makes it a lower bound. The `notice` covers an empty result (filters echoed, how to broaden), an `offset` past the last match (the offset to page below), and a `limit` served below the one requested when that withheld matches (the per-call cap, where paging continues, or that the page ends at match 10,000 and the search must narrow).

`dataset_id` and `domain` are the chaining IDs for `socrata_get_dataset` and `socrata_query_dataset`. `column_names` carries the Discovery API's `resource.columns_field_name` — the API field names SoQL takes (`cuisine_description`), not the display labels in `columns_name` (`CUISINE DESCRIPTION`) — with `:@computed_region_*` entries dropped to match `socrata_get_dataset`. A result without `columns_field_name` yields `[]`; labels are never a fallback. No type information — call `socrata_get_dataset` for the typed column schema before writing queries.

**Errors:**

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `result_window_exceeded` | `ValidationError` | `offset` is 10,000 or more: Discovery serves only the first 10,000 matches of a search (it answers HTTP 400 when `offset + limit` passes that). Checked before any request | Narrow the search with `domain`, `categories`, `tags`, `query`, or `only`, then page with an offset below 10,000 |
| `rate_limited` | `ServiceUnavailable` | Discovery API returned 429 | Retry after a short delay; add `SOCRATA_APP_TOKEN` for higher limits |
| `retry_deadline_exceeded` | `Timeout` | Discovery did not answer within the call's 50-second deadline (see [Upstream timing](#upstream-timing)) | Retry with a narrower search: `domain`, `categories`, `tags`, or a more specific `query` |
| `unknown_domain` | `NotFound` | Discovery answered 404 `{"error":"Domain not found: …"}` — the catalog does not index the domain | Pass a bare portal hostname, pick one from `socrata_list_portals`, or omit `domain` |
| `invalid_domain` | `ValidationError` | `domain` is not a hostname after normalization | Pass a bare portal hostname or pick one from `socrata_list_portals` |

Zero matches is not an error: the tool returns an empty `results` array with a `notice` that echoes the filters and suggests how to broaden.

---

### `socrata_get_dataset`

**Input schema:**

| Field | Type | Description |
|:------|:-----|:------------|
| `domain` | `string?` | Portal the dataset lives on, as a bare hostname; URL forms are reduced to the host. Defaults to `SOCRATA_DEFAULT_DOMAIN`, which is wrong for another portal's ID. |
| `dataset_id` | `string` | Four-by-four dataset ID matching `/[a-z0-9]{4}-[a-z0-9]{4}/` (e.g., `kzjm-xkqj`). Portal-scoped: obtain from `socrata_find_datasets` together with that result's `domain`. |

**Output:** `{ dataset_id, domain, name, description, category, tags, rowCount, dataUpdatedAt, license, columns: [{ fieldName, dataType, description, nonNullCount? }] }`.

Key column fields from the `api/views/{id}.json` response: `fieldName`, `dataTypeName`, `description`, `renderTypeName`, `cachedContents.non_null` (for `nonNullCount`). Computed region columns (prefix `:@computed_region_`) are filtered from the column list to reduce noise.

**Errors:**

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `invalid_id` | `ValidationError` | ID doesn't match `[a-z0-9]{4}-[a-z0-9]{4}` | Check the ID from `socrata_find_datasets` — dataset IDs are always 9 characters like `kzjm-xkqj` |
| `not_found` | `NotFound` | Valid format but no such dataset on the domain queried (see [Upstream failure classification](#upstream-failure-classification)). Message: `Dataset <id> not found on <domain>.`; `error.data` carries `domain` and `dataset_id` | Leads with the portal mismatch: retry with the `domain` from the same `socrata_find_datasets` result. When a best-effort Discovery `?ids=` lookup places the ID on another portal (`data.found_on_domain`), the hint names it: `<id> is on <portal> — retry with domain "<portal>".` |
| `unknown_domain` | `NotFound` | The domain does not serve the Socrata API to this server (see [Upstream failure classification](#upstream-failure-classification)). Fails on the first attempt | Check the hostname for typos; pass a bare portal hostname or pick one from `socrata_list_portals` |
| `invalid_domain` | `ValidationError` | `domain` is not a hostname after normalization | Pass a bare portal hostname or pick one from `socrata_list_portals` |
| `rate_limited` | `ServiceUnavailable` | 429 from the SODA views endpoint, whatever the body; the upstream `Retry-After` rides on `data.retryAfter` | Retry after delay; set `SOCRATA_APP_TOKEN` for higher per-IP limit |
| `retry_deadline_exceeded` | `Timeout` | The portal did not answer within the call's 50-second deadline, retries included (see [Upstream timing](#upstream-timing)) | Retry the same call shortly; a repeated timeout points to a degraded portal |

The Discovery lookup runs only on a `not_found`, makes one attempt under its own 2.5 s timeout capped by what is left of the call's deadline (outside the retry loop), and on any failure leaves the original `not_found` unchanged. An ID Discovery reports under the queried domain or a known catalog alias of it (`kzjm-xkqj` → `cos-data.seattle.gov` for `data.seattle.gov`) is not a mismatch.

---

### `socrata_query_dataset`

**Input schema:**

| Field | Type | Description |
|:------|:-----|:------------|
| `domain` | `string?` | Portal the dataset lives on, as a bare hostname; URL forms are reduced to the host. Defaults to `SOCRATA_DEFAULT_DOMAIN`, which is wrong for another portal's ID. The output `domain` is the normalized host. |
| `dataset_id` | `string` | Four-by-four dataset ID. Portal-scoped: obtain from `socrata_find_datasets` together with that result's `domain`. |
| `search` | `string?` | Convenience full-text search across all text columns (`$q`). For field-specific filtering, use `where` instead. |
| `select` | `string?` | SoQL SELECT clause — API field names (`field_name` from `socrata_get_dataset`, not display labels), aliases, aggregates: `"state, sum(deaths) as total_deaths"`. Omit for all columns. |
| `where` | `string?` | SoQL WHERE clause over API field names. An unquoted text value is read as a column name. String literal quoting depends on column type: `Number`-typed columns accept bare literals (`year=2020`), `Text`-typed columns require single-quoted strings (`year='2020'`). Check `data_type` from `socrata_get_dataset` first. Supports `=`, `!=`, `>`, `<`, `LIKE`, `IN(...)`, `BETWEEN`, `IS NULL`, `starts_with()`, `contains()`, `AND`, `OR`, `NOT`. |
| `group` | `string?` | SoQL GROUP BY clause over API field names. Requires aggregate in `select`. |
| `having` | `string?` | SoQL HAVING clause. Filters on aggregated results. |
| `order` | `string?` | SoQL ORDER BY over API field names or `select` aliases: `"total_deaths DESC"`. |
| `limit` | `number?` | Max rows (default 100). Max 50,000 with `SOCRATA_CLAMP_LIMITS` on, but one call returns at most 5,000: a larger value is served as 5,000, with a notice naming the offset that continues. With the switch off the schema maximum is 5,000. Use with `offset` for pagination. With a canvas, a page that fills `limit` with more rows matching stages up to 50,000 matching rows whatever `limit` is — a small `limit` stages a large match without a large inline page. |
| `offset` | `number?` | Row offset for pagination. |
| `canvas_id` | `string?` | DataCanvas token. When the server has a canvas and more rows match past the page, up to 50,000 matching rows spill to a canvas table regardless of `limit`. Omit to mint new canvas. |
| `table_name` | `string?` | Name for the staged table: letters, digits, and underscores, starting with a letter or underscore, 63 characters at most; lowercased, and not a SQL keyword. Defaults to a name derived from `dataset_id`. A spill under a name the canvas already holds replaces that table. A named call that stages nothing (the whole match fits the page, or the server has no canvas) says so in `notice`. |

**Output:** `{ rows: [object], rowCount, totalCount?, assembledQuery, domain, dataset_id, canvas_id?, canvas_row_count?, table_name? }`.

- `totalCount` counts the query as written, in the unit of `rows`: source rows for a plain query, groups for a grouped query, distinct values for a distinct select. It comes from a bounded recount (see the Design Decisions row), which runs when the page fills `limit` or comes back empty past `offset` 0, and is reported when the match holds more rows than the response. It is absent when the response holds the whole match, and when the recount failed or ran past its bound.
- `truncated` (with the paging `notice`) is set only when `totalCount > offset + rowCount`, or when the page fills `limit` and no count exists. A limit served below the one requested names both and the offset that continues.
- An empty page at `offset > 0` gets a past-the-end `notice` naming the match size when it is known, and a may-be-past-the-end `notice` when the recount failed.
- `canvas_id` and `table_name` are included when results spilled to a DataCanvas table. The spill fires when more rows match past the page and stages the matching set in **one SODA request** (`$limit=50000`, the caller's clauses and `$offset`, no tiebreaker order) into a **bounded copy** — up to 50,000 rows whatever `limit` was, reported in `canvas_row_count` — and `socrata_dataframe_query` runs SQL over that staged copy, with `table_name` as the `FROM` target. When `total_count` exceeds the cap the canvas holds a subset, not the literal full result set; page with `offset` to reach rows beyond it. The inline `rows` stay bounded by the served limit. Socrata system columns (`:@computed_region_*`) are excluded from the spilled table — they are not valid canvas identifiers; the inline `rows` keep them. On a spill the truncation `notice` names the table, `socrata_dataframe_describe`, and `socrata_dataframe_query`, and reports a table of the same name it replaced and that table's previous row count; without a spill it gives paging guidance.
- Staging is best-effort. When the staging request fails or the call's deadline cuts it off, the call still succeeds with its inline rows and no `canvas_id`, and the `notice` says why nothing was staged. Caller cancellation fails the call.
- The spilled table is typed from the `X-SODA2-Fields` / `X-SODA2-Types` headers of the query response: SODA `number` fields (aggregate aliases such as `count(*) as n` included) register as `DOUBLE`, so `year > 2020` works without a cast. Every other column keeps the type inferred over all staged rows — `boolean` → `BOOLEAN`, geo objects → `JSON`, `text` and `floating_timestamp` → `VARCHAR`. Timestamps stay `VARCHAR` because the canvas appender reads offset-less ISO strings as host-local time; `CAST(date AS TIMESTAMP)` keeps the wall-clock value. A header field null in every staged row still gets a column. When the headers are missing or do not pair up, the spill registers with inferred types and logs a warning. `DOUBLE` holds about 15–17 significant digits, so a longer `number` value rounds on the canvas while the inline `rows` keep the exact string.

**SODA 2.1 quirks surfaced in output:**
- All row values are strings in SODA 2.1 — even numeric columns. The column schema (`socrata_get_dataset`) is the source of truth for types; numeric parsing happens only when the caller needs it. The canvas spill is the exception: its `number` columns are `DOUBLE`.
- Computed region columns (`:@computed_region_*`) are excluded unless explicitly selected.

**Tip in description** (not in output): To enumerate distinct values for a column, use `select: "col, count(*) as n"` + `group: "col"` + `order: "n DESC"`.

**Errors:**

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `invalid_id` | `ValidationError` | Dataset ID malformed | Fix the ID — obtain from `socrata_find_datasets` |
| `not_found` | `NotFound` | No such dataset on the domain queried (same classification and shape as `socrata_get_dataset`) | Same as `socrata_get_dataset`: portal mismatch first, naming the holding portal when Discovery knows it |
| `unknown_domain` | `NotFound` | The domain does not serve the Socrata API to this server (same classification as `socrata_get_dataset`) | Check the hostname for typos; pass a bare portal hostname or pick one from `socrata_list_portals` |
| `not_tabular` | `ValidationError` | SODA identifies a non-tabular asset without row access | Find a queryable table with `socrata_find_datasets` and `only: "datasets"` |
| `query_rejected` | `ValidationError` | A gateway refused query clauses but accepted a bare row diagnostic | Simplify the query; use SoQL `case(condition, value, true, fallback)` for conditional aggregates |
| `invalid_domain` | `ValidationError` | `domain` is not a hostname after normalization | Pass a bare portal hostname or pick one from `socrata_list_portals` |
| `soql_error` | `ValidationError` | Any 400 with a SODA error body. `data.socrataCode` carries the upstream code (`code` from the compiler, `errorCode` from the query coordinator) and `data.column` the offending token when upstream names one. The message drops the coordinator's `; position: Map(…)` echo of the expanded SELECT. A 400 without a SODA body stays a generic `InvalidParams` | Chosen per code in the handler: `query.compiler.malformed` → use API field names (a display label with a space never parses), then check quoting; `query.soql.no-such-column` → name the token, and either use its `field_name` or single-quote it as a text value; `query.soql.type-mismatch` → the quoting rule (`year='2020'` for Text, `year=2020` for Number); any other code → the declared generic recovery |
| `rate_limited` | `ServiceUnavailable` | 429 from SODA endpoint, whatever the body. The service error keeps the upstream `Retry-After` on `data.retryAfter`, and the retry loop waits that long instead of backing off exponentially | Retry after delay; set `SOCRATA_APP_TOKEN` for higher per-IP limit |
| `retry_deadline_exceeded` | `Timeout` | The portal did not answer the query within the call's 50-second deadline, retries included (see [Upstream timing](#upstream-timing)) | Make the query cheaper, then retry: a narrower `where`, a smaller `limit`, or no `order` (sorting a large dataset is slow) |

---

### `socrata_list_portals`

**Input schema:**

| Field | Type | Description |
|:------|:-----|:------------|
| `query` | `string?` | Filter portal names/org names by keyword. Client-side substring match — the domains endpoint has no server-side text filter. |
| `limit` | `number?` | Max portals to return. Default 50, max 200. |
| `offset` | `number?` | Pagination offset. |

**Output:** `{ portals: [{ domain, organization, datasetCount }], totalCount }`.

Backed by a curated list of 39 known portals (the Discovery `/domains` listing endpoint returns 404). Per-portal dataset counts come from one Discovery `?domains=<domain>&search_context=<domain>&only=dataset&limit=0` query per portal — the same portal scope `socrata_find_datasets` uses, so federated catalogs count (Austin, Illinois, Mesa, San Francisco) and Seattle's alias join counts `cos-data.seattle.gov` — cached ~24 hours. Filtering and pagination are applied client-side.

**Errors:** none declared. A failed count, or one the call's 50-second deadline cuts off, degrades that portal to `datasetCount: null` and leaves the cache due for the next call; the listing itself cannot fail on an upstream error. An empty page at `offset > 0` gets a `notice` naming the offset to page below.

---

### `socrata_dataframe_query` and `socrata_dataframe_describe`

Available when the server has a DataCanvas (`CANVAS_PROVIDER_TYPE=duckdb`, the default). Follow the DataCanvas patterns from the `api-canvas` skill.

**`socrata_dataframe_query` inputs:** `canvas_id` (string, required), `sql` (string, SELECT-only SQL), `limit` (number?, default 1000; max 50,000 with `SOCRATA_CLAMP_LIMITS` on, 10,000 with it off). One call returns at most 10,000 rows, the DataCanvas default row limit, above which the provider rejects a query outright: a larger `limit` is served as 10,000. The tool takes no `offset`, so when more rows match, the `notice` gives the SQL paging recipe — `ORDER BY` a unique column (`ORDER BY ALL` when none is unique), `LIMIT 10000`, `OFFSET` raised by 10,000 per call.

**`socrata_dataframe_query` output:** `{ rows: [object], rowCount, sql }`. In `content[]` the `**SQL:**` echo is a code span, or a fenced `sql` block when the SQL spans lines; `structuredContent` carries it unchanged. Note: SODA `number` columns are staged as `DOUBLE` (see the `socrata_query_dataset` spill note), so numeric comparisons work without a cast; text and timestamp columns are `VARCHAR` — compare times with `CAST(date AS TIMESTAMP)`.

**`socrata_dataframe_describe` inputs:** `canvas_id` (string, optional in the schema, but required in practice when canvas is enabled — canvases cannot be enumerated, so omitting it fails with `canvas_id_required` instead of listing tables).

**`socrata_dataframe_describe` output:** `{ tables: [{ table_id, row_count, columns: [{ name, type }] }], canvas_id? }`. No registration time: the canvas `TableInfo` does not carry one.

**Errors** (both tools): `canvas_not_found` / `NotFound` when the canvas_id doesn't match any active canvas — canvas tokens cannot be listed, so re-run `socrata_query_dataset` to stage a fresh canvas. `socrata_dataframe_describe` additionally throws `canvas_id_required` / `ValidationError` when canvas is enabled and `canvas_id` is omitted.

---

## Workflow Analysis

### Discovery → Inspect → Query (primary agent workflow)

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `socrata_find_datasets` | Discover datasets matching the topic; get dataset IDs and domains |
| 2 | `socrata_get_dataset` | Inspect schema — column names, types, descriptions — before writing queries |
| 3 | `socrata_query_dataset` | Execute query; optional canvas spillover for large result sets |
| 4 | `socrata_dataframe_query` | (Optional) SQL over the bounded result set spilled to canvas when enabled |

### Portal-first workflow (agent doesn't know which portal to target)

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `socrata_list_portals` | Find the right portal by city/agency name |
| 2 | `socrata_find_datasets` | Search with `domain` scoped to that portal |
| 3+ | (same as above) | |

---

## API Reference

### SoQL Quick Reference (SODA 2.1)

| Clause | Parameter | Example |
|:-------|:----------|:--------|
| Column select + aggregates | `$select` | `type, count(*) as n` |
| Row filter | `$where` | `year=2023 AND state='WA'` |
| Full-text search | `$q` | `fire emergency` |
| Group by | `$group` | `type` |
| Filter on aggregates | `$having` | `count > 100` |
| Sort | `$order` | `n DESC` |
| Pagination | `$limit`, `$offset` | `limit=100`, `offset=200` |
| Row count | `$select=count(*)` | returns `[{"count":"12345"}]` |

**Column references:** API field names (`field_name` from `socrata_get_dataset`), never display labels — a label matches only when it equals the field name up to case, and one containing a space fails to parse.

**String quoting:** Quote text values with single quotes (`state='California'`); SODA also accepts double quotes. An unquoted value is read as a column name and fails as `query.soql.no-such-column`.

**Type matching:** SODA 2.1 stores and returns all values as strings, but `$where` comparisons are typed. A `Number`-typed column accepts bare numeric literals (`year=2023`); a `Text`-typed year column requires quoted strings (`year='2023'`). Check `data_type` from `socrata_get_dataset`.

**Computed regions:** Columns prefixed `:@computed_region_` are geospatial join columns added automatically. Filter them in schema display to reduce noise.

### Discovery API Filters

`GET https://api.us.socrata.com/api/catalog/v1`

| Param | Description |
|:------|:------------|
| `q` | Full-text search |
| `domains` | Comma-separated portal domains to scope search |
| `search_context` | Portal to answer as — adds the datasets it federates from other tenants, reported under its own domain |
| `ids` | Dataset IDs to look up (used for the `not_found` holding-portal lookup) |
| `categories` | Repeated param, one per category; values are ORed (a comma-joined value matches nothing) |
| `tags` | Repeated param, one per tag; values are ORed |
| `only` | Asset type: `datasets`, `maps`, `files`, `calendars`, `stories` |
| `limit` | Page size. The tool serves at most 100 per call |
| `offset` | Pagination offset. Discovery answers HTTP 400 when `offset + limit` passes 10,000, and `resultSetSize` stops counting at 10,000 |
| `order` | Sort: `relevance`, `page_views_total`, `created_at`, `updated_at` |

### Rate Limits

| Mode | Limit |
|:-----|:------|
| No token | Throttled shared pool per source IP (undocumented exact rate) |
| With `X-App-Token` | ~1,000 requests/hour per token |
| SODA response headers | No rate-limit headers returned — implement conservative spacing (200–500ms) |

---

## Upstream failure classification

One account for `get`, `query`, the dataset resource, the canvas spill, and `find`. Every request goes through `fetchJson` inside `withRetry` (1 + 3 attempts, 500 ms base backoff, all within the call's deadline — see [Upstream timing](#upstream-timing)). A reason in the Outcome column fails on the first attempt; "retried" means it is transient and spends every attempt before surfacing, or until the deadline ends them.

| What the portal host (or Discovery) did | Outcome |
|:----------------------------------------|:--------|
| `domain` is not a hostname after normalization | `invalid_domain`, before any request |
| Portal hostname has no DNS record (`ENOTFOUND`, Bun or Node shape) | `unknown_domain` |
| `api.us.socrata.com` has no DNS record, `EAI_AGAIN`, connection reset/refused, timeout | Retried |
| 404 with a SODA error body (`code`/`errorCode`, or `error: true`, plus `message`) | `not_found` |
| 404 without a SODA error body (HTML page, empty, another platform's JSON) | `unknown_domain` |
| Discovery 404 (`{"error":"Domain not found: …"}`) | `unknown_domain` |
| 403 with a SODA body naming the app token, token configured | Token disabled for the process; the call is repeated keyless once |
| 403 with SODA's `no row or column access to non-tabular tables` message | `not_tabular`; find a queryable table with `only: "datasets"` |
| 403 with any other SODA body (private dataset, token already disabled) | Generic `Forbidden`, first attempt |
| 403 without a SODA body (a gateway page) | `not_found` carrying `status: 403`; if the Discovery ID lookup lists the ID on this same host, `unknown_domain`. For a clause-bearing row query only, a successful bare-row diagnostic instead yields `query_rejected` |
| 400 with a SODA body | `soql_error` |
| 429, any body | `rate_limited`, retried, honoring `Retry-After` |
| 5xx other than 501 | Retried (an outage on a real portal looks the same as one anywhere else) |
| 501, and any other 4xx | Generic code for the status (`httpErrorFromResponse`), first attempt — except 408 and 425, which map to `Timeout` and are retried |
| 2xx that is not JSON, after a redirect to another host | `unknown_domain` |
| 2xx that is not JSON, from the requested host | Retried (`ServiceUnavailable`) |
| 2xx JSON that is not the thing requested (`/resource` not an array; views `id` ≠ the requested ID), after a redirect to another host | `unknown_domain` |
| Same, from the requested host | Views: `not_found`; `/resource`: `unknown_domain` |

A `not_found` from `get`, `query`, or the dataset resource always runs the one-attempt Discovery `?ids=` lookup described under `socrata_get_dataset`; `unknown_domain` never does. Discovery indexes some hosts that no longer serve SODA (`data.oxnard.org`, 2 entries on 2026-09-22), so a scoped `socrata_find_datasets` can return IDs whose `socrata_get_dataset` then fails as `unknown_domain`; the catalog answer is reported as-is. The canvas staging request (`fetchStagingRows`) and the best-effort recount use the same classification but run only after the first page succeeded; a failure of either leaves the page standing (the recount omits `total_count`, staging omits `canvas_id` and says so in the `notice`), and only the caller's cancellation fails the call.

---

## Upstream timing

Every upstream request one tool call or resource read makes shares a single 50-second deadline: each request's attempts and backoffs, the Discovery `?ids=` lookup, the bare-row diagnostic, the recount, and the staging request. The deadline ends before the 60-second request timeout MCP SDK clients apply by default, so a slow portal reaches the caller as a typed error rather than a client-side timeout.

| Request | Bound |
|:--------|:------|
| Row, views, and Discovery requests | The deadline's remainder, retried only while an attempt fits |
| Discovery `?ids=` lookup, bare-row diagnostic | One attempt, `min(2.5 s, remainder)` |
| Recount | One attempt, `min(15 s, remainder)` |
| Staging request | The deadline's remainder, retried only while an attempt fits |

Expiry fails as `Timeout` (`-32004`) with `reason: retry_deadline_exceeded`, `retryable: true`, and `data.host` and `data.deadlineMs`. An expiry that follows a 429 reports `rate_limited` instead, since the portal's throttling is the cause. `retry_deadline_exceeded` is declared on `socrata_query_dataset`, `socrata_get_dataset`, and `socrata_find_datasets`; `socrata_list_portals` declares no errors and degrades unfetched counts to `null`.

---

## Design Decisions

A gateway refusal of a clause-bearing query is checked with one bare `$limit=1` row request only after Discovery confirms the dataset on the same portal. The diagnostic has its own 2.5 s timeout and no retries or recursive lookups. A successful row array proves the query was rejected, so `query_rejected` recommends simplifying the query and using SoQL `case(condition, value, true, fallback)` for conditional aggregates. A refused or inconclusive diagnostic preserves `unknown_domain` and the original gateway cause. Caller cancellation propagates through both Discovery and the diagnostic.

Canvas table names replace the dataset ID's hyphen with an underscore and append `_rows`. Digit-leading IDs additionally receive `t_` so every name is a valid SQL identifier; existing letter-leading names remain stable.

| Decision | Choice | Reasoning |
|:---------|:-------|:---------|
| SODA version | 2.1, not 3.0 | SODA 3.0 requires mandatory auth (app token for every request). 2.1 is fully public. All portals support 2.1; SODA 3.0 rollout is still in progress. |
| Multi-portal vs. single-portal | Multi-portal with `domain` param + env var default | The entire value prop is any portal. Single-portal design would just reproduce the CDC server. |
| Domain parameter strategy | Optional per-call `domain` param, defaults to `SOCRATA_DEFAULT_DOMAIN` env var | Agents that always target one portal don't need to repeat it; agents hopping portals can override per call. |
| SoQL exposure | Structured params (`select`, `where`, `group`) + `search` shortcut | Raw SoQL string would require agents to know SoQL syntax. Structured params are safer and composable. The assembled query is returned so agents can learn the pattern. |
| Dataset discovery: cross-portal vs. per-portal | Both exposed via single tool; `domain` scopes to per-portal | Cross-portal is the power move; per-portal is common. One tool handles both rather than two separate discovery tools. |
| Discovery domain aliases | Static alias map comma-joined into the `domains` filter (`data.seattle.gov` also searches `cos-data.seattle.gov`) | Some portals keep a public vanity domain for direct dataset access but index their catalog under a separate Socrata tenant, so a Discovery search scoped to the vanity domain alone returns nothing. Augmenting the filter with the known sibling (never substituting) keeps the advertised domain usable. The same join applies to the per-portal dataset count, so `socrata_list_portals` and `socrata_find_datasets` agree. A domain Discovery does not index is answered with a 404 `Domain not found`, surfaced as `unknown_domain` rather than a risky unscoped fallback. |
| Federated portal catalogs | Every portal-scoped Discovery request also sends `search_context=<domain>`; no alias entries for hub-federated portals | Many portals publish through a data-hub or internal tenant and federate the public view to their own domain, so `domains=<domain>` alone counted near zero (live 2026-09-22: `data.austintexas.gov` 0, `data.illinois.gov` 0, `data.mesaaz.gov` 18, `data.sf.gov` 4). `search_context` makes Discovery answer as the portal: it adds the federated datasets (710, 297, 321, 666) and reports them under the portal's domain, where SODA serves them. Alias entries were rejected: San Francisco's catalog sits under no tenant a `domains` filter can name, and an alias to a hub would have reported results under the hub or an internal tenant. Portals that federate nothing keep identical counts. |
| Curated portal hosts | Each `KNOWN_PORTALS` entry is the host that serves SODA without a redirect | `data.sfgov.org` 301-redirects to `data.sf.gov`; listing the canonical host means the domain callers are told to use answers directly. A member whose Discovery scope answers 404 `Domain not found` is dropped rather than listed with a permanent `null` count (`data.iowa.gov`, 2026-09-22 — its SODA endpoint is an HTML 404 too). |
| Upstream error classification | Status first, then whether the SODA API itself wrote the body; the full table is [Upstream failure classification](#upstream-failure-classification) | Socrata error bodies vary by subsystem (`{code, message}`, `{error: true, message}`, Discovery's `{error: "<message>"}`), so gating a reason on one key dropped it for the others. What separates the portal from something else answering is not a single key but whether the body is any SODA error shape: every live Socrata 404 carries one, while an HTML page, a gateway page, or another platform's JSON 404 (`catalog.data.gov`) does not. Errors are built from `httpErrorFromResponse` so the upstream `Retry-After` survives into the retry loop. |
| A 2xx is data only when it is the thing requested | `/resource` must be a JSON array; `/api/views/<id>` must carry `id === <id>` | A redirect can land anywhere: `data.oxnard.org` redirects every SODA path to an unrelated OpenGov JSON page, which read as a dataset with no name and no columns. The views API echoes the requested `id` (60 of 60 sampled assets, maps and filtered views included), so the check never rejects a real dataset, and `data.sfgov.org` → `data.sf.gov` still succeeds. The dataset resource relies on the same service check rather than a second one of its own. |
| DNS name-not-found is not transient | `ENOTFOUND` from the portal host → `unknown_domain`; every other network error keeps retrying | `withRetry` treats any non-`McpError` throw as transient, so a mistyped host retried for ~4 s. `ENOTFOUND` is DNS saying the name does not exist; `EAI_AGAIN`, resets, and timeouts can clear. Bun puts the code on the rejected error, Node's undici on `cause`; both are read. The Discovery host failing to resolve means this server is offline, so it stays transient. |
| Gateway 403s are a dataset question first | A 403 without a SODA body → `not_found`, then the Discovery ID lookup decides | `data.cityofberkeley.info` is a live portal whose gateway answers 403 for any dataset ID it does not serve and 200 for real ones, so calling the host "not a Socrata portal" would steer an agent off a working portal over a typo. The lookup already runs on `not_found`: an ID on another portal gets `found_on_domain`; a same-host ID yields `unknown_domain` unless a clause-bearing row query's bare control proves query sensitivity. |
| Cross-portal dataset IDs | `not_found` names ID + domain; one best-effort Discovery `?ids=` lookup names the holding portal | A four-by-four ID is only meaningful on its own portal, and `domain` defaults to one portal, so a foreign ID is the common `not_found`. One lookup on an already-failed path (~0.4 s, own 2.5 s timeout, no retries, failures ignored) turns "search again" into "retry on X". `domain` stays optional (see Domain parameter strategy). |
| Domain normalization | One service-level normalizer to a bare lowercase hostname; non-hostnames fail as `invalid_domain` | Callers paste the address-bar form (`https://data.cdc.gov/`), which built `https://https://…` and retried a DNS failure to exhaustion. Normalizing where each URL is built covers every tool and the resource; rejecting before the request keeps a malformed value off the retry loop. |
| Invalid `SOCRATA_APP_TOKEN` handling | Degrade to keyless + one-time `WARN`, not fail | The app token is optional and keyless is the working default, so an invalid or revoked token (including mid-run revocation) shouldn't take every call down. On a 403 invalid-token response the service disables the token for the process, warns once, and retries keyless; a corrected `.env` plus restart re-enables it. |
| Canvas spillover | On by default (`CANVAS_PROVIDER_TYPE=duckdb`; `none` disables); stages a bounded copy (up to 50,000 rows) in one SODA request | Large civic datasets have millions of rows. When canvas is enabled, the spill stages the matching set into a bounded copy (`canvas_row_count`) so `socrata_dataframe_query` runs SQL over more than one page — honestly a bounded subset, not the literal full set when the match exceeds the cap. DuckDB ships as a regular dependency, so the canvas is on by default; the `.mcpb` bundle, which ships without the DuckDB native, pins it to `none`. |
| Single-request staging | The spill is one SODA request with `$limit=50000`, the caller's clauses and `$offset`, and no tiebreaker order; no paginated draining | SODA 2.1 sets no per-request `$limit` ceiling, and it orders ties arbitrarily per request, so `$offset` pages under a non-unique order overlap and skip rows. A tiebreaker is not available either: an `:id` order breaks grouped and aggregate queries (400) and `distinct` (500). One request is both correct and cheaper. |
| Per-call deadline | Every upstream request of a call shares one 50-second deadline (retries, backoffs, lookups, recount, staging), failing as `retry_deadline_exceeded` | Retries and backoffs could carry a call past the 60-second default MCP client timeout, which the caller sees as a bare client timeout; a deadline under it returns a typed, retryable error with the host and the bound. |
| Bounded `$query`-pipe recount | `total_count` counts the query as written (groups, distinct values) with `$query=SELECT … \|> SELECT count(*) AS n`, one attempt, `min(15 s, remainder)`, run before staging; it replaces omitting the count for grouped queries | The earlier source-row count could not describe returned groups, so grouped queries had no total at all; piping the query into a count gives the figure in the unit of `rows`. A grouped or distinct recount scans every match while the limited query can stop early, so the recount is bounded and best-effort: on failure `total_count` is absent and the page stands. The earlier rule (never claim an exact count without one) still holds. |
| Limit clamp | `SOCRATA_CLAMP_LIMITS` (default on) accepts a `limit` up to a ceiling above each tool's per-call cap and serves it at the cap with a notice naming the continuing offset; off, the cap is the schema maximum | Agents ask for more than a cap in one call and got a hard rejection; serving the cap and saying where paging continues costs them no retry. The schema advertises the ceiling or the cap to match, and the switch restores strict rejection for clients that want it. |
| Caller-named staged tables | `table_name` on `socrata_query_dataset` names the staged table; a spill under a name the canvas already holds replaces that table, and the `notice` reports the replacement and the prior row count | The default name derives from the dataset ID, so several filtered extracts of one dataset on one canvas collided. A caller-chosen name with the same `canvas_id` keeps them side by side; replacement stays the behavior for a repeated name, disclosed rather than silent. |
| `socrata_list_portals` on a deadline | Keeps degraded `null` counts and declares no error contract | The curated catalog needs no upstream call to return, so a count lookup the deadline cuts off degrades to `null` and leaves the cache due rather than failing a listing that has its answer. |
| `socrata_list_portals` — client-side vs server-side filter | Client-side substring match on query | The catalog is a curated list of 39 portals with no upstream listing endpoint to filter server-side; it is small enough for in-process filtering. |
| `socrata_find_datasets` `column_names` | Discovery `columns_field_name` (SoQL identifiers), computed regions dropped; display labels not returned | The labels in `columns_name` fail as SoQL identifiers once they contain a space, and a column list an agent can paste into `select` is the point of the field. Carrying both would double the per-result payload and leave the label trap in place. |
| `soql_error` recovery | Hint chosen per upstream code in the tool handler; the service only classifies | Parse errors, unknown identifiers, and type mismatches have different fixes, and an unquoted text value surfaces as an unknown column — one static hint was wrong for two of the three. The service keeps `socrataCode` and `column`; hint text is tool-facing, so it lives with the tool's contract. |
| Computed region columns | Filtered from default schema/row output | `:@computed_region_*` columns are geospatial join artifacts added by the platform — not actual dataset data. Including them by default adds noise in schema output. Let users explicitly `$select` them if needed. |
| Row count default | 100 rows, 5000 per call | Socrata's own default is 1000 with no ceiling. 100 keeps payloads manageable for typical agent workflows. The 5000 per-call cap prevents accidentally blowing context budgets on wide datasets. |
| `totalCount` in query response | Included only when the match holds more rows than the response | When the response holds the whole match, the agent has the full set — no value adding the count. When more rows match, it's essential for pagination decisions. |
| Resources vs. tools for schema | Both: `socrata_get_dataset` tool + `socrata://datasets/{domain}/{id}` resource | Tools cover tool-only agents. Resources give injectable context for clients that support them. Same data, two access paths. |
| Prompt | Single `explore_open_data` prompt | Multi-step civic data investigations are common and benefit from procedural guidance. One prompt covers the general pattern rather than domain-specific variants. |
| SODA 3.0 | Excluded | Requires mandatory auth per request; SODA 2.1 serves the same data publicly. Revisit if SODA 3.0 becomes universal and Socrata offers unauthenticated access. |
| Geographic/geospatial tools | Excluded | GeoJSON support exists in SODA 2.1, but building dedicated geospatial query tools (bounding-box search, polygon intersection) is a separate scope. The `where` clause handles proximity via `within_box()` for agents who know SoQL; a dedicated geo tool can be added later. |
| App tools | Excluded | No MCP Apps-capable client in scope; standard tools cover all workflows. |
