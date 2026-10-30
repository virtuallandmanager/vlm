import { describe, it, expect } from 'vitest'
import type { RoomScanLayout, RoomWall, ScannedRoom } from '@virvixr/shared'
import {
  applyNudges, snapDoors, mergeSharedWalls, wallPieces, wallsFromOutline,
  type GeometryWall, type WallPiece,
} from '../src/room-scan/geometry.js'

const ANCHOR: ScannedRoom['anchor'] = { source: 'quest-mruk', roomId: 'r', floorAnchorId: null, floorPose: { position: [0, 0, 0], yaw: 0 } }

function room(floor: Array<[number, number]>, walls?: RoomWall[], extra: Partial<ScannedRoom> = {}): ScannedRoom {
  return { label: 'Room', floor, floorY: 0, ceilingHeight: 2.5, walls: walls ?? wallsFromOutline(floor), objects: [], anchor: ANCHOR, ...extra }
}

function wall(a: [number, number], b: [number, number], openings: RoomWall['openings'] = [], over: Partial<GeometryWall> = {}): GeometryWall {
  return { a, b, openings, roomIndex: 0, shared: false, normal: [0, -1], align: 'inner', ...over }
}

const ceiling = () => 2.5
const len = (p: WallPiece) => Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1])
const byStart = (ps: WallPiece[]) => [...ps].sort((p, q) => p.a[0] - q.a[0] || p.bottom - q.bottom)

describe('wallPieces', () => {
  it('splits a 4 m wall around a 0.9 x 2.1 m door into left, lintel and right', () => {
    const pieces = byStart(wallPieces([wall([0, 0], [4, 0], [{ kind: 'door', offset: 1, width: 0.9, sill: 0, height: 2.1 }])], ceiling))
    expect(pieces).toHaveLength(3)
    const [left, lintel, right] = pieces
    expect(left.a[0]).toBeCloseTo(0); expect(left.b[0]).toBeCloseTo(1)
    expect(left.bottom).toBeCloseTo(0); expect(left.top).toBeCloseTo(2.5)
    expect(lintel.a[0]).toBeCloseTo(1); expect(lintel.b[0]).toBeCloseTo(1.9)
    expect(lintel.bottom).toBeCloseTo(2.1); expect(lintel.top).toBeCloseTo(2.5)
    expect(right.a[0]).toBeCloseTo(1.9); expect(right.b[0]).toBeCloseTo(4)
    expect(right.bottom).toBeCloseTo(0); expect(right.top).toBeCloseTo(2.5)
    for (const p of pieces) {
      expect(p.normal).toEqual([0, -1]); expect(p.align).toBe('inner'); expect(p.shared).toBe(false); expect(p.roomIndex).toBe(0)
    }
  })

  it('puts a piece under and a piece over a window with a 0.9 m sill', () => {
    const pieces = wallPieces([wall([0, 0], [4, 0], [{ kind: 'window', offset: 1, width: 1.2, sill: 0.9, height: 1.2 }])], ceiling)
    const inGap = pieces.filter(p => p.a[0] > 0.99 && p.b[0] < 2.21)
    expect(inGap).toHaveLength(2)
    const [under, over] = [...inGap].sort((p, q) => p.bottom - q.bottom)
    expect(under.bottom).toBeCloseTo(0); expect(under.top).toBeCloseTo(0.9)
    expect(over.bottom).toBeCloseTo(2.1); expect(over.top).toBeCloseTo(2.5)
    expect(pieces).toHaveLength(4)
  })

  it('uses absolute Y from the room floor', () => {
    const pieces = wallPieces([wall([0, 0], [4, 0], [{ kind: 'door', offset: 1, width: 0.9, sill: 0, height: 2.1 }])], ceiling, () => 3)
    const lintel = pieces.find(p => p.bottom > 3.5)!
    expect(lintel.bottom).toBeCloseTo(5.1); expect(lintel.top).toBeCloseTo(5.5)
    expect(Math.min(...pieces.map(p => p.bottom))).toBeCloseTo(3)
  })

  it('clamps an opening wider than its wall, leaving no negative-width piece', () => {
    const pieces = wallPieces([wall([0, 0], [2, 0], [{ kind: 'opening', offset: 0.5, width: 5, sill: 0, height: 2.1 }])], ceiling)
    for (const p of pieces) expect(len(p)).toBeGreaterThan(0)
    for (const p of pieces) for (const x of [p.a[0], p.b[0]]) { expect(x).toBeGreaterThanOrEqual(-1e-9); expect(x).toBeLessThanOrEqual(2 + 1e-9) }
    const sorted = byStart(pieces)
    expect(sorted).toHaveLength(2)
    expect(sorted[0].b[0]).toBeCloseTo(0.5); expect(sorted[0].top).toBeCloseTo(2.5)
    expect(sorted[1].a[0]).toBeCloseTo(0.5); expect(sorted[1].b[0]).toBeCloseTo(2); expect(sorted[1].bottom).toBeCloseTo(2.1)
  })

  it('merges overlapping openings into one covering both', () => {
    const pieces = byStart(wallPieces([wall([0, 0], [4, 0], [
      { kind: 'window', offset: 1, width: 1, sill: 1, height: 1 },
      { kind: 'window', offset: 1.5, width: 1, sill: 0.8, height: 0.8 },
    ])], ceiling))
    // left solid, under, over, right solid: one opening from 1 to 2.5, Y 0.8..2.0
    expect(pieces).toHaveLength(4)
    const gap = pieces.filter(p => p.a[0] > 0.99 && p.b[0] < 2.51)
    expect(gap.map(p => [p.a[0], p.b[0]])).toEqual([[1, 2.5], [1, 2.5]])
    const [under, over] = [...gap].sort((p, q) => p.bottom - q.bottom)
    expect(under.top).toBeCloseTo(0.8)
    expect(over.bottom).toBeCloseTo(2.0)
  })

  it('drops walls shorter than 0.10 m', () => {
    expect(wallPieces([wall([0, 0], [0.05, 0])], ceiling)).toEqual([])
  })
})

