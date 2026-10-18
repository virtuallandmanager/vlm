// Platform-free edit session for in-world HUD transform tools. The DCL adapter feeds it pointer rays every
// frame and forwards its throttled drafts over the network; nothing here touches a platform API.
import type { TransformData, Vec3 } from 'vlm-shared'
import {
  AXIS_VECTORS,
  add,
  angleOnRing,
  closestPointOnAxis,
  dot,
  eulerDegreesToQuat,
  length,
  quatFromAxisAngle,
  quatMultiply,
  quatToEulerDegrees,
  rayPlane,
  rotateVector,
  scale,
  snap,
  sub,
  type Axis,
  type Quat,
  type Ray,
} from './math.js'

export type TransformMode = 'move' | 'rotate' | 'resize'
export type MoveLock = 'free' | Axis
export type Handle =
  | { kind: 'body' }
  | { kind: 'ring'; axis: Axis }
  | { kind: 'uniform' }
  | { kind: 'stretch'; axis: Axis }
export type ElementKind = 'image' | 'video' | 'model' | 'sound'
export type Selected = { element: ElementKind; sk: string; name: string; transform: TransformData }
export type DraftPayload = { element: ElementKind; sk: string; transform: TransformData }

const DEFAULT_DRAFT_INTERVAL_MS = 100
/** Computed points farther than this from the ray origin are treated as misses. */
const MAX_HIT_DISTANCE = 50
const MIN_GRAB_DISTANCE = 0.01
const MIN_SCALE = 0.05
const ROTATE_SNAP_DEGREES = 15
const UNIFORM_SNAP_STEP = 0.1
const STRETCH_SNAP_STEP = 0.25
const UP: Vec3 = { x: 0, y: 1, z: 0 }
const LOCK_CYCLE: MoveLock[] = ['free', 'x', 'y', 'z']

const copyVec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z })
const copyTransform = (t: TransformData): TransformData => ({
  position: copyVec(t.position),
  rotation: copyVec(t.rotation),
  scale: copyVec(t.scale),
})
const EPSILON = 1e-4
const closeTo = (a: number, b: number): boolean => Math.abs(a - b) < EPSILON
/** Degrees compared modulo 360, so 359.99999 and 0 are the same angle. */
const closeAngle = (a: number, b: number): boolean => closeTo(wrap180(a - b), 0)
const sameVec = (a: Vec3, b: Vec3): boolean => closeTo(a.x, b.x) && closeTo(a.y, b.y) && closeTo(a.z, b.z)
const sameRotation = (a: Vec3, b: Vec3): boolean =>
  closeAngle(a.x, b.x) && closeAngle(a.y, b.y) && closeAngle(a.z, b.z)
const sameTransform = (a: TransformData, b: TransformData): boolean =>
  sameVec(a.position, b.position) && sameRotation(a.rotation, b.rotation) && sameVec(a.scale, b.scale)
const floorScale = (v: Vec3): Vec3 => ({
  x: Math.max(MIN_SCALE, v.x),
  y: Math.max(MIN_SCALE, v.y),
  z: Math.max(MIN_SCALE, v.z),
})
/** Wraps a degree difference into -180..180. */
const wrap180 = (deg: number): number => deg - Math.round(deg / 360) * 360

/** Null when the point is missing or implausibly far from the ray origin (near-parallel solves blow up). */
function near(ray: Ray, point: Vec3 | null): Vec3 | null {
  if (!point) return null
  return length(sub(point, ray.origin)) > MAX_HIT_DISTANCE ? null : point
}
const planeHit = (ray: Ray, point: Vec3, normal: Vec3): Vec3 | null => near(ray, rayPlane(ray, point, normal))
const axisHit = (ray: Ray, point: Vec3, axis: Axis): Vec3 | null => lineHit(ray, point, AXIS_VECTORS[axis])
const lineHit = (ray: Ray, point: Vec3, dir: Vec3): Vec3 | null => near(ray, closestPointOnAxis(ray, point, dir))

type DragState =
  | { kind: 'move-free'; start: TransformData }
  | { kind: 'move-axis'; start: TransformData; axis: Axis; grab: Vec3 | null } // null grab: retried next frame
  | { kind: 'rotate'; start: TransformData; axis: Axis; startQuat: Quat; lastAngle: number | null; total: number }
  | { kind: 'uniform'; start: TransformData; normal: Vec3; grabDistance: number | null }
  /** `dir` is the item's own (rotated) axis: stretching follows the item, not the scene. */
  | { kind: 'stretch'; start: TransformData; axis: Axis; dir: Vec3; grabDistance: number | null }

