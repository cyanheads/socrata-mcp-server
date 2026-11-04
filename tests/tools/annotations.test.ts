/**
 * @fileoverview `openWorldHint` on every tool: true for the tools that call a
 * Socrata portal or the Discovery API, false for the tools that work only on
 * the server's local DataCanvas (#67).
 * @module tests/tools/annotations.test
 */

import { describe, expect, it } from 'vitest';
import { dataframeDescribe } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDrop } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { findDatasets } from '@/mcp-server/tools/definitions/find-datasets.tool.js';
import { getDataset } from '@/mcp-server/tools/definitions/get-dataset.tool.js';
import { listPortals } from '@/mcp-server/tools/definitions/list-portals.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';

describe('openWorldHint', () => {
  it.each([
    { def: findDatasets, expected: true },
    { def: getDataset, expected: true },
    { def: queryDataset, expected: true },
    { def: listPortals, expected: true },
    { def: dataframeDescribe, expected: false },
    { def: dataframeQuery, expected: false },
    { def: dataframeDrop, expected: false },
  ])('$def.name declares openWorldHint: $expected', ({ def, expected }) => {
    expect(def.annotations?.openWorldHint).toBe(expected);
  });
});
