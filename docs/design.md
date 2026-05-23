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
| `socrata_find_datasets` | Cross-portal dataset discovery via the Socrata Discovery API. Searches across all Socrata-powered portals or scoped to one. Returns dataset IDs, names, abbreviated schemas, domains, and update timestamps. Use `socrata_get_dataset` to get the full column schema before querying. | `query`, `domain`, `categories`, `tags`, `only`, `order`, `limit`, `offset` | `readOnlyHint`, `openWorldHint` |
| `socrata_get_dataset` | Fetch full metadata and column schema for a dataset by ID. Returns field names, data types, descriptions, row count, and licensing. | `domain`, `dataset_id` | `readOnlyHint` |
| `socrata_query_dataset` | Execute a SoQL query against any dataset on any Socrata portal. Convenience `search` param for full-text; structured `select`, `where`, `group`, `having`, `order` for full control. Returns rows plus the assembled SoQL string. All row values are strings in SODA 2.1 — numeric columns require bare literals in `where`, text columns require single-quoted strings. | `domain`, `dataset_id`, `search`, `select`, `where`, `group`, `having`, `order`, `limit`, `offset`, `canvas_id` | `readOnlyHint`, `openWorldHint: false` |
| `socrata_list_portals` | List known Socrata-powered portals with their domain, organization, and dataset count. Backed by the Discovery API's domain catalog. | `query`, `limit`, `offset` | `readOnlyHint`, `openWorldHint: false` |
| `socrata_dataframe_query` | Run SQL against a previously registered DataCanvas table. Use after `socrata_query_dataset` spills a large result set to canvas. | `canvas_id`, `sql`, `limit` | `readOnlyHint` |
| `socrata_dataframe_describe` | List registered tables in a DataCanvas — schema, row count, column names, registered time. Shows what datasets are available for SQL queries. | `canvas_id` | `readOnlyHint` |

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

