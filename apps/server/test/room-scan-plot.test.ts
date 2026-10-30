import { describe, it, expect } from 'vitest'
import { NodeIO } from '@gltf-transform/core'
import { getBounds } from '@gltf-transform/functions'
import type { RoomScanLayout, ScannedRoom } from '@virvixr/shared'
import { buildRoomSetGlb, DEFAULT_ROOM_SET_OPTIONS, type RoomStyle } from '../src/room-scan/build-glb.js'
import { wallsFromOutline } from '../src/room-scan/geometry.js'
import { plotForLayout } from '../src/room-scan/plot.js'
import { outerShellBounds } from '../src/room-scan/shell.js'

const ANCHOR: ScannedRoom['anchor'] = { source: 'quest-mruk', roomId: 'r', floorAnchorId: null, floorPose: { position: [0, 0, 0], yaw: 0 } }
function rect(w: number, d: number): RoomScanLayout {
  const floor: Array<[number, number]> = [[0, 0], [w, 0], [w, d], [0, d]]
  return { version: 1, rooms: [{ label: 'Room', floor, floorY: 0, ceilingHeight: 2.5, walls: wallsFromOutline(floor), objects: [], anchor: ANCHOR }] }
}
function diamond(half: number): RoomScanLayout {
  const floor: Array<[number, number]> = [[half, 0], [2 * half, half], [half, 2 * half], [0, half]]
  return { version: 1, rooms: [{ label: 'Diamond', floor, floorY: 0, ceilingHeight: 2.5, walls: wallsFromOutline(floor), objects: [], anchor: ANCHOR }] }
}

describe('plotForLayout', () => {
  it('fits a 4 x 3 room on one parcel', () => {
    expect(plotForLayout(rect(4, 3))).toEqual({ width: 1, depth: 1, base: { x: 0, y: 0 } })
  })

  it('grows to 2 x 2 when walls and margins pass 16 m (15.5 + 0.12 + 1 = 16.62)', () => {
    expect(plotForLayout(rect(15.5, 4))).toEqual({ width: 2, depth: 2, base: { x: 0, y: 0 } })
  })

  it('returns null when the room is wider than the largest plot', () => {
    expect(plotForLayout(rect(10 * 16, 4))).toBeNull()
  })

  it('sizes a 45-degree room from its mitred outer shell, matching the generated bbox', async () => {
    const layout = diamond(7) // 14 m diagonal; side ~9.9 m
    const b = outerShellBounds(layout)
    const out = await buildRoomSetGlb(layout, DEFAULT_ROOM_SET_OPTIONS)
    expect(b.maxX - b.minX).toBeCloseTo(out.bbox.x, 3)
    expect(b.maxZ - b.minZ).toBeCloseTo(out.bbox.z, 3)
    // Mitred corners reach past footprint + 2T (14.24): 14 + 2 * 0.12 * sqrt(2).
    expect(b.maxX - b.minX).toBeGreaterThan(14.3)
    expect(plotForLayout(layout)).toEqual({ width: 1, depth: 1, base: { x: 0, y: 0 } })
    // 15.2 m of shell + 1 m of margin crosses 16 m only because of the mitres.
    const wide = diamond(7.4)
    expect(outerShellBounds(wide).maxX - outerShellBounds(wide).minX).toBeGreaterThan(15.0)
    expect(plotForLayout(wide)?.width).toBe(2)
  })
})

describe('outerShellBounds parity with the generator', () => {
  /** Two 4 x 3 rooms sharing a wall, with a front door on the first room. */
  function twoRooms(): RoomScanLayout {
    const a: Array<[number, number]> = [[0, 0], [4, 0], [4, 3], [0, 3]]
    const b: Array<[number, number]> = [[4.1, 0], [8, 0], [8, 3], [4.1, 3]]
    const wa = wallsFromOutline(a)
    wa[0].openings = [{ kind: 'door', offset: 1, width: 0.9, sill: 0, height: 2.1 }]
    return { version: 1, rooms: [
      { label: 'A', floor: a, floorY: 0, ceilingHeight: 2.5, walls: wa, objects: [], anchor: ANCHOR },
      { label: 'B', floor: b, floorY: 0, ceilingHeight: 2.5, walls: wallsFromOutline(b), objects: [], anchor: ANCHOR },
    ] }
  }

  for (const style of ['plain', 'house', 'storefront', 'dollhouse'] as RoomStyle[]) {
    it(`${style}: the wall shell extents equal the plot's shell bounds within 1 mm`, async () => {
      const layout = twoRooms()
      const out = await buildRoomSetGlb(layout, { ...DEFAULT_ROOM_SET_OPTIONS, style })
      const doc = await new NodeIO().readBinary(new Uint8Array(out.glb))
      const walls = doc.getRoot().listNodes().find(n => n.getName() === 'walls')!
      const { min, max } = getBounds(walls)
      const b = outerShellBounds(layout)
      expect(max[0] - min[0]).toBeCloseTo(b.maxX - b.minX, 3)
      expect(max[2] - min[2]).toBeCloseTo(b.maxZ - b.minZ, 3)
      expect(min[0]).toBeCloseTo(0.5, 3)
      expect(min[2]).toBeCloseTo(0.5, 3)
    })
  }
})
