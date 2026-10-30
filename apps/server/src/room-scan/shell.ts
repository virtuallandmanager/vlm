/**
 * The wall shell shared by the GLB generator and the plot fitter: how walls
 * join, the 0.12 m wall boxes, and the outer bounds of the result. Both
 * `buildRoomSetGlb` and `plotForLayout` read the shell from here so the plot
 * always matches what the generator builds (mitred corners included).
 */
import { layoutFootprint, type RoomScanLayout } from '@virvixr/shared'
import { applyNudges, mergeSharedWalls, MERGE_MAX_GAP_M, wallPieces, wallsFromOutline, type GeometryWall, type Nudge, type WallPiece } from './geometry.js'
import { MeshData, at, prism, type V2, type V3 } from './mesh.js'
import { STYLE_KITS } from './styles/index.js'

/** Wall thickness, metres. */
export const WALL_THICKNESS_M = 0.12
/** Clear space between the outer wall faces and the plot edge, metres. */
export const PLOT_MARGIN_M = 0.5
/** Wall ends this close together count as one corner, metres. */
const CORNER_JOIN_M = 0.05

const T = WALL_THICKNESS_M
const EPS = 1e-6

export const add = (p: V2, q: V2): V2 => [p[0] + q[0], p[1] + q[1]]
export const sub = (p: V2, q: V2): V2 => [p[0] - q[0], p[1] - q[1]]
export const scale = (p: V2, s: number): V2 => [p[0] * s, p[1] * s]
export const dot = (p: V2, q: V2) => p[0] * q[0] + p[1] * q[1]
export const dist = (p: V2, q: V2) => Math.hypot(p[0] - q[0], p[1] - q[1])
export function unit(a: V2, b: V2): { dir: V2; len: number } {
  const len = dist(a, b)
  return { dir: len > 0 ? scale(sub(b, a), 1 / len) : [1, 0], len }
}

/** Rooms without scanned walls get walls along their floor outline, then nudges apply. */
export function prepareScan(layout: RoomScanLayout, nudges?: Nudge[]): RoomScanLayout {
  const withWalls: RoomScanLayout = { ...layout, rooms: layout.rooms.map(r => (r.walls.length ? r : { ...r, walls: wallsFromOutline(r.floor) })) }
  return applyNudges(withWalls, nudges ?? [])
}

/** One end of a wall: whether it meets another wall (no end cap) and how far it extends to reach a partition. */
type WallEnd = { joined: boolean; extend: number }

/**
 * How every outer wall's ends meet: corners between two walls of the same
 * room close their outer gap with a corner post (convex corners only), and
 * a wall ending at a shared partition is extended to the partition's centre
 * line, closing the gap between the two rooms' scanned faces.
 */
export function joinWalls(walls: GeometryWall[]): { ends: Array<[WallEnd, WallEnd]>; posts: Array<{ roomIndex: number; poly: V2[] }> } {
  const ends = walls.map((): [WallEnd, WallEnd] => [{ joined: false, extend: 0 }, { joined: false, extend: 0 }])
  const posts: Array<{ roomIndex: number; poly: V2[] }> = []
  const endPoint = (w: GeometryWall, e: 0 | 1) => (e === 0 ? w.a : w.b)
  /** Unit direction from the end into the wall. */
  const into = (w: GeometryWall, e: 0 | 1): V2 => { const { dir } = unit(w.a, w.b); return e === 0 ? dir : scale(dir, -1) }

  walls.forEach((w, i) => {
    if (w.shared) return
    for (const e of [0, 1] as const) {
      if (ends[i][e].joined) continue
      const E = endPoint(w, e)
      let best: { j: number; f: 0 | 1; d: number } | null = null
      walls.forEach((v, j) => {
        if (j === i || v.shared || v.roomIndex !== w.roomIndex) return
        for (const f of [0, 1] as const) {
          const d = dist(E, endPoint(v, f))
          if (d <= CORNER_JOIN_M && !ends[j][f].joined && (!best || d < best.d)) best = { j, f, d }
        }
      })
      if (best) {
        const { j, f } = best as { j: number; f: 0 | 1 }
        const v = walls[j]
        ends[i][e].joined = true; ends[j][f].joined = true
        const uA = into(w, e), uB = into(v, f)
        const nA = w.normal, nB = v.normal
        const k = 1 + dot(nA, nB)
        if (dot(nA, uB) < -0.05 && dot(nB, uA) < -0.05 && k > 0.1) {
          const C = scale(add(E, endPoint(v, f)), 0.5)
          const M = add(C, scale(add(nA, nB), T / k))
          posts.push({ roomIndex: w.roomIndex, poly: [C, add(C, scale(nA, T)), M, add(C, scale(nB, T))] })
        }
        continue
      }
      // No corner: does the wall run into a shared partition just beyond its end?
      const beyond = scale(into(w, e), -1)
      for (const p of walls) {
        if (!p.shared) continue
        const denom = dot(beyond, p.normal)
        if (Math.abs(denom) < Math.SQRT1_2) continue
        const s = -dot(sub(E, p.a), p.normal) / denom
        if (s < -EPS || s > MERGE_MAX_GAP_M) continue
        const { dir, len } = unit(p.a, p.b)
        const q = dot(sub(add(E, scale(beyond, s)), p.a), dir)
        if (q < -T || q > len + T) continue
        ends[i][e] = { joined: true, extend: Math.max(0, s) }
        break
      }
    }
  })
  return { ends, posts }
}

