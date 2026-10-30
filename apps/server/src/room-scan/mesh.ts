/**
 * Low-poly mesh building blocks for room-set GLBs: flat-shaded triangle
 * lists, prisms over floor-plan polygons, ear-clipping triangulation and
 * polygon offsetting. Metres, x/z floor plane, Y up.
 */

export type V2 = [number, number]
export type V3 = [number, number, number]

/** A glTF material by name; `color` is '#RRGGBB' (sRGB). */
export interface MaterialSpec { name: string; color: string; alpha?: number; doubleSided?: boolean; metallic?: number; roughness?: number }

/** Flat-shaded triangles: every face gets its own vertices and normal. */
export class MeshData {
  positions: number[] = []
  normals: number[] = []
  indices: number[] = []

  get vertexCount() { return this.positions.length / 3 }
  get triangleCount() { return this.indices.length / 3 }

  /** A planar convex polygon (3+ corners) facing `facing`; winding is fixed to match. */
  face(pts: V3[], facing: V3): void {
    if (pts.length < 3) return
    let n = cross3(sub3(pts[1], pts[0]), sub3(pts[2], pts[0]))
    if (dot3(n, facing) < 0) { pts = [...pts].reverse(); n = scale3(n, -1) }
    const len = Math.hypot(n[0], n[1], n[2])
    if (len < 1e-12) return
    n = scale3(n, 1 / len)
    const base = this.vertexCount
    for (const p of pts) { this.positions.push(...p); this.normals.push(...n) }
    for (let i = 1; i + 1 < pts.length; i++) this.indices.push(base, base + i, base + i + 1)
  }

  /** Append another mesh's triangles. */
  append(other: MeshData): void {
    const base = this.vertexCount
    this.positions.push(...other.positions)
    this.normals.push(...other.normals)
    for (const i of other.indices) this.indices.push(base + i)
  }
}

/** A named mesh in one material, ready to become one glTF node. */
export interface MeshPart { name: string; material: MaterialSpec; mesh: MeshData }

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const cross2 = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0]

export const at = (p: V2, y: number): V3 => [p[0], y, p[1]]

/** Signed area of a floor-plan polygon; positive when counter-clockwise in (x, z). */
export function signedArea(poly: V2[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) a += cross2(poly[i], poly[(i + 1) % poly.length])
  return a / 2
}

/** The same polygon without repeated or collinear corners. */
export function cleanPolygon(poly: V2[], eps = 1e-6): V2[] {
  let pts = poly.filter((p, i) => {
    const q = poly[(i + 1) % poly.length]
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > eps
  })
  let changed = true
  while (changed && pts.length >= 3) {
    changed = false
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length]
      if (Math.abs(cross2([b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]])) < eps) {
        pts = pts.filter((_, k) => k !== i); changed = true; break
      }
    }
  }
  return pts
}

function inTriangle(p: V2, a: V2, b: V2, c: V2): boolean {
  const d1 = cross2([b[0] - a[0], b[1] - a[1]], [p[0] - a[0], p[1] - a[1]])
  const d2 = cross2([c[0] - b[0], c[1] - b[1]], [p[0] - b[0], p[1] - b[1]])
  const d3 = cross2([a[0] - c[0], a[1] - c[1]], [p[0] - c[0], p[1] - c[1]])
  return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12
}

/**
 * Triangulate a simple polygon by ear clipping. Returns index triples into
 * `poly`, each counter-clockwise in (x, z). A polygon that isn't simple
 * finishes as a fan rather than failing.
 */
export function earClip(poly: V2[]): Array<[number, number, number]> {
  const n = poly.length
  if (n < 3) return []
  let idx = Array.from({ length: n }, (_, i) => i)
  if (signedArea(poly) < 0) idx.reverse()
  const tris: Array<[number, number, number]> = []
  let guard = 0
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length]
      const a = poly[ia], b = poly[ib], c = poly[ic]
      if (cross2([b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]]) <= 1e-12) continue // reflex or flat
      if (idx.some(k => k !== ia && k !== ib && k !== ic && inTriangle(poly[k], a, b, c))) continue
      tris.push([ia, ib, ic])
      idx = idx.filter((_, k) => k !== i)
      clipped = true
      break
    }
    if (!clipped) break
  }
  for (let i = 1; i + 1 < idx.length; i++) tris.push([idx[0], idx[i], idx[i + 1]])
  return tris
}

