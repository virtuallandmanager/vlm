package gg.vlm.spaces.ring

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RingTrackerTest {
  private fun det(id: Long, version: Int = 0) =
      RingDetection(id, version, 0, 640.0, 480.0, 50.0, 45.0, 0.0, 0.0)

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

  @Test
  fun unsupportedVersionIgnored() {
    val t = RingTracker(setOf(7L))
    repeat(10) { assertTrue(t.update(listOf(det(7, version = 1))).isEmpty()) }
    repeat(2) { t.update(listOf(det(7, version = 3), det(7))) }
    assertEquals(listOf(0), t.update(listOf(det(7, version = 15), det(7))).map { it.version })
  }

  @Test
  fun nearestToCentrePicksTheMiddleMarker() {
    fun at(id: Long, x: Double, y: Double) = RingDetection(id, 0, 0, x, y, 50.0, 45.0, 0.0, 0.0)
    val picked = nearestToCentre(listOf(at(1, 100.0, 100.0), at(2, 650.0, 470.0), at(3, 1200.0, 900.0)), 1280, 960)
    assertEquals(2L, picked?.id)
    assertEquals(null, nearestToCentre(emptyList(), 1280, 960))
  }
}
