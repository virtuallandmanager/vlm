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
