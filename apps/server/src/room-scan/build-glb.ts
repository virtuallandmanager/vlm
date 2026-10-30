/**
 * Turns a room scan layout plus set options into one real-scale GLB: 0.12 m
 * walls extruded outward from the scanned lines (interiors stay 1:1), floors,
 * an optional ceiling, the style's roof and extras, optional furniture
 * blocks, and invisible `_collider` meshes for Decentraland collisions.
 */
import { Document, NodeIO, type Material, type Node } from '@gltf-transform/core'
import { type RoomScanLayout } from '@virvixr/shared'
import { glbStats } from '../catalog/glb-stats.js'
import { MERGE_MAX_ANGLE_DEG, MERGE_MAX_GAP_M, MERGE_MIN_OVERLAP_M, type GeometryWall, type Nudge } from './geometry.js'
import { add, buildWallShell, dot, PLOT_MARGIN_M, prepareScan, scale, shellBounds, sub, unit, WALL_THICKNESS_M } from './shell.js'
import { MeshData, at, cleanPolygon, edgeNormal, horizontalPolygon, offsetPolygonEdges, prism, yawBox, type MaterialSpec, type MeshPart, type V2, type V3 } from './mesh.js'
import { ROOM_STYLES, STYLE_KITS, type DoorSpot, type RoomStyle, type StyleKit } from './styles/index.js'

export type { RoomStyle, StyleKit, StyleContext } from './styles/index.js'
export type { MeshPart } from './mesh.js'

export interface RoomSetOptions { style: RoomStyle; wallColor: string; floorColor: string; ceiling: boolean; furniture: boolean; signText?: string }

export const DEFAULT_ROOM_SET_OPTIONS: RoomSetOptions = { style: 'plain', wallColor: '#E8E6E1', floorColor: '#B9A68C', ceiling: false, furniture: false }

export { PLOT_MARGIN_M, WALL_THICKNESS_M }
const ROOF_SLAB_M = 0.1
const ROOF_PITCH_DEG = 25
const ROOF_OVERHANG_M = 0.15 // inside the plot margin
/** Floors sit this far above the room's floor level so they don't z-fight the ground. */
const FLOOR_LIFT_M = 0.01

const T = WALL_THICKNESS_M
const EPS = 1e-6
const HEX = /^#[0-9a-f]{6}$/i

const COLLIDER_MATERIAL: MaterialSpec = { name: 'collider', color: '#FFFFFF', alpha: 0 }
const CEILING_MATERIAL: MaterialSpec = { name: 'ceiling', color: '#F2F0EB' }
const FURNITURE_MATERIAL: MaterialSpec = { name: 'furniture', color: '#9A9A9A' }

function normaliseOptions(o: RoomSetOptions): RoomSetOptions {
  const d = DEFAULT_ROOM_SET_OPTIONS
  const colour = (c: unknown, fallback: string) => (typeof c === 'string' && HEX.test(c.trim()) ? c.trim().toUpperCase() : fallback)
  return {
    style: ROOM_STYLES.includes(o.style) ? o.style : d.style,
    wallColor: colour(o.wallColor, d.wallColor),
    floorColor: colour(o.floorColor, d.floorColor),
    ceiling: o.ceiling === true,
    furniture: o.furniture === true,
    ...(typeof o.signText === 'string' ? { signText: o.signText } : {}),
  }
}