/** A horizontal polygon at height y, facing up (`up`) or down. */
export function horizontalPolygon(mesh: MeshData, poly: V2[], y: number, up: boolean): void {
  for (const [a, b, c] of earClip(poly)) mesh.face([at(poly[a], y), at(poly[b], y), at(poly[c], y)], [0, up ? 1 : -1, 0])
}

/** Unit outward normal of edge poly[i] -> poly[i+1]. */
export function edgeNormal(poly: V2[], i: number): V2 {
  const p = poly[i], q = poly[(i + 1) % poly.length]
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1
  const dx = (q[0] - p[0]) / len, dz = (q[1] - p[1]) / len
  return signedArea(poly) > 0 ? [dz, -dx] : [-dz, dx]
}

/** Move edge i (poly[i] -> poly[i+1]) `d[i]` metres outward; corners meet where the moved edges cross. */
export function offsetPolygonEdges(poly: V2[], d: number[]): V2[] {
  const n = poly.length
  return poly.map((p, i) => {
    const j = (i + n - 1) % n
    const n1 = edgeNormal(poly, j), n2 = edgeNormal(poly, i)
    const det = n1[0] * n2[1] - n1[1] * n2[0]
    // nearly parallel (or folded-back) edges: just move along the next edge's normal
    if (Math.abs(det) < 0.1) return [p[0] + n2[0] * d[i], p[1] + n2[1] * d[i]]
    // solve x . n1 = d[j], x . n2 = d[i]
    const x = (d[j] * n2[1] - d[i] * n1[1]) / det, z = (n1[0] * d[i] - n2[0] * d[j]) / det
    return [p[0] + x, p[1] + z]
  })
}

/**
 * A vertical prism over a floor-plan polygon from y0 to y1. `side(i)` picks
 * which edges (poly[i] -> poly[i+1]) get a wall face; all by default.
 */
export function prism(mesh: MeshData, poly: V2[], y0: number, y1: number, opts: { top?: boolean; bottom?: boolean; side?: (i: number) => boolean } = {}): void {
  const { top = true, bottom = true, side = () => true } = opts
  if (y1 - y0 < 1e-9 || poly.length < 3) return
  const ccw = signedArea(poly) > 0
  for (let i = 0; i < poly.length; i++) {
    if (!side(i)) continue
    const p = poly[i], q = poly[(i + 1) % poly.length]
    const dx = q[0] - p[0], dz = q[1] - p[1]
    const out: V3 = ccw ? [dz, 0, -dx] : [-dz, 0, dx]
    mesh.face([at(p, y0), at(q, y0), at(q, y1), at(p, y1)], out)
  }
  if (top) horizontalPolygon(mesh, poly, y1, true)
  if (bottom) horizontalPolygon(mesh, poly, y0, false)
}

/** An axis box rotated about Y: centre, size (x, y, z), yaw in degrees (+yaw turns +x towards -z). */
export function yawBox(mesh: MeshData, center: V3, size: V3, yawDeg: number): void {
  const t = (yawDeg * Math.PI) / 180
  const ux: V2 = [Math.cos(t), -Math.sin(t)], uz: V2 = [Math.sin(t), Math.cos(t)]
  const hx = size[0] / 2, hz = size[2] / 2
  const c: V2 = [center[0], center[2]]
  const corner = (sx: number, sz: number): V2 => [c[0] + ux[0] * hx * sx + uz[0] * hz * sz, c[1] + ux[1] * hx * sx + uz[1] * hz * sz]
  prism(mesh, [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], center[1] - size[1] / 2, center[1] + size[1] / 2)
}

/** A box on a wall: `along` the wall from `from` to `to` (floor-plan points), `out` metres from 0 to `depth` along `normal`, y from y0 to y1. */
export function wallBox(mesh: MeshData, from: V2, to: V2, normal: V2, out0: number, out1: number, y0: number, y1: number): void {
  const o = (p: V2, s: number): V2 => [p[0] + normal[0] * s, p[1] + normal[1] * s]
  prism(mesh, [o(from, out0), o(to, out0), o(to, out1), o(from, out1)], y0, y1)
}
