// In-world edit mode for editors: pointer click areas on every editable item, sound markers, remote-draft labels,
// the transform session and its gizmo. Everything here exists only on an editor's client and only while active;
// every collider is on CL_POINTER (never CL_PHYSICS) and exit() removes all of it.
import {
  engine,
  Entity,
  Transform,
  MeshRenderer,
  MeshCollider,
  Material,
  GltfContainer,
  ColliderLayer,
  TextShape,
  Billboard,
} from '@dcl/sdk/ecs'
import type { PBMeshCollider } from '@dcl/sdk/ecs'
import { Color3, Color4, Vector3 } from '@dcl/sdk/math'
import { TransformSession } from 'vlm-core'
import type { VLM, DraftPayload, ElementKind, Handle, MoveLock, Ray, TransformMode } from 'vlm-core'
import type { TransformData, Vec3 } from 'vlm-shared'
import type { DclAdapter } from '../DclAdapter'
import { Gizmo } from './gizmo.js'
import { EditInput, type EditHost } from './input.js'

export interface DclEditModeState {
  active: boolean
  mode: TransformMode
  lock: MoveLock
  selectedName: string | null
  dirty: boolean
  message: string | null
  /** Unsaved changes block the request (select another item, Done): the HUD asks Save or Revert. */
  prompt: boolean
}

const NOT_CONNECTED = 'Not connected — your change is still a draft'
const SAVE_ERROR_WINDOW_MS = 3000
const RESCAN_SECONDS = 1
const LABEL_GAP = 0.3
const MARKER_SIZE = 0.3
const MARKER_COLOR = Color4.create(1, 0.6, 0.1, 1)

/** How an item was made clickable, so exit() can undo exactly that. */
type Pick = {
  sk: string
  element: ElementKind
  entity: Entity
  how: 'self' | 'child' | 'mask' | 'marker'
  helper: Entity | null
  prevMask?: number
}

const isOurPlane = (mc: PBMeshCollider | null): boolean =>
  mc?.mesh?.$case === 'plane' && mc.collisionMask === ColliderLayer.CL_POINTER
const keyOf = (t: TransformData) => JSON.stringify(t)

export class DclEditMode implements EditHost {
  /** Called after any change the HUD shows (see `state`). */
  onChange: () => void = () => {}
  readonly session: TransformSession

  private readonly gizmo = new Gizmo()
  private readonly input: EditInput
  private _active = false
  private picks = new Map<string, Pick>()
  private byEntity = new Map<Entity, string>()
  private helpers = new Set<Entity>()
  private remote = new Map<string, { holderName: string; transform: TransformData | null }>()
  private labels = new Map<string, Entity>()
  private selectedEntity: Entity | null = null
  /** The sk this client holds on the server (sent a draft, no end yet). */
  private sentDraftFor: string | null = null
  /** Item to select once the save-or-revert prompt is answered. */
  private pending: string | null = null
  private message: string | null = null
  private prompt = false
  private lastSaveAt = -Infinity
  private lastDirty = false
  private appliedKey = ''
  private rescanIn = 0

  constructor(private readonly vlm: VLM, adapter: DclAdapter) {
    this.session = new TransformSession({ now: () => Date.now(), onDraft: (d) => this.onDraft(d) })
    this.input = new EditInput(this, (fn) => adapter.registerSystem(fn), (fn) => adapter.unregisterSystem(fn))
    vlm.events.on('transform_draft', (d: any) => this.onRemoteDraft(d))
    vlm.events.on('transform_draft_end', (d: any) => this.onRemoteEnd(d))
    vlm.events.on('transform_held', (d: any) => this.onHeld(d))
    vlm.events.on('vlm_error', (e: any) => this.onError(e))
  }

  get active(): boolean {
    return this._active
  }

  get mode(): TransformMode {
    return this.session.mode
  }

  get state(): DclEditModeState {
    const sel = this.session.selected
    return {
      active: this._active,
      mode: this.session.mode,
      lock: this.session.lock,
      selectedName: sel ? sel.name || sel.element : null,
      dirty: this.session.dirty,
      message: this.message,
      prompt: this.prompt,
    }
  }

  enter(): void {
    if (this._active) return
    this._active = true
    this.message = null
    this.scan()
    for (const sk of this.remote.keys()) this.ensureLabel(sk)
    this.input.start()
    this.changed()
  }

  /** Refused while there are unsaved changes (sets `prompt`). */
  exit(): void {
    if (!this._active) return
    if (this.session.dirty) {
      this.prompt = true
      this.changed()
      return
    }
    this.input.stop()
    this.releaseHold()
    this.session.clear()
    this.selectedEntity = null
    this.pending = null
    this.prompt = false
    this.message = null
    this.gizmo.clear()
    for (const p of this.picks.values()) this.removePick(p)
    this.picks.clear()
    this.byEntity.clear()
    this.helpers.clear()
    for (const e of this.labels.values()) engine.removeEntity(e)
    this.labels.clear()
    this._active = false
    this.changed()
  }