/** A gable roof over the walls' bounding box, ridge along the longer side. */
function pitchedRoof(bounds: { minX: number; minZ: number; maxX: number; maxZ: number }, eave: number, roof: MeshData, gables: MeshData) {
  const tan = Math.tan((ROOF_PITCH_DEG * Math.PI) / 180)
  const alongX = bounds.maxX - bounds.minX >= bounds.maxZ - bounds.minZ
  // Work in (u along the ridge, v across it), then map back to (x, z).
  const [u0, u1, v0, v1] = alongX ? [bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ] : [bounds.minZ, bounds.maxZ, bounds.minX, bounds.maxX]
  const P = (u: number, y: number, v: number): V3 => (alongX ? [u, y, v] : [v, y, u])
  const half = (v1 - v0) / 2, vm = (v0 + v1) / 2
  const ridge = eave + half * tan
  const o = ROOF_OVERHANG_M, low = eave - o * tan
  const both = (pts: V3[], facing: V3) => { roof.face(pts, facing); roof.face(pts, [-facing[0], -facing[1], -facing[2]]) }
  const up = (sideV: number): V3 => (alongX ? [0, 1, sideV] : [sideV, 1, 0])
  both([P(u0 - o, low, v0 - o), P(u1 + o, low, v0 - o), P(u1 + o, ridge, vm), P(u0 - o, ridge, vm)], up(-1))
  both([P(u0 - o, low, v1 + o), P(u1 + o, low, v1 + o), P(u1 + o, ridge, vm), P(u0 - o, ridge, vm)], up(1))
  for (const [u, s] of [[u0, -1], [u1, 1]] as const) {
    const tri = [P(u, eave, v0), P(u, eave, v1), P(u, ridge, vm)]
    const facing: V3 = alongX ? [s, 0, 0] : [0, 0, s]
    gables.face(tri, facing); gables.face(tri, [-facing[0], 0, -facing[2]])
  }
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * How far each edge of room `roomIndex`'s outline moves out to cover its walls:
 * the wall thickness, or only to the centre line of a shared partition that
 * runs along the edge, so two rooms' flat roofs meet there without overlapping.
 */
function roofEdgeOffsets(poly: V2[], roomIndex: number, walls: GeometryWall[]): number[] {
  const maxSin = Math.sin((MERGE_MAX_ANGLE_DEG * Math.PI) / 180)
  return poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length]
    const { dir, len } = unit(p, q)
    const n = edgeNormal(poly, i)
    for (const w of walls) {
      if (!w.shared || (w.roomIndex !== roomIndex && w.otherRoomIndex !== roomIndex)) continue
      const W = unit(w.a, w.b)
      if (Math.abs(dir[0] * W.dir[1] - dir[1] * W.dir[0]) > maxSin) continue
      const d = (dot(sub(w.a, p), n) + dot(sub(w.b, p), n)) / 2
      if (d < -EPS || d > MERGE_MAX_GAP_M) continue
      const sa = dot(sub(w.a, p), dir), sb = dot(sub(w.b, p), dir)
      if (Math.min(len, Math.max(sa, sb)) - Math.max(0, Math.min(sa, sb)) < MERGE_MIN_OVERLAP_M) continue
      return Math.max(0, d)
    }
    return T
  })
}

/** Write named parts into a glTF document, every vertex shifted by (dx, dy, dz). */
function writeGlb(nodes: Array<{ name: string; prims: Array<{ material: MaterialSpec; mesh: MeshData }> }>, dx: number, dy: number, dz: number): Promise<Uint8Array> {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const root = doc.createNode('room-set')
  const scene = doc.createScene('room-set').addChild(root)
  doc.getRoot().setDefaultScene(scene)
  const materials = new Map<string, Material>()
  const material = (spec: MaterialSpec): Material => {
    const key = `${spec.name}|${spec.color}|${spec.alpha ?? 1}`
    let mat = materials.get(key)
    if (!mat) {
      const rgb = [1, 3, 5].map(i => srgbToLinear(parseInt(spec.color.slice(i, i + 2), 16) / 255))
      const alpha = spec.alpha ?? 1
      mat = doc.createMaterial(spec.name)
        .setBaseColorFactor([rgb[0], rgb[1], rgb[2], alpha])
        .setMetallicFactor(spec.metallic ?? 0)
        .setRoughnessFactor(spec.roughness ?? 0.9)
        .setDoubleSided(spec.doubleSided ?? false)
      if (alpha < 1) mat.setAlphaMode('BLEND')
      materials.set(key, mat)
    }
    return mat
  }
  for (const { name, prims } of nodes) {
    const parts = prims.filter(p => p.mesh.indices.length > 0)
    if (!parts.length) continue
    const mesh = doc.createMesh(name)
    for (const { material: spec, mesh: data } of parts) {
      const pos = new Float32Array(data.positions)
      for (let i = 0; i < pos.length; i += 3) { pos[i] += dx; pos[i + 1] += dy; pos[i + 2] += dz }
      const indices = data.vertexCount < 65536 ? new Uint16Array(data.indices) : new Uint32Array(data.indices)
      mesh.addPrimitive(doc.createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
        .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(data.normals)).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer))
        .setMaterial(material(spec)))
    }
    const node: Node = doc.createNode(name).setMesh(mesh)
    root.addChild(node)
  }
  return new NodeIO().writeBinary(doc)
}

/**
 * Build the room set's GLB. Rooms are nudged first; rooms with no scanned
 * walls get walls along their floor outline. The set is translated so the
 * outer wall faces' minimum corner sits at the 0.5 m plot margin and the
 * lowest room floor at y = 0; `offset` is that translation.
 */
