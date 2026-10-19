// Editor-only outline around the selected item: thin edges of its box (a frame for flat images and videos), turned
// with the item. Built once per item shape, then only Transforms change. No colliders, so it never takes a click or
// a surface hit.
import { engine, Entity, Transform, MeshRenderer, Material } from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import type { ElementKind } from 'vlm-core'
import type { TransformData, Vec3 } from 'vlm-shared'
import { MARKER_SIZE } from './picks.js'

const COLOR = Color4.create(1, 0.85, 0.2, 1)
const THICKNESS = 0.025
/** Gap between the item and its outline, so the edges don't z-fight the item's own faces. */
const PAD = 0.03

type Edge = { entity: Entity; along: 'x' | 'y' | 'z'; sx: number; sy: number; sz: number }

const round = (n: number) => Math.round(n * 1000) / 1000
const keyOf = (v: Vec3) => `${round(v.x)},${round(v.y)},${round(v.z)}`

/** The item's box in its own frame: half extents and the center's offset from its origin. */
export function outlineBox(element: ElementKind, s: Vec3): { half: Vec3; center: Vec3 } {
  const ax = Math.abs(s.x), ay = Math.abs(s.y), az = Math.abs(s.z)
  if (element === 'sound') {
    const h = MARKER_SIZE / 2 + PAD
    return { half: { x: h, y: h, z: h }, center: { x: 0, y: 0, z: 0 } }
  }
  if (element === 'image' || element === 'video') {
    return { half: { x: ax / 2 + PAD, y: ay / 2 + PAD, z: 0 }, center: { x: 0, y: 0, z: 0 } }
  }
  // Models sit on their origin (base), so the box rises from it
  return { half: { x: ax / 2 + PAD, y: ay / 2 + PAD, z: az / 2 + PAD }, center: { x: 0, y: ay / 2, z: 0 } }
}

export class Outline {
  private root: Entity | null = null
  private edges: Edge[] = []
  private builtFor: string | null = null
  private positionKey = ''
  private rotationKey = ''
  private layoutKey = ''

  /** Outlines the item at the transform (null removes it). Call every frame. */
  update(t: TransformData | null, element: ElementKind | null): void {
    if (!t || !element) return this.clear()
    const flat = element === 'image' || element === 'video'
    const shape = flat ? 'flat' : 'box'
    if (shape !== this.builtFor) {
      this.clear()
      this.build(flat)
      this.builtFor = shape
    }
    const root = this.root!
    const pk = keyOf(t.position)
    if (pk !== this.positionKey) {
      this.positionKey = pk
      Transform.getMutable(root).position = Vector3.create(t.position.x, t.position.y, t.position.z)
    }
    const rk = keyOf(t.rotation)
    if (rk !== this.rotationKey) {
      this.rotationKey = rk
      Transform.getMutable(root).rotation = Quaternion.fromEulerDegrees(t.rotation.x, t.rotation.y, t.rotation.z)
    }
    const lk = `${element}:${keyOf(t.scale)}`
    if (lk === this.layoutKey) return
    this.layoutKey = lk
    const { half, center } = outlineBox(element, t.scale)
    for (const e of this.edges) {
      const tr = Transform.getMutable(e.entity)
      tr.position = Vector3.create(center.x + e.sx * half.x, center.y + e.sy * half.y, center.z + e.sz * half.z)
      tr.scale = Vector3.create(
        e.along === 'x' ? half.x * 2 + THICKNESS : THICKNESS,
        e.along === 'y' ? half.y * 2 + THICKNESS : THICKNESS,
        e.along === 'z' ? half.z * 2 + THICKNESS : THICKNESS,
      )
    }
  }

  owns(entity: Entity): boolean {
    return entity === this.root || this.edges.some((e) => e.entity === entity)
  }

  clear(): void {
    for (const e of this.edges) engine.removeEntity(e.entity)
    if (this.root !== null) engine.removeEntity(this.root)
    this.root = null
    this.edges = []
    this.builtFor = null
    this.positionKey = ''
    this.rotationKey = ''
    this.layoutKey = ''
  }

  /** Each edge runs along one axis, at ±1 on the other two (sx/sy/sz are those signs; 0 on its own axis). */
  private build(flat: boolean): void {
    const root = engine.addEntity()
    Transform.create(root, {})
    this.root = root
    const signs = [-1, 1]
    if (flat) {
      for (const s of signs) this.addEdge('x', 0, s, 0)
      for (const s of signs) this.addEdge('y', s, 0, 0)
      return
    }
    for (const a of signs) for (const b of signs) {
      this.addEdge('x', 0, a, b)
      this.addEdge('y', a, 0, b)
      this.addEdge('z', a, b, 0)
    }
  }

  private addEdge(along: Edge['along'], sx: number, sy: number, sz: number): void {
    const e = engine.addEntity()
    Transform.create(e, { parent: this.root! })
    MeshRenderer.setBox(e)
    Material.setBasicMaterial(e, { diffuseColor: COLOR, castShadows: false })
    this.edges.push({ entity: e, along, sx, sy, sz })
  }
}
