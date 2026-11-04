#!/usr/bin/env node
/**
 * @fileoverview socrata-mcp-server MCP server entry point.
 * Wraps the Socrata SODA 2.1 API and Discovery API for government open-data access.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { normalizeEnv } from '@cyanheads/mcp-ts-core/config';
import { getServerConfig, preloadEnvFile } from './config/server-config.js';
import { exploreOpenData } from './mcp-server/prompts/definitions/explore-open-data.prompt.js';
import { datasetResource } from './mcp-server/resources/definitions/dataset.resource.js';
import { portalsResource } from './mcp-server/resources/definitions/portals.resource.js';
import { dataframeDescribe } from './mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDrop } from './mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQuery } from './mcp-server/tools/definitions/dataframe-query.tool.js';
import { findDatasets } from './mcp-server/tools/definitions/find-datasets.tool.js';
import { getDataset } from './mcp-server/tools/definitions/get-dataset.tool.js';
import { listPortals } from './mcp-server/tools/definitions/list-portals.tool.js';
import { queryDataset } from './mcp-server/tools/definitions/query-dataset.tool.js';
import { setCanvas } from './services/canvas-accessor.js';
import { initSocrataService } from './services/socrata/socrata-service.js';

// DataCanvas defaults on; set CANVAS_PROVIDER_TYPE=none to disable it. `.env` is
// loaded first so a value set only there counts under Node too. Nothing parses
// config before createApp(), which reports an invalid value in its banner.
preloadEnvFile();
process.env.CANVAS_PROVIDER_TYPE =
  normalizeEnv({ CANVAS_PROVIDER_TYPE: process.env.CANVAS_PROVIDER_TYPE }).CANVAS_PROVIDER_TYPE ??
  'duckdb';

await createApp({
  name: 'socrata-mcp-server',
  title: 'socrata-mcp-server',
  skills: 'skills',
  tools: [
    findDatasets,
    getDataset,
    queryDataset,
    listPortals,
    dataframeDescribe,
    dataframeQuery,
    dataframeDrop,
  ],
  resources: [datasetResource, portalsResource],
  prompts: [exploreOpenData],
  // No handler gates on ctx.requestInput, so every tool answers in one round
  // trip — declare the stateless HTTP posture in source rather than relying on
  // MCP_SESSION_MODE being set in the deployment environment.
  sessionMode: 'stateless',
  // Public catalog server — serve full landing inventory regardless of auth mode.
  landing: { requireAuth: false },
  instructions:
    'Government open-data server wrapping the Socrata SODA 2.1 API and Discovery API.\n' +
    'Workflow: socrata_list_portals → socrata_find_datasets → socrata_get_dataset (inspect schema) → socrata_query_dataset.\n' +
    'A dataset ID is only valid on its own portal: pass it with the domain from the same socrata_find_datasets result. Domains are bare hostnames (data.cityofnewyork.us); URL forms are reduced to the host.\n' +
    'SoQL references columns by API field name (field_name from socrata_get_dataset, e.g. cuisine_description), never the display label.\n' +
    'All SODA 2.1 row values are strings. Column data_type from socrata_get_dataset determines WHERE quoting:\n' +
    '  Number columns: bare literals (year=2023)\n' +
    "  Text columns: single-quoted strings (year='2023')\n" +
    'Set SOCRATA_APP_TOKEN for higher rate limits. Large result sets spill to DataCanvas for SQL via socrata_dataframe_query.',
  setup(core) {
    // First: an invalid SOCRATA_* value stops startup here, with the banner naming it.
    getServerConfig();
    initSocrataService();
    // Canvas lives on CoreServices, not on the per-request Context — expose it
    // to handlers through the module-level accessor.
    setCanvas(core.canvas);
  },
});