  setMode(m: TransformMode): void {
    this.input.cancelDrag()
    this.session.setMode(m)
    this.session.setSnap(false)
    this.applyDraft()
    this.changed()
  }

  save(): void {
    const sel = this.session.selected
    const draft = this.session.draft
    if (!sel || !draft || !this.session.dirty) return
    if (this.input.isDragging) {
      this.input.cancelDrag()
      this.session.endDrag()
    }
    try {
      this.vlm.editing.save(sel.element, sel.sk, draft)
    } catch (err) {
      // The session stays dirty, so the draft is kept for another try
      this.message = err instanceof Error && err.message === 'not_connected' ? NOT_CONNECTED : 'Save failed — try again'
      this.changed()
      return
    }
    this.session.takeSave()
    this.lastSaveAt = Date.now()
    try {
      this.vlm.editing.endDraft(sel.sk, true)
    } catch {
      // Disconnected right after the save; the server releases the hold when this client leaves
    }
    this.sentDraftFor = null
    this.message = null
    this.answerPrompt()
  }

  revert(): void {
    const sel = this.session.selected
    if (!sel) return
    this.input.cancelDrag()
    this.session.revert()
    this.vlm.editing.scene.restoreTransform(sel.element, sel.sk)
    this.appliedKey = ''
    this.releaseHold()
    this.message = null
    this.answerPrompt()
  }

  // ── EditHost (called by the frame system) ─────────────────────────────

  handleAt(entity: Entity): Handle | null {
    return this.gizmo.handleAt(entity)
  }

  itemAt(entity: Entity): string | null {
    return this.byEntity.get(entity) ?? null
  }

  excludedFromSurface(entity: Entity): boolean {
    if (this.helpers.has(entity) || this.gizmo.owns(entity) || entity === this.selectedEntity) return true
    const sel = this.session.selected
    return !!sel && this.byEntity.get(entity) === sel.sk
  }

  press(target: { handle: Handle } | { sk: string } | null, ray: Ray, surfaceHit: Vec3 | null): boolean {
    if (!target) return false
    if ('sk' in target && this.session.selected?.sk !== target.sk && !this.selectSk(target.sk)) return false
    if ('sk' in target && this.session.mode !== 'move') return false
    const sel = this.session.selected
    if (!sel) return false
    const holder = this.remote.get(sel.sk)?.holderName
    if (holder) {
      this.message = `Being moved by ${holder}`
      this.changed()
      return false
    }
    this.session.beginDrag('handle' in target ? target.handle : { kind: 'body' }, ray, surfaceHit)
    return true
  }

  drag(ray: Ray, surfaceHit: Vec3 | null): void {
    this.session.drag(ray, surfaceHit)
    this.applyDraft()
  }

  release(): void {
    this.session.endDrag()
  }

  shiftTapped(): void {
    this.session.cycleLock()
    this.changed()
  }

  setSnap(on: boolean): void {
    this.session.setSnap(on)
  }

  sync(dt: number): void {
    this.rescanIn -= dt
    if (this.rescanIn <= 0) {
      this.rescanIn = RESCAN_SECONDS
      this.scan()
    }
    for (const p of this.picks.values()) {
      if (p.how === 'marker' && p.helper !== null) this.follow(p.helper, this.itemPosition(p.entity, 0))
    }
    for (const [sk, label] of this.labels) {
      const p = this.picks.get(sk)
      if (p) this.follow(label, this.itemPosition(p.entity, this.labelHeight(p)))
    }
    this.gizmo.update(this.session.mode, this.session.lock, this.session.selected ? this.session.draft : null)
    if (this.session.dirty !== this.lastDirty) this.changed()
  }

  // ── Selection and drafts ──────────────────────────────────────────────

  private selectSk(sk: string): boolean {
    const p = this.picks.get(sk)
    const item = p ? this.vlm.editing.scene.findByEntity(p.entity) : null
    if (!p || !item) return false
    if (this.session.dirty) {
      this.prompt = true
      this.pending = sk
      this.changed()
      return false
    }
    this.releaseHold()
    this.session.select(item)
    this.selectedEntity = p.entity
    this.appliedKey = keyOf(item.transform)
    this.prompt = false
    this.pending = null
    this.message = null
    this.changed()
    return true
  }

  private answerPrompt(): void {
    this.prompt = false
    const next = this.pending
    this.pending = null
    if (next) this.selectSk(next)
    this.changed()
  }

