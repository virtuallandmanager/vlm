import { describe, it, expect } from 'vitest'
import { NodeIO, type Document, type Node, type Primitive } from '@gltf-transform/core'
import { getBounds } from '@gltf-transform/functions'
import type { RoomOpening, RoomScanLayout, RoomWall, ScannedRoom } from '@virvixr/shared'
import { glbStats } from '../src/catalog/glb-stats.js'
import { buildRoomSetGlb, DEFAULT_ROOM_SET_OPTIONS, type RoomSetOptions, type RoomStyle } from '../src/room-scan/build-glb.js'
import { wallsFromOutline } from '../src/room-scan/geometry.js'

const ANCHOR: ScannedRoom['anchor'] = { source: 'quest-mruk', roomId: 'r', floorAnchorId: null, floorPose: { position: [0, 0, 0], yaw: 0 } }
const STYLES: RoomStyle[] = ['house', 'storefront', 'plain', 'dollhouse']
const DOOR: RoomOpening = { kind: 'door', offset: 1, width: 0.9, sill: 0, height: 2.1 }
const WINDOW: RoomOpening = { kind: 'window', offset: 1, width: 1.2, sill: 0.9, height: 1.2 }

function room(floor: Array<[number, number]>, walls?: RoomWall[], extra: Partial<ScannedRoom> = {}): ScannedRoom {
  return { label: 'Room', floor, floorY: 0, ceilingHeight: 2.5, walls: walls ?? wallsFromOutline(floor), objects: [], anchor: ANCHOR, ...extra }
}

const RECT: Array<[number, number]> = [[0, 0], [4, 0], [4, 3], [0, 3]]
/** A 4 x 3 x 2.5 m room with a door on its first wall and a window on its second. */
function room43(extra: Partial<ScannedRoom> = {}): RoomScanLayout {
  const walls = wallsFromOutline(RECT)
  walls[0].openings = [DOOR]
  walls[1].openings = [WINDOW]
  return { version: 1, rooms: [room(RECT, walls, extra)] }
}

const opts = (over: Partial<RoomSetOptions> = {}): RoomSetOptions => ({ ...DEFAULT_ROOM_SET_OPTIONS, ...over })
const read = (glb: Buffer): Promise<Document> => new NodeIO().readBinary(new Uint8Array(glb))

function nodes(doc: Document): Node[] { return doc.getRoot().listNodes() }
function node(doc: Document, name: string): Node | undefined { return nodes(doc).find(n => n.getName() === name) }
function prims(doc: Document, material: string): Primitive[] {
  return doc.getRoot().listMeshes().flatMap(m => m.listPrimitives()).filter(p => p.getMaterial()?.getName() === material)
}
function vertexCount(doc: Document, material: string): number {
  return prims(doc, material).reduce((s, p) => s + (p.getAttribute('POSITION')?.getCount() ?? 0), 0)
}
function triangleArea(p: Primitive): number {
  const pos = p.getAttribute('POSITION')!, idx = p.getIndices()!
  const v = (i: number) => pos.getElement(idx.getScalar(i), [0, 0, 0])
  let area = 0
  for (let i = 0; i < idx.getCount(); i += 3) {
    const a = v(i), b = v(i + 1), c = v(i + 2)
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    area += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2
  }
  return area
}

function upFacingArea(p: Primitive): number {
  const pos = p.getAttribute('POSITION')!, nor = p.getAttribute('NORMAL')!, idx = p.getIndices()!
  let area = 0
  for (let i = 0; i < idx.getCount(); i += 3) {
    const [a, b, c] = [0, 1, 2].map(k => pos.getElement(idx.getScalar(i + k), [0, 0, 0]))
    if (nor.getElement(idx.getScalar(i), [0, 0, 0])[1] < 0.99) continue
    area += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2
  }
  return area
}

