/**
 * @fileoverview The `limit` input of a tool with a per-call cap, its maximum set by
 * SOCRATA_CLAMP_LIMITS when the schema validates or is emitted rather than at import.
 * @module mcp-server/tools/capped-limit
 */

import { z } from '@cyanheads/mcp-ts-core';
import { activeServerConfig } from '@/config/server-config.js';

/**
 * A `limit` input whose maximum follows SOCRATA_CLAMP_LIMITS: `ceiling` while
 * clamping is on (the handler serves a value above `cap` at `cap`), `cap` while
 * it is off. A `.check()` enforces the maximum on each parse and `.meta()`
 * getters advertise it, with the matching description, on each JSON Schema
 * emission, so both read the config setup() parsed, or the schema defaults
 * before then.
 */
export function cappedLimit(options: {
  cap: number;
  ceiling: number;
  defaultValue: number;
  describe: (clamped: boolean) => string;
}) {
  const { cap, ceiling, defaultValue, describe } = options;
  const clamped = () => activeServerConfig().clampLimits;
  const maximum = () => (clamped() ? ceiling : cap);
  return z
    .number()
    .int()
    .min(1)
    .check((payload) => {
      const max = maximum();
      if (payload.value > max) {
        payload.issues.push({
          code: 'too_big',
          origin: 'number',
          maximum: max,
          inclusive: true,
          input: payload.value,
        });
      }
    })
    .default(defaultValue)
    .meta({
      get maximum() {
        return maximum();
      },
      get description() {
        return describe(clamped());
      },
    });
}
