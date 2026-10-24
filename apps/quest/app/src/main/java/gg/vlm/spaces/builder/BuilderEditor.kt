package gg.vlm.spaces.builder

import gg.vlm.spaces.api.BuilderCall

/** The builder's calls for one space, as [BuilderEditor] makes them ([forSpace] in the app, a fake in tests). */
interface BuilderRemote {
  suspend fun draft(sk: String, element: String, t: ItemTransform): BuilderCall<DraftAnswer>

  suspend fun endDraft(sk: String, saved: Boolean): BuilderCall<Unit>

  suspend fun updateInstance(sk: String, t: ItemTransform): BuilderCall<Unit>

  suspend fun putAdjustment(sk: String, a: Adjustment): BuilderCall<Unit>

  suspend fun deleteAdjustment(sk: String): BuilderCall<Unit>
}

/** [BuilderApi]'s calls for [spaceId]. */
fun BuilderApi.forSpace(spaceId: String): BuilderRemote {
  val api = this
  return object : BuilderRemote {
    override suspend fun draft(sk: String, element: String, t: ItemTransform) = api.draft(spaceId, sk, element, t)

    override suspend fun endDraft(sk: String, saved: Boolean) = api.endDraft(spaceId, sk, saved)

    override suspend fun updateInstance(sk: String, t: ItemTransform) = api.updateInstance(spaceId, sk, t)

    override suspend fun putAdjustment(sk: String, a: Adjustment) = api.putAdjustment(spaceId, sk, a)

    override suspend fun deleteAdjustment(sk: String) = api.deleteAdjustment(spaceId, sk)
  }
}

/** What the HUD needs from the editor (see [hudModel]). */
data class EditorView(
    val items: List<BuilderItem>,
    val picked: String?,
    /** The picked item's live transform (the drag in progress included). */
    val pickedTransform: ItemTransform?,
    val mode: TransformMode,
    /** The Everywhere / Just this place switch, for the picked item. */
    val scope: Scope,
    /** Items with unsaved changes. */
    val edited: Set<String>,
    val message: String?,
    val saving: Boolean,
    val confirmingDone: Boolean,
)

enum class DoneStep {
  /** Unsaved changes: the HUD asks [DONE_CONFIRM], answered with [BuilderEditor.confirmDone]. */
  CONFIRM,
  /** Nothing to save: reverted and left. */
  LEFT,
  /** A save is running; try again when it ends. */
  BUSY,
}

/**
 * The builder's edits of one space: picking, the [TransformSession] behind Move / Rotate / Resize and Exact, the
 * Everywhere / Just this place switch, live drafts and Save / Revert / Done.
 *
 * Every change goes to [store]; its shared transform ([DraftStore.Draft.sharedNow]) is relayed through [remote] as a
 * live draft, at most ten a second per item ([throttle], whose held-back last pose goes out from [tick] or when the
 * drag ends). A `Held` answer drops the pick and the item's draft and shows "<name> is moving this". **Save** runs the
 * store's [DraftStore.saveOps] item by item: an item whose save call succeeds is forgotten (a failed draft end after it
 * is retried on its own with the next save), one whose save call fails keeps its draft for another try. Until the
 * feed shows a saved item again, it stays where it was saved, and further edits of it start from the shared
 * transform and adjustment that save left. **Done** asks first when there's anything unsaved: yes saves and leaves once everything
 * saved, no reverts and leaves.
 *
 * [launch] runs a call off the frame (the app's main-thread coroutine scope; tests run it at once). Main thread only.
 */
