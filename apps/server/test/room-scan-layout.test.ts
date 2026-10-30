import { describe, it, expect } from 'vitest'
import { validateLayout, layoutFootprint, type RoomScanLayout } from '@virvixr/shared'

function fixture(): any {
  return {
    version: 1,
    rooms: [{
      label: 'Living room',
      floor: [[0, 0], [4, 0], [4, 3], [0, 3]],
      floorY: 0,
      ceilingHeight: 2.5,
      walls: [
        { a: [0, 0], b: [4, 0], openings: [{ kind: 'door', offset: 1, width: 0.9, sill: 0, height: 2.0 }] },
        { a: [4, 0], b: [4, 3], openings: [] },
        { a: [4, 3], b: [0, 3], openings: [] },
        { a: [0, 3], b: [0, 0], openings: [] },
      ],
      objects: [],
      anchor: { source: 'quest-mruk', roomId: 'room-1', floorAnchorId: null, floorPose: { position: [0, 0, 0], yaw: 0 } },
    }],
  }
}

function errorsOf(input: unknown): string[] {
  const r = validateLayout(input)
  if (r.ok) throw new Error('expected rejection')
  return r.errors
}

describe('validateLayout', () => {
  it('accepts a 4 x 3 m one-room fixture with one door', () => {
    const r = validateLayout(fixture())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.layout.rooms[0].walls).toHaveLength(4)
      expect(r.layout.rooms[0].walls[0].openings[0].kind).toBe('door')
    }
  })

  it('drops walls shorter than 0.10 m', () => {
    const f = fixture()
    f.rooms[0].walls.push({ a: [1, 1], b: [1.05, 1], openings: [] })
    const r = validateLayout(f)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.layout.rooms[0].walls).toHaveLength(4)
  })

  it('clamps opening offset and width into the wall', () => {
    const f = fixture()
    f.rooms[0].walls[1].openings = [
      { kind: 'window', offset: 2.5, width: 2, sill: 0.9, height: 1 },
      { kind: 'opening', offset: -1, width: 1, sill: 0, height: 2 },
      { kind: 'door', offset: 9, width: 1, sill: 0, height: 2 },
    ]
    const r = validateLayout(f)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const [w, o, d] = r.layout.rooms[0].walls[1].openings
      expect(w.offset).toBeCloseTo(2.5); expect(w.width).toBeCloseTo(0.5)
      expect(o.offset).toBe(0); expect(o.width).toBeCloseTo(1)
      expect(d.offset).toBeCloseTo(3); expect(d.width).toBe(0)
    }
  })

  it('rejects version other than 1', () => {
    const f = fixture(); f.version = 2
    expect(errorsOf(f).some(e => e.includes('version'))).toBe(true)
  })

  it('rejects a room with fewer than 3 floor points', () => {
    const f = fixture(); f.rooms[0].floor = [[0, 0], [1, 0]]
    expect(errorsOf(f).some(e => e.includes('rooms[0].floor'))).toBe(true)
  })

  it('rejects non-finite numbers', () => {
    const f = fixture(); f.rooms[0].floorY = Infinity
    expect(errorsOf(f).some(e => e.includes('rooms[0].floorY'))).toBe(true)
    const g = fixture(); g.rooms[0].floor[1] = [NaN, 0]
    expect(errorsOf(g).some(e => e.includes('rooms[0].floor[1]'))).toBe(true)
  })

  it('rejects a ceiling height outside 1.8 to 8 m', () => {
    for (const h of [1.7, 8.1]) {
      const f = fixture(); f.rooms[0].ceilingHeight = h
      expect(errorsOf(f).some(e => e.includes('rooms[0].ceilingHeight'))).toBe(true)
    }
  })

  it('rejects an empty scan', () => {
    expect(errorsOf({ version: 1, rooms: [] }).some(e => e.includes('empty_scan'))).toBe(true)
    expect(errorsOf({ rooms: [] }).some(e => e.includes('empty_scan'))).toBe(true)
  })

  it('rejects a scan with no surviving wall and no usable floor as empty_scan', () => {
    const f = fixture()
    f.rooms[0].floor = [[0, 0], [0.05, 0], [0.05, 0.05]]
    f.rooms[0].walls = [{ a: [0, 0], b: [0.05, 0], openings: [] }]
    expect(errorsOf(f).some(e => e.includes('empty_scan'))).toBe(true)
    const collinear = fixture()
    collinear.rooms[0].floor = [[0, 0], [1, 0], [2, 0]]
    collinear.rooms[0].walls = []
    expect(errorsOf(collinear).some(e => e.includes('empty_scan'))).toBe(true)
  })

  it('accepts a scan when a room keeps a wall or a usable floor', () => {
    const wallsOnly = fixture(); wallsOnly.rooms[0].floor = [[0, 0], [1, 0], [2, 0]]
    expect(validateLayout(wallsOnly).ok).toBe(true)
    const floorOnly = fixture(); floorOnly.rooms[0].walls = []
    expect(validateLayout(floorOnly).ok).toBe(true)
  })

  it('caps rooms, floor points, walls, openings and objects, naming the field', () => {
    const many = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i))
    const rooms = fixture(); rooms.rooms = many(33, () => fixture().rooms[0])
    expect(errorsOf(rooms).some(e => e.startsWith('rooms ') && e.includes('32'))).toBe(true)
    const floor = fixture(); floor.rooms[0].floor = many(257, (i) => [Math.cos(i / 40), Math.sin(i / 40)])
    expect(errorsOf(floor).some(e => e.startsWith('rooms[0].floor ') && e.includes('256'))).toBe(true)
    const walls = fixture(); walls.rooms[0].walls = many(257, () => fixture().rooms[0].walls[1])
    expect(errorsOf(walls).some(e => e.startsWith('rooms[0].walls ') && e.includes('256'))).toBe(true)
    const openings = fixture(); openings.rooms[0].walls[0].openings = many(33, () => ({ kind: 'window', offset: 0, width: 0.1, sill: 1, height: 1 }))
    expect(errorsOf(openings).some(e => e.startsWith('rooms[0].walls[0].openings ') && e.includes('32'))).toBe(true)
    const objects = fixture(); objects.rooms[0].objects = many(257, () => ({ label: 'box', center: [1, 0.5, 1], size: [1, 1, 1], yaw: 0 }))
    expect(errorsOf(objects).some(e => e.startsWith('rooms[0].objects ') && e.includes('256'))).toBe(true)
    const atCaps = fixture()
    atCaps.rooms = many(32, () => fixture().rooms[0])
    atCaps.rooms[0].walls[0].openings = many(32, () => ({ kind: 'window', offset: 0, width: 0.1, sill: 1, height: 1 }))
    atCaps.rooms[0].objects = many(256, () => ({ label: 'box', center: [1, 0.5, 1], size: [1, 1, 1], yaw: 0 }))
    expect(validateLayout(atCaps).ok).toBe(true)
  })

  it('rejects a wall with missing or non-array openings', () => {
    const f = fixture(); delete f.rooms[0].walls[0].openings
    expect(errorsOf(f).some(e => e.includes('rooms[0].walls[0].openings'))).toBe(true)
    const g = fixture(); g.rooms[0].walls[1].openings = 'x'
    expect(errorsOf(g).some(e => e.includes('rooms[0].walls[1].openings'))).toBe(true)
  })

  it('rejects an invalid opening kind', () => {
    const f = fixture(); f.rooms[0].walls[0].openings[0].kind = 'portal'
    expect(errorsOf(f).some(e => e.includes('rooms[0].walls[0].openings[0].kind'))).toBe(true)
  })

  it('rejects invalid anchor fields', () => {
    const a = fixture(); a.rooms[0].anchor.source = 'hololens'
    expect(errorsOf(a).some(e => e.includes('rooms[0].anchor.source'))).toBe(true)
    const b = fixture(); delete b.rooms[0].anchor.roomId
    expect(errorsOf(b).some(e => e.includes('rooms[0].anchor.roomId'))).toBe(true)
    const c = fixture(); c.rooms[0].anchor.floorPose.yaw = NaN
    expect(errorsOf(c).some(e => e.includes('rooms[0].anchor.floorPose.yaw'))).toBe(true)
    const d = fixture(); d.rooms[0].anchor.floorPose.position = [0, Infinity, 0]
    expect(errorsOf(d).some(e => e.includes('rooms[0].anchor.floorPose.position[1]'))).toBe(true)
  })

  it('rejects non-object input', () => {
    expect(validateLayout(null).ok).toBe(false)
    expect(validateLayout('x').ok).toBe(false)
  })
})

describe('layoutFootprint', () => {
  it('returns the floor bounds of the 4 x 3 m fixture', () => {
    const r = validateLayout(fixture())
    if (!r.ok) throw new Error('fixture invalid')
    expect(layoutFootprint(r.layout as RoomScanLayout)).toEqual({ minX: 0, minZ: 0, maxX: 4, maxZ: 3 })
  })
})
