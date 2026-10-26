package io.virvi.ar.ring

import io.virvi.ar.Vec3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PoseAveragerTest {
  @Test
  fun meanOfSamples() {
    val a = PoseAverager(capacity = 10, minCount = 1)
    a.add(Vec3(1.0, 2.0, 3.0))
    a.add(Vec3(3.0, 2.0, 1.0))
    val m = a.mean()!!
    assertEquals(2.0, m.x, 1e-12)
    assertEquals(2.0, m.y, 1e-12)
    assertEquals(2.0, m.z, 1e-12)
    // Spread is the largest distance from the mean: sqrt(1 + 1).
    assertEquals(Math.sqrt(2.0), a.spread()!!, 1e-12)
  }

  @Test
  fun minimumCount() {
    val a = PoseAverager(capacity = 10, minCount = 5)
    repeat(4) { a.add(Vec3(0.0, 0.0, it.toDouble())) }
    assertFalse(a.ready)
    assertEquals(4, a.count)
    a.add(Vec3(0.0, 0.0, 4.0))
    assertTrue(a.ready)
    assertEquals(2.0, a.mean()!!.z, 1e-12)
  }

  @Test
  fun capacityDropsOldest() {
    val a = PoseAverager(capacity = 3, minCount = 1)
    for (z in listOf(100.0, 1.0, 2.0, 3.0)) a.add(Vec3(0.0, 0.0, z))
    assertEquals(3, a.count)
    assertEquals(2.0, a.mean()!!.z, 1e-12)
  }

  @Test
  fun clear() {
    val a = PoseAverager(capacity = 10, minCount = 1)
    a.add(Vec3(1.0, 1.0, 1.0))
    a.clear()
    assertEquals(0, a.count)
    assertFalse(a.ready)
    assertNull(a.mean())
    assertNull(a.spread())
  }
}
