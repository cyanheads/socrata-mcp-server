/**
 * @fileoverview Server-specific environment variable configuration for socrata-mcp-server.
 * Parsed once, by getServerConfig() in createApp()'s setup(), via parseEnvConfig for
 * clear error messaging; nothing parses it at module import.
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

const ENV_VARS = {
  appToken: 'SOCRATA_APP_TOKEN',
  defaultDomain: 'SOCRATA_DEFAULT_DOMAIN',
  dataframeDropEnabled: 'SOCRATA_DATAFRAME_DROP_ENABLED',
  clampLimits: 'SOCRATA_CLAMP_LIMITS',
} as const satisfies Record<keyof ServerConfig, string>;

const SCHEMA_DEFAULTS: ServerConfig = ServerConfigSchema.parse({});

let _config: ServerConfig | undefined;

/**
 * The server config, parsed once. src/index.ts calls it first in setup(), after
 * createApp() has loaded `.env` and parsed its own config, so an invalid value
 * stops startup with the banner naming the variable. Never call it at import:
 * a ConfigurationError thrown there exits on a raw stack trace instead.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, ENV_VARS);
  return _config;
}

/**
 * The config an input schema reads when it validates or is emitted: what
 * setup() parsed, or the schema defaults before it runs. Never parses the
 * environment, since `tool()` emits every input schema when its definition
 * module is imported.
 */
export function activeServerConfig(): ServerConfig {
  return _config ?? SCHEMA_DEFAULTS;
}

/**
 * Loads the working directory's `.env` into `process.env`, never overriding a
 * variable already set, for a read made before createApp(): Bun loads `.env` at
 * startup, but under Node the framework loads it only inside createApp().
 * Every failure is left to createApp(), which loads the file again and reports
 * any failure but a missing file in its startup banner. Node reports an
 * unreadable file as missing, so under Node the server starts without it.
 */
export function preloadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch {
    // A missing file is the usual case; createApp() reports any other failure it sees.
  }
}

/**
 * SOCRATA_DATAFRAME_DROP_ENABLED alone, for the drop tool's module, which picks
 * its definition at import, before setup() parses the config. `.env` is loaded
 * first. An invalid value reads as off here; getServerConfig() in setup() then
 * stops startup naming it.
 */
export function dataframeDropFlag(): boolean {
  preloadEnvFile();
  const flag = ServerConfigSchema.shape.dataframeDropEnabled.safeParse(
    process.env[ENV_VARS.dataframeDropEnabled],
  );
  return flag.success && flag.data;
}
