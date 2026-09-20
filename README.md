<div align="center">
  <h1>@cyanheads/socrata-mcp-server</h1>
  <p><b>Search and query government open-data portals (Socrata SODA API) via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.15-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/socrata-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/%40cyanheads%2Fsocrata-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/socrata-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/socrata-mcp-server/releases/latest/download/socrata-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=socrata-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc29jcmF0YS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22socrata-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fsocrata-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

**Public Hosted Server:** [https://socrata.caseyjhand.com/mcp](https://socrata.caseyjhand.com/mcp)

</div>

---

## Overview

Government open-data portals — searched and queried via the Socrata SODA 2.1 API and Discovery API. Discover portals and datasets, inspect typed column schemas, and run SoQL queries or DuckDB-powered SQL over large result sets, from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `socrata_list_portals` | List known Socrata-powered government open-data portals with domain, organization name, and approximate dataset count |
| `socrata_find_datasets` | Search for datasets across all Socrata portals or scope to one portal via the Discovery API |
| `socrata_get_dataset` | Fetch full metadata and typed column schema for a dataset by ID — required before writing SoQL queries |
| `socrata_query_dataset` | Execute a SoQL query against any dataset: search, select, where, group, having, order, with DataCanvas spillover |
| `socrata_dataframe_describe` | List registered tables in a DataCanvas session — schema, row count, column names |
| `socrata_dataframe_query` | Run SELECT-only SQL against DataCanvas tables populated by `socrata_query_dataset` |

### Resources

| Resource | Description |
|:---|:---|
| `socrata://datasets/{domain}/{datasetId}` | Fetch full metadata and column schema for a dataset by stable URI — same payload as `socrata_get_dataset` |
| `socrata://portals` | Paginated list of known Socrata portals with organization name and approximate dataset count |

All resource data is also reachable via tools. Use the corresponding tool for agent workflows — resources are for clients that support URI-addressable data.

### Prompts

| Prompt | Description |
|:---|:---|
| `explore_open_data` | Structured six-step civic data investigation workflow: find portal → discover datasets → inspect schema → query → aggregate → synthesize |

## Capability reference

### `socrata_list_portals` <sub>tool</sub>

- Curated catalog of 40 well-known city, county, state, and federal portals — every member verified live in the Discovery catalog
- Per-portal dataset counts fetched live from the Discovery API, cached ~24 hours (`0` means the portal exposes no dataset assets to the catalog; `null` means the count is temporarily unavailable)
- Client-side substring filtering on domain or organization name; pagination up to 200 per page with offset
- Returns domain (pass to `socrata_find_datasets`), organization name, and approximate dataset count
- Typed error: `rate_limited` (retryable) when the Discovery API returns 429

---

### `socrata_find_datasets` <sub>tool</sub>

- Full-text query across dataset names/descriptions; scope with `domain`, filter by `categories`/`tags`, restrict `only` to an asset type (datasets, maps, files, calendars, stories)
- Sort by relevance, page views, created date, or updated date; up to 100 per page with offset pagination
- Returns dataset IDs, names, domains, tags, update timestamps, and abbreviated column-name previews — call `socrata_get_dataset` for typed schema before writing queries
- Recovery hints on empty results — echoes applied filters and suggests how to broaden
- Typed error: `rate_limited` (retryable) when the Discovery API returns 429

---

### `socrata_get_dataset` <sub>tool</sub>

- Returns field names, Socrata data types, descriptions, row count (with `row_count_source` provenance), and licensing when available
- Column `data_type` determines WHERE clause syntax: `Number` → bare literals (`year=2023`), `Text` → single-quoted strings (`year='2023'`)
- Excludes computed region columns (`:@computed_region_*`) to reduce noise; includes per-column non-null counts when available
- Typed errors: `invalid_id` (malformed four-by-four ID), `not_found` (valid format, no such dataset on the domain)
- Always call before writing a `socrata_query_dataset` WHERE clause

---

### `socrata_query_dataset` <sub>tool</sub>

- `search` for quick full-text lookup (`$q`), or combine `select`/`where`/`group`/`having`/`order` for full analytical control; operators `=`, `!=`, `>`, `<`, `LIKE`, `IN(...)`, `BETWEEN`, `IS NULL`, `starts_with()`, `contains()`, `AND`, `OR`, `NOT`
- Aggregation via `count(*)`, `sum()`, `avg()`, `min()`, `max()` with `group`/`having`
- Up to 5000 rows per call with offset pagination; `total_count` returned when a plain row query is truncated (absent for grouped/aggregate queries)
- `assembled_query` echoes the SoQL string for learning the syntax; all SODA 2.1 row values are strings except geo/location columns, which return nested objects
- When `CANVAS_PROVIDER_TYPE=duckdb` and the result hits the limit, up to 50,000 matching rows spill to a DataCanvas table (`canvas_id` + `canvas_row_count`) for SQL via `socrata_dataframe_query`
- Typed errors: `invalid_id`, `not_found`, `soql_error` (bad SoQL or unknown column), `rate_limited` (retryable)

---

### `socrata_dataframe_describe` <sub>tool</sub>

- Requires `canvas_id` from a prior `socrata_query_dataset` spill — canvases cannot be enumerated, so omitting it fails with `canvas_id_required` rather than listing tables
- Shows table name, row count, and DuckDB-inferred column types for each registered table
- Only meaningful when `CANVAS_PROVIDER_TYPE=duckdb` is set
- Typed errors: `canvas_id_required`, `canvas_not_found` (expired or unknown token — re-run `socrata_query_dataset` to stage a fresh canvas)

---

### `socrata_dataframe_query` <sub>tool</sub>

- SELECT-only SQL against a `canvas_id` table staged by `socrata_query_dataset`; DDL, DML, and file-reading functions (`read_csv`, `read_parquet`) are rejected
- DuckDB infers types from spilled data — numeric columns SODA returned as strings become queryable with numeric comparisons (`year > 2020`, `amount < 500`)
- Up to 10,000 rows per call, default 1000
- Typed errors: `canvas_disabled` (`CANVAS_PROVIDER_TYPE` not set), `canvas_not_found`, `table_not_found`, `sql_rejected` (non-SELECT, system catalog access, or a denied function)
- Works out of the box when `CANVAS_PROVIDER_TYPE=duckdb` is set — DuckDB ships as a regular dependency

---

### `socrata://datasets/{domain}/{datasetId}` <sub>resource</sub>

- Returns the same payload as `socrata_get_dataset` — field names, data types, descriptions, row count, licensing
- `domain` and `datasetId` come from `socrata_find_datasets`; `datasetId` must match the four-by-four pattern (e.g. `kzjm-xkqj`)
- Fails validation on a malformed ID, and not-found when the dataset doesn't exist on the domain

---

### `socrata://portals` <sub>resource</sub>

- Curated catalog of 40 known Socrata portals, cursor-paginated (`cursor` param, default 50 per page, capped at 200)
- Returns domain, organization name, and approximate dataset count (`0` = no dataset assets, `null` = temporarily unavailable), cached ~24 hours
- Pass `domain` to `socrata_find_datasets` to scope a search to one portal

---

### `explore_open_data` <sub>prompt</sub>

- Arguments: `topic` required; `portal` and `geography` optional to skip discovery or scope WHERE clauses
- Returns one user message walking a six-step workflow: find portal → discover datasets → inspect schema → query → aggregate → synthesize

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Socrata-specific:

- Full Socrata SODA 2.1 API integration — SoQL query builder with select, where, group, having, order, search, limit, offset
- Discovery API for cross-portal dataset search and per-portal dataset counts (curated 40-portal catalog, counts cached ~24h)
- App token support (`SOCRATA_APP_TOKEN`) for higher per-IP rate limits
- Configurable default portal domain via `SOCRATA_DEFAULT_DOMAIN`
- DataCanvas spillover (DuckDB, bundled) — large query results register as SQL tables for analytical queries

Agent-friendly output:

- Assembled SoQL string echoed in every `socrata_query_dataset` response so agents can learn and refine syntax
- Recovery hints on empty results — echoes applied filters with specific suggestions for broadening
- Truncation disclosure — `truncated`/`shown`/`cap` fields when rows fill the limit, with guidance to page, raise the limit, or query the spilled canvas
- Typed error reasons across every tool (`invalid_id`, `not_found`, `soql_error`, `rate_limited`, `canvas_id_required`, `canvas_not_found`, `table_not_found`, `sql_rejected`, `canvas_disabled`) with actionable recovery text

## Getting started

Add the following to your MCP client configuration file.

### Public Hosted Instance

A public instance is available at `https://socrata.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "socrata-mcp-server": {
      "type": "streamable-http",
      "url": "https://socrata.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

```json
{
  "mcpServers": {
    "socrata-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/socrata-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "socrata-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/socrata-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "socrata-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/socrata-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Optional: A Socrata app token — register for free at any portal (e.g. [data.seattle.gov](https://data.seattle.gov)) to get higher rate limits (10 req/s per token vs. shared throttled pool without one).

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/socrata-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd socrata-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set SOCRATA_APP_TOKEN if you have one
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `SOCRATA_APP_TOKEN` | Socrata app token (X-App-Token header). Without a token, requests share a throttled pool per source IP. | — |
| `SOCRATA_DEFAULT_DOMAIN` | Default portal domain when `domain` is omitted from tool calls. | `data.seattle.gov` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | Session handling: `stateful`, `stateless`, or `auto` (schema default `auto` resolves to stateful). This server sets it explicitly to stateless. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424): `debug`, `info`, `notice`, `warning`, `error`. | `info` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas spillover for large result sets. DuckDB ships with the server — no additional install required. | — |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security audit
  bun run test       # Vitest test suite
  ```

### Docker

```sh
docker build -t socrata-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=http -p 3010:3010 socrata-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/socrata-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools, resources, prompts, and inits the Socrata service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Six tools covering portal listing, dataset search, schema fetch, SoQL query, and DataCanvas SQL. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Dataset metadata and portal catalog resources. |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). Civic data investigation workflow prompt. |
| `src/services/socrata` | Socrata service layer — SODA 2.1 API client, Discovery API, query builder, type normalization. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Call `socrata_get_dataset` before writing WHERE clauses — column `data_type` determines quoting
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
