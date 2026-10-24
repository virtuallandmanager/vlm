package gg.vlm.spaces.visitor

import gg.vlm.spaces.Vec3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RingLockTest {
  private val head = Vec3(0.0, 1.6, 0.0)
  private val near = Vec3(0.0, 1.6, 1.0)
  private val far = Vec3(0.0, 1.6, 3.0)

  @Test fun `gathers until enough frames, then steps steady once`() {
    val l = RingLock()
    repeat(VisitorTuning.MIN_FRAMES - 1) { assertEquals(Gate.GATHERING, l.step(near, 180.0, head).gate) }
    val s = l.step(near, 180.0, head)
    assertEquals(Gate.STEADY, s.gate)
    assertTrue(s.becameSteady)
    assertEquals(near, s.world)
    assertEquals(180.0, s.headingDeg!!, 1e-9)
    val again = l.step(near, 180.0, head)
    assertEquals(Gate.STEADY, again.gate)
    assertFalse(again.becameSteady)
  }

  @Test fun `too far with a wall heading`() {
    val l = RingLock()
    repeat(VisitorTuning.MIN_FRAMES) { l.step(far, 180.0, head) }
    assertEquals(Gate.TOO_FAR, l.step(far, 180.0, head).gate)
  }

  @Test fun `no wall heading is gathering, never too far or steady`() {
    val l = RingLock()
    repeat(20) {
      assertEquals(Gate.GATHERING, l.step(far, null, head).gate)
    }
    val n = RingLock()
    repeat(20) {
      val s = n.step(near, null, head)
      assertEquals(Gate.GATHERING, s.gate)
      assertFalse(s.becameSteady)
    }
  }

  @Test fun `a frame without a wall in the window holds it gathering`() {
    val l = RingLock()
    repeat(VisitorTuning.MIN_FRAMES) { l.step(near, 180.0, head) }
    assertEquals(Gate.GATHERING, l.step(near, null, head).gate)
  }

  @Test fun `leaving steady and coming back is a new edge`() {
    val l = RingLock()
    repeat(VisitorTuning.MIN_FRAMES) { l.step(near, 180.0, head) }
    // a wobble pushes the spread over the limit
    assertEquals(Gate.GATHERING, l.step(Vec3(0.1, 1.6, 1.0), 180.0, head).gate)
    l.clear()
    repeat(VisitorTuning.MIN_FRAMES - 1) { l.step(near, 180.0, head) }
    assertTrue(l.step(near, 180.0, head).becameSteady)
  }

  @Test fun `dropping out of steady and settling again without clear is a new edge`() {
    val l = RingLock()
    var edges = 0
    repeat(VisitorTuning.MIN_FRAMES) { if (l.step(near, 180.0, head).becameSteady) edges++ }
    assertEquals(1, edges)
    // a wobble leaves the gate, and stays in the window until enough steady frames push it out
    assertEquals(Gate.GATHERING, l.step(Vec3(0.1, 1.6, 1.0), 180.0, head).gate)
    var back = 0
    repeat(VisitorTuning.AVERAGE_FRAMES + VisitorTuning.MIN_FRAMES) { if (l.step(near, 180.0, head).becameSteady) back++ }
    assertEquals(1, back)
    assertEquals(Gate.STEADY, l.step(near, 180.0, head).gate)
  }
}
