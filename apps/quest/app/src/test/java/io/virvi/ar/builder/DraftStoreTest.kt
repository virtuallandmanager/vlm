package io.virvi.ar.builder

import io.virvi.ar.Vec3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DraftStoreTest {
  private var t = 1_000_000L
  private val store = DraftStore { t }

  private fun v(x: Double, y: Double, z: Double) = Vec3(x, y, z)

  private fun tr(p: Vec3, r: Vec3 = v(0.0, 0.0, 0.0), s: Vec3 = v(1.0, 1.0, 1.0)) = ItemTransform(p, r, s)

  private val origin = tr(v(0.0, 0.0, 0.0))

  @Test
  fun `everywhere saves the shared transform then ends the draft saved`() {
    val now = tr(v(2.0, 0.0, 1.0))
    store.edit("a", "image", origin, null, now, Scope.EVERYWHERE)
    assertEquals(listOf(SaveOp.UpdateInstance("a", now), SaveOp.EndDraft("a", true)), store.saveOps())
  }

  @Test
  fun `everywhere on an adjusted item writes now minus the adjustment`() {
    val adj = Adjustment(v(0.5, 0.0, 0.0), v(0.0, 10.0, 0.0), v(2.0, 1.0, 1.0))
    val base = tr(v(1.0, 0.0, 0.0), v(0.0, 90.0, 0.0), v(1.0, 1.0, 1.0))
    // The builder sees shared + adjustment, then drags it 1 m along z.
    val now = tr(v(1.5, 0.0, 1.0), v(0.0, 100.0, 0.0), v(2.0, 1.0, 1.0))
    store.edit("a", "image", base, adj, now, Scope.EVERYWHERE)
    assertEquals(
        listOf(SaveOp.UpdateInstance("a", tr(v(1.0, 0.0, 1.0), v(0.0, 90.0, 0.0), v(1.0, 1.0, 1.0))), SaveOp.EndDraft("a", true)),
        store.saveOps(),
    )
  }

  @Test
  fun `just here saves the offset from the base and needs no end draft`() {
    val base = tr(v(1.0, 0.0, 0.0), v(0.0, 90.0, 0.0), v(2.0, 2.0, 2.0))
    val now = tr(v(1.5, 0.0, 0.0), v(0.0, 100.0, 0.0), v(1.0, 2.0, 2.0))
    store.edit("a", "image", base, null, now, Scope.JUST_HERE)
    assertEquals(
        listOf(SaveOp.PutAdjustment("a", Adjustment(v(0.5, 0.0, 0.0), v(0.0, 10.0, 0.0), v(0.5, 1.0, 1.0)))),
        store.saveOps(),
    )
  }

  @Test
  fun `just here on an adjusted item replaces the adjustment with the full offset`() {
    val adj = Adjustment(v(0.5, 0.0, 0.0), v(0.0, 0.0, 0.0), v(1.0, 1.0, 1.0))
    val base = tr(v(1.0, 0.0, 0.0))
    // Seen at 1.5; nudged a further 0.25 to 1.75: the offset is 0.75 from the base, not 0.25 on top of 0.5.
    store.edit("a", "image", base, adj, tr(v(1.75, 0.0, 0.0)), Scope.JUST_HERE)
    val op = store.saveOps().single() as SaveOp.PutAdjustment
    assertEquals(0.75, op.adjustment.dPosition.x, 1e-9)
  }

  @Test
  fun `a zero base scale component gives factor 1`() {
    val base = tr(v(0.0, 0.0, 0.0), s = v(0.0, 1.0, 1.0))
    store.edit("a", "image", base, null, tr(v(0.0, 0.0, 0.0), s = v(3.0, 1.0, 1.0)), Scope.JUST_HERE)
    val op = store.saveOps().single() as SaveOp.PutAdjustment
    assertEquals(v(1.0, 1.0, 1.0), op.adjustment.scaleFactor)
  }

  @Test
  fun `editing again updates the draft instead of adding one`() {
    store.edit("a", "image", origin, null, tr(v(1.0, 0.0, 0.0)), Scope.EVERYWHERE)
    t += 500
    store.edit("a", "image", origin, null, tr(v(2.0, 0.0, 0.0)), Scope.JUST_HERE)
    val d = store.drafts().single()
    assertEquals(2.0, d.now.position.x, 0.0)
    assertEquals(Scope.JUST_HERE, d.scope)
    assertEquals(t, d.editedAtMs)
  }

  @Test
  fun `saveOps keeps the drafts until each is forgotten`() {
    store.edit("a", "image", origin, null, origin, Scope.EVERYWHERE)
    store.edit("b", "model", origin, null, origin, Scope.EVERYWHERE)
    store.saveOps()
    assertEquals(2, store.drafts().size)
    store.forget("a")
    assertEquals(listOf("b"), store.drafts().map { it.sk })
  }

  @Test
  fun `revert ends each draft unsaved and clears`() {
    store.edit("a", "image", origin, null, origin, Scope.EVERYWHERE)
    store.edit("b", "model", origin, null, origin, Scope.JUST_HERE)
    assertEquals(listOf(SaveOp.EndDraft("a", false), SaveOp.EndDraft("b", false)), store.revert())
    assertTrue(store.drafts().isEmpty())
    assertTrue(store.saveOps().isEmpty())
  }

  @Test
  fun `dropMissing forgets an item that left the feed and ends its draft unsaved`() {
    store.edit("a", "image", origin, null, origin, Scope.EVERYWHERE)
    store.edit("b", "model", origin, null, origin, Scope.EVERYWHERE)
    assertEquals(listOf(SaveOp.EndDraft("a", false)), store.dropMissing(setOf("b")))
    assertEquals(listOf("b"), store.drafts().map { it.sk })
    assertTrue(store.dropMissing(setOf("b")).isEmpty())
  }

  @Test
  fun `expire ends the drafts it drops unsaved`() {
    store.edit("old", "image", origin, null, origin, Scope.JUST_HERE)
    t += 10 * 60_000L + 1
    assertEquals(listOf(SaveOp.EndDraft("old", false)), store.expire(10 * 60_000L))
  }

  @Test
  fun `a just-here edit back at its base clears the adjustment instead of saving an identity one`() {
    val adj = Adjustment(v(0.5, 0.0, 0.0), v(0.0, 0.0, 0.0), v(1.0, 1.0, 1.0))
    val base = tr(v(1.0, 0.0, 0.0), v(0.0, 90.0, 0.0))
    // 450 degrees is 90: still the base.
    store.edit("a", "image", base, adj, tr(v(1.0, 0.0, 0.0), v(0.0, 450.0, 0.0)), Scope.JUST_HERE)
    assertEquals(listOf(SaveOp.DeleteAdjustment("a")), store.saveOps())
  }

  @Test
  fun `a just-here edit back at its base with no adjustment only ends the draft`() {
    store.edit("a", "image", origin, null, origin, Scope.JUST_HERE)
    assertEquals(listOf(SaveOp.EndDraft("a", false)), store.saveOps())
  }

  @Test
  fun `sharedNow takes this place's offset out of an everywhere draft`() {
    val adj = Adjustment(v(0.5, 0.0, 0.0), v(0.0, 10.0, 0.0), v(2.0, 1.0, 1.0))
    val base = tr(v(1.0, 0.0, 0.0), v(0.0, 90.0, 0.0))
    store.edit("a", "image", base, adj, tr(v(1.5, 0.0, 1.0), v(0.0, 100.0, 0.0), v(2.0, 1.0, 1.0)), Scope.EVERYWHERE)
    assertEquals(tr(v(1.0, 0.0, 1.0), v(0.0, 90.0, 0.0), v(1.0, 1.0, 1.0)), store.drafts().single().sharedNow)
  }

  @Test
  fun `sharedNow of a just-here draft is the untouched base`() {
    val base = tr(v(1.0, 0.0, 0.0))
    store.edit("a", "image", base, null, tr(v(3.0, 0.0, 0.0)), Scope.JUST_HERE)
    assertEquals(base, store.draft("a")!!.sharedNow)
  }

  @Test
  fun `expire drops drafts older than the limit`() {
    val tenMin = 10 * 60_000L
    store.edit("old", "image", origin, null, origin, Scope.EVERYWHERE)
    t += tenMin + 1
    store.edit("new", "model", origin, null, origin, Scope.EVERYWHERE)
    store.expire(tenMin)
    assertEquals(listOf("new"), store.drafts().map { it.sk })
    t += tenMin
    store.expire(tenMin)
    assertTrue("exactly at the limit stays", store.drafts().isNotEmpty())
    t += 1
    store.expire(tenMin)
    assertFalse(store.drafts().isNotEmpty())
  }

  @Test
  fun `a mirrored item's just-here factor stays positive, the mirror staying in the shared scale`() {
    val base = tr(v(0.0, 0.0, 0.0), s = v(-2.0, 1.0, 1.0))
    store.edit("a", "image", base, null, tr(v(0.0, 0.0, 0.0), s = v(-3.0, 1.0, 1.0)), Scope.JUST_HERE)
    val op = store.saveOps().single() as SaveOp.PutAdjustment
    assertEquals(v(1.5, 1.0, 1.0), op.adjustment.scaleFactor)
  }
}