Wraps the [Socrata SODA API](https://dev.socrata.com/) to expose any of 200+ government open-data portals to LLMs. Portals share a common API surface (SODA 2.1 + the Discovery API), so one server covers city, county, state, and federal datasets — Seattle, Chicago, New York, HHS, data.gov, and more.

Core challenge: 10K+ datasets with heterogeneous schemas, spread across independent portals. The server provides a discovery-first workflow — find the portal and dataset, inspect the schema, then query — rather than hardcoding knowledge about any specific dataset.

Target users: civic developers, journalists, researchers, urban planners, and any agent needing government data.

**Auth**: SODA 2.1 is fully public. An optional app token (`X-App-Token` header) raises rate limits. SODA 3.0 requires mandatory auth; design targets SODA 2.1 exclusively.

---

## Requirements

- Read-only — all tools have `readOnlyHint: true`
- Multi-portal: every tool that touches dataset data accepts a `domain` param (e.g., `data.seattle.gov`); default falls back to `SOCRATA_DEFAULT_DOMAIN` env var, then `data.seattle.gov`
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
| `CANVAS_PROVIDER_TYPE` | No | `none` | Set to `duckdb` to enable DataCanvas spillover for large query results. Requires `@duckdb/node-api` peer dependency. |

---

## Implementation Order

1. Config (`server-config.ts`) — `SOCRATA_APP_TOKEN`, `SOCRATA_DEFAULT_DOMAIN`
2. `SocrataService` — Discovery API client, per-portal catalog client, SODA query client, retry/backoff layer
3. `socrata_find_datasets` tool
4. `socrata_get_dataset` tool
5. `socrata_query_dataset` tool (with DataCanvas spillover when enabled)
6. `socrata_list_portals` tool
7. `socrata_dataframe_query` and `socrata_dataframe_describe` tools (when `CANVAS_PROVIDER_TYPE=duckdb`)
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
| `domain` | `string?` | Scope to a single portal (e.g., `data.seattle.gov`). Omit to search all portals. |
| `categories` | `string[]?` | Filter by domain categories (e.g., `["Public Safety", "Transportation"]`). |
| `tags` | `string[]?` | Filter by tags (e.g., `["covid19", "permits"]`). |
| `only` | `enum("datasets","maps","files","calendars","stories")?` | Filter by asset type. Default: all. Usually `datasets` is what you want. |
| `order` | `enum("relevance","page_views_total","created_at","updated_at")?` | Sort order for results. Default: `relevance`. Use `updated_at` to surface recently-refreshed datasets. |
| `limit` | `number?` | Results to return. Default 10, max 100. |
| `offset` | `number?` | Pagination offset. |

**Output:** `{ results: [{ dataset_id, domain, name, description, category, tags, columnNames, license, dataUpdatedAt, viewCount }], totalCount, query }`.

`dataset_id` and `domain` are the chaining IDs for `socrata_get_dataset` and `socrata_query_dataset`. `columnNames` are included as a preview from the Discovery API response — they do not include type information; call `socrata_get_dataset` for typed column schema before writing queries.

**Errors:**

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `no_results` | `NotFound` | Query returned 0 results | Broaden search terms, remove category/tag filters, or try without a domain constraint |
| `rate_limited` | `ServiceUnavailable` | Discovery API returned 429 | Retry after a short delay; add `SOCRATA_APP_TOKEN` for higher limits |

---

### `socrata_get_dataset`

**Input schema:**

| Field | Type | Description |
|:------|:-----|:------------|
| `domain` | `string?` | Portal domain. Defaults to `SOCRATA_DEFAULT_DOMAIN`. |
| `dataset_id` | `string` | Four-by-four dataset ID matching `/[a-z0-9]{4}-[a-z0-9]{4}/` (e.g., `kzjm-xkqj`). Obtain from `socrata_find_datasets`. |

**Output:** `{ dataset_id, domain, name, description, category, tags, rowCount, dataUpdatedAt, license, columns: [{ fieldName, dataType, description, nonNullCount? }] }`.

Key column fields from the `api/views/{id}.json` response: `fieldName`, `dataTypeName`, `description`, `renderTypeName`, `cachedContents.non_null` (for `nonNullCount`). Computed region columns (prefix `:@computed_region_`) are filtered from the column list to reduce noise.

**Errors:**

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `invalid_id` | `InvalidParams` | ID doesn't match `[a-z0-9]{4}-[a-z0-9]{4}` | Check the ID from `socrata_find_datasets` — dataset IDs are always 9 characters like `kzjm-xkqj` |
| `not_found` | `NotFound` | Valid format but dataset doesn't exist or was removed | Search again with `socrata_find_datasets` — the dataset may have been retired or replaced |

---

### `socrata_query_dataset`

**Input schema:**

| Field | Type | Description |
|:------|:-----|:------------|
| `domain` | `string?` | Portal domain. Defaults to `SOCRATA_DEFAULT_DOMAIN`. |
| `dataset_id` | `string` | Four-by-four dataset ID. |
| `search` | `string?` | Convenience full-text search across all text columns (`$q`). For field-specific filtering, use `where` instead. |
| `select` | `string?` | SoQL SELECT clause — column names, aliases, aggregates: `"state, sum(deaths) as total_deaths"`. Omit for all columns. |
| `where` | `string?` | SoQL WHERE clause. String literal quoting depends on column type: `Number`-typed columns accept bare literals (`year=2020`), `Text`-typed columns require single-quoted strings (`year='2020'`). Check `dataType` from `socrata_get_dataset` first. Supports `=`, `!=`, `>`, `<`, `LIKE`, `IN(...)`, `BETWEEN`, `IS NULL`, `starts_with()`, `contains()`, `AND`, `OR`, `NOT`. |
| `group` | `string?` | SoQL GROUP BY clause. Requires aggregate in `select`. |
| `having` | `string?` | SoQL HAVING clause. Filters on aggregated results. |
| `order` | `string?` | SoQL ORDER BY: `"total_deaths DESC"`. |
| `limit` | `number?` | Max rows (default 100, max 5000). Use with `offset` for pagination. |
| `offset` | `number?` | Row offset for pagination. |
| `canvas_id` | `string?` | DataCanvas token. When `CANVAS_PROVIDER_TYPE=duckdb`, results spill to canvas when rows exceed preview size. Omit to mint new canvas. |

**Output:** `{ rows: [object], rowCount, totalCount?, assembledQuery, domain, dataset_id, canvas_id? }`.

- `totalCount` is included when the result set is truncated (`rowCount < totalCount`) so the agent knows to paginate or narrow the query.
- `canvasId` is included when results spilled to a DataCanvas table (requires `CANVAS_PROVIDER_TYPE=duckdb`). Use with `socrata_dataframe_query` to run SQL against the full result set.

**SODA 2.1 quirks surfaced in output:**
- All row values are strings in SODA 2.1 — even numeric columns. The column schema (`socrata_get_dataset`) is the source of truth for types; numeric parsing happens only when the caller needs it.
- Computed region columns (`:@computed_region_*`) are excluded unless explicitly selected.

**Tip in description** (not in output): To enumerate distinct values for a column, use `select: "col, count(*) as n"` + `group: "col"` + `order: "n DESC"`.

**Errors:**

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `invalid_id` | `InvalidParams` | Dataset ID malformed | Fix the ID — obtain from `socrata_find_datasets` |
| `not_found` | `NotFound` | Dataset doesn't exist on this domain | Search again with `socrata_find_datasets` |
| `soql_error` | `InvalidParams` | SoQL syntax error or unknown column — Socrata returns `errorCode: "query.soql.no-such-column"` or similar | Check column names via `socrata_get_dataset`, fix single-quote quoting for string literals, match type to value (text year: `year='2020'`, numeric year: `year=2020`) |
| `rate_limited` | `ServiceUnavailable` | 429 from SODA endpoint | Retry after delay; set `SOCRATA_APP_TOKEN` for higher per-IP limit |

---

### `socrata_list_portals`

**Input schema:**

| Field | Type | Description |
|:------|:-----|:------------|
| `query` | `string?` | Filter portal names/org names by keyword. Client-side substring match — the domains endpoint has no server-side text filter. |
| `limit` | `number?` | Max portals to return. Default 50, max 200. |
| `offset` | `number?` | Pagination offset. |

**Output:** `{ portals: [{ domain, organization, datasetCount }], totalCount }`.

Backed by `GET https://api.us.socrata.com/api/catalog/v1/domains`. Returns all known portals (a few hundred entries); filtering and pagination are applied client-side.

**Errors:**

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `rate_limited` | `ServiceUnavailable` | Discovery API returned 429 | Retry after a short delay; add `SOCRATA_APP_TOKEN` for higher limits |

---

### `socrata_dataframe_query` and `socrata_dataframe_describe`

Only meaningful when `CANVAS_PROVIDER_TYPE=duckdb`. Follow the DataCanvas patterns from the `api-canvas` skill.

**`socrata_dataframe_query` inputs:** `canvas_id` (string, required), `sql` (string, SELECT-only SQL), `limit` (number?, default 1000).

**`socrata_dataframe_query` output:** `{ rows: [object], rowCount, sql }`. Note: DuckDB infers types from the spilled data — numeric columns that SODA returned as strings are queryable with numeric comparisons after spillover.

**`socrata_dataframe_describe` inputs:** `canvas_id` (string, optional — omit to list all tables in the session).

**`socrata_dataframe_describe` output:** `{ tables: [{ tableId, rowCount, columns: [{ name, type }], registeredAt }] }`.

**Errors** (both tools): `canvas_not_found` / `InvalidParams` when the canvas_id doesn't match any registered table — use `socrata_dataframe_describe` to list active tables.

---

## Workflow Analysis

### Discovery → Inspect → Query (primary agent workflow)

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `socrata_find_datasets` | Discover datasets matching the topic; get dataset IDs and domains |
| 2 | `socrata_get_dataset` | Inspect schema — column names, types, descriptions — before writing queries |
| 3 | `socrata_query_dataset` | Execute query; optional canvas spillover for large result sets |
| 4 | `socrata_dataframe_query` | (Optional) SQL over full spilled result set when canvas is enabled |

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

**String quoting:** Single-quotes only (`state='California'`). Double-quotes are not SoQL strings.

**Type matching:** SODA 2.1 stores and returns all values as strings, but `$where` comparisons are typed. A `Number`-typed column accepts bare numeric literals (`year=2023`); a `Text`-typed year column requires quoted strings (`year='2023'`). Check `dataTypeName` from `socrata_get_dataset`.

**Computed regions:** Columns prefixed `:@computed_region_` are geospatial join columns added automatically. Filter them in schema display to reduce noise.

### Discovery API Filters

`GET https://api.us.socrata.com/api/catalog/v1`

| Param | Description |
|:------|:------------|
| `q` | Full-text search |
| `domains` | Comma-separated portal domains to scope search |
| `categories` | Comma-separated category names |
| `tags` | Comma-separated tag values |
| `only` | Asset type: `datasets`, `maps`, `files`, `calendars`, `stories` |
| `limit` | Page size (max 100) |
| `offset` | Pagination offset |
| `order` | Sort: `relevance`, `page_views_total`, `created_at`, `updated_at` |

### Rate Limits

| Mode | Limit |
|:-----|:------|
| No token | Throttled shared pool per source IP (undocumented exact rate) |
| With `X-App-Token` | ~1,000 requests/hour per token |
| SODA response headers | No rate-limit headers returned — implement conservative spacing (200–500ms) |

---

## Design Decisions

| Decision | Choice | Reasoning |
|:---------|:-------|:---------|
| SODA version | 2.1, not 3.0 | SODA 3.0 requires mandatory auth (app token for every request). 2.1 is fully public. All portals support 2.1; SODA 3.0 rollout is still in progress. |
| Multi-portal vs. single-portal | Multi-portal with `domain` param + env var default | The entire value prop is any portal. Single-portal design would just reproduce the CDC server. |
| Domain parameter strategy | Optional per-call `domain` param, defaults to `SOCRATA_DEFAULT_DOMAIN` env var | Agents that always target one portal don't need to repeat it; agents hopping portals can override per call. |
| SoQL exposure | Structured params (`select`, `where`, `group`) + `search` shortcut | Raw SoQL string would require agents to know SoQL syntax. Structured params are safer and composable. The assembled query is returned so agents can learn the pattern. |
| Dataset discovery: cross-portal vs. per-portal | Both exposed via single tool; `domain` scopes to per-portal | Cross-portal is the power move; per-portal is common. One tool handles both rather than two separate discovery tools. |
| Canvas spillover | Opt-in via `CANVAS_PROVIDER_TYPE=duckdb` | Large civic datasets can have millions of rows — the 5000-row cap is a hard stop without canvas. Canvas is DuckDB-backed, so it's not suitable for all deployment contexts. Keep it opt-in, not default. |
| `socrata_list_portals` — client-side vs server-side filter | Client-side substring match on query | The domains endpoint returns the full list (a few hundred entries); no server-side text filter exists. The list is small enough for in-process filtering. |
| Computed region columns | Filtered from default schema/row output | `:@computed_region_*` columns are geospatial join artifacts added by the platform — not actual dataset data. Including them by default adds noise in schema output. Let users explicitly `$select` them if needed. |
| Row count default | 100 rows, max 5000 | Socrata's own default is 1000 with no ceiling. 100 keeps payloads manageable for typical agent workflows. 5000 cap prevents accidentally blowing context budgets on wide datasets. |
| `totalCount` in query response | Included only when result is truncated | When `rowCount == totalCount`, the agent has the full set — no value adding the count. When truncated, it's essential for pagination decisions. |
| Resources vs. tools for schema | Both: `socrata_get_dataset` tool + `socrata://datasets/{domain}/{id}` resource | Tools cover tool-only agents. Resources give injectable context for clients that support them. Same data, two access paths. |
| Prompt | Single `explore_open_data` prompt | Multi-step civic data investigations are common and benefit from procedural guidance. One prompt covers the general pattern rather than domain-specific variants. |
| SODA 3.0 | Excluded | Requires mandatory auth per request; SODA 2.1 serves the same data publicly. Revisit if SODA 3.0 becomes universal and Socrata offers unauthenticated access. |
| Geographic/geospatial tools | Excluded | GeoJSON support exists in SODA 2.1, but building dedicated geospatial query tools (bounding-box search, polygon intersection) is a separate scope. The `where` clause handles proximity via `within_box()` for agents who know SoQL; a dedicated geo tool can be added later. |
| App tools | Excluded | No MCP Apps-capable client in scope; standard tools cover all workflows. |
