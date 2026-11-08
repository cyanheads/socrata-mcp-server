/**
 * @fileoverview Timing assertion shared by the suites that hold a scanner,
 * escaper, or regex over caller- or portal-sized text to linear cost.
 * @module tests/linear-cost
 */

import { expect } from 'vitest';

/** Thread CPU milliseconds `work` takes, which a loaded machine cannot inflate by descheduling it. */
function cpuMs(work: () => void): number {
  const start = process.threadCpuUsage();
  work();
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1000;
}

/** Thread CPU one sample may use: it covers 320k characters, which linear time does well under this. */
const SAMPLE_CAP_MS = 1000;

/**
 * Asserts that the work `prepare(size)` returns costs time linear in `size` as
 * it doubles from 5k to 320k characters. Inputs are built outside the
 * measurement. Each sample covers 320k characters in all (64 calls at 5k, one
 * at 320k), so the smallest size measures well above the timer's resolution.
 * The base is the least of five samples; each larger size takes up to three,
 * stopping at the first within 4× of linear, since a garbage-collection pause
 * only ever adds time. Each size is checked before the next runs and no sample
 * may reach {@link SAMPLE_CAP_MS}, so a quadratic scan fails within seconds:
 * across the span linear is 64×, quadratic 4,096×, and the bound 256×.
 */
export function expectLinearCost(prepare: (size: number) => () => void): void {
  const first = 5000;
  const last = first * 64;
  const sampler = (size: number) => {
    const work = prepare(size);
    const calls = last / size;
    return () => {
      const ms = cpuMs(() => {
        for (let call = 0; call < calls; call++) work();
      });
      expect(ms, `${calls} × ${size} characters`).toBeLessThan(SAMPLE_CAP_MS);
      return ms / calls;
    };
  };
  const base = Math.min(...Array.from({ length: 5 }, sampler(first)));
  for (let size = first * 2; size <= last; size *= 2) {
    const bound = (4 * size) / first;
    const sample = sampler(size);
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3 && best / base >= bound; i++) best = Math.min(best, sample());
    expect(best / base, `${size} characters`).toBeLessThan(bound);
  }
}