class BuilderEditor(
    private val remote: BuilderRemote,
    private val store: DraftStore,
    private val clock: () -> Long,
    private val launch: (suspend () -> Unit) -> Unit,
    private val throttle: DraftThrottle = DraftThrottle(clock),
) {
  /** Something the HUD shows changed. */
  var onChange: (() -> Unit)? = null
  /** Done finished: leave builder mode. */
  var onLeave: (() -> Unit)? = null

  private val session = TransformSession(clock, ::sessionDraft)
  private var items: List<BuilderItem> = emptyList()
  private var bySk: Map<String, BuilderItem> = emptyMap()

  var picked: String? = null
    private set

  private var scope = Scope.EVERYWHERE
  private var message: String? = null
  private var saving = false
  /** A save's calls are under way (guards [runSave] itself; [saving] is set before it is launched). */
  private var running = false
  private var confirmingDone = false

  /**
   * What a save of an item left on the server, kept until the feed's version of the item changes from [feedItem]
   * (or already shows it): where it is shown ([now]) and the [shared] transform and [adjustment] new edits start from.
   */
  private class SavedState(val feedItem: BuilderItem?, val now: ItemTransform, val shared: ItemTransform, val adjustment: Adjustment?)

  private val saved = HashMap<String, SavedState>()
  /** Draft ends that failed after their item saved, retried with the next save: sk to `saved`. */
  private val endsToRetry = LinkedHashMap<String, Boolean>()

  val mode: TransformMode
    get() = session.mode

  val lock: MoveLock
    get() = session.lock

  val dragging: Boolean
    get() = session.dragging

  /** The picked item and its live transform, for the gizmo and outline; null when nothing is picked. */
  fun pickedItem(): Pair<BuilderItem, ItemTransform>? {
    val item = picked?.let(bySk::get) ?: return null
    return item to (session.draft ?: shown(item))
  }

  fun view() =
      EditorView(
          items = items,
          picked = picked,
          pickedTransform = session.draft,
          mode = session.mode,
          scope = scope,
          edited = store.drafts().map { it.sk }.toSet(),
          message = message,
          saving = saving,
          confirmingDone = confirmingDone,
      )

  /** What the scene should show for items that differ from the feed, by [BuilderItem.renderKey]. */
  fun overrides(): Map<String, ItemTransform> {
    val out = HashMap<String, ItemTransform>()
    for ((sk, s) in saved) bySk[sk]?.let { out[it.renderKey] = s.now }
    for (d in store.drafts()) bySk[d.sk]?.let { out[it.renderKey] = d.now }
    pickedItem()?.let { (item, t) -> out[item.renderKey] = t }
    return out
  }

  /**
   * The feed's items (each new snapshot). Drafts of items that left are dropped (their drafts end unsaved), and a
   * picked item that left is unpicked. A picked item with no unsaved change follows the feed.
   */
  fun setItems(next: List<BuilderItem>) {
    items = next
    bySk = next.associateBy { it.sk }
    runEnds(store.dropMissing(bySk.keys))
    // The feed has moved on for that item (this save, or anyone's later change): it is the truth again.
    saved.entries.removeAll { (sk, s) ->
      val item = bySk[sk]
      item == null || item != s.feedItem || showsSaved(item, s)
    }
    val p = picked
    if (p != null && p !in bySk) {
      session.clear()
      picked = null
    } else if (p != null && store.draft(p) == null && !session.dragging) {
      reselect(p)
    }
    changed()
  }

  fun pick(sk: String) {
    if (sk !in bySk || session.dragging) return
    picked = sk
    scope = store.draft(sk)?.scope ?: Scope.EVERYWHERE
    message = null
    reselect(sk)
    changed()
  }

  fun unpick() {
    if (session.dragging) endDrag()
    session.clear()
    picked = null
    changed()
  }

  fun setMode(m: TransformMode) {
    session.setMode(m)
    changed()
  }

  /** The switch, for the picked item; an existing draft of it changes scope too. */
  fun setScope(s: Scope) {
    scope = s
    val sk = picked
    val d = sk?.let(store::draft)
    if (d != null) {
      store.edit(d.sk, d.element, d.base, d.adjustment, d.now, s)
      relay(d.sk, flush = true)
    }
    changed()
  }

  /** Held grip: snapping on, as Shift in Decentraland. */
  fun setSnap(on: Boolean) = session.setSnap(on)

  /**
   * The ray grabbed [handle] of the picked item ([ray] in scene coordinates). For Move, [lock] is the axis handle's
   * axis, or [MoveLock.FREE] for the item itself.
   */
  fun beginDrag(handle: Handle, ray: Ray, lock: MoveLock = MoveLock.FREE) {
    if (picked == null) return
    if (handle is Handle.Body) session.setLock(lock)
    session.beginDrag(handle, ray, null)
  }

  fun drag(ray: Ray) = session.drag(ray, null)

  /** The drag ended: its last pose is relayed whatever the throttle says. */
  fun endDrag() {
    val sk = picked
    session.endDrag()
    clearLock()
    if (sk != null) flush(sk)
  }

  /** An axis handle's lock (and its guide) lasts for its drag only. */
  private fun clearLock() {
    if (session.lock != MoveLock.FREE) session.setLock(MoveLock.FREE)
  }

  /** Drops a drag in progress without relaying or recording its last frame. */
  private fun cancelDrag() {
    session.cancelDrag()
    clearLock()
  }

  /** An Exact field: [axis] of [mode]'s value (metres, degrees, or scale floored at [MIN_SCALE]). */
  fun setExact(mode: TransformMode, axis: Axis, value: Double): Boolean {
    val sk = picked ?: return false
    val before = session.mode
    if (before != mode) session.setMode(mode)
    val ok = session.setValue(axis, value)
    if (before != mode) session.setMode(before)
    flush(sk)
    return ok
  }

  /** **Reset to shared**: a Just this place edit back to the shared transform, which saves as a cleared adjustment. */
  fun resetToShared(sk: String) {
    val item = bySk[sk] ?: return
    val (shared, adjustment) = basis(item)
    if (adjustment == null || (session.dragging && picked == sk)) return
    store.edit(sk, item.element, shared, adjustment, shared, Scope.JUST_HERE)
    relay(sk, flush = true)
    if (picked == sk) {
      scope = Scope.JUST_HERE
      reselect(sk)
    }
    changed()
  }

  /** Sends held-back drafts that are due. Call every frame. */
  fun tick() {
    for (sk in throttle.due()) store.draft(sk)?.let(::send)
  }

  /** Drops drafts not edited for [olderThanMs] (their drafts end unsaved). */
  fun expire(olderThanMs: Long) {
    val ops = store.expire(olderThanMs)
    runEnds(ops)
    val p = picked
    if (p != null && ops.any { it.sk == p } && !session.dragging) reselect(p)
    if (ops.isNotEmpty()) changed()
  }

  fun save() {
    if (!startSaving()) return
    launch { runSave() }
  }

  /** Marks a save as started (so a second tap is ignored at once); false if one already is. */
  private fun startSaving(): Boolean {
    if (saving) return false
    saving = true
    message = null
    changed()
    return true
  }

  /** Ends every draft unsaved and puts the items back where the feed has them. */
  fun revert() {
    if (saving) return
    // First, so the drag's unsent frame can't bring a draft back once the store is cleared.
    cancelDrag()
    val ops = store.revert()
    ops.forEach { throttle.reset(it.sk) }
    runEnds(ops)
    message = null
    val p = picked
    if (p != null) {
      scope = Scope.EVERYWHERE
      reselect(p)
    }
    changed()
  }

  fun done(): DoneStep {
    if (saving) return DoneStep.BUSY
    if (store.drafts().isNotEmpty()) {
      confirmingDone = true
      changed()
      return DoneStep.CONFIRM
    }
    revert()
    leave()
    return DoneStep.LEFT
  }

  /** The answer to [DONE_CONFIRM]: save and leave once all saved (a failure stays, with a message), or revert and leave. */
  fun confirmDone(save: Boolean) {
    if (save) {
      if (!startSaving()) return
      confirmingDone = false
      cancelDrag()
      launch { if (runSave()) leave() }
    } else {
      confirmingDone = false
      revert()
      leave()
    }
    changed()
  }

  fun cancelDone() {
    confirmingDone = false
    changed()
  }

  private fun leave() {
    cancelDrag()
    session.clear()
    picked = null
    message = null
    saved.clear()
    // Last chance for draft ends that failed after their save; best effort (holds lapse anyway).
    runEnds(endsToRetry.map { (sk, s) -> SaveOp.EndDraft(sk, s) })
    endsToRetry.clear()
    onLeave?.invoke()
  }

  /** The shared transform and adjustment an edit of [item] starts from: what its last save left, else the feed's. */
  private fun basis(item: BuilderItem): Pair<ItemTransform, Adjustment?> =
      saved[item.sk]?.let { it.shared to it.adjustment } ?: (item.shared to item.adjustment)

  private fun showsSaved(item: BuilderItem, s: SavedState): Boolean =
      TransformMath.sameTransform(item.shared, s.shared) &&
          ((item.adjustment == null && s.adjustment == null) ||
              (item.adjustment != null && s.adjustment != null && sameAdjustment(item.adjustment, s.adjustment)))

  private fun sameAdjustment(a: Adjustment, b: Adjustment) =
      TransformMath.sameVec(a.dPosition, b.dPosition) && TransformMath.sameVec(a.dRotation, b.dRotation) &&
          TransformMath.sameVec(a.scaleFactor, b.scaleFactor)

  /** The item's transform as the builder should see it: its draft, else its just-saved transform, else the feed's. */
  private fun shown(item: BuilderItem): ItemTransform = store.draft(item.sk)?.now ?: saved[item.sk]?.now ?: item.now

  private fun reselect(sk: String) {
    val item = bySk[sk] ?: return
    session.clear()
    session.select(Selected(item.element, sk, item.name, shown(item)))
  }

  private fun sessionDraft(p: DraftPayload) {
    val item = bySk[p.sk] ?: return
    val (shared, adjustment) = basis(item)
    store.edit(p.sk, item.element, shared, adjustment, p.transform, scope)
    relay(p.sk, flush = false)
    changed()
  }

  private fun relay(sk: String, flush: Boolean) {
    val d = store.draft(sk) ?: return
    if (throttle.allow(sk)) send(d) else if (flush) flush(sk)
  }

  private fun flush(sk: String) {
    if (throttle.flush(sk)) store.draft(sk)?.let(::send)
  }

  private fun send(d: DraftStore.Draft) {
    launch {
      val r = remote.draft(d.sk, d.element, d.sharedNow)
      val answer = (r as? BuilderCall.Ok)?.value
      if (answer is DraftAnswer.Held) held(d.sk, answer.name)
    }
  }

  /** Someone else is moving [sk]: it's unpicked and this headset's draft of it is dropped. */
  private fun held(sk: String, name: String) {
    store.forget(sk)
    throttle.reset(sk)
    if (picked == sk) {
      session.clear()
      picked = null
    }
    message = heldMessage(name.ifBlank { "Someone" })
    changed()
  }

  /**
   * Runs the save ops; true when every item saved. An item counts as saved once its save call (instance, adjustment
   * or cleared adjustment) succeeds; a draft end that fails after it is kept in [endsToRetry] and is all that is sent
   * for it next time.
   */
  private suspend fun runSave(): Boolean {
    if (running) return false
    running = true
    saving = true
    for ((sk, s) in endsToRetry.entries.toList()) if (exec(SaveOp.EndDraft(sk, s)) is BuilderCall.Ok) endsToRetry.remove(sk)
    val before = store.drafts().associateBy { it.sk }
    var failed = 0
    for ((sk, ops) in store.saveOps().groupBy { it.sk }) {
      val draft = before[sk] ?: continue
      val main = ops.filter { it !is SaveOp.EndDraft }
      if (!main.all { exec(it) is BuilderCall.Ok }) {
        failed++
        continue
      }
      val endFailed = ops.filterIsInstance<SaveOp.EndDraft>().filter { exec(it) !is BuilderCall.Ok }
      // A draft edited again while it was saving is kept for the next save (which ends it then).
      if (store.draft(sk) != draft) continue
      store.forget(sk)
      throttle.reset(sk)
      endFailed.forEach { endsToRetry[it.sk] = it.saved }
      saved[sk] = savedState(draft, main)
    }
    running = false
    saving = false
    if (failed > 0) message = saveFailedMessage(failed)
    changed()
    return failed == 0
  }

  /** What saving [d] with [ops] left on the server. */
  private fun savedState(d: DraftStore.Draft, ops: List<SaveOp>): SavedState {
    var shared = d.base
    var adjustment = d.adjustment
    for (op in ops)
        when (op) {
          is SaveOp.UpdateInstance -> shared = op.transform
          is SaveOp.PutAdjustment -> adjustment = op.adjustment
          is SaveOp.DeleteAdjustment -> adjustment = null
          is SaveOp.EndDraft -> Unit
        }
    return SavedState(bySk[d.sk], d.now, shared, adjustment)
  }

  private suspend fun exec(op: SaveOp): BuilderCall<Unit> =
      when (op) {
        is SaveOp.UpdateInstance -> remote.updateInstance(op.sk, op.transform)
        is SaveOp.PutAdjustment -> remote.putAdjustment(op.sk, op.adjustment)
        // Already gone (cleared elsewhere, or never there) is what was asked for.
        is SaveOp.DeleteAdjustment -> remote.deleteAdjustment(op.sk).let { if (it == BuilderCall.NotFound) BuilderCall.Ok(Unit) else it }
        is SaveOp.EndDraft -> remote.endDraft(op.sk, op.saved)
      }

  /** Unsaved draft ends; best effort, nothing to retry (the server lets a hold lapse). */
  private fun runEnds(ops: List<SaveOp>) {
    for (op in ops) launch { exec(op) }
  }

  private fun changed() {
    onChange?.invoke()
  }
}
