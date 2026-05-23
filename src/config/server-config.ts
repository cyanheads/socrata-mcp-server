/**
 * @fileoverview Server-specific environment variable configuration for socrata-mcp-server.
 * Parsed lazily on first access via parseEnvConfig for clear error messaging.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

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
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    appToken: 'SOCRATA_APP_TOKEN',
    defaultDomain: 'SOCRATA_DEFAULT_DOMAIN',
  });
  return _config;
}
