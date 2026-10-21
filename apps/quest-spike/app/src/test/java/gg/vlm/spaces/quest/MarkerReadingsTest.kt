package gg.vlm.spaces.quest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkerReadingsTest {
  @Test
  fun foundIsWhereTrackingStartsAndLostIsWhereItStops() {
    val r = MarkerReading()
    r.observe(true, 3.1)
    r.observe(true, 3.6)
    r.observe(false, 4.2)
    r.observe(true, 2.4)
    assertEquals(listOf(3.1, 2.4), r.foundAt)
    assertEquals(listOf(3.6), r.lostAt)
    assertEquals(3.1, r.farthestFound!!, 0.0)
    assertEquals(3.6, r.farthestTracked!!, 0.0)
    assertEquals(2.4, r.now!!, 0.0)
    assertTrue(r.tracked)
  }

  @Test
  fun summaryLine() {
    val r = MarkerReading()
    assertEquals("not seen yet", r.summary)
    r.observe(true, 2.345)
    assertEquals("tracking at 2.35 m · found at 2.35 m (farthest 2.35 m)", r.summary)
    r.observe(false, 4.0)
    assertEquals("not tracking · found at 2.35 m (farthest 2.35 m) · lost at 2.35 m", r.summary)
  }

  @Test
  fun markerForQrPayload() {
    assertEquals("TEST12", TestMarker.codeFromQr("HTTPS://VLM.GG/S/TEST12"))
    assertEquals("TEST17", TestMarker.codeFromQr("https://vlm.gg/s/test17"))
    assertNull(TestMarker.codeFromQr("https://example.com/s/TEST12"))
  }

  @Test
  fun qrSideIsTwentyFiveOfThirtyThreeModules() {
    assertEquals(0.0909, TestMarker.ALL[0].qrSide, 1e-4)
  }
}
