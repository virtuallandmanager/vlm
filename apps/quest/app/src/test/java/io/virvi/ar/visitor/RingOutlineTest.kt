package io.virvi.ar.visitor

import kotlin.math.PI
import kotlin.math.hypot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RingOutlineTest {
  @Test fun `48 segments around the printed edge, closing the circle`() {
    val segs = outlineSegments(0.140)
    assertEquals(48, segs.size)
    val r = 0.070 + OUTLINE_THICKNESS_M / 2
    for (s in segs) {
      assertEquals(r, hypot(s.centre.x, s.centre.y), 1e-9)
      assertEquals(0.0, s.centre.z, 1e-12)
    }
    // segments overlap a little, so there are no gaps
    assertTrue(segs.sumOf { it.lengthM } > 2 * PI * r)
    assertEquals(2 * PI / 48, segs[1].angleRad - segs[0].angleRad, 1e-9)
  }
}