describe('mergeSharedWalls', () => {
  const door = { kind: 'door' as const, offset: 1, width: 0.9, sill: 0, height: 2.1 }
  function sideBySide(gap: number, secondAngleDeg = 0): RoomScanLayout {
    // Room A spans x 0..4; its east wall x=4 runs z 0..3 and carries the door.
    const a = room([[0, 0], [4, 0], [4, 3], [0, 3]], [
      { a: [0, 0], b: [4, 0], openings: [] },
      { a: [4, 0], b: [4, 3], openings: [door] },
      { a: [4, 3], b: [0, 3], openings: [] },
      { a: [0, 3], b: [0, 0], openings: [] },
    ])
    const x0 = 4 + gap
    const t = (secondAngleDeg * Math.PI) / 180
    // Room B's west wall runs from (x0,3) down to (x0,0), optionally rotated about (x0,0).
    const west: [number, number] = [x0 + 3 * Math.sin(t), 3 * Math.cos(t)]
    const b = room([[x0, 0], [x0 + 4, 0], [x0 + 4, 3], [x0, 3]], [
      { a: [x0, 0], b: [x0 + 4, 0], openings: [] },
      { a: [x0 + 4, 0], b: [x0 + 4, 3], openings: [] },
      { a: [x0 + 4, 3], b: west, openings: [] },
      { a: west, b: [x0, 0], openings: [{ kind: 'door', offset: 3 - 1.9, width: 0.9, sill: 0, height: 2.1 }] },
    ])
    return { version: 1, rooms: [a, b] }
  }

  it('merges two side-by-side rooms 0.12 m apart into one shared centred partition and keeps the door', () => {
    const walls = mergeSharedWalls(sideBySide(0.12))
    const shared = walls.filter(w => w.shared)
    expect(shared).toHaveLength(1)
    const s = shared[0]
    expect(s.align).toBe('center')
    expect(s.a[0]).toBeCloseTo(4.06); expect(s.b[0]).toBeCloseTo(4.06)
    expect(Math.abs(s.b[1] - s.a[1])).toBeCloseTo(3)
    expect(s.openings).toHaveLength(1)
    expect(s.openings[0].kind).toBe('door')
    expect(s.openings[0].offset).toBeCloseTo(1); expect(s.openings[0].width).toBeCloseTo(0.9)
    expect(Math.hypot(...s.normal)).toBeCloseTo(1)
    expect(walls).toHaveLength(7)
    const others = walls.filter(w => !w.shared)
    for (const w of others) expect(w.align).toBe('inner')
    // outward normals: room A's south wall faces -z, room B's east wall faces +x
    const southA = others.find(w => w.roomIndex === 0 && w.a[1] === 0 && w.b[1] === 0)!
    expect(southA.normal[0]).toBeCloseTo(0); expect(southA.normal[1]).toBeCloseTo(-1)
    const eastB = others.find(w => w.roomIndex === 1 && Math.abs(w.a[0] - 8.12) < 1e-9 && Math.abs(w.b[0] - 8.12) < 1e-9)!
    expect(eastB.normal[0]).toBeCloseTo(1); expect(eastB.normal[1]).toBeCloseTo(0)
    // one door through the partition: one lintel, and no solid piece where the door is
    const pieces = wallPieces(shared, ceiling)
    expect(pieces.filter(p => p.bottom > 2)).toHaveLength(1)
  })

  it('keeps the non-overlapping remainder of a longer wall as an inner wall', () => {
    const layout = sideBySide(0.12)
    // stretch room A's east wall to z=5: 3 m overlaps room B, 2 m is left over
    layout.rooms[0].walls[1] = { a: [4, 0], b: [4, 5], openings: [] }
    const walls = mergeSharedWalls(layout).filter(w => w.roomIndex === 0 && Math.abs(w.a[0] - 4) < 1e-9 && Math.abs(w.b[0] - 4) < 1e-9)
    expect(walls).toHaveLength(1)
    expect(walls[0].shared).toBe(false)
    expect(Math.min(walls[0].a[1], walls[0].b[1])).toBeCloseTo(3)
    expect(Math.max(walls[0].a[1], walls[0].b[1])).toBeCloseTo(5)
  })

  it("doesn't merge walls 10 degrees apart", () => {
    const walls = mergeSharedWalls(sideBySide(0.12, 10))
    expect(walls.filter(w => w.shared)).toHaveLength(0)
    expect(walls).toHaveLength(8)
  })

  it("doesn't merge walls more than 0.30 m apart", () => {
    expect(mergeSharedWalls(sideBySide(0.4)).filter(w => w.shared)).toHaveLength(0)
  })
})