describe('buildRoomSetGlb', () => {
  it('defaults to plain, the global interior colours, no ceiling and no furniture', () => {
    expect(DEFAULT_ROOM_SET_OPTIONS).toEqual({ style: 'plain', wallColor: '#E8E6E1', floorColor: '#B9A68C', ceiling: false, furniture: false })
  })

  it('builds a 4 x 3 x 2.5 m plain room whose walls extrude outward: 4.24 x 3.24, 2.5 m plus a 0.1 m roof', async () => {
    const out = await buildRoomSetGlb(room43(), opts({ style: 'plain' }))
    const stats = await glbStats(out.glb)
    expect(stats.bbox.x).toBeCloseTo(4.24, 2)
    expect(stats.bbox.z).toBeCloseTo(3.24, 2)
    expect(stats.bbox.y).toBeCloseTo(2.6, 2)
    expect(out.bbox).toEqual(stats.bbox)
    expect(out.triangles).toBe(stats.triangles)
  })

  it('closes the outer corners: wall geometry reaches every outer corner exactly, with no overshoot', async () => {
    const doc = await read((await buildRoomSetGlb(room43(), opts({ style: 'dollhouse' }))).glb)
    const { min, max } = getBounds(node(doc, 'walls')!)
    expect(min[0]).toBeCloseTo(0.5, 5); expect(min[2]).toBeCloseTo(0.5, 5)
    expect(max[0]).toBeCloseTo(4.74, 5); expect(max[2]).toBeCloseTo(3.74, 5)
    // every outer corner of the 4.24 x 3.24 shell has exterior geometry on it
    const outer = prims(doc, 'exterior-dollhouse')
    const pts: number[][] = outer.flatMap(p => {
      const a = p.getAttribute('POSITION')!
      return Array.from({ length: a.getCount() }, (_, i) => a.getElement(i, [0, 0, 0]))
    })
    for (const [x, z] of [[0.5, 0.5], [4.74, 0.5], [4.74, 3.74], [0.5, 3.74]]) {
      expect(pts.some(p => Math.abs(p[0] - x) < 1e-4 && Math.abs(p[2] - z) < 1e-4)).toBe(true)
    }
  })

  it('offsets the set so the outer wall faces start at the 0.5 m margin: {0.62, 0.62} for an outline at (0,0)', async () => {
    expect((await buildRoomSetGlb(room43(), opts())).offset).toEqual({ x: expect.closeTo(0.62, 6), y: 0, z: expect.closeTo(0.62, 6) })
    const moved: Array<[number, number]> = RECT.map(([x, z]) => [x + 2, z + 1])
    expect((await buildRoomSetGlb({ version: 1, rooms: [room(moved)] }, opts())).offset).toEqual({ x: expect.closeTo(-1.38, 6), y: 0, z: expect.closeTo(-0.38, 6) })
  })

  it('applies nudges before placing the set', async () => {
    const out = await buildRoomSetGlb(room43(), opts(), [{ dx: 1, dz: -2, yaw: 0 }])
    expect(out.offset).toEqual({ x: expect.closeTo(-0.38, 6), y: 0, z: expect.closeTo(2.62, 6) })
  })

  it('lifts or lowers the set so the lowest room floor sits at y = 0, and reports it in offset.y', async () => {
    const out = await buildRoomSetGlb(room43({ floorY: -1.3 }), opts())
    expect(out.offset.y).toBeCloseTo(1.3, 6)
    const doc = await read(out.glb)
    expect(getBounds(doc.getRoot().getDefaultScene()!).min[1]).toBeCloseTo(0, 5)
    expect(getBounds(node(doc, 'walls')!).max[1]).toBeCloseTo(2.5, 5)
    // the floor is lifted 1 cm off the ground so it doesn't z-fight it
    expect(getBounds(node(doc, 'floor')!).max[1]).toBeCloseTo(0.01, 5)
  })

  it('never gives dollhouse a ceiling', async () => {
    expect(node(await read((await buildRoomSetGlb(room43(), opts({ style: 'dollhouse', ceiling: true }))).glb), 'ceiling')).toBeUndefined()
  })

  it('covers two rooms sharing a wall with flat roofs that meet at the partition without overlapping', async () => {
    const b: Array<[number, number]> = [[4.1, 0], [8.1, 0], [8.1, 3], [4.1, 3]]
    const doc = await read((await buildRoomSetGlb({ version: 1, rooms: [room(RECT), room(b)] }, opts({ style: 'plain' }))).glb)
    const roof = doc.getRoot().listMeshes().find(m => m.getName() === 'roof')!
    let top = 0
    for (const p of roof.listPrimitives()) top += upFacingArea(p)
    const union = 8.34 * 3.24 // outer shell x -0.12..8.22, z -0.12..3.12
    expect(Math.abs(top - union) / union).toBeLessThan(0.01)
  })

  it('adds a ceiling only when asked', async () => {
    expect(node(await read((await buildRoomSetGlb(room43(), opts({ ceiling: false }))).glb), 'ceiling')).toBeUndefined()
    expect(node(await read((await buildRoomSetGlb(room43(), opts({ ceiling: true }))).glb), 'ceiling')).toBeDefined()
  })

  it('gives dollhouse no roof and 1.2 m outer walls', async () => {
    const out = await buildRoomSetGlb(room43(), opts({ style: 'dollhouse' }))
    const doc = await read(out.glb)
    expect(node(doc, 'roof')).toBeUndefined()
    expect(getBounds(node(doc, 'walls')!).max[1]).toBeCloseTo(1.2, 5)
  })

  it('keeps shared partitions full height in a dollhouse', async () => {
    const b: Array<[number, number]> = [[4.1, 0], [8.1, 0], [8.1, 3], [4.1, 3]]
    const out = await buildRoomSetGlb({ version: 1, rooms: [room(RECT), room(b)] }, opts({ style: 'dollhouse' }))
    const doc = await read(out.glb)
    expect(getBounds(node(doc, 'walls')!).max[1]).toBeCloseTo(2.5, 5)
  })

  it('gives house a pitched roof whose top is above 2.5 + 0.5 m, and a door canopy', async () => {
    const doc = await read((await buildRoomSetGlb(room43(), opts({ style: 'house' }))).glb)
    const roof = node(doc, 'roof')
    expect(roof).toBeDefined()
    expect(getBounds(roof!).max[1]).toBeGreaterThan(3.0)
    expect(node(doc, 'canopy')).toBeDefined()
  })

  it('gives plain a flat roof slab', async () => {
    const doc = await read((await buildRoomSetGlb(room43(), opts({ style: 'plain' }))).glb)
    const { min, max } = getBounds(node(doc, 'roof')!)
    expect(min[1]).toBeCloseTo(2.5, 5); expect(max[1]).toBeCloseTo(2.6, 5)
  })

  it('gives storefront a glass outer face on the door wall, an awning, and the sign text as a node name', async () => {
    const doc = await read((await buildRoomSetGlb(room43(), opts({ style: 'storefront', signText: 'Corner Cafe' }))).glb)
    expect(prims(doc, 'storefront-glass').length).toBeGreaterThan(0)
    expect(node(doc, 'awning')).toBeDefined()
    expect(nodes(doc).some(n => n.getName() === 'sign: Corner Cafe')).toBe(true)
  })

  it('stays under 2,000 triangles for a 4 x 3 room with a door and a window in every style', async () => {
    for (const style of STYLES) {
      const out = await buildRoomSetGlb(room43(), opts({ style, ceiling: true, signText: 'Shop' }))
      expect(out.triangles, style).toBeLessThan(2000)
      expect(out.triangles, style).toBeGreaterThan(0)
    }
  })

  it('restyling keeps the interior-wall and floor primitives identical', async () => {
    const plain = await read((await buildRoomSetGlb(room43(), opts({ style: 'plain' }))).glb)
    for (const style of ['house', 'storefront'] as const) {
      const other = await read((await buildRoomSetGlb(room43(), opts({ style }))).glb)
      expect(vertexCount(other, 'interior-wall'), style).toBe(vertexCount(plain, 'interior-wall'))
      expect(vertexCount(other, 'floor'), style).toBe(vertexCount(plain, 'floor'))
    }
    expect(vertexCount(plain, 'interior-wall')).toBeGreaterThan(0)
  })

  it('builds an L-shaped room whose floor area equals the outline area within 1%', async () => {
    const L: Array<[number, number]> = [[0, 0], [5, 0], [5, 2], [2, 2], [2, 4], [0, 4]]
    const out = await buildRoomSetGlb({ version: 1, rooms: [room(L)] }, opts({ style: 'house' }))
    const doc = await read(out.glb)
    const area = prims(doc, 'floor').reduce((s, p) => s + triangleArea(p), 0)
    expect(Math.abs(area - 14) / 14).toBeLessThan(0.01)
    const stats = await glbStats(out.glb)
    expect(stats.bbox.x).toBeGreaterThanOrEqual(5.24 - 0.01)
  })

  it('falls back to walls along the floor outline when a room has none', async () => {
    const stats = await glbStats((await buildRoomSetGlb({ version: 1, rooms: [room(RECT, [])] }, opts())).glb)
    expect(stats.bbox.x).toBeCloseTo(4.24, 2)
    expect(stats.bbox.z).toBeCloseTo(3.24, 2)
  })

  it('merges two rooms into one set with one partition between them', async () => {
    const b: Array<[number, number]> = [[4.1, 0], [8.1, 0], [8.1, 3], [4.1, 3]]
    const stats = await glbStats((await buildRoomSetGlb({ version: 1, rooms: [room(RECT), room(b)] }, opts())).glb)
    expect(stats.bbox.x).toBeCloseTo(8.34, 2)
    expect(stats.bbox.z).toBeCloseTo(3.24, 2)
  })

  it('emits invisible _collider meshes for walls and floor, which is how Decentraland gives GLB models collision', async () => {
    const doc = await read((await buildRoomSetGlb(room43(), opts())).glb)
    const names = nodes(doc).map(n => n.getName())
    expect(names).toContain('walls_collider')
    expect(names).toContain('floor_collider')
    for (const n of nodes(doc).filter(n => n.getName().endsWith('_collider'))) {
      expect(n.getMesh()!.getName().endsWith('_collider')).toBe(true)
    }
  })

  it('adds grey furniture blocks, with colliders, only when asked', async () => {
    const layout = room43({ objects: [{ label: 'table', center: [2, 0.4, 1.5], size: [1.2, 0.8, 0.8], yaw: 30 }] })
    expect(node(await read((await buildRoomSetGlb(layout, opts())).glb), 'furniture')).toBeUndefined()
    const doc = await read((await buildRoomSetGlb(layout, opts({ furniture: true }))).glb)
    const { min, max } = getBounds(node(doc, 'furniture')!)
    expect(min[1]).toBeCloseTo(0, 5); expect(max[1]).toBeCloseTo(0.8, 5)
    expect(node(doc, 'furniture_collider')).toBeDefined()
  })

  it('falls back to the default colours for invalid colour inputs and accepts any-case #RRGGBB', async () => {
    const colour = async (o: Partial<RoomSetOptions>, material: string) =>
      prims(await read((await buildRoomSetGlb(room43(), opts(o))).glb), material)[0].getMaterial()!.getBaseColorFactor()
    const fallback = await colour({}, 'interior-wall')
    expect(await colour({ wallColor: 'red' }, 'interior-wall')).toEqual(fallback)
    expect(await colour({ wallColor: '#e8e6e1' }, 'interior-wall')).toEqual(fallback)
    expect(await colour({ floorColor: '#12345' }, 'floor')).toEqual(await colour({}, 'floor'))
    expect(await colour({ wallColor: '#FF0000' }, 'interior-wall')).not.toEqual(fallback)
  })
})
