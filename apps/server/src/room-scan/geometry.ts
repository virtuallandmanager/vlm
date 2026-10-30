/**
 * Pure floor-plan geometry for turning a room scan into wall pieces:
 * per-room nudges, door snapping, merging walls two rooms share, and
 * splitting walls around their openings. Metres, x/z floor plane, Y up.
 */
import { MIN_WALL_LENGTH_M, type RoomOpening, type RoomScanLayout, type RoomWall, type ScannedRoom } from '@virvixr/shared'

/** Two walls are parallel enough to merge within this many degrees. */
export const MERGE_MAX_ANGLE_DEG = 5
/** Two walls merge when their scanned faces are at most this far apart, metres. */
export const MERGE_MAX_GAP_M = 0.3
/** Two walls merge only when they run alongside each other for at least this long, metres. */
export const MERGE_MIN_OVERLAP_M = 0.5
/** Openings in two rooms snap together when their centres are within this distance, metres. */
export const DOOR_SNAP_M = 0.25
/** Walls shorter than this are dropped, metres. */
export const MIN_WALL_M = MIN_WALL_LENGTH_M

type Vec = [number, number]
export type Nudge = { dx: number; dz: number; yaw: number }

/**
 * A wall ready to cut into pieces. `normal` is unit and points away from
 * room `roomIndex`'s interior. `align: 'inner'` means the line is the scanned
 * inner face and the thickness extends along `normal`; `'center'` is a merged
 * partition whose line is midway between the two rooms' faces, thickness
 * centred on it. A shared wall names the other room in `otherRoomIndex`.
 * Opening sills are relative to room `roomIndex`'s floor.
 */
export type GeometryWall = RoomWall & { roomIndex: number; shared: boolean; normal: Vec; align: 'inner' | 'center'; otherRoomIndex?: number }

/** A solid rectangle of wall, before thickness. `bottom`/`top` are absolute Y. */
export interface WallPiece { a: Vec; b: Vec; bottom: number; top: number; shared: boolean; roomIndex: number; normal: Vec; align: 'inner' | 'center' }

const EPS = 1e-6
const sub = (p: Vec, q: Vec): Vec => [p[0] - q[0], p[1] - q[1]]
const add = (p: Vec, q: Vec): Vec => [p[0] + q[0], p[1] + q[1]]
const scale = (p: Vec, s: number): Vec => [p[0] * s, p[1] * s]
const dot = (p: Vec, q: Vec) => p[0] * q[0] + p[1] * q[1]
const cross = (p: Vec, q: Vec) => p[0] * q[1] - p[1] * q[0]
const length = (p: Vec) => Math.hypot(p[0], p[1])
const along = (a: Vec, dir: Vec, t: number): Vec => add(a, scale(dir, t))

function unitDir(w: { a: Vec; b: Vec }): { dir: Vec; len: number } {
  const d = sub(w.b, w.a)
  const len = length(d)
  return { dir: len > 0 ? scale(d, 1 / len) : [1, 0], len }
}

/** The walls along a floor outline, closing back to the first corner. Corners under 0.10 m from the previous one are skipped. */
export function wallsFromOutline(floor: Array<[number, number]>): RoomWall[] {
  const pts: Vec[] = []
  for (const p of floor) if (!pts.length || length(sub(p, pts[pts.length - 1])) >= MIN_WALL_M) pts.push(p)
  while (pts.length > 1 && length(sub(pts[0], pts[pts.length - 1])) < MIN_WALL_M) pts.pop()
  if (pts.length < 3) return []
  return pts.map((a, i) => ({ a, b: pts[(i + 1) % pts.length], openings: [] }))
}

/** Area centroid of a floor polygon (vertex mean if it has no area). */
export function floorCentroid(floor: Array<[number, number]>): Vec {
  let area = 0, cx = 0, cz = 0
  for (let i = 0; i < floor.length; i++) {
    const p = floor[i], q = floor[(i + 1) % floor.length]
    const c = cross(p, q)
    area += c; cx += (p[0] + q[0]) * c; cz += (p[1] + q[1]) * c
  }
  if (Math.abs(area) < EPS) {
    const n = floor.length || 1
    return [floor.reduce((s, p) => s + p[0], 0) / n, floor.reduce((s, p) => s + p[1], 0) / n]
  }
  return [cx / (3 * area), cz / (3 * area)]
}