describe('wallsFromOutline', () => {
  it('gives an L-shaped 6-corner outline 6 walls whose endpoints meet', () => {
    const L: Array<[number, number]> = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]]
    const walls = wallsFromOutline(L)
    expect(walls).toHaveLength(6)
    for (let i = 0; i < 6; i++) {
      expect(walls[i].a).toEqual(L[i])
      expect(walls[i].b).toEqual(walls[(i + 1) % 6].a)
      expect(walls[i].openings).toEqual([])
    }
    // the inner corner at (2,2) gets outward normals on both sides
    const merged = mergeSharedWalls({ version: 1, rooms: [room(L)] })
    expect(merged).toHaveLength(6)
    const at = (a: [number, number]) => merged.find(w => w.a[0] === a[0] && w.a[1] === a[1])!
    expect(at([4, 2]).normal[1]).toBeCloseTo(1) // (4,2)->(2,2) faces +z
    expect(at([2, 2]).normal[0]).toBeCloseTo(1) // (2,2)->(2,4) faces +x
  })
})

describe('snapDoors', () => {
  const zero = () => ({ dx: 0, dz: 0, yaw: 0 })
  function twoRooms(dx: number, dz: number): RoomScanLayout {
    const a = room([[0, 0], [4, 0], [4, 3], [0, 3]], [
      { a: [4, 0], b: [4, 3], openings: [{ kind: 'door', offset: 1, width: 0.9, sill: 0, height: 2.1 }] }, // centre (4, 1.45)
    ])
    const b = room([[4 + dx, dz], [8 + dx, dz], [8 + dx, 3 + dz], [4 + dx, 3 + dz]], [
      { a: [4 + dx, dz], b: [4 + dx, 3 + dz], openings: [{ kind: 'door', offset: 1, width: 0.9, sill: 0, height: 2.1 }] },
    ])
    return { version: 1, rooms: [a, b] }
  }

  it('moves a second room offset by (0.2, 0.1) so its door centre lands on the first room\'s door', () => {
    const layout = twoRooms(0.2, 0.1)
    const nudges = snapDoors(layout, [zero(), zero()])
    expect(nudges[0]).toEqual(zero())
    expect(nudges[1].dx).toBeCloseTo(-0.2); expect(nudges[1].dz).toBeCloseTo(-0.1); expect(nudges[1].yaw).toBe(0)
    const moved = applyNudges(layout, nudges)
    expect(moved.rooms[1].walls[0].a[0]).toBeCloseTo(4); expect(moved.rooms[1].walls[0].a[1]).toBeCloseTo(0)
  })

  it('leaves rooms whose doors are more than 0.25 m apart alone', () => {
    const nudges = snapDoors(twoRooms(0.2, 0.2), [zero(), zero()])
    expect(nudges).toEqual([zero(), zero()])
  })

  it('snaps on top of an existing nudge', () => {
    const nudges = snapDoors(twoRooms(0.5, 0), [zero(), { dx: -0.4, dz: 0, yaw: 0 }])
    expect(nudges[1].dx).toBeCloseTo(-0.5); expect(nudges[1].dz).toBeCloseTo(0)
  })
})

