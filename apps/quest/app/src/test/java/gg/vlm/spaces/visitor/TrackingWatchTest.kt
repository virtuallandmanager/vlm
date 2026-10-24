package gg.vlm.spaces.visitor

import gg.vlm.spaces.Vec3
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TrackingWatchTest {
  /** One 72 Hz frame. */
  private val tick = 1.0 / 72

  @Test fun `steady walking is not a jump`() {
    val w = TrackingWatch()
    for (i in 0..20) assertFalse(w.onHead(Vec3(i * 0.02, 1.6, 0.0), i * 1.0, tick))
  }

  @Test fun `a 0_4 m step in one frame is a jump`() {
    val w = TrackingWatch()
    w.onHead(Vec3(0.0, 1.6, 0.0), 0.0, tick)
    assertTrue(w.onHead(Vec3(0.4, 1.6, 0.0), 0.0, tick))
  }

  @Test fun `a 30 degree yaw snap in one frame is a jump, also across the wrap`() {
    val w = TrackingWatch()
    w.onHead(Vec3(0.0, 1.6, 0.0), 350.0, tick)
    assertTrue(w.onHead(Vec3(0.0, 1.6, 0.0), 20.0, tick))
  }

  @Test fun `a small turn across the wrap is not a jump`() {
    val w = TrackingWatch()
    w.onHead(Vec3(0.0, 1.6, 0.0), 355.0, tick)
    assertFalse(w.onHead(Vec3(0.0, 1.6, 0.0), 5.0, tick))
  }

  @Test fun `the first call after reset is not a jump`() {
    val w = TrackingWatch()
    w.onHead(Vec3(0.0, 1.6, 0.0), 0.0, tick)
    w.reset()
    assertFalse(w.onHead(Vec3(5.0, 1.6, 0.0), 90.0, tick))
  }

  @Test fun `after a jump the new place is the baseline`() {
    val w = TrackingWatch()
    w.onHead(Vec3(0.0, 1.6, 0.0), 0.0, tick)
    w.onHead(Vec3(3.0, 1.6, 0.0), 0.0, tick)
    assertFalse(w.onHead(Vec3(3.02, 1.6, 0.0), 0.0, tick))
  }

  @Test fun `a stalled tick while walking briskly is not a jump`() {
    // 0.3 s stalled at 2 m/s: 0.6 m, under the 0.75 m that 0.3 s allows.
    val w = TrackingWatch()
    w.onHead(Vec3(0.0, 1.6, 0.0), 0.0, tick)
    assertFalse(w.onHead(Vec3(0.6, 1.6, 0.0), 0.0, 0.3))
    // and turning at 200°/s through the same stall: 60°, under 90°
    assertFalse(w.onHead(Vec3(0.6, 1.6, 0.0), 60.0, 0.3))
  }

  @Test fun `a move faster than walking over a stalled tick is a jump`() {
    val w = TrackingWatch()
    w.onHead(Vec3(0.0, 1.6, 0.0), 0.0, tick)
    assertTrue(w.onHead(Vec3(1.0, 1.6, 0.0), 0.0, 0.3)) // 3.3 m/s
    assertTrue(w.onHead(Vec3(1.0, 1.6, 0.0), 100.0, 0.3)) // 333°/s
  }

  @Test fun `a long gap allows no more than half a second`() {
    val w = TrackingWatch()
    w.onHead(Vec3(0.0, 1.6, 0.0), 0.0, tick)
    // 2 s gap: the allowance stays at 0.5 s (1.25 m, 150°)
    assertFalse(w.onHead(Vec3(1.2, 1.6, 0.0), 0.0, 2.0))
    assertTrue(w.onHead(Vec3(2.6, 1.6, 0.0), 0.0, 2.0))
    assertFalse(w.onHead(Vec3(2.6, 1.6, 0.0), 140.0, 2.0))
    assertTrue(w.onHead(Vec3(2.6, 1.6, 0.0), 300.0, 2.0)) // a 160° turn
  }
}
