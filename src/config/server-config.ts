/**
 * @fileoverview Server-specific environment variable configuration for socrata-mcp-server.
 * Parsed lazily on first access via parseEnvConfig for clear error messaging.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseConfig, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  appToken: z
    .string()
    .optional()
    .describe(
      'Socrata app token (X-App-Token header). Free to register at any portal. Without a token, requests draw from a shared throttled pool per source IP.',
    ),
  defaultDomain: z
    .string()
    .default('data.seattle.gov')
    .describe(
      'Default portal domain when domain is omitted from tool calls (e.g. data.seattle.gov, data.cityofnewyork.us).',
    ),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe(
      'Enables socrata_dataframe_drop. Off by default: the tool is omitted from the tool list until this is true.',
    ),
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      "Serves a limit above a tool's per-call cap at the cap, with a notice naming the offset that continues, instead of rejecting it. False restores each cap as the schema maximum.",
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * The server config, parsed once. Tool modules read it at import (the clamp
 * switch shapes an input schema, the drop flag picks a definition), before
 * src/index.ts reaches its own parseConfig() call. Under Node the framework
 * loads `.env` only inside parseConfig() (Bun loads it at startup), so it runs
 * first here: otherwise a value set only in `.env` is missed and cached as unset.
 */
export function getServerConfig(): ServerConfig {
  if (!_config) {
    parseConfig();
    _config = parseEnvConfig(ServerConfigSchema, {
      appToken: 'SOCRATA_APP_TOKEN',
      defaultDomain: 'SOCRATA_DEFAULT_DOMAIN',
      dataframeDropEnabled: 'SOCRATA_DATAFRAME_DROP_ENABLED',
      clampLimits: 'SOCRATA_CLAMP_LIMITS',
    });
  }
  return _config;
}
