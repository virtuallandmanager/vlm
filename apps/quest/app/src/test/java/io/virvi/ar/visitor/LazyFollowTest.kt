package io.virvi.ar.visitor

import io.virvi.ar.Vec3
import org.junit.Assert.assertEquals
import org.junit.Test

class LazyFollowTest {
  private val eye = Vec3(0.0, 1.6, 0.0)

  @Test fun `first update puts the card 1 m ahead and 15 cm below the eyes`() {
    val p = LazyFollow().update(eye, 0.0, 0)
    assertEquals(0.0, p.position.x, 1e-9)
    assertEquals(1.45, p.position.y, 1e-9)
    assertEquals(1.0, p.position.z, 1e-9)
    assertEquals(0.0, p.yawDeg, 1e-9)
  }

  @Test fun `turning less than 35 degrees leaves it where it is`() {
    val f = LazyFollow()
    f.update(eye, 0.0, 0)
    val p = f.update(eye, 34.0, 100)
    assertEquals(1.0, p.position.z, 1e-9)
    assertEquals(0.0, p.yawDeg, 1e-9)
  }

  @Test fun `turning further re-centres it, eased over 300 ms`() {
    val f = LazyFollow()
    f.update(eye, 0.0, 0)
    val start = f.update(eye, 90.0, 1000)
    assertEquals(1.0, start.position.z, 1e-9) // the ease starts where the card was
    val mid = f.update(eye, 90.0, 1150)
    assertEquals(45.0, mid.yawDeg, 1e-6)
    val end = f.update(eye, 90.0, 1300)
    assertEquals(1.0, end.position.x, 1e-9)
    assertEquals(0.0, end.position.z, 1e-9)
    assertEquals(90.0, end.yawDeg, 1e-9)
    assertEquals(end, f.update(eye, 90.0, 2000))
  }

  @Test fun `walking well away from it re-centres it too`() {
    val f = LazyFollow()
    f.update(eye, 0.0, 0)
    f.update(Vec3(0.0, 1.6, 1.2), 0.0, 1000)
    val p = f.update(Vec3(0.0, 1.6, 1.2), 0.0, 1300)
    assertEquals(2.2, p.position.z, 1e-9)
  }

  @Test fun `recentre snaps on the next update`() {
    val f = LazyFollow()
    f.update(eye, 0.0, 0)
    f.recentre()
    val p = f.update(eye, 180.0, 10)
    assertEquals(-1.0, p.position.z, 1e-9)
  }
}
