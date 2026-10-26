import { describe, expect, it } from 'vitest'
import type { Plot } from '@virvixr/shared'
import type { WizardAsset } from '../api'
import { clampToPlot, footprint, layoutTheme, suggestPosition, type PlacedItem } from './placement'

const plot: Plot = { width: 1, depth: 1, base: { x: 0, y: 0 } }
const asset = (id: string, x: number, z: number | null = x): WizardAsset => ({
  id, name: id, thumbnailUrl: null, cdnUrl: null, dimensions: z === null ? null : { x, y: 1, z }, triangleCount: 100, fileSizeBytes: 10,
})
const placed = (a: WizardAsset, x: number, z: number, rotationY = 0): PlacedItem => ({ key: `${a.id}${x}${z}`, asset: a, x, z, rotationY })

describe('footprint', () => {
  it('defaults to 1x1 and swaps for 90/270', () => {
    expect(footprint(asset('a', 1, null))).toEqual({ x: 1, z: 1 })
    const long: WizardAsset = { ...asset('b', 2), dimensions: { x: 2, y: 1, z: 4 } }
    expect(footprint(long, 90)).toEqual({ x: 4, z: 2 })
    expect(footprint(long, 270)).toEqual({ x: 4, z: 2 })
    expect(footprint(long, 180)).toEqual({ x: 2, z: 4 })
  })
  it('a 2x2 item rotated 90 keeps swapped (equal) footprint', () => {
    expect(footprint(asset('c', 2), 90)).toEqual({ x: 2, z: 2 })
  })
})

describe('suggestPosition', () => {
  it('lands near the centre and 2 m from spawn on an empty plot', () => {
    const p = suggestPosition(plot, [], asset('a', 1), { x: 8, z: 1 })!
    expect(Math.hypot(p.x - 8, p.z - 8)).toBeLessThan(1)
    expect(Math.hypot(p.x - 8, p.z - 1)).toBeGreaterThanOrEqual(2)
  })
  it('returns null on a plot full of 4x4 items', () => {
    const big = asset('big', 4)
    const full: PlacedItem[] = []
    for (const x of [2, 6, 10, 14]) for (const z of [2, 6, 10, 14]) full.push(placed(big, x, z))
    expect(suggestPosition(plot, full, asset('a', 1), { x: 8, z: 1 })).toBeNull()
  })
  it('does not overlap placed items', () => {
    const a = asset('a', 4)
    const p = suggestPosition(plot, [placed(a, 8, 8)], a, { x: 8, z: 1 })!
    expect(Math.abs(p.x - 8) >= 4.5 || Math.abs(p.z - 8) >= 4.5).toBe(true)
  })
  it('places a 16x16 building on a 1x1 plot even though it covers the spawn', () => {
    expect(suggestPosition(plot, [], asset('house', 16), { x: 8, z: 1 })).toEqual({ x: 8, z: 8 })
  })
  it('still keeps clear of the spawn when another spot fits', () => {
    // 32 x 16 m plot, spawn at x = 12: only centres x >= 22 keep the footprint 2 m from it.
    const p = suggestPosition({ width: 2, depth: 1, base: { x: 0, y: 0 } }, [], asset('house', 16), { x: 12, z: 1 })!
    expect(p.x).toBeGreaterThanOrEqual(22)
  })
  it('returns null when the asset is larger than the plot', () => {
    expect(suggestPosition(plot, [], asset('huge', 20), { x: 8, z: 1 })).toBeNull()
  })
})

describe('clampToPlot / layoutTheme', () => {
  it('clamps the whole footprint inside', () => {
    const c = clampToPlot(plot, placed(asset('a', 2), -5, 99))
    expect(c.x).toBe(1)
    expect(c.z).toBe(15)
  })
  it('turns fractions into metres', () => {
    const [it] = layoutTheme([{ asset: asset('a', 1), x: 0.5, z: 0.25, rotationY: 90 }], { ...plot, width: 2 })
    expect(it).toMatchObject({ x: 16, z: 4, rotationY: 90 })
  })
})
