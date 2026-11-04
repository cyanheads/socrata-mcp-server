/**
 * @fileoverview The four-by-four dataset ID as tool and resource input.
 * @module mcp-server/dataset-id-schema
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * A four-by-four dataset ID, handed on lowercased: SODA serves IDs in lowercase
 * only. The pattern spells both letter cases rather than taking a flag, since a
 * regex flag never reaches JSON Schema and a client validating against a
 * lowercase-only pattern would refuse IDs the server accepts. Each use adds its
 * own `.describe()`.
 */
export const DatasetIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/,
    'Expected a four-by-four dataset ID: four letters or digits, a hyphen, and four more (kzjm-xkqj). Find one with socrata_find_datasets, which returns each ID with the domain it belongs to.',
  )
  .toLowerCase();
