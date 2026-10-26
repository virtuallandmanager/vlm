// Editor-only handle entities for the active transform mode. Built once per mode (and move lock), then only their
// Transforms are updated as the draft changes. Colliders are on the pointer layer only, never physics.
// Rings and the move guide sit on the scene's axes; resize handles sit under a sub-root turned with the item, so they
// land on its own faces and corners (stretching follows the item's local axes, see TransformSession).
import { engine, Entity, Transform, MeshRenderer, MeshCollider, Material, ColliderLayer } from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import type { Axis, ElementKind, Handle, MoveLock, TransformMode } from '@virvixr/core'
import type { TransformData, Vec3 } from '@virvixr/shared'

const AXES: Axis[] = ['x', 'y', 'z']
const AXIS_VEC: Record<Axis, Vec3> = { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } }
/** Two in-plane basis vectors per ring axis (the ring around X lies in the YZ plane, and so on). */
const RING_BASIS: Record<Axis, [Vec3, Vec3]> = {
  x: [AXIS_VEC.y, AXIS_VEC.z],
  y: [AXIS_VEC.z, AXIS_VEC.x],
  z: [AXIS_VEC.x, AXIS_VEC.y],
}
const COLORS: Record<Axis, Color4> = {
  x: Color4.create(0.95, 0.2, 0.2, 1),
  y: Color4.create(0.2, 0.85, 0.3, 1),
  z: Color4.create(0.25, 0.45, 1, 1),
}
const UNIFORM_COLOR = Color4.create(1, 1, 1, 1)

const RING_SEGMENTS = 32
const RING_THICKNESS = 0.04
const RING_MIN_RADIUS = 0.5
const RING_RADIUS_FACTOR = 0.6
const HANDLE_SIZE = 0.12
/** Gap between an item's half-extent (scale / 2) and its resize handles. */
const HANDLE_GAP = 0.15
const HANDLE_MIN_OFFSET = 0.3
const GUIDE_LENGTH = 40
const GUIDE_THICKNESS = 0.015

type Part = { entity: Entity; handle: Handle | null; layout: (s: Vec3) => { position: Vec3; rotation?: Quaternion.MutableQuaternion; scale: Vec3 } }

const round = (n: number) => Math.round(n * 1000) / 1000
const keyOf = (v: Vec3) => `${round(v.x)},${round(v.y)},${round(v.z)}`

export class Gizmo {
  private root: Entity | null = null
  /** Parent of the resize handles, rotated by the draft's rotation; null outside resize mode. */
  private itemRoot: Entity | null = null
  private parts: Part[] = []
  private handles = new Map<Entity, Handle>()
  private builtFor: string | null = null
  private positionKey = ''
  private rotationKey = ''
  private layoutKey = ''

  /** Shows this mode's handles at the transform (null hides everything). Call every frame. */
  update(mode: TransformMode, lock: MoveLock, t: TransformData | null, element: ElementKind | null = null): void {
    if (!t) return this.clear()
    // Images and videos are flat planes: no Z stretch handle
    const flat = element === 'image' || element === 'video' || element === 'ad_space'
    const built = mode === 'move' ? `move:${lock}` : mode === 'resize' ? `resize:${flat ? 'flat' : 'solid'}` : mode
    if (built !== this.builtFor) {
      this.clear()
      this.build(mode, lock, flat)
      this.builtFor = built
    }
    const root = this.root!
    const pk = keyOf(t.position)
    if (pk !== this.positionKey) {
      this.positionKey = pk
      Transform.getMutable(root).position = Vector3.create(t.position.x, t.position.y, t.position.z)
    }
    const rk = keyOf(t.rotation)
    if (this.itemRoot !== null && rk !== this.rotationKey) {
      this.rotationKey = rk
      Transform.getMutable(this.itemRoot).rotation = Quaternion.fromEulerDegrees(t.rotation.x, t.rotation.y, t.rotation.z)
    }
    const lk = keyOf(t.scale)
    if (lk !== this.layoutKey) {
      this.layoutKey = lk
      for (const p of this.parts) {
        const l = p.layout(t.scale)
        const tr = Transform.getMutable(p.entity)
        tr.position = Vector3.create(l.position.x, l.position.y, l.position.z)
        tr.scale = Vector3.create(l.scale.x, l.scale.y, l.scale.z)
        if (l.rotation) tr.rotation = l.rotation
      }
    }
  }

