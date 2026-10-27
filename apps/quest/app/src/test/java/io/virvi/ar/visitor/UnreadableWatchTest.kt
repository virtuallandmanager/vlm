package io.virvi.ar.visitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UnreadableWatchTest {
  @Test fun `reports when the candidate was first seen, across short gaps`() {
    val w = UnreadableWatch()
    assertEquals(VisitorEvent.UnreadableSeen(100), w.onFrame(true, 100))
    assertNull(w.onFrame(false, 200))
    assertEquals(VisitorEvent.UnreadableSeen(100), w.onFrame(true, 900))
  }

  @Test fun `says gone once after the hint time with no candidate`() {
    val w = UnreadableWatch()
    w.onFrame(true, 0)
    assertNull(w.onFrame(false, VisitorTuning.UNREADABLE_HINT_MS - 1))
    assertEquals(VisitorEvent.UnreadableGone, w.onFrame(false, VisitorTuning.UNREADABLE_HINT_MS))
    assertNull(w.onFrame(false, VisitorTuning.UNREADABLE_HINT_MS + 100))
    // a new sighting starts a new run
    assertEquals(VisitorEvent.UnreadableSeen(5000), w.onFrame(true, 5000))
  }

  @Test fun `nothing seen, nothing said`() {
    val w = UnreadableWatch()
    assertNull(w.onFrame(false, 0))
    assertNull(w.onFrame(false, 10_000))
  }

  @Test fun `reset forgets the run`() {
    val w = UnreadableWatch()
    w.onFrame(true, 0)
    w.reset()
    assertNull(w.onFrame(false, 10_000))
  }
}
