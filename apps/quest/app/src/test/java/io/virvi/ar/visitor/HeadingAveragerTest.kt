package io.virvi.ar.visitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HeadingAveragerTest {
  @Test fun `empty has no mean`() {
    val h = HeadingAverager()
    assertNull(h.mean())
    assertNull(h.spread())
  }

  @Test fun `averages across the plus-minus 180 seam`() {
    val h = HeadingAverager()
    h.add(179.0)
    h.add(-179.0)
    assertEquals(180.0, Math.abs(h.mean()!!), 1e-9)
    assertEquals(1.0, h.spread()!!, 1e-9)
  }

  @Test fun `spread is the largest distance from the mean`() {
    val h = HeadingAverager()
    listOf(10.0, 10.0, 10.0, 14.0).forEach(h::add)
    assertEquals(11.0, h.mean()!!, 0.01)
    assertEquals(3.0, h.spread()!!, 0.01)
  }

  @Test fun `a frame with no wall in the window means no heading`() {
    val h = HeadingAverager(capacity = 3)
    h.add(10.0)
    h.add(null)
    h.add(10.0)
    assertNull(h.mean())
    assertNull(h.spread())
    h.add(10.0)
    assertNull(h.mean())
    h.add(10.0) // the null slides out
    assertEquals(10.0, h.mean()!!, 1e-9)
  }

  @Test fun `keeps only the last capacity headings`() {
    val h = HeadingAverager(capacity = 2)
    listOf(90.0, 0.0, 0.0).forEach(h::add)
    assertEquals(0.0, h.mean()!!, 1e-9)
    assertEquals(0.0, h.spread()!!, 1e-9)
    h.clear()
    assertNull(h.mean())
  }
}