  handleAt(entity: Entity): Handle | null {
    return this.handles.get(entity) ?? null
  }

  owns(entity: Entity): boolean {
    return entity === this.root || entity === this.itemRoot || this.parts.some((p) => p.entity === entity)
  }

  clear(): void {
    for (const p of this.parts) engine.removeEntity(p.entity)
    if (this.itemRoot !== null) engine.removeEntity(this.itemRoot)
    if (this.root !== null) engine.removeEntity(this.root)
    this.root = null
    this.itemRoot = null
    this.parts = []
    this.handles.clear()
    this.builtFor = null
    this.positionKey = ''
    this.rotationKey = ''
    this.layoutKey = ''
  }

  private build(mode: TransformMode, lock: MoveLock, flat: boolean): void {
    const root = engine.addEntity()
    Transform.create(root, {})
    this.root = root
    if (mode === 'move') {
      if (lock !== 'free') this.addGuide(lock)
    } else if (mode === 'rotate') {
      for (const axis of AXES) this.addRing(axis)
    } else {
      const itemRoot = engine.addEntity()
      Transform.create(itemRoot, { parent: root })
      this.itemRoot = itemRoot
      this.addPart({ kind: 'uniform' }, UNIFORM_COLOR, (s) => ({
        position: { x: offset(s.x), y: offset(s.y), z: offset(s.z) },
        scale: { x: HANDLE_SIZE, y: HANDLE_SIZE, z: HANDLE_SIZE },
      }), itemRoot)
      for (const axis of AXES) {
        if (flat && axis === 'z') continue
        this.addPart({ kind: 'stretch', axis }, COLORS[axis], (s) => ({
          position: Vector3.scale(AXIS_VEC[axis], offset(s[axis])),
          scale: { x: HANDLE_SIZE, y: HANDLE_SIZE, z: HANDLE_SIZE },
        }), itemRoot)
      }
    }
  }

  /** A thin line through the item along the locked axis; nothing to grab, so no collider. */
  private addGuide(axis: Axis): void {
    const scale = { x: GUIDE_THICKNESS, y: GUIDE_THICKNESS, z: GUIDE_THICKNESS }
    scale[axis] = GUIDE_LENGTH
    this.addPart(null, COLORS[axis], () => ({ position: { x: 0, y: 0, z: 0 }, scale }))
  }

  private addRing(axis: Axis): void {
    const [u, v] = RING_BASIS[axis]
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const theta = ((i + 0.5) / RING_SEGMENTS) * Math.PI * 2
      this.addPart({ kind: 'ring', axis }, COLORS[axis], (s) => {
        const r = ringRadius(s)
        const pos = Vector3.add(Vector3.scale(u, r * Math.cos(theta)), Vector3.scale(v, r * Math.sin(theta)))
        const tangent = Vector3.add(Vector3.scale(u, -Math.sin(theta)), Vector3.scale(v, Math.cos(theta)))
        const length = ((Math.PI * 2 * r) / RING_SEGMENTS) * 1.1
        return {
          position: pos,
          rotation: Quaternion.lookRotation(tangent, AXIS_VEC[axis]),
          scale: { x: RING_THICKNESS, y: RING_THICKNESS, z: length },
        }
      })
    }
  }

  private addPart(handle: Handle | null, color: Color4, layout: Part['layout'], parent: Entity = this.root!): void {
    const e = engine.addEntity()
    Transform.create(e, { parent })
    MeshRenderer.setBox(e)
    Material.setBasicMaterial(e, { diffuseColor: color, castShadows: false })
    if (handle) {
      MeshCollider.setBox(e, ColliderLayer.CL_POINTER)
      this.handles.set(e, handle)
    }
    this.parts.push({ entity: e, handle, layout })
  }
}

/** Ring radius: 0.6 × the largest scale component, at least 0.5 m. */
export function ringRadius(s: Vec3): number {
  return Math.max(RING_MIN_RADIUS, RING_RADIUS_FACTOR * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)))
}

const offset = (s: number) => Math.max(HANDLE_MIN_OFFSET, Math.abs(s) / 2 + HANDLE_GAP)
