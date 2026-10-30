/**
 * Room scan layout: the device-neutral description of a scanned space that a
 * headset uploads and the generator turns into a 3D set. Metres, Y up, one
 * shared frame; x,z pairs are floor-plane coordinates.
 */

/** A door, window or gap in a wall. `offset` is metres from the wall's start to the opening's near edge. */
export interface RoomOpening { kind: 'door' | 'window' | 'opening'; offset: number; width: number; sill: number; height: number }
/** A wall segment between two floor-plane endpoints. */
export interface RoomWall { a: [number, number]; b: [number, number]; openings: RoomOpening[] }
/** A labelled furniture box; `yaw` is in degrees. */
export interface RoomObject { label: string; center: [number, number, number]; size: [number, number, number]; yaw: number }
/** Where the room sits in the device's own tracking space. */
export interface RoomAnchor { source: 'quest-mruk' | 'ios-roomplan'; roomId: string; floorAnchorId: string | null; floorPose: { position: [number, number, number]; yaw: number } }
/** One scanned room: floor outline, walls, furniture and its anchor. */
export interface ScannedRoom { label: string; floor: Array<[number, number]>; floorY: number; ceilingHeight: number; walls: RoomWall[]; objects: RoomObject[]; anchor: RoomAnchor }
/** A whole scan: every room in one shared frame. */
export interface RoomScanLayout { version: 1; rooms: ScannedRoom[] }

/** Walls shorter than this many metres are degenerate and dropped. */
export const MIN_WALL_LENGTH_M = 0.1
/** Accepted ceiling height range, metres. */
export const MIN_CEILING_M = 1.8
export const MAX_CEILING_M = 8

const OPENING_KINDS: RoomOpening['kind'][] = ['door', 'window', 'opening']
const ANCHOR_SOURCES: RoomAnchor['source'][] = ['quest-mruk', 'ios-roomplan']

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown, path: string, errors: string[]): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push(`${path} must be a finite number`)
    return 0
  }
  return v
}

function tuple(v: unknown, n: 2, path: string, errors: string[]): [number, number]
function tuple(v: unknown, n: 3, path: string, errors: string[]): [number, number, number]
function tuple(v: unknown, n: number, path: string, errors: string[]): number[] {
  if (!Array.isArray(v) || v.length !== n) {
    errors.push(`${path} must be an array of ${n} numbers`)
    return new Array(n).fill(0)
  }
  return v.map((x, i) => num(x, `${path}[${i}]`, errors))
}

function str(v: unknown, path: string, errors: string[]): string {
  if (typeof v !== 'string') {
    errors.push(`${path} must be a string`)
    return ''
  }
  return v
}

function parseOpening(v: unknown, path: string, wallLen: number, errors: string[]): RoomOpening | null {
  if (!isObj(v)) { errors.push(`${path} must be an object`); return null }
  const kind = OPENING_KINDS.find(k => k === v.kind)
  if (!kind) errors.push(`${path}.kind must be door, window or opening`)
  const offset = num(v.offset, `${path}.offset`, errors)
  const width = num(v.width, `${path}.width`, errors)
  const sill = num(v.sill, `${path}.sill`, errors)
  const height = num(v.height, `${path}.height`, errors)
  if (!kind) return null
  const clampedOffset = Math.min(Math.max(offset, 0), wallLen)
  const clampedWidth = Math.min(Math.max(width, 0), wallLen - clampedOffset)
  return { kind, offset: clampedOffset, width: clampedWidth, sill, height }
}

function parseWall(v: unknown, path: string, errors: string[]): RoomWall | null {
  if (!isObj(v)) { errors.push(`${path} must be an object`); return null }
  const a = tuple(v.a, 2, `${path}.a`, errors)
  const b = tuple(v.b, 2, `${path}.b`, errors)
  if (!Array.isArray(v.openings)) { errors.push(`${path}.openings must be an array`); return null }
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const openings: RoomOpening[] = []
  v.openings.forEach((o, i) => {
    const parsed = parseOpening(o, `${path}.openings[${i}]`, len, errors)
    if (parsed) openings.push(parsed)
  })
  // Degenerate walls are dropped silently; they are scan noise, not caller error.
  if (len < MIN_WALL_LENGTH_M) return null
  return { a, b, openings }
}

