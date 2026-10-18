// Edit-mode frame system: the pointer's world ray, one continuous camera raycast, and pointer / Shift edges.
// Uses only IA_POINTER and SHIFT_ACTION (never E, F or 1-4).
import {
  engine,
  Entity,
  Transform,
  Raycast,
  RaycastResult,
  RaycastQueryType,
  ColliderLayer,
  InputAction,
  PointerEventType,
  inputSystem,
} from '@dcl/sdk/ecs'
import type { LastWriteWinElementSetComponentDefinition } from '@dcl/sdk/ecs'
// Namespace import: a static property read below keeps PrimaryPointerInfo's @__PURE__ definition from being
// tree-shaken out of a creator's scene build (getComponentOrNull alone only finds components already defined).
import * as ecs from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { clearHudPress, hudPress } from '../hud/press.js'
import type { Handle, Ray, TransformMode } from 'vlm-core'
import type { Vec3 } from 'vlm-shared'

/**
 * IA_MODIFIER: Shift on desktop, present from @dcl/ecs / @dcl/sdk 7.23 (the workspace's typings predate it).
 * See docs/superpowers/spikes/2026-10-18-hud-transform-input.md.
 */
export const SHIFT_ACTION = 14 as InputAction

const RAY_DISTANCE = 50
/** A press only becomes a drag once the pointer ray has turned this far, so a plain click selects without moving. */
const DRAG_THRESHOLD_DEGREES = 2
const DRAG_THRESHOLD_COS = Math.cos((DRAG_THRESHOLD_DEGREES * Math.PI) / 180)

type PointerInfoComponent = LastWriteWinElementSetComponentDefinition<{ worldRayDirection?: Vec3 }>
/** Defined by @dcl/ecs >= 7.20; undefined on older SDKs (camera forward is used then). */
const PrimaryPointerInfo: PointerInfoComponent | null = ((ecs as any).PrimaryPointerInfo as PointerInfoComponent | undefined) ?? null

/** What the frame system needs from edit mode. Entities are raycast hit ids. */
export interface EditHost {
  readonly mode: TransformMode
  /** A gizmo handle of the selected item. */
  handleAt(entity: Entity): Handle | null
  /** The sk of the editable item this entity belongs to (item entity or its pointer helper). */
  itemAt(entity: Entity): string | null
  /** True for the selected item, its helper, and every editor-only helper. Never a surface. */
  excludedFromSurface(entity: Entity): boolean
  /** Pointer went down (selection happens here); the handle a drag would use, or null for none. */
  press(target: { handle: Handle } | { sk: string } | null): Handle | null
  /** The pointer moved past the drag threshold while still down. */
  beginDrag(handle: Handle, ray: Ray, surfaceHit: Vec3 | null): void
  drag(ray: Ray, surfaceHit: Vec3 | null): void
  /** Pointer released after beginDrag. */
  release(): void
  shiftTapped(): void
  setSnap(on: boolean): void
  /** Runs first every frame (helpers follow their items, gizmo follows the draft). */
  sync(dt: number): void
}

type Hit = { entity: Entity | null; position: Vec3; length: number }

/** Pointer ray direction: PrimaryPointerInfo.worldRayDirection, else camera forward. */
function rayDirection(cameraRotation: { x: number; y: number; z: number; w: number }): Vec3 {
  const d = PrimaryPointerInfo?.getOrNull(engine.RootEntity)?.worldRayDirection
  const len = d ? Math.hypot(d.x, d.y, d.z) : 0
  if (d && len > 1e-6) return { x: d.x / len, y: d.y / len, z: d.z / len }
  return Vector3.rotate(Vector3.Forward(), cameraRotation)
}

export class EditInput {
  private rayEntity: Entity | null = null
  private pointerWasDown = false
  private shiftWasDown = false
  private dragging = false
  /** Pressed on something draggable, waiting for the ray to pass the threshold. */
  private armed: { handle: Handle; direction: Vec3 } | null = null
  /**
   * A press seen last frame, applied this frame unless the HUD claimed it: React-ECS onMouseDown and this system
   * run in no guaranteed order, but both have run by the next frame.
   */
  private pendingPress: { target: { handle: Handle } | { sk: string } | null; direction: Vec3; released: boolean; frame: number } | null = null
  private readonly system = (dt: number) => this.frame(dt)

  constructor(
    private readonly host: EditHost,
    private readonly registerSystem: (fn: (dt: number) => void) => void,
    private readonly unregisterSystem: (fn: (dt: number) => void) => void,
  ) {}

  get isDragging(): boolean {
    return this.dragging
  }

  start(): void {
    if (this.rayEntity !== null) return
    const e = engine.addEntity()
    Transform.create(e, {})
    Raycast.create(e, {
      direction: { $case: 'globalDirection', globalDirection: Vector3.Forward() },
      maxDistance: RAY_DISTANCE,
      queryType: RaycastQueryType.RQT_QUERY_ALL,
      continuous: true,
      collisionMask: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER,
    })
    this.rayEntity = e
    // Swallow a press already in progress (e.g. the click that turned edit mode on)
    this.pointerWasDown = inputSystem.isPressed(InputAction.IA_POINTER)
    this.shiftWasDown = inputSystem.isPressed(SHIFT_ACTION)
    this.dragging = false
    this.armed = null
    this.pendingPress = null
    clearHudPress()
    this.registerSystem(this.system)
  }

