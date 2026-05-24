<div align="center">
  <h1>@cyanheads/socrata-mcp-server</h1>
  <p><b>Search and query government open-data portals (Socrata SODA API) via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/socrata-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/%40cyanheads%2Fsocrata-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/socrata-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/socrata-mcp-server/releases/latest/download/socrata-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=socrata-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc29jcmF0YS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22socrata-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fsocrata-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Six tools covering the full Socrata workflow — portal discovery, dataset search, schema inspection, SoQL querying, and DuckDB-powered analytical SQL over large result sets:

| Tool | Description |
|:---|:---|
| `socrata_list_portals` | List known Socrata-powered government open-data portals with domain, organization name, and dataset count |
| `socrata_find_datasets` | Search for datasets across all Socrata portals or scope to one portal via the Discovery API |
| `socrata_get_dataset` | Fetch full metadata and typed column schema for a dataset by ID — required before writing SoQL queries |
| `socrata_query_dataset` | Execute a SoQL query against any dataset: search, select, where, group, having, order, with DataCanvas spillover |
| `socrata_dataframe_describe` | List registered tables in a DataCanvas session — schema, row count, column names |
| `socrata_dataframe_query` | Run SELECT-only SQL against DataCanvas tables populated by `socrata_query_dataset` |

### `socrata_list_portals`

List known Socrata-powered government open-data portals.

- Backed by the Discovery API domains catalog — hundreds of city, county, state, and federal portals
- Client-side substring filtering on domain or organization name
- Pagination (up to 200 per page) with offset
- Returns domain (pass to `socrata_find_datasets`), organization name, and dataset count
- Use this first when you don't know which portal to target

---

### `socrata_find_datasets`

Search for datasets across all Socrata portals or scope to a single portal.

- Full-text search across dataset names and descriptions
- Scope to a single portal with the `domain` parameter
- Filter by category (e.g. `["Public Safety", "Transportation"]`) and tags (e.g. `["covid19"]`)
- Asset type filtering: datasets, maps, files, calendars, stories
- Sort by relevance, page views, created date, or updated date
- Pagination (up to 100 per page) with offset
- Returns dataset IDs, names, abbreviated column previews, domains, and update timestamps
- Column names here are preview-only — call `socrata_get_dataset` for typed schema before writing queries
- Recovery hints on empty results — echoes applied filters and suggests how to broaden

---

### `socrata_get_dataset`

Fetch full metadata and column schema for a Socrata dataset by ID.

- Returns field names, Socrata data types, descriptions, row count, and licensing
- Column `data_type` determines correct WHERE clause syntax: `Number` → bare literals (`year=2023`), `Text` → single-quoted strings (`year='2023'`)
- Excludes computed region columns (`:@computed_region_*`) to reduce noise
- Per-column non-null row counts when available
- Always call this before writing a `socrata_query_dataset` query

---

### `socrata_query_dataset`

Execute a SoQL query against any dataset on any Socrata portal.

- `search` parameter for quick full-text lookup across all text columns (`$q`)
- `select`, `where`, `group`, `having`, `order` for full analytical control
- SoQL operators: `=`, `!=`, `>`, `<`, `LIKE`, `IN(...)`, `BETWEEN`, `IS NULL`, `starts_with()`, `contains()`, `AND`, `OR`, `NOT`
- Aggregation: `count(*)`, `sum()`, `avg()`, `min()`, `max()` with `group` and `having`
- Pagination up to 5000 rows per call with offset; `total_count` returned when result is truncated
- `assembled_query` in the response echoes the SoQL string for learning the syntax
- All SODA 2.1 row values are strings — geo/location columns return nested objects
- When `CANVAS_PROVIDER_TYPE=duckdb` and result hits the limit, rows spill to a DataCanvas table for SQL-based analysis

---

### `socrata_dataframe_describe`

List registered tables in a DataCanvas session.

- Shows table name, row count, and DuckDB-inferred column types for each registered table
- Only meaningful when `CANVAS_PROVIDER_TYPE=duckdb` is set
- Use after `socrata_query_dataset` spills a large result set
- Returns canvas ID for use in `socrata_dataframe_query`

---

### `socrata_dataframe_query`

Run SELECT-only SQL against DataCanvas tables populated by `socrata_query_dataset`.

- DuckDB infers types from spilled data — numeric columns that SODA returned as strings become queryable with numeric comparisons (`year > 2020`, `amount < 500`)
- SELECT-only enforcement: DDL, DML, and file-reading functions (`read_csv`, `read_parquet`) are rejected
- Up to 10,000 rows per call
- Only works when `CANVAS_PROVIDER_TYPE=duckdb` is set

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `socrata://datasets/{domain}/{datasetId}` | Fetch full metadata and column schema for a dataset by stable URI — same payload as `socrata_get_dataset` |
| Resource | `socrata://portals` | Paginated list of known Socrata portals with organization name and dataset count |
| Prompt | `explore_open_data` | Structured six-step civic data investigation workflow: find portal → discover datasets → inspect schema → query → aggregate → synthesize |

All resource data is also reachable via tools. Use the corresponding tool for agent workflows — resources are for clients that support URI-addressable data.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports
- Optional DataCanvas (DuckDB) for analytical SQL over large result sets

Socrata-specific:

- Full Socrata SODA 2.1 API integration — SoQL query builder with select, where, group, having, order, search, limit, offset
- Discovery API for cross-portal dataset search and portal catalog
- App token support (`SOCRATA_APP_TOKEN`) for higher per-IP rate limits
- Configurable default portal domain via `SOCRATA_DEFAULT_DOMAIN`
- Computed region column filtering to reduce noise in wide datasets
- DataCanvas spillover — large query results automatically register as DuckDB tables for SQL analysis

Agent-friendly output:

- Assembled SoQL string echoed in every `socrata_query_dataset` response so agents can learn and refine syntax
- Recovery hints on empty results — echoes applied filters with specific suggestions for broadening
- Column type context embedded in schema output with WHERE-clause quoting rules stated explicitly
- Per-item structured error reasons (`invalid_id`, `not_found`, `soql_error`, `rate_limited`) with actionable recovery text

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "socrata": {
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
    "socrata": {
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
    "socrata": {
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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424): `debug`, `info`, `notice`, `warning`, `error`. | `info` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas spillover for large result sets. | — |
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
