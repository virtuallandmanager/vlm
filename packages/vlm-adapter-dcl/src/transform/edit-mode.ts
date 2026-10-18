// In-world edit mode for editors: click areas on every editable item (picks.ts), remote-draft labels, the transform
// session and its gizmo. Everything here exists only on an editor's client and only while active; every collider
// is on CL_POINTER (never CL_PHYSICS) and exit() removes all of it.
import { engine, Entity, Transform, TextShape, Billboard } from '@dcl/sdk/ecs'
import { Color3, Color4 } from '@dcl/sdk/math'
import { TransformSession } from 'vlm-core'
import type { VLM, DraftPayload, Handle, MoveLock, Ray, Selected, TransformMode } from 'vlm-core'
import type { TransformData, Vec3 } from 'vlm-shared'
import type { DclAdapter } from '../DclAdapter'
import { Gizmo } from './gizmo.js'
import { EditInput, type EditHost } from './input.js'
import { MARKER_SIZE, Picks, entityPosition, follow, type Pick } from './picks.js'

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
/** How long a remote save's transform beats stored data that hasn't caught up yet. */
const REMOTE_SAVE_WINDOW_MS = 3000
const RESCAN_SECONDS = 1
const LABEL_GAP = 0.3

const keyOf = (t: TransformData) => JSON.stringify(t)

export class DclEditMode implements EditHost {
  /** Called after any change the HUD shows (see `state`). */
  onChange: () => void = () => {}
  readonly session: TransformSession

  private readonly gizmo = new Gizmo()
  private readonly picks = new Picks()
  private readonly input: EditInput
  private _active = false
  private remote = new Map<string, { holderName: string; transform: TransformData | null }>()
  /** Transforms another editor saved, until our stored data shows them (draft_end can beat the preset update). */
  private remoteSaves = new Map<string, { transform: TransformData; at: number }>()
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
    this.picks.clear()
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
    return this.picks.skAt(entity)
  }

  excludedFromSurface(entity: Entity): boolean {
    if (this.picks.isHelper(entity) || this.gizmo.owns(entity) || entity === this.selectedEntity) return true
    const sel = this.session.selected
    return !!sel && this.picks.skAt(entity) === sel.sk
  }

  press(target: { handle: Handle } | { sk: string } | null): Handle | null {
    if (!target) return null
    if ('handle' in target) return this.session.selected ? target.handle : null
    if (this.session.selected?.sk !== target.sk && !this.selectSk(target.sk)) return null
    return this.session.mode === 'move' ? { kind: 'body' } : null
  }

  beginDrag(handle: Handle, ray: Ray, surfaceHit: Vec3 | null): void {
    const sel = this.session.selected
    const holder = sel ? this.remote.get(sel.sk)?.holderName : undefined
    if (!sel || holder) {
      this.input.cancelDrag()
      if (holder) {
        this.message = `Being moved by ${holder}`
        this.changed()
      }
      return
    }
    // A clean selection may be stale (another editor saved since): start from what's stored now
    if (!this.session.dirty) this.reselect(sel.sk)
    this.session.beginDrag(handle, ray, surfaceHit)
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
    this.picks.followItems()
    for (const [sk, label] of this.labels) {
      const p = this.picks.get(sk)
      const pos = p ? entityPosition(p.entity, this.labelHeight(p)) : null
      if (pos) follow(label, pos)
    }
    const sel = this.session.selected
    // While someone else holds the item, the gizmo sits where they have it, not at our stale draft
    const remoteT = sel && !this.session.dirty ? this.remote.get(sel.sk)?.transform : null
    this.gizmo.update(this.session.mode, this.session.lock, sel ? remoteT ?? this.session.draft : null)
    if (this.session.dirty !== this.lastDirty) this.changed()
  }

  // ── Selection and drafts ──────────────────────────────────────────────

  /** The item as stored now, or as another editor just saved it if stored data hasn't caught up. */
  private freshItem(sk: string): Selected | null {
    const p = this.picks.get(sk)
    const item = p ? this.vlm.editing.scene.findByEntity(p.entity) : null
    if (!item) return null
    const saved = this.remoteSaves.get(sk)
    if (saved) {
      if (Date.now() - saved.at < REMOTE_SAVE_WINDOW_MS && keyOf(saved.transform) !== keyOf(item.transform)) {
        return { ...item, transform: saved.transform }
      }
      this.remoteSaves.delete(sk)
    }
    return item
  }

  private selectSk(sk: string): boolean {
    const p = this.picks.get(sk)
    const item = this.freshItem(sk)
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

  /** Replaces a clean selection's baseline with fresh data (no hold change, mode and lock kept). */
  private reselect(sk: string): void {
    const item = this.freshItem(sk)
    if (!item || this.session.dirty) return
    this.session.clear()
    this.session.select(item)
    this.appliedKey = keyOf(item.transform)
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
    const last = this.remote.get(d.sk)?.transform ?? null
    this.remote.delete(d.sk)
    if (d.saved && last) this.remoteSaves.set(d.sk, { transform: last, at: Date.now() })
    this.removeLabel(d.sk)
    // Our clean selection of that item is stale now (saved elsewhere, or restored): reselect it fresh
    const sel = this.session.selected
    if (sel?.sk === d.sk && !this.session.dirty) {
      this.input.cancelDrag()
      this.reselect(d.sk)
      this.changed()
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

  /** Only for items with a click area (so the label has somewhere to sit), only while active. */
  private ensureLabel(sk: string): void {
    const p = this.picks.get(sk)
    if (!this._active || !p) return
    const text = `being moved by ${this.remote.get(sk)?.holderName ?? 'another editor'}`
    const existing = this.labels.get(sk)
    if (existing !== undefined) {
      const ts = TextShape.getMutableOrNull(existing)
      if (ts && ts.text !== text) ts.text = text
      return
    }
    const pos = entityPosition(p.entity, this.labelHeight(p))
    if (!pos) return
    const e = engine.addEntity()
    Transform.create(e, { position: pos })
    TextShape.create(e, { text, fontSize: 3, textColor: Color4.White(), outlineWidth: 0.1, outlineColor: Color3.Black() })
    Billboard.create(e, {})
    this.labels.set(sk, e)
  }

  private removeLabel(sk: string): void {
    const label = this.labels.get(sk)
    if (label !== undefined) engine.removeEntity(label)
    this.labels.delete(sk)
  }

  /** Refreshes click areas, drops a selection whose item is gone, and keeps labels in step with picks. */
  private scan(): void {
    if (!this._active) return
    const live = this.picks.sync(this.vlm.editing.scene.listEditable())
    for (const sk of [...this.labels.keys()]) if (!this.picks.get(sk)) this.removeLabel(sk)
    for (const sk of this.remote.keys()) this.ensureLabel(sk)
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

  /** Label height above the item's origin: over the top of a plane, the marker, or a base-origin model. */
  private labelHeight(p: Pick): number {
    const sy = Math.abs(Transform.getOrNull(p.entity)?.scale.y ?? 1)
    if (p.how === 'marker') return MARKER_SIZE / 2 + LABEL_GAP
    if (p.element === 'model') return sy + LABEL_GAP
    return sy / 2 + LABEL_GAP
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