export class TransformSession {
  private readonly now: () => number
  private readonly onDraft: (d: DraftPayload) => void
  private readonly draftIntervalMs: number

  private _selected: Selected | null = null
  private baseline: TransformData | null = null
  private _draft: TransformData | null = null
  private _mode: TransformMode = 'move'
  private _lock: MoveLock = 'free'
  private snapOn = false

  private handle: Handle | null = null
  private dragState: DragState | null = null
  /** Lock the active move drag was started with; a change triggers a rebase. */
  private dragLock: MoveLock = 'free'
  private emittedThisDrag = false
  private lastEmit = 0
  /** What the network last saw this drag (the drag-start transform until the first emit). */
  private lastSent: TransformData | null = null

  constructor(opts: { now: () => number; onDraft: (d: DraftPayload) => void; draftIntervalMs?: number }) {
    this.now = opts.now
    this.onDraft = opts.onDraft
    this.draftIntervalMs = opts.draftIntervalMs ?? DEFAULT_DRAFT_INTERVAL_MS
  }

  get selected(): Selected | null {
    return this._selected ? { ...this._selected, transform: copyTransform(this._selected.transform) } : null
  }
  get draft(): TransformData | null {
    return this._draft ? copyTransform(this._draft) : null
  }
  get dirty(): boolean {
    return !!this._draft && !!this.baseline && !sameTransform(this._draft, this.baseline)
  }
  get mode(): TransformMode {
    return this._mode
  }
  get lock(): MoveLock {
    return this._lock
  }

  select(item: Selected): 'ok' | 'dirty' {
    if (this.dirty) return 'dirty'
    this._selected = { ...item, transform: copyTransform(item.transform) }
    this.baseline = copyTransform(item.transform)
    this._draft = copyTransform(item.transform)
    this.resetDrag()
    return 'ok'
  }

  setMode(m: TransformMode): void {
    this._mode = m
    this.flushIfChanged()
    this.resetDrag()
  }

  cycleLock(): MoveLock {
    this._lock = LOCK_CYCLE[(LOCK_CYCLE.indexOf(this._lock) + 1) % LOCK_CYCLE.length]
    return this._lock
  }

  setSnap(on: boolean): void {
    this.snapOn = on
  }

  beginDrag(handle: Handle, ray: Ray, surfaceHit: Vec3 | null): void {
    void surfaceHit // free move uses no grab offset, so the begin-time hit is not needed
    if (!this._draft || !this.handleFitsMode(handle)) return
    this.handle = handle
    this.emittedThisDrag = false
    this.lastSent = copyTransform(this._draft)
    this.startFrom(this._draft, ray)
  }

  drag(ray: Ray, surfaceHit: Vec3 | null): void {
    if (!this._draft || !this._selected || !this.handle || !this.dragState) return
    if (this.dragState.kind.startsWith('move') && this.dragLock !== this._lock) {
      this.startFrom(this._draft, ray)
    }
    const next = this.compute(this.dragState, ray, surfaceHit)
    if (!next || sameTransform(next, this._draft)) return
    this._draft = next
    const t = this.now()
    if (!this.emittedThisDrag || t - this.lastEmit >= this.draftIntervalMs) {
      this.emittedThisDrag = true
      this.lastEmit = t
      this.emit()
    }
  }

  /** Sends the draft unless the network already has it. */
  private flushIfChanged(): void {
    if (!this.dragState || !this._draft) return
    if (this.lastSent && sameTransform(this._draft, this.lastSent)) return
    this.lastEmit = this.now()
    this.emit()
  }

  endDrag(): void {
    if (!this.dragState) return
    this.flushIfChanged()
    this.resetDrag()
  }

  takeSave(): DraftPayload | null {
    if (!this._selected || !this._draft || !this.dirty) return null
    this.baseline = copyTransform(this._draft)
    this._selected.transform = copyTransform(this._draft)
    return { element: this._selected.element, sk: this._selected.sk, transform: copyTransform(this._draft) }
  }

  revert(): TransformData | null {
    if (!this.baseline) return null
    this._draft = copyTransform(this.baseline)
    this.resetDrag()
    return copyTransform(this.baseline)
  }

  clear(): void {
    this._selected = null
    this.baseline = null
    this._draft = null
    this.resetDrag()
  }

  private resetDrag(): void {
    this.handle = null
    this.dragState = null
    this.emittedThisDrag = false
    this.lastSent = null
  }

  private emit(): void {
    if (!this._selected || !this._draft) return
    this.lastSent = copyTransform(this._draft)
    this.onDraft({ element: this._selected.element, sk: this._selected.sk, transform: copyTransform(this._draft) })
  }

