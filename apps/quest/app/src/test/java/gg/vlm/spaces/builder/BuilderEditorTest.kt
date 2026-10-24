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
    var during: (() -> Unit)? = null

    private fun unit(call: String): BuilderCall<Unit> {
      calls += call
      during?.invoke()
      return if (failing.any { call.startsWith(it) }) BuilderCall.Failed(500) else BuilderCall.Ok(Unit)
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
  fun `a saved place stops showing after a while even if the feed never has it`() {
    loaded()
    moveTo("in1", 4.0)
    editor.save()
    editor.unpick()
    t += SAVED_SHOW_MS + 1
    editor.setItems(listOf(poster, chair))
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
}
