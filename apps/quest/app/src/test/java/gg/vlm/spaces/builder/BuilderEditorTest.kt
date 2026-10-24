package gg.vlm.spaces.builder

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.api.BuilderCall
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BuilderEditorTest {
  private var t = 1_000_000L

  private fun v(x: Double, y: Double, z: Double) = Vec3(x, y, z)

  private fun tr(p: Vec3, r: Vec3 = v(0.0, 0.0, 0.0), s: Vec3 = v(1.0, 1.0, 1.0)) = ItemTransform(p, r, s)

  /** Records every call; [answers] picks each call's result by its name. */
  private inner class FakeRemote : BuilderRemote {
    val calls = ArrayList<String>()
    val relayed = ArrayList<ItemTransform>()
    var draftAnswer: BuilderCall<DraftAnswer> = BuilderCall.Ok(DraftAnswer.Ok)
    val failing = HashSet<String>()
    val notFound = HashSet<String>()
    var during: (() -> Unit)? = null

    private fun unit(call: String): BuilderCall<Unit> {
      calls += call
      during?.invoke()
      return when {
        failing.any { call.startsWith(it) } -> BuilderCall.Failed(500)
        notFound.any { call.startsWith(it) } -> BuilderCall.NotFound
        else -> BuilderCall.Ok(Unit)
      }
    }

    override suspend fun draft(sk: String, element: String, t: ItemTransform): BuilderCall<DraftAnswer> {
      calls += "draft $sk $element"
      relayed += t
      return draftAnswer
    }

    override suspend fun endDraft(sk: String, saved: Boolean) = unit("end $sk $saved")

    override suspend fun updateInstance(sk: String, t: ItemTransform) = unit("update $sk ${t.position.x}")

    override suspend fun putAdjustment(sk: String, a: Adjustment) = unit("adjust $sk ${a.dPosition.x}")

    override suspend fun deleteAdjustment(sk: String) = unit("clear $sk")
  }

  private val remote = FakeRemote()
  private val store = DraftStore { t }
  private val editor = BuilderEditor(remote, store, { t }, { block -> runBlocking { block() } })
  private var left = 0

  init {
    editor.onLeave = { left++ }
  }

  private val adj = Adjustment(v(0.5, 0.0, 0.0), v(0.0, 0.0, 0.0), v(1.0, 1.0, 1.0))
  private val poster = BuilderItem("in1", "el1:in1", "image", "Poster", tr(v(1.0, 1.0, 0.0)), tr(v(1.0, 1.0, 0.0)), null)
  /** Shown 0.5 m along x from its shared place. */
  private val chair = BuilderItem("in2", "el2:in2", "model", "Chair", tr(v(2.5, 0.0, 0.0)), tr(v(2.0, 0.0, 0.0)), adj)

  private fun loaded(): BuilderEditor {
    editor.setItems(listOf(poster, chair))
    return editor
  }

  /** Moves the picked item to x by typing into Exact. */
  private fun moveTo(sk: String, x: Double) {
    editor.pick(sk)
    assertTrue(editor.setExact(TransformMode.MOVE, Axis.X, x))
  }

  @Test
  fun `a placed item is picked when the feed delivers it`() {
    loaded()
    val fresh = BuilderItem("in9", "el9:in9", "image", "New", tr(v(0.0, 1.6, 1.0)), tr(v(0.0, 1.6, 1.0)), null)
    editor.pickWhenPresent("in9")
    assertEquals(null, editor.picked)
    editor.setItems(listOf(poster, chair, fresh))
    assertEquals("in9", editor.picked)
  }

  @Test
  fun `a placed item already in the feed is picked at once, and a manual pick cancels the wait`() {
    loaded()
    editor.pickWhenPresent("in1")
    assertEquals("in1", editor.picked)
    editor.pickWhenPresent("in9")
    editor.pick("in2")
    editor.setItems(listOf(poster, chair, BuilderItem("in9", "el9:in9", "image", "New", tr(v(0.0, 0.0, 0.0)), tr(v(0.0, 0.0, 0.0)), null)))
    assertEquals("in2", editor.picked)
  }

  @Test
  fun `an everywhere edit relays the shared transform, without this place's offset`() {
    loaded()
    moveTo("in2", 3.5)
    assertEquals(listOf("draft in2 model"), remote.calls)
    assertEquals(3.0, remote.relayed.single().position.x, 1e-9)
  }

  @Test
  fun `a just-here edit relays the untouched shared transform`() {
    loaded()
    editor.pick("in2")
    editor.setScope(Scope.JUST_HERE)
    editor.setExact(TransformMode.MOVE, Axis.X, 3.5)
    assertEquals(2.0, remote.relayed.last().position.x, 1e-9)
  }

  @Test
  fun `quick edits are throttled, and the last one still goes out`() {
    loaded()
    editor.pick("in1")
    editor.setExact(TransformMode.MOVE, Axis.X, 2.0)
    t += 10
    editor.setExact(TransformMode.MOVE, Axis.X, 3.0)
    // A typed value is flushed at once; the drag case: hold one back, then tick.
    assertEquals(2, remote.relayed.size)
    assertEquals(3.0, remote.relayed.last().position.x, 1e-9)
  }

  @Test
  fun `a drag's held-back pose goes out on tick once due, and on endDrag at once`() {
    loaded()
    editor.pick("in1")
    val down = { x: Double -> Ray(v(x, 10.0, 0.0), v(0.0, -1.0, 0.0)) }
    editor.beginDrag(Handle.Body, down(1.0))
    editor.drag(down(2.0)) // first emit: relayed
    t += 100
    editor.drag(down(3.0)) // session emits (100 ms), throttle lets it through
    t += 100
    editor.drag(down(4.0))
    assertEquals(3, remote.relayed.size)
    // Session emits only every 100 ms; endDrag flushes the session and the throttle together.
    t += 20
    editor.drag(down(5.0))
    assertEquals(3, remote.relayed.size)
    editor.endDrag()
    assertEquals(4, remote.relayed.size)
    assertEquals(5.0, remote.relayed.last().position.x, 1e-9)
    editor.tick()
    assertEquals("nothing left to send", 4, remote.relayed.size)
  }

  @Test
  fun `tick sends a draft the throttle held back`() {
    loaded()
    editor.pick("in1")
    editor.setExact(TransformMode.MOVE, Axis.X, 2.0)
    t += 10
    val down = { x: Double -> Ray(v(x, 10.0, 0.0), v(0.0, -1.0, 0.0)) }
    editor.beginDrag(Handle.Body, down(1.0))
    editor.drag(down(4.0)) // session's first emit this drag; the throttle holds it (10 ms after the last send)
    assertEquals(1, remote.relayed.size)
    editor.tick()
    assertEquals(1, remote.relayed.size)
    t += 100
    editor.tick()
    assertEquals(2, remote.relayed.size)
    assertEquals(4.0, remote.relayed.last().position.x, 1e-9)
  }

  @Test
  fun `a held answer drops the pick and the draft and names who is moving it`() {
    loaded()
    remote.draftAnswer = BuilderCall.Ok(DraftAnswer.Held("Sam (headset)"))
    moveTo("in1", 4.0)
    assertNull(editor.picked)
    assertTrue(store.drafts().isEmpty())
    assertEquals("Sam (headset) is moving this", editor.view().message)
    assertTrue(editor.overrides().isEmpty())
  }

  @Test
  fun `an unavailable answer changes nothing`() {
    loaded()
    remote.draftAnswer = BuilderCall.Ok(DraftAnswer.Unavailable)
    moveTo("in1", 4.0)
    assertEquals("in1", editor.picked)
    assertEquals(1, store.drafts().size)
  }

  @Test
  fun `save runs each item's ops, forgets those that saved and keeps those that failed`() {
    loaded()
    moveTo("in1", 4.0)
    moveTo("in2", 3.5)
    remote.calls.clear()
    remote.failing += "update in2"
    editor.save()
    assertEquals(listOf("update in1 4.0", "end in1 true", "update in2 3.0"), remote.calls)
    assertEquals(listOf("in2"), store.drafts().map { it.sk })
    assertEquals("Couldn't save 1 change: try again", editor.view().message)
    remote.failing.clear()
    remote.calls.clear()
    editor.save()
    assertEquals(listOf("update in2 3.0", "end in2 true"), remote.calls)
    assertTrue(store.drafts().isEmpty())
    assertNull(editor.view().message)
  }

  @Test
  fun `a saved item keeps its saved place until the feed has it`() {
    loaded()
    moveTo("in1", 4.0)
    editor.save()
    editor.unpick()
    assertEquals(4.0, editor.overrides()["el1:in1"]!!.position.x, 1e-9)
    editor.setItems(listOf(poster, chair)) // a snapshot from before the save
    assertEquals(4.0, editor.overrides()["el1:in1"]!!.position.x, 1e-9)
    editor.setItems(listOf(poster.copy(now = tr(v(4.0, 1.0, 0.0)), shared = tr(v(4.0, 1.0, 0.0))), chair))
    assertNull(editor.overrides()["el1:in1"])
  }

  @Test
  fun `a draft edited again while saving is kept for the next save`() {
    loaded()
    moveTo("in1", 4.0)
    remote.during = { if (remote.calls.last().startsWith("update")) editor.setExact(TransformMode.MOVE, Axis.X, 5.0) }
    editor.save()
    remote.during = null
    assertEquals(5.0, store.draft("in1")!!.now.position.x, 1e-9)
  }

  @Test
  fun `revert ends each draft unsaved and puts the picked item back`() {
    loaded()
    moveTo("in1", 4.0)
    remote.calls.clear()
    editor.revert()
    assertEquals(listOf("end in1 false"), remote.calls)
    assertTrue(store.drafts().isEmpty())
    assertEquals(1.0, editor.pickedItem()!!.second.position.x, 1e-9)
  }

  @Test
  fun `done with nothing to save leaves at once`() {
    loaded()
    editor.pick("in1")
    assertEquals(DoneStep.LEFT, editor.done())
    assertEquals(1, left)
    assertTrue(remote.calls.isEmpty())
    assertNull(editor.picked)
  }

  @Test
  fun `done with changes asks, and yes saves then leaves`() {
    loaded()
    moveTo("in1", 4.0)
    assertEquals(DoneStep.CONFIRM, editor.done())
    assertTrue(editor.view().confirmingDone)
    assertEquals(0, left)
    remote.calls.clear()
    editor.confirmDone(save = true)
    assertEquals(listOf("update in1 4.0", "end in1 true"), remote.calls)
    assertEquals(1, left)
    assertFalse(editor.view().confirmingDone)
  }

  @Test
  fun `done's save that fails stays in builder mode with the message`() {
    loaded()
    moveTo("in1", 4.0)
    editor.done()
    remote.failing += "update"
    editor.confirmDone(save = true)
    assertEquals(0, left)
    assertEquals("Couldn't save 1 change: try again", editor.view().message)
    assertEquals(1, store.drafts().size)
  }

  @Test
  fun `done's no reverts then leaves`() {
    loaded()
    moveTo("in1", 4.0)
    editor.done()
    remote.calls.clear()
    editor.confirmDone(save = false)
    assertEquals(listOf("end in1 false"), remote.calls)
    assertEquals(1, left)
    assertTrue(store.drafts().isEmpty())
  }

  @Test
  fun `an item deleted in the shared scene loses its draft quietly and is unpicked`() {
    loaded()
    editor.pick("in2")
    editor.setScope(Scope.JUST_HERE)
    editor.setExact(TransformMode.MOVE, Axis.X, 3.5)
    remote.calls.clear()
    editor.setItems(listOf(poster))
    assertEquals(listOf("end in2 false"), remote.calls)
    assertNull(editor.picked)
    assertTrue(store.drafts().isEmpty())
    assertNull(editor.view().message)
  }

  @Test
  fun `reset to shared saves as a cleared adjustment`() {
    loaded()
    editor.resetToShared("in2")
    assertEquals(2.0, editor.overrides()["el2:in2"]!!.position.x, 1e-9)
    remote.calls.clear()
    editor.save()
    assertEquals(listOf("clear in2"), remote.calls)
  }

  @Test
  fun `reset to shared does nothing for an item without an adjustment`() {
    loaded()
    editor.resetToShared("in1")
    assertTrue(store.drafts().isEmpty())
  }

  @Test
  fun `a just-here edit saves as this place's offset`() {
    loaded()
    editor.pick("in2")
    editor.setScope(Scope.JUST_HERE)
    editor.setExact(TransformMode.MOVE, Axis.X, 3.5)
    remote.calls.clear()
    editor.save()
    assertEquals(listOf("adjust in2 1.5"), remote.calls)
  }

  @Test
  fun `the switch defaults to Everywhere, and picking again restores an item's own scope`() {
    loaded()
    editor.pick("in2")
    assertEquals(Scope.EVERYWHERE, editor.view().scope)
    editor.setScope(Scope.JUST_HERE)
    editor.setExact(TransformMode.MOVE, Axis.X, 3.5)
    editor.pick("in1")
    assertEquals(Scope.EVERYWHERE, editor.view().scope)
    editor.pick("in2")
    assertEquals(Scope.JUST_HERE, editor.view().scope)
    assertEquals(3.5, editor.pickedItem()!!.second.position.x, 1e-9)
  }

  @Test
  fun `switching an edited item's scope changes what it saves`() {
    loaded()
    moveTo("in2", 3.5)
    editor.setScope(Scope.JUST_HERE)
    assertEquals(listOf(SaveOp.PutAdjustment("in2", Adjustment(v(1.5, 0.0, 0.0), v(0.0, 0.0, 0.0), v(1.0, 1.0, 1.0)))), store.saveOps())
  }

  @Test
  fun `exact rotation and scale go through the session, scale floored at 0_05`() {
    loaded()
    editor.pick("in1")
    editor.setExact(TransformMode.ROTATE, Axis.Y, 90.0)
    editor.setExact(TransformMode.RESIZE, Axis.X, 0.0)
    val now = store.draft("in1")!!.now
    assertEquals(90.0, now.rotation.y, 0.0)
    assertEquals(MIN_SCALE, now.scale.x, 0.0)
    assertEquals("the bar's mode is unchanged", TransformMode.MOVE, editor.mode)
  }

  @Test
  fun `a picked item with no changes follows the feed`() {
    loaded()
    editor.pick("in1")
    editor.setItems(listOf(poster.copy(now = tr(v(7.0, 1.0, 0.0))), chair))
    assertEquals(7.0, editor.pickedItem()!!.second.position.x, 1e-9)
  }

  @Test
  fun `expire ends old drafts unsaved`() {
    loaded()
    moveTo("in1", 4.0)
    remote.calls.clear()
    t += 10 * 60_000L + 1
    editor.expire(10 * 60_000L)
    assertEquals(listOf("end in1 false"), remote.calls)
    assertEquals(1.0, editor.pickedItem()!!.second.position.x, 1e-9)
  }

  @Test
  fun `the hud model shows rows with the adjusted dot and the picked bar`() {
    loaded()
    moveTo("in1", 4.0)
    val m = hudModel(editor.view(), HudTab.LAYOUT, hudWarnings(false, listOf("Gallery")))
    assertEquals(BUILDER_BANNER, m.banner)
    assertEquals(1, m.warnings.size)
    assertEquals(
        listOf(HudRow("in1", "Poster", "Image", false, true, true), HudRow("in2", "Chair", "Model", true, false, false)),
        m.rows,
    )
    val bar = m.bar!!
    assertEquals("Poster", bar.name)
    assertEquals(Scope.EVERYWHERE, bar.scope)
    assertEquals(listOf("4.00", "1.00", "0.00"), bar.exact[0].values)
    assertEquals("Rotation", bar.exact[1].label)
    assertTrue(m.canSave)
  }

  @Test
  fun `the hud model has no bar and no save with nothing picked or edited`() {
    loaded()
    val m = hudModel(editor.view(), HudTab.ASSETS, emptyList())
    assertNull(m.bar)
    assertFalse(m.canSave)
    assertTrue(m.warnings.isEmpty())
  }

  // ── fix round 1 ──

  private fun down(x: Double) = Ray(v(0.0, 10.0, 0.0), TransformMath.normalize(v(x, -9.0, 0.0)))

  @Test
  fun `revert mid-drag leaves no draft and relays nothing more`() {
    loaded()
    editor.pick("in1")
    editor.beginDrag(Handle.Body, down(1.0))
    editor.drag(down(2.0)) // relayed
    t += 20
    editor.drag(down(3.0)) // unsent: inside the session's 100 ms
    val relayed = remote.relayed.size
    editor.revert()
    editor.endDrag()
    editor.tick()
    t += 200
    editor.tick()
    assertTrue(store.drafts().isEmpty())
    assertEquals(relayed, remote.relayed.size)
    assertEquals("end in1 false", remote.calls.last())
  }

  @Test
  fun `leaving mid-drag (Done, save) leaves no draft behind and relays nothing after the save`() {
    loaded()
    moveTo("in1", 4.0)
    assertEquals(DoneStep.CONFIRM, editor.done())
    editor.beginDrag(Handle.Body, down(4.0))
    t += 200
    editor.drag(down(5.0))
    t += 20
    editor.drag(down(6.0)) // unsent
    editor.confirmDone(save = true)
    editor.endDrag()
    t += 200
    editor.tick()
    assertEquals(1, left)
    assertTrue(store.drafts().isEmpty())
    assertEquals("end in1 true", remote.calls.last())
  }

  @Test
  fun `leaving mid-drag (Done, don't save) leaves no draft behind`() {
    loaded()
    moveTo("in1", 4.0)
    editor.done()
    editor.beginDrag(Handle.Body, down(4.0))
    t += 200
    editor.drag(down(5.0))
    t += 20
    editor.drag(down(6.0))
    editor.confirmDone(save = false)
    editor.endDrag()
    assertTrue(store.drafts().isEmpty())
    assertEquals("end in1 false", remote.calls.last())
  }

  @Test
  fun `a second Save tap while one is pending sends each call once`() {
    val pending = ArrayList<suspend () -> Unit>()
    val deferred = BuilderEditor(remote, store, { t }, { pending += it })
    deferred.setItems(listOf(poster, chair))
    deferred.pick("in1")
    deferred.setExact(TransformMode.MOVE, Axis.X, 4.0)
    runBlocking { pending.toList().forEach { it() } }
    pending.clear()
    remote.calls.clear()
    deferred.save()
    deferred.save()
    deferred.done()
    deferred.confirmDone(save = true)
    assertTrue(deferred.view().saving)
    runBlocking { pending.toList().forEach { it() } }
    assertEquals(listOf("update in1 4.0", "end in1 true"), remote.calls)
    assertFalse(deferred.view().saving)
  }

  @Test
  fun `after a just-here save, an everywhere edit takes the new adjustment out`() {
    loaded()
    editor.pick("in2")
    editor.setScope(Scope.JUST_HERE)
    editor.setExact(TransformMode.MOVE, Axis.X, 3.5) // offset 1.5 from shared 2.0
    editor.save()
    editor.setItems(listOf(poster, chair)) // the feed hasn't caught up
    editor.pick("in2")
    assertEquals(Scope.EVERYWHERE, editor.view().scope)
    editor.setExact(TransformMode.MOVE, Axis.X, 4.0)
    remote.calls.clear()
    editor.save()
    assertEquals(listOf("update in2 2.5", "end in2 true"), remote.calls)
  }

  @Test
  fun `after an everywhere save, a just-here edit measures from the new shared transform`() {
    loaded()
    moveTo("in2", 3.5) // shared becomes 3.0
    editor.save()
    editor.setItems(listOf(poster, chair))
    editor.pick("in2")
    editor.setScope(Scope.JUST_HERE)
    editor.setExact(TransformMode.MOVE, Axis.X, 4.0)
    remote.calls.clear()
    editor.save()
    assertEquals(listOf("adjust in2 1.0"), remote.calls)
  }

  @Test
  fun `after a just-here save, moving back to the shared place clears the adjustment`() {
    loaded()
    editor.pick("in1")
    editor.setScope(Scope.JUST_HERE)
    editor.setExact(TransformMode.MOVE, Axis.X, 2.0)
    editor.save()
    editor.pick("in1")
    editor.setScope(Scope.JUST_HERE)
    editor.setExact(TransformMode.MOVE, Axis.X, 1.0)
    remote.calls.clear()
    editor.save()
    assertEquals(listOf("clear in1"), remote.calls)
  }

  @Test
  fun `once the feed changes for a saved item, its edits start from the feed again`() {
    loaded()
    moveTo("in2", 3.5)
    editor.save()
    val moved = chair.copy(now = tr(v(7.5, 0.0, 0.0)), shared = tr(v(7.0, 0.0, 0.0)))
    editor.setItems(listOf(poster, moved))
    editor.pick("in2")
    editor.setScope(Scope.JUST_HERE)
    editor.setExact(TransformMode.MOVE, Axis.X, 8.0)
    remote.calls.clear()
    editor.save()
    assertEquals(listOf("adjust in2 1.0"), remote.calls)
  }

  @Test
  fun `a saved place gives way at once when someone else moves the item`() {
    loaded()
    moveTo("in1", 4.0)
    editor.save()
    editor.unpick()
    editor.setItems(listOf(poster.copy(now = tr(v(9.0, 1.0, 0.0)), shared = tr(v(9.0, 1.0, 0.0))), chair))
    assertNull(editor.overrides()["el1:in1"])
  }

  @Test
  fun `clearing an adjustment that is already gone counts as saved`() {
    loaded()
    editor.resetToShared("in2")
    remote.notFound += "clear"
    editor.save()
    assertTrue(store.drafts().isEmpty())
    assertNull(editor.view().message)
  }

  @Test
  fun `a failed draft end after a saved instance retries only the draft end`() {
    loaded()
    moveTo("in1", 4.0)
    remote.failing += "end in1"
    editor.save()
    assertTrue("the move saved", store.drafts().isEmpty())
    assertNull(editor.view().message)
    remote.failing.clear()
    remote.calls.clear()
    editor.save()
    assertEquals(listOf("end in1 true"), remote.calls)
    remote.calls.clear()
    editor.save()
    assertTrue(remote.calls.isEmpty())
  }

  @Test
  fun `an axis handle's lock ends with its drag`() {
    loaded()
    editor.pick("in1")
    editor.beginDrag(Handle.Body, down(1.0), MoveLock.Z)
    assertEquals(MoveLock.Z, editor.lock)
    editor.drag(down(2.0))
    editor.endDrag()
    assertEquals(MoveLock.FREE, editor.lock)
  }

  @Test
  fun `leaving clears the message and the saved places`() {
    loaded()
    moveTo("in1", 4.0)
    editor.save()
    remote.draftAnswer = BuilderCall.Ok(DraftAnswer.Held("Sam"))
    moveTo("in2", 3.0)
    assertEquals("Sam is moving this", editor.view().message)
    assertEquals(DoneStep.LEFT, editor.done())
    assertNull(editor.view().message)
    assertTrue(editor.overrides().isEmpty())
  }

  @Test
  fun `a failed save-and-leave shows the store's pose, not the dropped drag's unsent one`() {
    loaded()
    moveTo("in1", 4.0)
    assertEquals(DoneStep.CONFIRM, editor.done())
    editor.beginDrag(Handle.Body, down(4.0))
    t += 200
    editor.drag(down(5.0)) // relayed and stored
    t += 20
    editor.drag(down(6.0)) // unsent: only the session has it
    remote.failing += "update"
    editor.confirmDone(save = true)
    assertEquals(0, left)
    assertEquals(5.0, store.draft("in1")!!.now.position.x, 1e-9)
    assertEquals(5.0, editor.pickedItem()!!.second.position.x, 1e-9)
    assertFalse(editor.dragging)
  }

  private fun carried(sk: String = "in1"): ItemTransform {
    editor.pick(sk)
    return editor.beginCarry()!!
  }

  @Test
  fun `a carry drafts and relays like a drag, with the putting-down pose sent last`() {
    loaded()
    val start = carried()
    assertTrue(editor.dragging)
    editor.carryTo(start.copy(position = v(2.0, 1.0, 0.0))) // relayed
    t += 20
    editor.carryTo(start.copy(position = v(3.0, 1.0, 0.0))) // held back
    assertEquals(1, remote.relayed.size)
    t += 20
    editor.endCarry(start.copy(position = v(3.5, 1.0, 0.0)))
    assertFalse(editor.dragging)
    assertEquals(3.5, remote.relayed.last().position.x, 1e-9)
    assertEquals(3.5, store.draft("in1")!!.now.position.x, 1e-9)
    t += 200
    editor.tick()
    assertEquals(3.5, remote.relayed.last().position.x, 1e-9)
  }

  @Test
  fun `carrying needs a picked item and no drag under way`() {
    loaded()
    assertNull(editor.beginCarry())
    editor.pick("in1")
    editor.beginDrag(Handle.Body, down(1.0))
    assertNull(editor.beginCarry())
  }

  @Test
  fun `an item taken by someone else mid-carry drops the carry`() {
    loaded()
    val start = carried()
    editor.carryTo(start.copy(position = v(2.0, 1.0, 0.0)))
    remote.draftAnswer = BuilderCall.Ok(DraftAnswer.Held("Sam"))
    t += 200
    editor.carryTo(start.copy(position = v(3.0, 1.0, 0.0)))
    assertNull(editor.picked)
    assertFalse(editor.dragging)
  }

  @Test
  fun `a ray drag cannot begin over a carry`() {
    loaded()
    val start = carried()
    editor.beginDrag(Handle.Body, down(1.0))
    editor.drag(down(4.0))
    editor.carryTo(start.copy(position = v(2.0, 1.0, 0.0)))
    assertEquals(2.0, editor.pickedItem()!!.second.position.x, 1e-9)
  }
}
