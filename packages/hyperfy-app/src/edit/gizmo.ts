/**
 * The edit gizmo as Hyperfy `prim` nodes: arrows for move on X, Y and Z, rings for rotate, a cube for uniform
 * scale, each with a larger, nearly invisible hit target. It only maps pointer events to handles and shows, hides
 * and places itself; all editing logic lives in controller.ts. Hyperfy fires node pointer events from its render
 * raycast, so the parts need no colliders (prims have no physics unless asked).
 */
import type { Axis } from 'vlm-core/transform/math'
import type { TransformMode } from 'vlm-core/transform/session'
import type { GizmoHandle } from './controller.js'

type Triple = [number, number, number]
export interface GizmoNode {
  position: { fromArray(a: number[]): unknown }
  rotation: { set(x: number, y: number, z: number, order: string): unknown }
  active: boolean
  color?: string
  emissive?: string | null
  onPointerDown?: () => void
  onPointerEnter?: () => void
  onPointerLeave?: () => void
  add(child: GizmoNode): void
}

export interface GizmoHost {
  /** `app.create`: 'group', or 'prim' with its data. */
  create(type: 'group' | 'prim', data?: Record<string, unknown>): GizmoNode
  /** `app.add` / `app.remove`: the gizmo lives under the app root, like VLM's nodes. */
  add(node: GizmoNode): void
  remove(node: GizmoNode): void
}

export interface GizmoEvents {
  down(handle: GizmoHandle): void
  enter(handle: GizmoHandle): void
  leave(handle: GizmoHandle): void
}

const COLORS: Record<Axis, string> = { x: '#e5484d', y: '#46a758', z: '#3e63dd' }
const UNIFORM_COLOR = '#f5d90a'
const HOVER = '#ffffff'
const HIT_OPACITY = 0.05 // Hyperfy draws (and raycasts) nothing at 0.01 or below
const ARROW_LENGTH = 0.8
const RING_RADIUS = 0.7
const NO_SHADOW = { castShadow: false, receiveShadow: false }

/**
 * Turns that point a prim's +Y along an axis (YXZ Euler, Hyperfy frame). VLM +z is Hyperfy -z, so the Z arrow
 * points down Hyperfy's -z.
 */
const ARROW_TURN: Record<Axis, Triple> = { x: [0, 0, -Math.PI / 2], y: [0, 0, 0], z: [-Math.PI / 2, 0, 0] }
/** Turns that lay a torus (normal +Z) around an axis. */
const RING_TURN: Record<Axis, Triple> = { x: [0, Math.PI / 2, 0], y: [Math.PI / 2, 0, 0], z: [0, 0, 0] }
const AXES: Axis[] = ['x', 'y', 'z']

type Part = { handle: GizmoHandle; mode: TransformMode; group: GizmoNode; visuals: GizmoNode[] }

export class Gizmo {
  private readonly root: GizmoNode
  private readonly parts: Part[] = []
  private attached = false

  constructor(private readonly host: GizmoHost, events: GizmoEvents) {
    this.root = host.create('group')
    for (const axis of AXES) {
      this.part({ kind: 'arrow', axis }, 'move', COLORS[axis], ARROW_TURN[axis], [
        ['cylinder', [0.02, 0.02, ARROW_LENGTH], [0, ARROW_LENGTH / 2, 0], 1],
        ['cone', [0.06, 0.16], [0, ARROW_LENGTH + 0.08, 0], 1],
        ['cylinder', [0.09, 0.09, ARROW_LENGTH + 0.16], [0, (ARROW_LENGTH + 0.16) / 2, 0], HIT_OPACITY],
      ], events)
      this.part({ kind: 'ring', axis }, 'rotate', COLORS[axis], RING_TURN[axis], [
        ['torus', [RING_RADIUS, 0.015], [0, 0, 0], 1],
        ['torus', [RING_RADIUS, 0.08], [0, 0, 0], HIT_OPACITY],
      ], events)
    }
    this.part({ kind: 'uniform' }, 'resize', UNIFORM_COLOR, [0, 0, 0], [
      ['box', [0.2, 0.2, 0.2], [0, 0, 0], 1],
      ['box', [0.4, 0.4, 0.4], [0, 0, 0], HIT_OPACITY],
    ], events)
  }

  /** Shows the parts for `mode` at `position` (app-local, Hyperfy frame), or hides the gizmo for null. */
  show(mode: TransformMode, position: Triple | null): void {
    if (!position) return this.hide()
    this.root.position.fromArray(position)
    for (const p of this.parts) p.group.active = p.mode === mode
    if (!this.attached) {
      this.host.add(this.root)
      this.attached = true
    }
  }

  hide(): void {
    if (!this.attached) return
    this.host.remove(this.root)
    this.attached = false
  }

  /** Lights up the hovered (or dragged) handle; null for none. */
  highlight(handle: GizmoHandle | null): void {
    const key = handle ? JSON.stringify(handle) : null
    for (const p of this.parts) {
      const on = JSON.stringify(p.handle) === key
      for (const v of p.visuals) v.emissive = on ? HOVER : null
    }
  }

  private part(
    handle: GizmoHandle,
    mode: TransformMode,
    color: string,
    turn: Triple,
    shapes: Array<[type: string, size: number[], at: Triple, opacity: number]>,
    events: GizmoEvents,
  ): void {
    const group = this.host.create('group')
    group.rotation.set(turn[0], turn[1], turn[2], 'YXZ')
    const visuals: GizmoNode[] = []
    for (const [type, size, at, opacity] of shapes) {
      const node = this.host.create('prim', { type, size, color, opacity, ...NO_SHADOW })
      node.position.fromArray(at)
      node.onPointerDown = () => events.down(handle)
      node.onPointerEnter = () => events.enter(handle)
      node.onPointerLeave = () => events.leave(handle)
      if (opacity === 1) visuals.push(node)
      group.add(node)
    }
    this.root.add(group)
    this.parts.push({ handle, mode, group, visuals })
  }
}