export interface WallMeshes { interior: MeshData; outer: MeshData; doorWall: MeshData; collider: MeshData }

/** One wall piece as a 0.12 m box: inner face(s) in the interior material, outer face and top in the exterior one. */
export function addPiece(m: WallMeshes, p: WallPiece, wall: GeometryWall, startEnd: WallEnd | null, endEnd: WallEnd | null, floorBase: number, outer: MeshData) {
  const { dir } = unit(p.a, p.b)
  const n = p.normal
  const [s0, s1] = p.align === 'inner' ? [0, T] : [-T / 2, T / 2]
  const A = sub(p.a, scale(dir, startEnd?.extend ?? 0)), B = add(p.b, scale(dir, endEnd?.extend ?? 0))
  const A0 = add(A, scale(n, s0)), B0 = add(B, scale(n, s0)), B1 = add(B, scale(n, s1)), A1 = add(A, scale(n, s1))
  const y0 = p.bottom, y1 = p.top
  const n3: V3 = [n[0], 0, n[1]], d3: V3 = [dir[0], 0, dir[1]]
  const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]]
  m.interior.face([at(A0, y0), at(B0, y0), at(B0, y1), at(A0, y1)], neg(n3))
  ;(wall.shared ? m.interior : outer).face([at(A1, y0), at(B1, y0), at(B1, y1), at(A1, y1)], n3)
  m.outer.face([at(A0, y1), at(B0, y1), at(B1, y1), at(A1, y1)], [0, 1, 0])
  if (y0 > floorBase + EPS) m.interior.face([at(A0, y0), at(B0, y0), at(B1, y0), at(A1, y0)], [0, -1, 0])
  if (!startEnd?.joined) m.interior.face([at(A0, y0), at(A1, y0), at(A1, y1), at(A0, y1)], neg(d3))
  if (!endEnd?.joined) m.interior.face([at(B0, y0), at(B1, y0), at(B1, y1), at(B0, y1)], d3)
  prism(m.collider, [A0, B0, B1, A1], y0, y1)
}


export interface ShellBounds { minX: number; minZ: number; maxX: number; maxZ: number }

/**
 * Outer bounds (x, z) of the wall shell the generator builds: every wall
 * vertex and corner post, so rotated or angled rooms count their mitred
 * outer corners. Pure and synchronous; independent of the style.
 */
export function outerShellBounds(layout: RoomScanLayout, nudges?: Nudge[]): ShellBounds {
  const scan = prepareScan(layout, nudges)
  const rooms = scan.rooms
  const kit = STYLE_KITS.plain
  const outerHeightOf = (i: number) => Math.min(rooms[i].ceilingHeight, kit.outerWallHeight(rooms[i].ceilingHeight))
  const floorYOf = (i: number) => rooms[i].floorY
  const walls = mergeSharedWalls(scan)
  const wm: WallMeshes = { interior: new MeshData(), outer: new MeshData(), doorWall: new MeshData(), collider: new MeshData() }
  const { ends, posts } = joinWalls(walls)
  walls.forEach((w, k) => {
    const pieces = wallPieces([w], i => (w.shared ? rooms[i].ceilingHeight : outerHeightOf(i)), floorYOf)
    const { dir, len } = unit(w.a, w.b)
    const floorBase = Math.min(floorYOf(w.roomIndex), w.otherRoomIndex === undefined ? Infinity : floorYOf(w.otherRoomIndex))
    for (const p of pieces) {
      const atStart = Math.abs(dot(sub(p.a, w.a), dir)) < EPS
      const atEnd = Math.abs(dot(sub(p.b, w.a), dir) - len) < EPS
      addPiece(wm, p, w, atStart ? ends[k][0] : null, atEnd ? ends[k][1] : null, floorBase, wm.outer)
    }
  })
  for (const post of posts) {
    const y0 = floorYOf(post.roomIndex)
    prism(wm.outer, post.poly, y0, y0 + outerHeightOf(post.roomIndex), { bottom: false, side: i => i === 1 || i === 2 })
  }
  return boundsOf([wm.interior, wm.outer, wm.doorWall], scan)
}

function boundsOf(meshes: MeshData[], scan: RoomScanLayout): ShellBounds {
  const shell = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity }
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i], z = m.positions[i + 2]
      shell.minX = Math.min(shell.minX, x); shell.maxX = Math.max(shell.maxX, x)
      shell.minZ = Math.min(shell.minZ, z); shell.maxZ = Math.max(shell.maxZ, z)
    }
  }
  if (!Number.isFinite(shell.minX)) {
    const fp = layoutFootprint(scan)
    return { minX: fp.minX - T, minZ: fp.minZ - T, maxX: fp.maxX + T, maxZ: fp.maxZ + T }
  }
  return shell
}
