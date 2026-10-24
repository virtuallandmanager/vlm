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
    repeat(VisitorTuning.MIN_FRAMES - 1) { assertEquals(Gate.GATHERING, l.step(near, 180.0, head, 0L).gate) }
    val s = l.step(near, 180.0, head, 0L)
    assertEquals(Gate.STEADY, s.gate)
    assertTrue(s.becameSteady)
    assertEquals(near, s.world)
    assertEquals(180.0, s.headingDeg!!, 1e-9)
    val again = l.step(near, 180.0, head, 0L)
    assertEquals(Gate.STEADY, again.gate)
    assertFalse(again.becameSteady)
  }

  @Test fun `too far with a wall heading`() {
    val l = RingLock()
    repeat(VisitorTuning.MIN_FRAMES) { l.step(far, 180.0, head, 0L) }
    assertEquals(Gate.TOO_FAR, l.step(far, 180.0, head, 0L).gate)
  }

  @Test fun `no wall heading is gathering, never too far or steady`() {
    val l = RingLock()
    repeat(20) {
      assertEquals(Gate.GATHERING, l.step(far, null, head, 0L).gate)
    }
    val n = RingLock()
    repeat(20) {
      val s = n.step(near, null, head, 0L)
      assertEquals(Gate.GATHERING, s.gate)
      assertFalse(s.becameSteady)
    }
  }

  @Test fun `a frame without a wall in the window holds it gathering`() {
    val l = RingLock()
    repeat(VisitorTuning.MIN_FRAMES) { l.step(near, 180.0, head, 0L) }
    assertEquals(Gate.GATHERING, l.step(near, null, head, 0L).gate)
  }

  @Test fun `leaving steady and coming back is a new edge`() {
    val l = RingLock()
    repeat(VisitorTuning.MIN_FRAMES) { l.step(near, 180.0, head, 0L) }
    // a wobble pushes the spread over the limit
    assertEquals(Gate.GATHERING, l.step(Vec3(0.1, 1.6, 1.0), 180.0, head, 0L).gate)
    l.clear()
    repeat(VisitorTuning.MIN_FRAMES - 1) { l.step(near, 180.0, head, 0L) }
    assertTrue(l.step(near, 180.0, head, 0L).becameSteady)
  }

  @Test fun `dropping out of steady and settling again without clear is a new edge`() {
    val l = RingLock()
    var edges = 0
    repeat(VisitorTuning.MIN_FRAMES) { if (l.step(near, 180.0, head, 0L).becameSteady) edges++ }
    assertEquals(1, edges)
    // a wobble leaves the gate, and stays in the window until enough steady frames push it out
    assertEquals(Gate.GATHERING, l.step(Vec3(0.1, 1.6, 1.0), 180.0, head, 0L).gate)
    var back = 0
    repeat(VisitorTuning.AVERAGE_FRAMES + VisitorTuning.MIN_FRAMES) { if (l.step(near, 180.0, head, 0L).becameSteady) back++ }
    assertEquals(1, back)
    assertEquals(Gate.STEADY, l.step(near, 180.0, head, 0L).gate)
  }

  @Test fun `a still ring with no wall heading says so only after the wait`() {
    val l = RingLock()
    var t = 0L
    repeat(VisitorTuning.MIN_FRAMES) { assertFalse(l.step(near, null, head, t).wallMissing) }
    // still since the MIN_FRAMES-th frame (t = 0); 3 s later it is not yet over the wait
    t = VisitorTuning.NO_WALL_HINT_MS
    assertFalse(l.step(near, null, head, t).wallMissing)
    t += 1
    val s = l.step(near, null, head, t)
    assertTrue(s.wallMissing)
    assertEquals(Gate.GATHERING, s.gate)
  }

  @Test fun `moving, or a wall heading, restarts the no-wall wait`() {
    val l = RingLock()
    repeat(VisitorTuning.MIN_FRAMES) { l.step(near, null, head, 0L) }
    // a wobble: no longer still
    assertFalse(l.step(Vec3(0.1, 1.6, 1.0), null, head, 1_000L).wallMissing)
    l.clear()
    repeat(VisitorTuning.MIN_FRAMES) { l.step(near, null, head, 2_000L) }
    assertFalse(l.step(near, null, head, 4_000L).wallMissing) // 2 s since it settled again
    assertTrue(l.step(near, null, head, 5_001L).wallMissing)
    // with a wall heading it is never missing, however long
    val w = RingLock()
    repeat(VisitorTuning.MIN_FRAMES) { w.step(near, 180.0, head, 0L) }
    assertFalse(w.step(near, 180.0, head, 10_000L).wallMissing)
  }

  private fun step(gate: Gate, wallMissing: Boolean = false) = LockStep(gate, false, near, null, wallMissing)

  @Test fun `gather status for every case`() {
    assertEquals(GatherStatus.NONE_IN_VIEW, gatherStatus(emptyList(), false))
    assertEquals(GatherStatus.UNREADABLE, gatherStatus(emptyList(), true))
    assertEquals(GatherStatus.GATHERING, gatherStatus(listOf(step(Gate.GATHERING)), false))
    assertEquals(GatherStatus.GATHERING, gatherStatus(listOf(step(Gate.STEADY)), false))
    assertEquals(GatherStatus.TOO_FAR, gatherStatus(listOf(step(Gate.TOO_FAR)), false))
    // a readable ring beats an unreadable one
    assertEquals(GatherStatus.TOO_FAR, gatherStatus(listOf(step(Gate.TOO_FAR)), true))
    // one steady ring beats a far one
    assertEquals(GatherStatus.GATHERING, gatherStatus(listOf(step(Gate.TOO_FAR), step(Gate.STEADY)), false))
    assertEquals(GatherStatus.NO_WALL, gatherStatus(listOf(step(Gate.GATHERING, wallMissing = true)), false))
    // another ring still settling, with its wall, isn't stuck
    assertEquals(
        GatherStatus.GATHERING,
        gatherStatus(listOf(step(Gate.GATHERING, wallMissing = true), step(Gate.GATHERING)), false),
    )
  }

  @Test fun `a far ring with no wall heading says step closer`() {
    val l = RingLock()
    var s = l.step(far, null, head, 0L)
    repeat(20) { s = l.step(far, null, head, it * 300L) }
    assertEquals(Gate.GATHERING, s.gate)
    assertEquals(3.0, s.distanceM, 1e-9)
    assertEquals(GatherStatus.TOO_FAR, gatherStatus(listOf(s), false))
    // even once it has held still long enough to say the wall is missing: step closer first
    assertTrue(s.wallMissing)
    assertEquals(GatherStatus.TOO_FAR, gatherStatus(listOf(s), false))
    // a near ring with no heading is still gathering
    val n = RingLock()
    assertEquals(GatherStatus.GATHERING, gatherStatus(listOf(n.step(near, null, head, 0L)), false))
  }

  @Test fun `a still ring seen too steeply says stand in front, never that the wall is missing`() {
    val l = RingLock()
    var s = l.step(near, null, head, 0L, steep = true)
    assertFalse(s.tooSteep) // not still yet
    repeat(40) { s = l.step(near, null, head, it * 300L, steep = true) }
    assertTrue(s.tooSteep)
    assertFalse(s.wallMissing)
    assertEquals(Gate.GATHERING, s.gate)
    assertEquals(GatherStatus.TOO_STEEP, gatherStatus(listOf(s), false))
    // stepping round to head-on: the heading counts again
    repeat(VisitorTuning.AVERAGE_FRAMES) { s = l.step(near, 180.0, head, 20_000L) }
    assertFalse(s.tooSteep)
    assertEquals(Gate.STEADY, s.gate)
  }

  @Test fun `gather status with steep rings`() {
    val steep = LockStep(Gate.GATHERING, false, near, null, tooSteep = true)
    assertEquals(GatherStatus.TOO_STEEP, gatherStatus(listOf(steep), false))
    assertEquals(GatherStatus.TOO_STEEP, gatherStatus(listOf(steep, steep), true))
    // too far comes first; another ring still gathering isn't stuck
    assertEquals(GatherStatus.TOO_FAR, gatherStatus(listOf(steep, step(Gate.TOO_FAR)), false))
    assertEquals(GatherStatus.GATHERING, gatherStatus(listOf(steep, step(Gate.GATHERING)), false))
    assertEquals(GatherStatus.GATHERING, gatherStatus(listOf(steep, step(Gate.STEADY)), false))
  }
}
