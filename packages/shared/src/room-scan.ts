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
/** A floor outline enclosing less than this many square metres is degenerate. */
export const MIN_FLOOR_AREA_M2 = 0.01
/** Upload size caps: anything larger is refused as invalid_layout. */
export const ROOM_SCAN_LIMITS = { rooms: 32, floorPoints: 256, walls: 256, openingsPerWall: 32, objects: 256 } as const

/** A room set's exterior style. */
export type RoomStyle = 'house' | 'storefront' | 'plain' | 'dollhouse'
/** A room set's look: exterior style, interior finishes, ceiling and furniture blocks. */
export interface RoomSetOptions { style: RoomStyle; wallColor: string; floorColor: string; ceiling: boolean; furniture: boolean; signText?: string }
export const DEFAULT_ROOM_SET_OPTIONS: RoomSetOptions = { style: 'plain', wallColor: '#E8E6E1', floorColor: '#B9A68C', ceiling: false, furniture: false }

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

/** Reports `path` when `v` is an array longer than `max`; true when within the cap. */
function withinCap(v: unknown, max: number, path: string, what: string, errors: string[]): boolean {
  if (Array.isArray(v) && v.length > max) {
    errors.push(`${path} must contain at most ${max} ${what}`)
    return false
  }
  return true
}

/** Absolute shoelace area of a floor outline, square metres. */
function polygonArea(points: Array<[number, number]>): number {
  let twice = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i]
    const [x2, z2] = points[(i + 1) % points.length]
    twice += x1 * z2 - x2 * z1
  }
  return Math.abs(twice) / 2
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
  if (!withinCap(v.openings, ROOM_SCAN_LIMITS.openingsPerWall, `${path}.openings`, 'openings', errors)) return null
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
  else if (withinCap(v.floor, ROOM_SCAN_LIMITS.floorPoints, `${path}.floor`, 'points', errors)) floor = v.floor.map((p, i) => tuple(p, 2, `${path}.floor[${i}]`, errors))
  const floorY = num(v.floorY, `${path}.floorY`, errors)
  const ceilingHeight = num(v.ceilingHeight, `${path}.ceilingHeight`, errors)
  if (Number.isFinite(ceilingHeight) && typeof v.ceilingHeight === 'number' && (ceilingHeight < MIN_CEILING_M || ceilingHeight > MAX_CEILING_M)) {
    errors.push(`${path}.ceilingHeight must be between ${MIN_CEILING_M} and ${MAX_CEILING_M} m`)
  }
  const walls: RoomWall[] = []
  if (!Array.isArray(v.walls)) errors.push(`${path}.walls must be an array`)
  else if (withinCap(v.walls, ROOM_SCAN_LIMITS.walls, `${path}.walls`, 'walls', errors)) v.walls.forEach((w, i) => { const p = parseWall(w, `${path}.walls[${i}]`, errors); if (p) walls.push(p) })
  const objects: RoomObject[] = []
  if (!Array.isArray(v.objects)) errors.push(`${path}.objects must be an array`)
  else if (withinCap(v.objects, ROOM_SCAN_LIMITS.objects, `${path}.objects`, 'objects', errors)) v.objects.forEach((o, i) => { const p = parseObject(o, `${path}.objects[${i}]`, errors); if (p) objects.push(p) })
  const anchor = parseAnchor(v.anchor, `${path}.anchor`, errors)
  return { label, floor, floorY, ceilingHeight, walls, objects, anchor }
}

/**
 * Check an untrusted upload and return a normalised layout: walls under
 * 0.10 m are dropped and opening offsets/widths are clamped into their wall.
 * Errors name the offending field, e.g. `rooms[0].ceilingHeight`. A scan where
 * no room keeps a wall or a usable floor (area over MIN_FLOOR_AREA_M2) is
 * refused with an `empty_scan` error; one over ROOM_SCAN_LIMITS names the
 * array that is too long.
 */
export function validateLayout(input: unknown): { ok: true; layout: RoomScanLayout } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isObj(input)) return { ok: false, errors: ['layout must be an object'] }
  if (input.version !== 1) errors.push('version must be 1')
  const rooms: ScannedRoom[] = []
  if (!Array.isArray(input.rooms)) errors.push('rooms must be an array')
  else if (input.rooms.length === 0) errors.push('empty_scan: rooms must contain at least one room')
  else if (withinCap(input.rooms, ROOM_SCAN_LIMITS.rooms, 'rooms', 'rooms', errors)) {
    input.rooms.forEach((r, i) => { const p = parseRoom(r, `rooms[${i}]`, errors); if (p) rooms.push(p) })
  }
  if (errors.length) return { ok: false, errors }
  const usable = rooms.some((r) => r.walls.length > 0 || polygonArea(r.floor) > MIN_FLOOR_AREA_M2)
  if (!usable) return { ok: false, errors: ['empty_scan: no room has a wall or a usable floor'] }
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
