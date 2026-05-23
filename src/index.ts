#!/usr/bin/env node
/**
 * @fileoverview socrata-mcp-server MCP server entry point.
 * Wraps the Socrata SODA 2.1 API and Discovery API for government open-data access.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { exploreOpenData } from './mcp-server/prompts/definitions/explore-open-data.prompt.js';
import { datasetResource } from './mcp-server/resources/definitions/dataset.resource.js';
import { portalsResource } from './mcp-server/resources/definitions/portals.resource.js';
import { dataframeDescribe } from './mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQuery } from './mcp-server/tools/definitions/dataframe-query.tool.js';
import { findDatasets } from './mcp-server/tools/definitions/find-datasets.tool.js';
import { getDataset } from './mcp-server/tools/definitions/get-dataset.tool.js';
import { listPortals } from './mcp-server/tools/definitions/list-portals.tool.js';
import { queryDataset } from './mcp-server/tools/definitions/query-dataset.tool.js';
import { initSocrataService } from './services/socrata/socrata-service.js';

await createApp({
  tools: [findDatasets, getDataset, queryDataset, listPortals, dataframeDescribe, dataframeQuery],
  resources: [datasetResource, portalsResource],
  prompts: [exploreOpenData],
  instructions:
    'Government open-data server wrapping the Socrata SODA 2.1 API and Discovery API.\n' +
    'Workflow: socrata_list_portals → socrata_find_datasets → socrata_get_dataset (inspect schema) → socrata_query_dataset.\n' +
    'All SODA 2.1 row values are strings. Column dataType from socrata_get_dataset determines WHERE quoting:\n' +
    '  Number columns: bare literals (year=2023)\n' +
    "  Text columns: single-quoted strings (year='2023')\n" +
    'Set SOCRATA_APP_TOKEN for higher rate limits. Set CANVAS_PROVIDER_TYPE=duckdb for SQL analytics on large result sets.',
  setup() {
    initSocrataService();
  },
});