function insidePolygon(pt: Vec, poly: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j]
    if ((zi > pt[1]) !== (zj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/** Unit normal of a wall pointing away from the room's interior. */
function outwardNormal(w: { a: Vec; b: Vec }, floor: Array<[number, number]>): Vec {
  const { dir } = unitDir(w)
  const left: Vec = [-dir[1], dir[0]]
  const mid = scale(add(w.a, w.b), 0.5)
  const right: Vec = [-left[0], -left[1]]
  const probe = 0.01
  const leftIn = insidePolygon(add(mid, scale(left, probe)), floor)
  const rightIn = insidePolygon(add(mid, scale(left, -probe)), floor)
  // The probe only decides when the wall sits on the outline (exactly one side inside).
  if (leftIn !== rightIn) return leftIn ? right : left
  // Wall inset from (or outside) the outline: face the way the nearest outline edge faces.
  const edge = nearestOutlineEdgeNormal(mid, dir, floor)
  if (edge) return dot(edge, left) >= 0 ? left : right
  return dot(sub(mid, floorCentroid(floor)), left) >= 0 ? left : right
}

/** Outward normal of the floor-outline edge nearest `pt`, preferring edges within 45° of `dir`. */
function nearestOutlineEdgeNormal(pt: Vec, dir: Vec, floor: Array<[number, number]>): Vec | null {
  let area = 0
  for (let i = 0; i < floor.length; i++) area += cross(floor[i], floor[(i + 1) % floor.length])
  if (floor.length < 3 || Math.abs(area) < EPS) return null
  let best: { d: number; parallel: boolean; n: Vec } | null = null
  for (let i = 0; i < floor.length; i++) {
    const e = { a: floor[i], b: floor[(i + 1) % floor.length] }
    const { dir: ed, len } = unitDir(e)
    if (len < EPS) continue
    const t = Math.min(Math.max(dot(sub(pt, e.a), ed), 0), len)
    const d = length(sub(pt, along(e.a, ed, t)))
    const parallel = Math.abs(dot(ed, dir)) >= Math.SQRT1_2
    // Counter-clockwise outline (positive area): the interior is on each edge's left.
    const n: Vec = area > 0 ? [ed[1], -ed[0]] : [-ed[1], ed[0]]
    if (!best || (parallel && !best.parallel) || (parallel === best.parallel && d < best.d)) best = { d, parallel, n }
  }
  return best ? best.n : null
}

/** Rotate and translate each room (rotation about its floor centroid; +yaw turns +x towards -z). Returns a new layout. */
export function applyNudges(layout: RoomScanLayout, nudges: Nudge[]): RoomScanLayout {
  return {
    ...layout,
    rooms: layout.rooms.map((room, i): ScannedRoom => {
      const n = nudges[i] ?? { dx: 0, dz: 0, yaw: 0 }
      const c = floorCentroid(room.floor)
      const t = (n.yaw * Math.PI) / 180
      const cos = Math.cos(t), sin = Math.sin(t)
      const move = (p: Vec): Vec => {
        if (n.yaw === 0) return [p[0] + n.dx, p[1] + n.dz]
        const x = p[0] - c[0], z = p[1] - c[1]
        return [x * cos + z * sin + c[0] + n.dx, -x * sin + z * cos + c[1] + n.dz]
      }
      return {
        ...room,
        floor: room.floor.map(move),
        walls: room.walls.map(w => ({ ...w, a: move(w.a), b: move(w.b), openings: w.openings.map(o => ({ ...o })) })),
        objects: room.objects.map(o => {
          const [x, z] = move([o.center[0], o.center[2]])
          return { ...o, center: [x, o.center[1], z], yaw: o.yaw + n.yaw }
        }),
      }
    }),
  }
}

function openingCentres(room: ScannedRoom): Vec[] {
  const out: Vec[] = []
  for (const w of room.walls) {
    const { dir } = unitDir(w)
    for (const o of w.openings) out.push(along(w.a, dir, o.offset + o.width / 2))
  }
  return out
}

/**
 * Nudges that also line up doorways: each room after the first is moved so
 * its opening centre closest to an earlier room's opening centre (within
 * DOOR_SNAP_M) lands exactly on it. Rooms with no such pair keep their nudge.
 */
export function snapDoors(layout: RoomScanLayout, nudges: Nudge[]): Nudge[] {
  const out = layout.rooms.map((_, i) => ({ ...(nudges[i] ?? { dx: 0, dz: 0, yaw: 0 }) }))
  const placed: Vec[] = []
  layout.rooms.forEach((_, i) => {
    let centres = openingCentres(applyNudges({ ...layout, rooms: [layout.rooms[i]] }, [out[i]]).rooms[0])
    if (i > 0) {
      let best: { d: number; delta: Vec } | null = null
      for (const p of centres) for (const q of placed) {
        const d = length(sub(q, p))
        if (d <= DOOR_SNAP_M && (!best || d < best.d)) best = { d, delta: sub(q, p) }
      }
      if (best && best.d > 0) {
        out[i] = { ...out[i], dx: out[i].dx + best.delta[0], dz: out[i].dz + best.delta[1] }
        centres = centres.map(p => add(p, best.delta))
      }
    }
    placed.push(...centres)
  })
  return out
}

/** Clamp openings into a wall of length `len`, drop empty ones, and merge overlapping ones (min bottom, max top). */
function normaliseOpenings(openings: RoomOpening[], len: number): RoomOpening[] {
  const clamped = openings
    .map(o => {
      const start = Math.min(Math.max(o.offset, 0), len)
      const end = Math.min(Math.max(o.offset + o.width, 0), len)
      return { ...o, offset: start, width: end - start }
    })
    .filter(o => o.width > EPS)
    .sort((p, q) => p.offset - q.offset)
  const rank = { door: 2, opening: 1, window: 0 } as const
  const merged: RoomOpening[] = []
  for (const o of clamped) {
    const last = merged[merged.length - 1]
    if (last && o.offset < last.offset + last.width - EPS) {
      const end = Math.max(last.offset + last.width, o.offset + o.width)
      const bottom = Math.min(last.sill, o.sill)
      const top = Math.max(last.sill + last.height, o.sill + o.height)
      merged[merged.length - 1] = {
        kind: rank[o.kind] > rank[last.kind] ? o.kind : last.kind,
        offset: last.offset, width: end - last.offset, sill: bottom, height: top - bottom,
      }
    } else merged.push({ ...o })
  }
  return merged
}

/** The part of a wall between params t0..t1 (metres from its start), with its openings clipped and re-based. */
function slice(w: GeometryWall, t0: number, t1: number): GeometryWall {
  const { dir } = unitDir(w)
  const openings: RoomOpening[] = []
  for (const o of w.openings) {
    const s = Math.max(o.offset, t0), e = Math.min(o.offset + o.width, t1)
    if (e - s > EPS) openings.push({ ...o, offset: s - t0, width: e - s })
  }
  return { ...w, a: along(w.a, dir, t0), b: along(w.a, dir, t1), openings }
}

type Candidate = { i: number; j: number; t0: number; t1: number; gap: number }

/** Whether wall q (another room's) runs back-to-back with wall p closely enough to merge; returns p's overlap params and q's face offset along p's normal. */
function mergeCandidate(p: GeometryWall, q: GeometryWall): Omit<Candidate, 'i' | 'j'> | null {
  if (p.roomIndex === q.roomIndex || p.shared || q.shared) return null
  const P = unitDir(p), Q = unitDir(q)
  if (Math.abs(cross(P.dir, Q.dir)) > Math.sin((MERGE_MAX_ANGLE_DEG * Math.PI) / 180)) return null
  if (dot(p.normal, q.normal) >= 0) return null // faces must point at each other
  const ga = dot(sub(q.a, p.a), p.normal), gb = dot(sub(q.b, p.a), p.normal)
  if (Math.max(Math.abs(ga), Math.abs(gb)) > MERGE_MAX_GAP_M) return null
  const sa = dot(sub(q.a, p.a), P.dir), sb = dot(sub(q.b, p.a), P.dir)
  const t0 = Math.max(0, Math.min(sa, sb)), t1 = Math.min(P.len, Math.max(sa, sb))
  if (t1 - t0 < MERGE_MIN_OVERLAP_M) return null
  return { t0, t1, gap: (ga + gb) / 2 }
}

/**
 * Every room's walls with outward normals, where back-to-back walls of two
 * rooms (parallel within 5°, faces within 0.30 m, overlapping ≥ 0.5 m) become
 * one `shared` centred partition over the overlapping stretch, carrying both
 * walls' openings (a door seen from both sides becomes one). Any leftover
 * stretch of either wall stays as that room's inner wall. Walls under 0.10 m
 * are dropped.
 */
export function mergeSharedWalls(layout: RoomScanLayout): GeometryWall[] {
  let walls: GeometryWall[] = []
  layout.rooms.forEach((room, roomIndex) => {
    for (const w of room.walls) {
      const { len } = unitDir(w)
      if (len < MIN_WALL_M) continue
      walls.push({ a: w.a, b: w.b, openings: normaliseOpenings(w.openings, len), roomIndex, shared: false, normal: outwardNormal(w, room.floor), align: 'inner' })
    }
  })

  for (;;) {
    let found: Candidate | null = null
    for (let i = 0; i < walls.length && !found; i++) for (let j = 0; j < walls.length && !found; j++) {
      if (walls[i].roomIndex >= walls[j].roomIndex) continue
      const c = mergeCandidate(walls[i], walls[j])
      if (c) found = { i, j, ...c }
    }
    if (!found) break
    const p = walls[found.i], q = walls[found.j]
    const P = unitDir(p), Q = unitDir(q)
    const shift = scale(p.normal, found.gap / 2)
    const start = add(along(p.a, P.dir, found.t0), shift)
    const end = add(along(p.a, P.dir, found.t1), shift)
    // q's overlapping stretch in its own params
    const ua = dot(sub(along(p.a, P.dir, found.t0), q.a), Q.dir), ub = dot(sub(along(p.a, P.dir, found.t1), q.a), Q.dir)
    const u0 = Math.max(0, Math.min(ua, ub)), u1 = Math.min(Q.len, Math.max(ua, ub))

    const floorShift = layout.rooms[q.roomIndex].floorY - layout.rooms[p.roomIndex].floorY
    const fromP = slice(p, found.t0, found.t1).openings
    const fromQ = slice(q, u0, u1).openings.map(o => {
      // re-project q's opening onto p's direction, measured from the partition start
      const s0 = dot(sub(along(q.a, Q.dir, u0 + o.offset), p.a), P.dir) - found!.t0
      const s1 = dot(sub(along(q.a, Q.dir, u0 + o.offset + o.width), p.a), P.dir) - found!.t0
      return { ...o, offset: Math.min(s0, s1), width: Math.abs(s1 - s0), sill: o.sill + floorShift }
    })
    const merged: GeometryWall = {
      a: start, b: end, roomIndex: p.roomIndex, otherRoomIndex: q.roomIndex, shared: true, normal: p.normal, align: 'center',
      openings: normaliseOpenings([...fromP, ...fromQ], found.t1 - found.t0),
    }

    const rest: GeometryWall[] = []
    const keep = (w: GeometryWall, a: number, b: number) => { if (b - a >= MIN_WALL_M) rest.push(slice(w, a, b)) }
    keep(p, 0, found.t0); keep(p, found.t1, P.len)
    keep(q, 0, u0); keep(q, u1, Q.len)
    walls = [...walls.filter((_, k) => k !== found!.i && k !== found!.j), ...rest, merged]
  }
  return walls
}

/**
 * Cut each wall into solid rectangles around its openings: full-height
 * stretches between openings, a lintel from each opening's top to the
 * ceiling, and a piece from the floor up to each raised sill. A shared wall
 * runs from the lower of its two rooms' floors to the lower of their ceilings.
 */
export function wallPieces(
  walls: GeometryWall[],
  ceilingHeightOf: (roomIndex: number) => number,
  floorYOf: (roomIndex: number) => number = () => 0,
): WallPiece[] {
  const pieces: WallPiece[] = []
  for (const w of walls) {
    const { dir, len } = unitDir(w)
    if (len < MIN_WALL_M) continue
    const rooms = w.otherRoomIndex === undefined ? [w.roomIndex] : [w.roomIndex, w.otherRoomIndex]
    const bottom = Math.min(...rooms.map(floorYOf))
    const top = Math.min(...rooms.map(r => floorYOf(r) + ceilingHeightOf(r)))
    const base = floorYOf(w.roomIndex)
    const piece = (t0: number, t1: number, lo: number, hi: number) => {
      if (t1 - t0 > EPS && hi - lo > EPS) {
        pieces.push({ a: along(w.a, dir, t0), b: along(w.a, dir, t1), bottom: lo, top: hi, shared: w.shared, roomIndex: w.roomIndex, normal: w.normal, align: w.align })
      }
    }
    let cursor = 0
    for (const o of normaliseOpenings(w.openings, len)) {
      const lo = Math.min(Math.max(base + o.sill, bottom), top)
      const hi = Math.min(Math.max(base + o.sill + o.height, lo), top)
      piece(cursor, o.offset, bottom, top)
      piece(o.offset, o.offset + o.width, bottom, lo)
      piece(o.offset, o.offset + o.width, hi, top)
      cursor = o.offset + o.width
    }
    piece(cursor, len, bottom, top)
  }
  return pieces
}