  private handleFitsMode(h: Handle): boolean {
    switch (this._mode) {
      case 'move':
        return h.kind === 'body'
      case 'rotate':
        return h.kind === 'ring'
      case 'resize':
        return h.kind === 'uniform' || h.kind === 'stretch'
    }
  }

  /** Captures drag-start data from `from` and the ray that grabbed the handle. */
  private startFrom(from: TransformData, ray: Ray): void {
    const handle = this.handle!
    const start = copyTransform(from)
    const pos = start.position
    switch (handle.kind) {
      case 'body':
        this.dragLock = this._lock
        this.dragState =
          this._lock === 'free'
            ? { kind: 'move-free', start }
            : { kind: 'move-axis', start, axis: this._lock, grab: axisHit(ray, pos, this._lock) }
        break
      case 'ring': {
        const lastAngle = planeHit(ray, pos, AXIS_VECTORS[handle.axis])
          ? angleOnRing(ray, pos, AXIS_VECTORS[handle.axis])
          : null
        this.dragState = {
          kind: 'rotate',
          start,
          axis: handle.axis,
          startQuat: eulerDegreesToQuat(start.rotation),
          lastAngle,
          total: 0,
        }
        break
      }
      case 'uniform': {
        const normal = scale(ray.direction, -1)
        const grab = planeHit(ray, pos, normal)
        const dist = grab ? length(sub(grab, pos)) : 0
        this.dragState = { kind: 'uniform', start, normal, grabDistance: dist >= MIN_GRAB_DISTANCE ? dist : null }
        break
      }
      case 'stretch': {
        const dir = rotateVector(eulerDegreesToQuat(start.rotation), AXIS_VECTORS[handle.axis])
        const grab = lineHit(ray, pos, dir)
        const d = grab ? Math.abs(dot(sub(grab, pos), dir)) : 0
        this.dragState = { kind: 'stretch', start, axis: handle.axis, dir, grabDistance: d >= MIN_GRAB_DISTANCE ? d : null }
        break
      }
    }
  }

  /** The new draft for this frame, or null when the frame can't be evaluated (draft stays as it is). */
  private compute(state: DragState, ray: Ray, surfaceHit: Vec3 | null): TransformData | null {
    const out = copyTransform(state.start)
    switch (state.kind) {
      case 'move-free': {
        const hit = near(ray, surfaceHit) ?? planeHit(ray, state.start.position, UP)
        if (!hit) return null
        out.position = copyVec(hit)
        return out
      }
      case 'move-axis': {
        const now = axisHit(ray, state.start.position, state.axis)
        if (!state.grab) {
          state.grab = now // grab couldn't be resolved earlier; use this frame as the grab, no movement yet
          return null
        }
        if (!now) return null
        const along = dot(sub(now, state.grab), AXIS_VECTORS[state.axis])
        out.position = add(state.start.position, scale(AXIS_VECTORS[state.axis], along))
        return out
      }
      case 'rotate': {
        const axisVec = AXIS_VECTORS[state.axis]
        const angle = planeHit(ray, state.start.position, axisVec)
          ? angleOnRing(ray, state.start.position, axisVec)
          : null
        if (angle === null) return null
        if (state.lastAngle !== null) state.total += wrap180(angle - state.lastAngle)
        state.lastAngle = angle
        const delta = this.snapOn ? snap(state.total, ROTATE_SNAP_DEGREES) : state.total
        // No net rotation: keep the exact start Euler (the quaternion round trip wraps angles and zeroes z at the poles).
        out.rotation =
          Math.abs(delta) < 1e-6
            ? copyVec(state.start.rotation)
            : quatToEulerDegrees(quatMultiply(quatFromAxisAngle(axisVec, delta), state.startQuat))
        return out
      }
      case 'uniform': {
        if (state.grabDistance === null) return null
        const hit = planeHit(ray, state.start.position, state.normal)
        if (!hit) return null
        let factor = length(sub(hit, state.start.position)) / state.grabDistance
        if (this.snapOn) factor = Math.max(UNIFORM_SNAP_STEP, snap(factor, UNIFORM_SNAP_STEP))
        out.scale = floorScale(scale(state.start.scale, factor))
        return out
      }
      case 'stretch': {
        if (state.grabDistance === null) return null
        const hit = lineHit(ray, state.start.position, state.dir)
        if (!hit) return null
        const factor = Math.abs(dot(sub(hit, state.start.position), state.dir)) / state.grabDistance
        let size = state.start.scale[state.axis] * factor
        if (this.snapOn) size = Math.max(STRETCH_SNAP_STEP, snap(size, STRETCH_SNAP_STEP))
        out.scale[state.axis] = Math.max(MIN_SCALE, size)
        return out
      }
    }
  }
}
