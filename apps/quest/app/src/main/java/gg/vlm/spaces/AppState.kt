package gg.vlm.spaces

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import gg.vlm.spaces.api.FeedStatus
import gg.vlm.spaces.ring.CameraStatus
import gg.vlm.spaces.ring.RING_TEST_MARKERS

/** What the control panel shows. Written on the main thread by MainActivity, read by the Compose panel. */
class AppState {
  var feedUrl by mutableStateOf("https://vlm.gg")
  /** Temporary (until the visitor flow): the space to follow, typed by hand. */
  var spaceId by mutableStateOf("")
  var feed by mutableStateOf<FeedStatus?>(null)
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
  var occlusion by mutableStateOf(Occlusion.DEPTH)
  var occlusionStatus by mutableStateOf("Hidden behind anything real the headset's depth sees")
  /** Tints the room scan's walls and ceiling, to check they line up with the real ones. */
  var showWalls by mutableStateOf(false)
}

/** What hides the virtual scene where something real is in front of it. */
enum class Occlusion(val label: String) {
  OFF("Off"),
  /** The room scan's walls and ceiling, as surfaces that show passthrough. */
  WALLS("Walls"),
  /** The headset's live depth: anything real, people and furniture included. */
  DEPTH("Live depth"),
}

/** What the panel's buttons do. */
interface PanelActions {
  fun connect()
  fun placeAhead()
  fun turn(degrees: Double)
  fun alignToMarker()
  fun setModelTurn(on: Boolean)
  fun resetReadings()
  fun setOcclusion(o: Occlusion)
  fun setShowWalls(on: Boolean)
}
