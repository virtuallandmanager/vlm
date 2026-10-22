package gg.vlm.spaces.quest

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import gg.vlm.spaces.quest.ring.CameraStatus
import gg.vlm.spaces.quest.ring.RING_TEST_MARKERS

/** What the control panel shows. Written on the main thread by MainActivity, read by the Compose panel. */
class AppState {
  var feedUrl by mutableStateOf("https://vlm.gg")
  var worldKey by mutableStateOf("")
  var feed by mutableStateOf(FeedStatus())
  var itemCount by mutableStateOf(0)
  var modelTurn by mutableStateOf(true)
  var placement by mutableStateOf("Scene 2 m ahead of where you started")
  var markerStatus by mutableStateOf("Waiting for permissions")
  /** Null until the camera is first started. */
  var cameraStatus by mutableStateOf<CameraStatus?>(null)
  var markerLines by mutableStateOf(RING_TEST_MARKERS.map { "${it.name}: not seen yet" })
  /** One line per test marker, after its [markerLines] entry: its world position and wall heading. */
  var poseLines by mutableStateOf(RING_TEST_MARKERS.map { "  not in view" })
  var wallStatus by mutableStateOf("Room scan not loaded yet")
  var lastRing by mutableStateOf("No ring marker read yet")
}

/** What the panel's buttons do. */
interface PanelActions {
  fun connect()
  fun placeAhead()
  fun turn(degrees: Double)
  fun alignToMarker()
  fun setModelTurn(on: Boolean)
  fun resetReadings()
}
