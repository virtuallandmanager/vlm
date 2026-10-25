import { plotSizeM, type Plot } from 'vlm-shared'
import type { WizardAsset } from '../api'

/** An asset placed on the plot. Metres, plot-relative, y = 0; x east, z north from the south-west corner. */
export interface PlacedItem {
  key: string
  asset: WizardAsset
  x: number
  z: number
  rotationY: number
}

const STEP = 0.5
const MARGIN = 0.5
const SPAWN_CLEAR = 2

/** Ground footprint of an asset (1×1 m when unknown), swapped for 90° and 270° turns. */
export function footprint(asset: WizardAsset, rotationY = 0): { x: number; z: number } {
  const x = asset.dimensions?.x || 1
  const z = asset.dimensions?.z || 1
  const quarter = Math.round((((rotationY % 360) + 360) % 360) / 90)
  return quarter % 2 === 1 ? { x: z, z: x } : { x, z }
}

function clampXZ(plot: Plot, asset: WizardAsset, rotationY: number, x: number, z: number) {
  const size = plotSizeM(plot)
  const f = footprint(asset, rotationY)
  const lim = (len: number, half: number, v: number) =>
    len <= half * 2 ? len / 2 : Math.min(len - half, Math.max(half, v))
  return { x: lim(size.x, f.x / 2, x), z: lim(size.z, f.z / 2, z) }
}

/** Keeps an item's whole footprint inside the plot. */
export function clampToPlot(plot: Plot, item: PlacedItem): PlacedItem {
  return { ...item, ...clampXZ(plot, item.asset, item.rotationY, item.x, item.z) }
}

/** Theme positions are fractions (0-1) of the plot; convert to metres and keep them inside the chosen plot. */
export function layoutTheme(
  items: Array<{ asset: WizardAsset; x: number; z: number; rotationY: number }>,
  plot: Plot,
): PlacedItem[] {
  const size = plotSizeM(plot)
  return items.map((it, i) =>
    clampToPlot(plot, { key: `theme-${i}-${it.asset.id}`, asset: it.asset, x: it.x * size.x, z: it.z * size.z, rotationY: it.rotationY }),
  )
}

/**
 * A free spot for `asset`, searched outward from the plot's centre. The
 * footprint plus a margin must clear every placed item and the spawn point
 * and stay inside the plot. Null when nothing fits.
 */
export function suggestPosition(
  plot: Plot,
  placed: PlacedItem[],
  asset: WizardAsset,
  spawn: { x: number; z: number },
): { x: number; z: number } | null {
  const size = plotSizeM(plot)
  const f = footprint(asset)
  const hx = f.x / 2
  const hz = f.z / 2
  if (f.x > size.x || f.z > size.z) return null
  const cx = size.x / 2
  const cz = size.z / 2
  const fits = (x: number, z: number) => {
    if (x - hx < 0 || x + hx > size.x || z - hz < 0 || z + hz > size.z) return false
    // Nearest point of the footprint to the spawn.
    const dx = Math.max(x - hx - spawn.x, 0, spawn.x - (x + hx))
    const dz = Math.max(z - hz - spawn.z, 0, spawn.z - (z + hz))
    if (Math.hypot(dx, dz) < SPAWN_CLEAR) return false
    return placed.every((p) => {
      const pf = footprint(p.asset, p.rotationY)
      return (
        Math.abs(x - p.x) >= hx + pf.x / 2 + MARGIN || Math.abs(z - p.z) >= hz + pf.z / 2 + MARGIN
      )
    })
  }
  const maxRing = Math.ceil(Math.max(size.x, size.z) / STEP)
  for (let k = 0; k <= maxRing; k++) {
    const ring: Array<{ x: number; z: number; d: number }> = []
    for (let i = -k; i <= k; i++) {
      for (let j = -k; j <= k; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== k) continue
        ring.push({ x: cx + i * STEP, z: cz + j * STEP, d: Math.hypot(i, j) })
      }
    }
    ring.sort((a, b) => a.d - b.d)
    for (const c of ring) if (fits(c.x, c.z)) return { x: c.x, z: c.z }
  }
  return null
}
