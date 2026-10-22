package gg.vlm.spaces.quest.ring

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraStatusTest {
  @Test
  fun cameraStatusText() {
    assertEquals("Camera permission denied: marker detection is off", cameraStatusText(CameraStatus.NO_PERMISSION))
    assertEquals(
        "No passthrough camera found (needs Quest 3/3S, Horizon OS v74+)",
        cameraStatusText(CameraStatus.NO_CAMERA),
    )
    CameraStatus.values().forEach { assertTrue(it.name, cameraStatusText(it).isNotBlank()) }
  }
}