  /** Applies the draft to the item locally (every frame while dragging; drafts on the wire are throttled). */
  private applyDraft(): void {
    const sel = this.session.selected
    const draft = this.session.draft
    if (!sel || !draft) return
    const k = keyOf(draft)
    if (k === this.appliedKey) return
    this.appliedKey = k
    this.vlm.editing.scene.previewTransform(sel.element, sel.sk, draft)
  }

  private onDraft(d: DraftPayload): void {
    this.applyDraft()
    try {
      this.vlm.editing.sendDraft({ element: d.element, sk: d.sk, ...d.transform })
      this.sentDraftFor = d.sk
    } catch {
      if (this.message !== NOT_CONNECTED) {
        this.message = NOT_CONNECTED
        this.changed()
      }
    }
  }

  /** Tells the server this client no longer holds its item (no-op if it never sent a draft). */
  private releaseHold(): void {
    const sk = this.sentDraftFor
    if (!sk) return
    this.sentDraftFor = null
    try {
      this.vlm.editing.endDraft(sk, false)
    } catch {
      // Not connected: the server releases the hold when this client leaves
    }
  }

  // ── Remote editors ────────────────────────────────────────────────────

  private onRemoteDraft(d: { sk: string; holderName?: string; position: Vec3; rotation: Vec3; scale: Vec3 }): void {
    const holderName = d.holderName || 'another editor'
    this.remote.set(d.sk, { holderName, transform: { position: d.position, rotation: d.rotation, scale: d.scale } })
    this.ensureLabel(d.sk)
  }

  private onRemoteEnd(d: { sk: string; saved: boolean }): void {
    this.remote.delete(d.sk)
    const label = this.labels.get(d.sk)
    if (label !== undefined) engine.removeEntity(label)
    this.labels.delete(d.sk)
    // Our selection of that item is stale now (saved elsewhere, or restored): reselect it fresh
    const sel = this.session.selected
    if (sel?.sk === d.sk && !this.session.dirty) {
      this.input.cancelDrag()
      this.session.clear()
      this.selectedEntity = null
      this.selectSk(d.sk)
    }
  }

  private onHeld(d: { sk: string; holderName?: string }): void {
    const holderName = d.holderName || 'another editor'
    const prev = this.remote.get(d.sk)
    this.remote.set(d.sk, { holderName, transform: prev?.transform ?? null })
    this.ensureLabel(d.sk)
    const sel = this.session.selected
    if (sel?.sk === d.sk) {
      // Our drag on an item someone else holds never counted: drop it and show where theirs is
      this.input.cancelDrag()
      this.session.revert()
      if (this.sentDraftFor === d.sk) this.sentDraftFor = null
      if (prev?.transform) this.vlm.editing.scene.previewTransform(sel.element, sel.sk, prev.transform)
      else this.vlm.editing.scene.restoreTransform(sel.element, sel.sk)
      this.appliedKey = ''
    }
    this.message = `Being moved by ${holderName}`
    this.changed()
  }

  private onError(e: { code?: string; messageType?: string }): void {
    if (Date.now() - this.lastSaveAt > SAVE_ERROR_WINDOW_MS) return
    if (e?.messageType !== 'scene_preset_update' && e?.messageType !== 'transform_end') return
    this.message = `Save failed — ${e.code ?? 'server error'}`
    this.changed()
  }

  private ensureLabel(sk: string): void {
    if (!this._active) return
    const text = `being moved by ${this.remote.get(sk)?.holderName ?? 'another editor'}`
    const existing = this.labels.get(sk)
    if (existing !== undefined) {
      const ts = TextShape.getMutableOrNull(existing)
      if (ts && ts.text !== text) ts.text = text
      return
    }
    const e = engine.addEntity()
    Transform.create(e, {})
    TextShape.create(e, { text, fontSize: 3, textColor: Color4.White(), outlineWidth: 0.1, outlineColor: Color3.Black() })
    Billboard.create(e, {})
    this.labels.set(sk, e)
  }

  // ── Click areas and sound markers ─────────────────────────────────────

  /** Adds click areas for new items, drops them for removed ones, and re-applies any a manager replaced. */
  private scan(): void {
    if (!this._active) return
    const live = new Map<string, Entity>()
    for (const item of this.vlm.editing.scene.listEditable()) {
      const entity = item.entity as Entity
      live.set(item.sk, entity)
      const p = this.picks.get(item.sk)
      if (p && p.entity === entity) this.refreshPick(p)
      else {
        if (p) this.removePick(p)
        this.addPick(item.sk, item.element, entity)
      }
    }
    for (const [sk, p] of this.picks) {
      if (live.has(sk)) continue
      this.removePick(p)
      this.picks.delete(sk)
    }
    this.byEntity.clear()
    this.helpers.clear()
    for (const p of this.picks.values()) {
      this.byEntity.set(p.entity, p.sk)
      if (p.helper !== null) {
        this.byEntity.set(p.helper, p.sk)
        this.helpers.add(p.helper)
      }
    }
    const sel = this.session.selected
    if (sel && live.get(sel.sk) !== this.selectedEntity) {
      // The selected item is gone (deleted, hidden, preset change): its draft goes with it
      this.input.cancelDrag()
      if (this.sentDraftFor === sel.sk) this.releaseHold()
      this.session.clear()
      this.selectedEntity = null
      this.prompt = false
      this.pending = null
      this.changed()
    }
  }

