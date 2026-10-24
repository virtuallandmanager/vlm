package gg.vlm.spaces.visitor

import gg.vlm.spaces.Vec3
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TrackingWatchTest {
  @Test fun `steady walking is not a jump`() {
    val w = TrackingWatch()
    for (i in 0..20) assertFalse(w.onHead(Vec3(i * 0.02, 1.6, 0.0), i * 1.0))
  }

  @Test fun `a 0_4 m step is a jump`() {
    val w = TrackingWatch()
    w.onHead(Vec3(0.0, 1.6, 0.0), 0.0)
    assertTrue(w.onHead(Vec3(0.4, 1.6, 0.0), 0.0))
  }

  @Test fun `a 30 degree yaw snap is a jump, also across the wrap`() {
    val w = TrackingWatch()
    w.onHead(Vec3(0.0, 1.6, 0.0), 350.0)
    assertTrue(w.onHead(Vec3(0.0, 1.6, 0.0), 20.0))
  }

  @Test fun `a small turn across the wrap is not a jump`() {
    val w = TrackingWatch()
    w.onHead(Vec3(0.0, 1.6, 0.0), 355.0)
    assertFalse(w.onHead(Vec3(0.0, 1.6, 0.0), 5.0))
  }

  @Test fun `the first call after reset is not a jump`() {
    val w = TrackingWatch()
    w.onHead(Vec3(0.0, 1.6, 0.0), 0.0)
    w.reset()
    assertFalse(w.onHead(Vec3(5.0, 1.6, 0.0), 90.0))
  }

  @Test fun `after a jump the new place is the baseline`() {
    val w = TrackingWatch()
    w.onHead(Vec3(0.0, 1.6, 0.0), 0.0)
    w.onHead(Vec3(3.0, 1.6, 0.0), 0.0)
    assertFalse(w.onHead(Vec3(3.02, 1.6, 0.0), 0.0))
  }
}
