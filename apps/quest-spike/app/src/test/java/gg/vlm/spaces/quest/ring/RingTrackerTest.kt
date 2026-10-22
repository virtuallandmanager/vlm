package gg.vlm.spaces.quest.ring

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RingTrackerTest {
  private fun det(id: Long) = RingDetection(id, 0, 0, 640.0, 480.0, 50.0, 45.0, 0.0, 0.0)

  @Test
  fun needsThreeFrames() {
    val t = RingTracker(setOf(7L))
    assertTrue(t.update(listOf(det(7))).isEmpty())
    assertTrue(t.update(listOf(det(7))).isEmpty())
    assertEquals(listOf(7L), t.update(listOf(det(7))).map { it.id })
    assertEquals(listOf(7L), t.update(listOf(det(7))).map { it.id })
  }

  @Test
  fun missResets() {
    val t = RingTracker(setOf(7L))
    repeat(3) { t.update(listOf(det(7))) }
    assertTrue(t.update(emptyList()).isEmpty())
    assertTrue(t.update(listOf(det(7))).isEmpty())
    assertTrue(t.update(listOf(det(7))).isEmpty())
    assertEquals(listOf(7L), t.update(listOf(det(7))).map { it.id })
  }

  @Test
  fun unregisteredIgnored() {
    val t = RingTracker(setOf(7L))
    repeat(10) { assertTrue(t.update(listOf(det(9))).isEmpty()) }
    repeat(2) { t.update(listOf(det(7), det(9))) }
    assertEquals(listOf(7L), t.update(listOf(det(7), det(9))).map { it.id })
  }

  @Test
  fun resetForgetsStreaks() {
    val t = RingTracker(setOf(7L))
    repeat(2) { t.update(listOf(det(7))) }
    t.reset()
    assertTrue(t.update(listOf(det(7))).isEmpty())
    assertTrue(t.update(listOf(det(7))).isEmpty())
    assertEquals(listOf(7L), t.update(listOf(det(7))).map { it.id })
  }

  @Test
  fun sameIdTwiceInOneFrameCountsOnce() {
    val t = RingTracker(setOf(7L))
    assertTrue(t.update(listOf(det(7), det(7))).isEmpty())
    assertTrue(t.update(listOf(det(7))).isEmpty())
    assertEquals(listOf(7L), t.update(listOf(det(7), det(7))).map { it.id })
  }
}
