/**
 * @fileoverview The `asset_type` output field, one name and description on
 * every surface that reports it: socrata_find_datasets results,
 * socrata_get_dataset, and the socrata://datasets resource.
 * @module mcp-server/asset-type-schema
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * The catalog asset type, an open string passed through from upstream
 * (Discovery `resource.type`, the views API `assetType`): the vocabulary is
 * Socrata's, and an unlisted type still reaches the caller.
 */
export const AssetTypeSchema = z
  .string()
  .optional()
  .describe(
    'Catalog asset type, such as dataset, filter (a filtered view), map, chart, calendar, visualization, measure, story, href (an external link), federated_href, file. Only dataset and filter answer socrata_query_dataset with rows. Absent when the catalog lists none.',
  );