  private addPick(sk: string, element: ElementKind, entity: Entity): void {
    const p: Pick = { sk, element, entity, how: 'self', helper: null }
    if (element === 'image' || element === 'video') {
      if (MeshCollider.has(entity)) this.addChildPlane(p)
      else MeshCollider.setPlane(entity, ColliderLayer.CL_POINTER)
    } else if (element === 'model') {
      const g = GltfContainer.getMutableOrNull(entity)
      if (!g) return // not loadable here (missing model): nothing to click
      p.how = 'mask'
      p.prevMask = g.visibleMeshesCollisionMask
      g.visibleMeshesCollisionMask = (p.prevMask ?? 0) | ColliderLayer.CL_POINTER
    } else {
      p.how = 'marker'
      const m = engine.addEntity()
      Transform.create(m, { position: this.itemPosition(entity, 0), scale: Vector3.create(MARKER_SIZE, MARKER_SIZE, MARKER_SIZE) })
      MeshRenderer.setSphere(m)
      Material.setBasicMaterial(m, { diffuseColor: MARKER_COLOR, castShadows: false })
      MeshCollider.setSphere(m, ColliderLayer.CL_POINTER)
      p.helper = m
    }
    this.picks.set(sk, p)
  }

  /** A pointer plane on a child entity, for items that already have a collider of their own. */
  private addChildPlane(p: Pick): void {
    const c = engine.addEntity()
    Transform.create(c, { parent: p.entity })
    MeshCollider.setPlane(c, ColliderLayer.CL_POINTER)
    p.how = 'child'
    p.helper = c
  }

  private refreshPick(p: Pick): void {
    if (p.how === 'self') {
      const mc = MeshCollider.getOrNull(p.entity)
      if (!mc) MeshCollider.setPlane(p.entity, ColliderLayer.CL_POINTER)
      else if (!isOurPlane(mc)) this.addChildPlane(p) // a manager set its own collider: don't fight it
    } else if (p.how === 'mask') {
      const g = GltfContainer.getMutableOrNull(p.entity)
      const mask = g?.visibleMeshesCollisionMask ?? 0
      if (g && !(mask & ColliderLayer.CL_POINTER)) {
        // The model was reloaded; its new mask is the one to restore
        p.prevMask = g.visibleMeshesCollisionMask
        g.visibleMeshesCollisionMask = mask | ColliderLayer.CL_POINTER
      }
    }
  }

  private removePick(p: Pick): void {
    if (p.helper !== null) engine.removeEntity(p.helper)
    if (p.how === 'self' && isOurPlane(MeshCollider.getOrNull(p.entity))) MeshCollider.deleteFrom(p.entity)
    if (p.how === 'mask') {
      const g = GltfContainer.getMutableOrNull(p.entity)
      if (g) g.visibleMeshesCollisionMask = p.prevMask
    }
  }

  private itemPosition(entity: Entity, up: number): Vec3 {
    const pos = Transform.getOrNull(entity)?.position
    return pos ? { x: pos.x, y: pos.y + up, z: pos.z } : { x: 0, y: -100, z: 0 }
  }

  /** Label height above the item's origin: over the top of a plane, the marker, or a base-origin model. */
  private labelHeight(p: Pick): number {
    const sy = Math.abs(Transform.getOrNull(p.entity)?.scale.y ?? 1)
    if (p.how === 'marker') return MARKER_SIZE / 2 + LABEL_GAP
    if (p.element === 'model') return sy + LABEL_GAP
    return sy / 2 + LABEL_GAP
  }

  private follow(entity: Entity, pos: Vec3): void {
    const t = Transform.getOrNull(entity)
    if (!t) return
    if (Math.abs(t.position.x - pos.x) < 1e-4 && Math.abs(t.position.y - pos.y) < 1e-4 && Math.abs(t.position.z - pos.z) < 1e-4) return
    Transform.getMutable(entity).position = Vector3.create(pos.x, pos.y, pos.z)
  }

  private changed(): void {
    this.lastDirty = this.session.dirty
    try {
      this.onChange()
    } catch (err) {
      console.warn('[VLM] edit mode onChange failed:', err)
    }
  }
}