export async function buildRoomSetGlb(
  layout: RoomScanLayout,
  options: RoomSetOptions,
  nudges?: Nudge[],
): Promise<{ glb: Buffer; triangles: number; bbox: { x: number; y: number; z: number }; offset: { x: number; y: number; z: number } }> {
  const opts = normaliseOptions(options)
  const kit: StyleKit = STYLE_KITS[opts.style]
  const scan = prepareScan(layout, nudges)
  const rooms = scan.rooms
  const floorYOf = (i: number) => rooms[i].floorY
  const outerHeightOf = (i: number) => Math.min(rooms[i].ceilingHeight, kit.outerWallHeight(rooms[i].ceilingHeight))
  const wallShell = buildWallShell(scan, kit)
  const { walls, doorWall, meshes: wm } = wallShell

  // The front door: the first door in an outer wall.
  let door: DoorSpot | undefined
  if (doorWall >= 0) {
    const w = walls[doorWall]
    const o = w.openings.find(op => op.kind === 'door')!
    const { dir } = unit(w.a, w.b)
    door = {
      center: add(add(w.a, scale(dir, o.offset + o.width / 2)), scale(w.normal, T)),
      along: dir, normal: w.normal, width: o.width,
      top: floorYOf(w.roomIndex) + o.sill + o.height,
      wallTop: floorYOf(w.roomIndex) + outerHeightOf(w.roomIndex),
    }
  }

  // Where the outer shell starts, for the plot offset and the pitched roof.
  const shell = shellBounds(wallShell, scan)

  // Floors, ceiling, roof.
  const floor = new MeshData(), floorCollider = new MeshData(), ceiling = new MeshData(), roof = new MeshData(), gables = new MeshData()
  rooms.forEach((room, i) => {
    const poly = cleanPolygon(room.floor)
    if (poly.length < 3) return
    horizontalPolygon(floor, poly, room.floorY + FLOOR_LIFT_M, true)
    horizontalPolygon(floorCollider, poly, room.floorY + FLOOR_LIFT_M, true)
    if (opts.ceiling && kit.ceiling !== false) horizontalPolygon(ceiling, poly, room.floorY + room.ceilingHeight, false)
    if (kit.roof === 'flat') {
      const top = room.floorY + outerHeightOf(i)
      prism(roof, offsetPolygonEdges(poly, roofEdgeOffsets(poly, i, walls)), top, top + ROOF_SLAB_M, { bottom: !opts.ceiling })
    }
  })
  if (kit.roof === 'pitched' && rooms.length) {
    pitchedRoof(shell, Math.max(...rooms.map((r, i) => r.floorY + outerHeightOf(i))), roof, gables)
  }

  // Furniture blocks.
  const furniture = new MeshData()
  if (opts.furniture) {
    for (const room of rooms) for (const o of room.objects) {
      yawBox(furniture, o.center, [Math.max(o.size[0], 0.05), Math.max(o.size[1], 0.05), Math.max(o.size[2], 0.05)], o.yaw)
    }
  }

  const wallMaterial: MaterialSpec = { name: 'interior-wall', color: opts.wallColor }
  const floorMaterial: MaterialSpec = { name: 'floor', color: opts.floorColor }
  const extras: MeshPart[] = kit.extras({ door, signText: opts.signText })
  const nodes = [
    { name: 'walls', prims: [{ material: wallMaterial, mesh: wm.interior }, { material: kit.outerMaterial, mesh: wm.outer }, ...(kit.doorWallMaterial ? [{ material: kit.doorWallMaterial, mesh: wm.doorWall }] : [])] },
    { name: 'floor', prims: [{ material: floorMaterial, mesh: floor }] },
    { name: 'ceiling', prims: [{ material: CEILING_MATERIAL, mesh: ceiling }] },
    { name: 'roof', prims: [{ material: kit.roofMaterial ?? kit.outerMaterial, mesh: roof }, { material: kit.outerMaterial, mesh: gables }] },
    { name: 'furniture', prims: [{ material: FURNITURE_MATERIAL, mesh: furniture }] },
    ...extras.map(p => ({ name: p.name, prims: [{ material: p.material, mesh: p.mesh }] })),
    // Decentraland collides with meshes named `_collider` (GltfContainer's invisible-mesh default) and never renders them.
    { name: 'walls_collider', prims: [{ material: COLLIDER_MATERIAL, mesh: wm.collider }] },
    { name: 'floor_collider', prims: [{ material: COLLIDER_MATERIAL, mesh: floorCollider }] },
    { name: 'furniture_collider', prims: [{ material: COLLIDER_MATERIAL, mesh: furniture }] },
  ]
  const lowestFloor = rooms.length ? Math.min(...rooms.map(r => r.floorY)) : 0
  const offset = { x: PLOT_MARGIN_M - shell.minX, y: 0 - lowestFloor, z: PLOT_MARGIN_M - shell.minZ }
  const glb = Buffer.from(await writeGlb(nodes, offset.x, offset.y, offset.z))
  const { triangles, bbox } = await glbStats(glb)
  return { glb, triangles, bbox, offset }
}
