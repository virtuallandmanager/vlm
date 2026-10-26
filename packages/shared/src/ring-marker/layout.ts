/**
 * Ring marker geometry and SVG. A port of apps/ring-marker/ringmarker/layout.py
 * (marker_shapes and corner_grids); apps/ring-marker/vectors/layout.json is the contract.
 * Lengths in mm, origin at the circle's centre, +y up, angles in degrees clockwise from the top.
 * Everything is specified at a 140 mm diameter and scaled by diameter / 140.
 */
import { encodeRing } from './codec.js'
import { sha256 } from './sha256.js'

// Field names match layout.py's Sector, Disc and Rect (Rect is x0/y0/x1/y1, not x/y/w/h).
export type RingShape =
  | { kind: 'sector'; r0: number; r1: number; a0: number; a1: number }
  | { kind: 'disc'; r: number }
  | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number }

export const RING_MAX_DIAMETER_MM = 256
export const RING_DEFAULT_DIAMETER_MM = 140

const REF_DIAMETER = 140
const PLAQUE_REF = 150
const FINDER_REF: [number, number] = [62, 70]
const CODE_RINGS_REF: [number, number][] = [[51, 59], [40, 48], [29, 37]] // ring 0 outermost
const DOT_REF = 12
const FINDER_ANGLES: [number, number] = [8, 352]
const INSET_DEG = 1.2
const PER_RING = 24
const CELL_DEG = 360 / PER_RING
const CORNER_SQUARE_REF = 4
const CORNER_INSET_REF = 3

export function ringPlaqueSizeMm(diameterMm: number): number {
  return (diameterMm * PLAQUE_REF) / REF_DIAMETER
}

/** Runs of consecutive true cells as [start, length], wrapping 23 -> 0. All-on gives [0, 24]. */
function runs(on: boolean[]): [number, number][] {
  const n = on.length
  if (on.every(Boolean)) return [[0, n]]
  const out: [number, number][] = []
  for (let k = 0; k < n; k++) {
    if (on[k] && !on[(k - 1 + n) % n]) {
      let length = 1
      while (on[(k + length) % n]) length++
      out.push([k, length])
    }
  }
  return out
}

/**
 * Four corner marks (TL, TR, BR, BL) as 3x3 cell grids (row 0 at the top). The plaque-corner
 * square is always on; the other 8 take the bits of SHA-256(id as 4 big-endian bytes).
 */
function cornerGrids(markerId: number, diameterMm: number) {
  const s = diameterMm / REF_DIAMETER
  const half = ringPlaqueSizeMm(diameterMm) / 2
  const step = CORNER_SQUARE_REF * s
  const inset = CORNER_INSET_REF * s
  const id = new Uint8Array(4)
  new DataView(id.buffer).setUint32(0, markerId >>> 0)
  const digest = sha256(id)
  const corners: [boolean, boolean][] = [[false, false], [true, false], [true, true], [false, true]]
  return corners.map(([right, bottom], c) => {
    const outerRow = bottom ? 2 : 0
    const outerCol = right ? 2 : 0
    const cells: boolean[][] = [[], [], []]
    let bit = 0
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        if (row === outerRow && col === outerCol) cells[row][col] = true
        else cells[row][col] = ((digest[c] >> (7 - bit++)) & 1) === 1
      }
    }
    const x0 = right ? half - inset - 3 * step : -half + inset
    const yTop = bottom ? -half + inset + 3 * step : half - inset
    return { x0, yTop, step, cells }
  })
}

export function ringShapes(markerId: number, diameterMm: number, version = 0): RingShape[] {
  if (diameterMm > RING_MAX_DIAMETER_MM) {
    throw new Error(`diameter ${diameterMm} mm exceeds the ${RING_MAX_DIAMETER_MM} mm limit`)
  }
  const s = diameterMm / REF_DIAMETER
  const cells = encodeRing(markerId, version)
  const shapes: RingShape[] = []
  shapes.push({ kind: 'sector', r0: FINDER_REF[0] * s, r1: FINDER_REF[1] * s, a0: FINDER_ANGLES[0], a1: FINDER_ANGLES[1] })
  CODE_RINGS_REF.forEach(([ref0, ref1], ring) => {
    const on = cells.slice(ring * PER_RING, (ring + 1) * PER_RING)
    for (const [start, length] of runs(on)) {
      const r0 = ref0 * s
      const r1 = ref1 * s
      if (length === PER_RING) shapes.push({ kind: 'sector', r0, r1, a0: 0, a1: 360 })
      else {
        const a0 = start * CELL_DEG + INSET_DEG
        shapes.push({ kind: 'sector', r0, r1, a0, a1: a0 + length * CELL_DEG - 2 * INSET_DEG })
      }
    }
  })
  shapes.push({ kind: 'disc', r: DOT_REF * s })
  for (const { x0, yTop, step, cells: grid } of cornerGrids(markerId, diameterMm)) {
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        if (grid[row][col]) {
          shapes.push({ kind: 'rect', x0: x0 + col * step, y0: yTop - (row + 1) * step, x1: x0 + (col + 1) * step, y1: yTop - row * step })
        }
      }
    }
  }
  return shapes
}

const f = (n: number): string => String(Math.round(n * 1000) / 1000)

/** SVG path for an annular sector. SVG y points down, so y = -r*cos(a). */
function sectorPath(r0: number, r1: number, a0: number, a1: number): string {
  const pt = (r: number, a: number) => {
    const rad = (a * Math.PI) / 180
    return `${f(r * Math.sin(rad))} ${f(-r * Math.cos(rad))}`
  }
  if (a1 - a0 >= 360) {
    // Full ring: two half arcs per edge (a single arc can't start and end on the same point).
    const ring = (r: number, sweep: number) => `M ${f(0)} ${f(-r)} A ${f(r)} ${f(r)} 0 1 ${sweep} ${f(0)} ${f(r)} A ${f(r)} ${f(r)} 0 1 ${sweep} ${f(0)} ${f(-r)} Z`
    return `${ring(r1, 1)} ${ring(r0, 1)}`
  }
  const large = a1 - a0 > 180 ? 1 : 0
  return `M ${pt(r1, a0)} A ${f(r1)} ${f(r1)} 0 ${large} 1 ${pt(r1, a1)} L ${pt(r0, a1)} A ${f(r0)} ${f(r0)} 0 ${large} 0 ${pt(r0, a0)} Z`
}

/** Standalone SVG sized in millimetres: light plaque, dark shapes. */
export function ringMarkerSvg(markerId: number, diameterMm: number, opts: { dark?: string; light?: string } = {}): string {
  const dark = opts.dark ?? '#000000'
  const light = opts.light ?? '#ffffff'
  const side = ringPlaqueSizeMm(diameterMm)
  const half = side / 2
  const body = ringShapes(markerId, diameterMm).map((sh) => {
    if (sh.kind === 'sector') return `<path d="${sectorPath(sh.r0, sh.r1, sh.a0, sh.a1)}" fill-rule="evenodd"/>`
    if (sh.kind === 'disc') return `<circle cx="0" cy="0" r="${f(sh.r)}"/>`
    return `<rect x="${f(sh.x0)}" y="${f(-sh.y1)}" width="${f(sh.x1 - sh.x0)}" height="${f(sh.y1 - sh.y0)}"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f(side)}mm" height="${f(side)}mm" viewBox="${f(-half)} ${f(-half)} ${f(side)} ${f(side)}">` +
    `<rect x="${f(-half)}" y="${f(-half)}" width="${f(side)}" height="${f(side)}" fill="${light}"/>` +
    `<g fill="${dark}">${body.join('')}</g></svg>`
}