describe('applyNudges', () => {
  it('rotates a room by yaw 90 about its floor centroid and translates it', () => {
    const layout: RoomScanLayout = { version: 1, rooms: [room([[0, 0], [4, 0], [4, 2], [0, 2]], undefined, {
      objects: [{ label: 'table', center: [3, 0.4, 1], size: [1, 0.8, 1], yaw: 10 }],
    })] }
    const out = applyNudges(layout, [{ dx: 0, dz: 0, yaw: 90 }])
    const r = out.rooms[0]
    // centroid (2,1); a 4 x 2 room becomes 2 x 4 about it
    const xs = r.floor.map(p => p[0]), zs = r.floor.map(p => p[1])
    expect(Math.min(...xs)).toBeCloseTo(1); expect(Math.max(...xs)).toBeCloseTo(3)
    expect(Math.min(...zs)).toBeCloseTo(-1); expect(Math.max(...zs)).toBeCloseTo(3)
    // walls and objects move with the floor
    expect(r.walls[0].a[0]).toBeCloseTo(r.floor[0][0]); expect(r.walls[0].a[1]).toBeCloseTo(r.floor[0][1])
    const c = r.objects[0].center
    expect(Math.hypot(c[0] - 2, c[2] - 1)).toBeCloseTo(1)
    // +yaw turns +x towards -z (right-handed, Y up), so (3,1) lands on (2,0)
    expect(c[0]).toBeCloseTo(2); expect(c[1]).toBeCloseTo(0.4); expect(c[2]).toBeCloseTo(0)
    expect(r.objects[0].yaw).toBeCloseTo(100)
    // input untouched
    expect(layout.rooms[0].floor[1]).toEqual([4, 0])

    const shifted = applyNudges(layout, [{ dx: 1, dz: -2, yaw: 0 }])
    expect(shifted.rooms[0].floor[0]).toEqual([1, -2])
  })
})
