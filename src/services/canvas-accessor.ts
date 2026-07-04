/**
 * @fileoverview Module-level accessor for the optional DataCanvas service.
 * The framework exposes canvas only on `CoreServices` in the `setup()` callback
 * (never on the per-request `Context`), so handlers reach it through this
 * accessor. `getCanvas()` returns `undefined` when CANVAS_PROVIDER_TYPE is not
 * set to a supported engine.
 * @module services/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Wire the canvas service from `setup(core)`. Pass `undefined` to clear (tests). */
export function setCanvas(canvas: DataCanvas | undefined): void {
  _canvas = canvas;
}

/** The DataCanvas service, or `undefined` when canvas is disabled. */
export function getCanvas(): DataCanvas | undefined {
  return _canvas;
}
