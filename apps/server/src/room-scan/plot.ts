import { DCL_PARCEL_M, MAX_PLOT_SIDE, type Plot, type RoomScanLayout } from '@virvixr/shared'
import type { Nudge } from './geometry.js'
import { outerShellBounds, PLOT_MARGIN_M } from './shell.js'

/** The smallest square plot (parcels) that holds the generated shell plus margins, or null when it exceeds MAX_PLOT_SIDE. */
export function plotForLayout(layout: RoomScanLayout, nudges?: Nudge[]): Plot | null {
  const b = outerShellBounds(layout, nudges)
  const side = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 2 * PLOT_MARGIN_M
  const n = Math.max(1, Math.ceil(side / DCL_PARCEL_M - 1e-9))
  return n > MAX_PLOT_SIDE ? null : { width: n, depth: n, base: { x: 0, y: 0 } }
}
