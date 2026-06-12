# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-06-12

Truncation disclosure on socrata_query_dataset and socrata_dataframe_query, SQL system-catalog denial, explicit server identity; @cyanheads/mcp-ts-core ^0.9.21 → ^0.10.6

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-06-04

socrata_dataframe_describe and socrata_dataframe_query: canvas_not_found error contract now fires when canvas.acquire throws NotFound on an unknown canvas_id

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-06-02

mcp-ts-core ^0.9.21: per-request log context fix, secret stripping from error messages, withRetry fail-fast on non-retryable errors; README client-config key renamed; skills sync

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-30

Enrichment adoption: query/filter echoes, true result totals, and empty-result guidance in a typed enrichment block; removed unreachable no_results error; structuredContent key renames

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-28

mcp-ts-core ^0.9.7 → ^0.9.13: HTTP body cap (413), session-init gate, quieter 401/403/400/404 logs, GET /mcp keywords; error-code reclassifications; dep refresh

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-23

Add hosted server endpoint — remotes block in server.json, public URL in README

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-23

Description alignment, manifest fixes, package.json standardization (bun run scripts, funding block)

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-23

0.1.1 — initial public release of socrata-mcp-server: 6 tools, 2 resources, 1 prompt for querying 200+ Socrata government open-data portals via the SODA 2.1 and Discovery APIs

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-23

Initial release — Socrata SODA 2.1 and Discovery API server with 6 tools, 2 resources, and 1 prompt