  stop(): void {
    if (this.rayEntity === null) return
    this.unregisterSystem(this.system)
    engine.removeEntity(this.rayEntity)
    this.rayEntity = null
    this.dragging = false
    this.armed = null
    this.pendingPress = null
    clearHudPress()
  }

  /** Ends a drag in progress without waiting for the pointer to come up (mode switch, held, save). */
  cancelDrag(): void {
    this.dragging = false
    this.armed = null
    this.pendingPress = null
  }

  private frame(dt: number): void {
    hudPress.now++
    try {
      this.step(dt)
    } finally {
      // A mark older than one frame can never belong to a pending press
      if (hudPress.frame < hudPress.now - 1) clearHudPress()
    }
  }

  private step(dt: number): void {
    const rayEntity = this.rayEntity
    if (rayEntity === null) return
    this.host.sync(dt)

    const cam = Transform.getOrNull(engine.CameraEntity)
    if (!cam) return
    const ray: Ray = { origin: { x: cam.position.x, y: cam.position.y, z: cam.position.z }, direction: rayDirection(cam.rotation) }
    // The renderer casts this every tick; the result read below is from the previous frame's ray.
    Transform.getMutable(rayEntity).position = Vector3.create(ray.origin.x, ray.origin.y, ray.origin.z)
    Raycast.getMutable(rayEntity).direction = { $case: 'globalDirection', globalDirection: Vector3.create(ray.direction.x, ray.direction.y, ray.direction.z) }

    const hits = this.readHits(rayEntity)
    const surfaceHit = hits.find((h) => h.entity === null || !this.host.excludedFromSurface(h.entity))?.position ?? null

    const pointerDown = inputSystem.isPressed(InputAction.IA_POINTER)
    const pressed =
      !this.pointerWasDown && (pointerDown || inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_DOWN))
    const released = !pointerDown || inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_UP)
    this.pointerWasDown = pointerDown

    // A press from last frame resolves first, so a press in this same frame is stored below, not lost
    if (this.pendingPress && !this.dragging && !this.armed) {
      const p = this.pendingPress
      this.pendingPress = null
      // The mark lands in the press frame or the next, before or after this system depending on order
      const claimed = hudPress.frame >= p.frame - 1
      clearHudPress()
      if (!claimed) {
        const handle = this.host.press(p.target)
        // Still held: the drag threshold measures from the press-time ray
        if (handle && !p.released && !released) this.armed = { handle, direction: p.direction }
      }
    }

    if (this.dragging) {
      if (released) {
        this.dragging = false
        this.host.release()
      } else {
        this.host.drag(ray, surfaceHit)
      }
    } else if (this.armed) {
      if (released) {
        this.armed = null // a plain click: selected, nothing moved
      } else if (Vector3.dot(this.armed.direction, ray.direction) < DRAG_THRESHOLD_COS) {
        const { handle } = this.armed
        this.armed = null
        this.dragging = true
        this.host.beginDrag(handle, ray, surfaceHit)
        // beginDrag may refuse (held by someone else) and cancel; only drag if still dragging
        if (this.dragging) this.host.drag(ray, surfaceHit)
      }
    } else if (pressed) {
      this.pendingPress = { target: this.pick(hits), direction: ray.direction, released, frame: hudPress.now }
    }

    const shiftDown = inputSystem.isPressed(SHIFT_ACTION)
    if (this.host.mode === 'move') {
      if (shiftDown && !this.shiftWasDown) this.host.shiftTapped()
    } else {
      // Held Shift snaps; set every frame so a mode switch with Shift already down still snaps
      this.host.setSnap(shiftDown)
    }
    this.shiftWasDown = shiftDown
  }

  /** A handle wins over an item; otherwise the nearest editable item. */
  private pick(hits: Hit[]): { handle: Handle } | { sk: string } | null {
    for (const h of hits) {
      const handle = h.entity !== null ? this.host.handleAt(h.entity) : null
      if (handle) return { handle }
    }
    for (const h of hits) {
      const sk = h.entity !== null ? this.host.itemAt(h.entity) : null
      if (sk) return { sk }
    }
    return null
  }

  private readHits(rayEntity: Entity): Hit[] {
    const result = RaycastResult.getOrNull(rayEntity)
    if (!result) return []
    const out: Hit[] = []
    for (const h of result.hits) {
      if (!h.position) continue
      // The player's own avatar is never a surface (third-person camera rays pass through it)
      if (h.entityId === engine.PlayerEntity) continue
      out.push({ entity: h.entityId === undefined ? null : (h.entityId as Entity), position: h.position, length: h.length })
    }
    return out.sort((a, b) => a.length - b.length)
  }
}
