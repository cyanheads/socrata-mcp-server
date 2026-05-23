# socrata-mcp-server — Idea

MCP server wrapping the Socrata SODA API — the open data platform used by hundreds of government portals (cities, counties, states, federal agencies). Connects to any Socrata-powered portal (data.seattle.gov, data.kingcounty.gov, data.cityofchicago.org, data.ny.gov, etc.).

## Why

- 200+ government portals, 10K+ datasets — civic devs, journalists, researchers, urban planners
- Same API surface everywhere (SoQL query language)
- Free, no key required for SODA 2.x reads (optional app token for higher rate limits)
- Seattle hometown angle: data.seattle.gov as the default/demo portal, but universal reach
- No existing MCP server covers this platform

## API

- **Base pattern**: `https://{domain}/resource/{dataset-id}.json`
- **Query language**: SoQL — `$select`, `$where`, `$limit`, `$offset`, `$order`, `$group`, `$q` (full-text)
- **Catalog/discovery**: `https://api.us.socrata.com/api/catalog/v1` (cross-portal search)
- **Per-portal catalog**: `https://{domain}/api/views.json`
- **Auth**: Optional app token via `X-App-Token` header (1K req/hr with token, throttled without)
- **Format**: JSON, CSV, GeoJSON
- **Rate limits**: 1K requests/hour per app token; unauthenticated requests share a throttled pool

## Scope

- Read-only (public data queries)
- Multi-portal: connect to any Socrata domain
- Dataset discovery, metadata inspection, data querying
- SoQL query construction and execution

## Licensing

- No platform-level prohibition on proxying; Socrata dev docs encourage building apps on SODA
- Data licensing is per-dataset/per-portal (common: public domain, CC0, CC BY)
- SODA3 endpoints require auth — design for app token pass-through

## Prior art in the ecosystem

- CDC server already uses Socrata SODA API (data.cdc.gov) — reusable SoQL patterns