function parseObject(v: unknown, path: string, errors: string[]): RoomObject | null {
  if (!isObj(v)) { errors.push(`${path} must be an object`); return null }
  return {
    label: str(v.label, `${path}.label`, errors),
    center: tuple(v.center, 3, `${path}.center`, errors),
    size: tuple(v.size, 3, `${path}.size`, errors),
    yaw: num(v.yaw, `${path}.yaw`, errors),
  }
}

function parseAnchor(v: unknown, path: string, errors: string[]): RoomAnchor {
  const fallback: RoomAnchor = { source: 'quest-mruk', roomId: '', floorAnchorId: null, floorPose: { position: [0, 0, 0], yaw: 0 } }
  if (!isObj(v)) { errors.push(`${path} must be an object`); return fallback }
  const source = ANCHOR_SOURCES.find(k => k === v.source)
  if (!source) errors.push(`${path}.source must be quest-mruk or ios-roomplan`)
  const roomId = str(v.roomId, `${path}.roomId`, errors)
  if (v.floorAnchorId !== null && typeof v.floorAnchorId !== 'string') errors.push(`${path}.floorAnchorId must be a string or null`)
  const pose = isObj(v.floorPose) ? v.floorPose : (errors.push(`${path}.floorPose must be an object`), {})
  return {
    source: source ?? fallback.source, // only reached with errors recorded; result is discarded
    roomId,
    floorAnchorId: typeof v.floorAnchorId === 'string' ? v.floorAnchorId : null,
    floorPose: { position: tuple(pose.position, 3, `${path}.floorPose.position`, errors), yaw: num(pose.yaw, `${path}.floorPose.yaw`, errors) },
  }
}

function parseRoom(v: unknown, path: string, errors: string[]): ScannedRoom | null {
  if (!isObj(v)) { errors.push(`${path} must be an object`); return null }
  const label = str(v.label, `${path}.label`, errors)
  let floor: Array<[number, number]> = []
  if (!Array.isArray(v.floor) || v.floor.length < 3) errors.push(`${path}.floor must have at least 3 points`)
  else floor = v.floor.map((p, i) => tuple(p, 2, `${path}.floor[${i}]`, errors))
  const floorY = num(v.floorY, `${path}.floorY`, errors)
  const ceilingHeight = num(v.ceilingHeight, `${path}.ceilingHeight`, errors)
  if (Number.isFinite(ceilingHeight) && typeof v.ceilingHeight === 'number' && (ceilingHeight < MIN_CEILING_M || ceilingHeight > MAX_CEILING_M)) {
    errors.push(`${path}.ceilingHeight must be between ${MIN_CEILING_M} and ${MAX_CEILING_M} m`)
  }
  const walls: RoomWall[] = []
  if (!Array.isArray(v.walls)) errors.push(`${path}.walls must be an array`)
  else v.walls.forEach((w, i) => { const p = parseWall(w, `${path}.walls[${i}]`, errors); if (p) walls.push(p) })
  const objects: RoomObject[] = []
  if (!Array.isArray(v.objects)) errors.push(`${path}.objects must be an array`)
  else v.objects.forEach((o, i) => { const p = parseObject(o, `${path}.objects[${i}]`, errors); if (p) objects.push(p) })
  const anchor = parseAnchor(v.anchor, `${path}.anchor`, errors)
  return { label, floor, floorY, ceilingHeight, walls, objects, anchor }
}

/**
 * Check an untrusted upload and return a normalised layout: walls under
 * 0.10 m are dropped and opening offsets/widths are clamped into their wall.
 * Errors name the offending field, e.g. `rooms[0].ceilingHeight`.
 */
export function validateLayout(input: unknown): { ok: true; layout: RoomScanLayout } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isObj(input)) return { ok: false, errors: ['layout must be an object'] }
  if (input.version !== 1) errors.push('version must be 1')
  const rooms: ScannedRoom[] = []
  if (!Array.isArray(input.rooms)) errors.push('rooms must be an array')
  else if (input.rooms.length === 0) errors.push('empty_scan: rooms must contain at least one room')
  else input.rooms.forEach((r, i) => { const p = parseRoom(r, `rooms[${i}]`, errors); if (p) rooms.push(p) })
  if (errors.length) return { ok: false, errors }
  return { ok: true, layout: { version: 1, rooms } }
}

/** Axis-aligned bounds of every room's floor outline (walls and objects excluded). */
export function layoutFootprint(layout: RoomScanLayout): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
  for (const room of layout.rooms) {
    for (const [x, z] of room.floor) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
  }
  return { minX, minZ, maxX, maxZ }
}
