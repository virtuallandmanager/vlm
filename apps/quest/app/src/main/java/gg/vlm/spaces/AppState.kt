package gg.vlm.spaces

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import gg.vlm.spaces.api.FeedStatus
import gg.vlm.spaces.ring.CameraStatus
import gg.vlm.spaces.ring.RING_TEST_MARKERS
import gg.vlm.spaces.visitor.RecentSpace
import gg.vlm.spaces.visitor.SpacePageInfo
import gg.vlm.spaces.visitor.VisitorCopy

/** What the panels show. Written on the main thread by MainActivity and the visitor controller, read by Compose. */
class AppState {
  // ── visitor ──
  /** The hint card's line, or null when the card is hidden (the scene is shown). */
  var hint by mutableStateOf<String?>(VisitorCopy.HINT)
  var sceneShown by mutableStateOf(false)
  var menuOpen by mutableStateOf(false)
  /** A line under the menu's buttons, such as "Builder mode is coming soon"; null for none. */
  var menuNote by mutableStateOf<String?>(null)
  var occlusion by mutableStateOf(Occlusion.DEPTH)
  /** The menu's Spaces list is open. */
  var spacesOpen by mutableStateOf(false)
  /** Spaces opened or visited, newest first. */
  var recentSpaces by mutableStateOf<List<RecentSpace>>(emptyList())
  /** The space page's content, or null when the page is closed. */
  var spacePage by mutableStateOf<SpacePageInfo?>(null)
  /** Why the open space page can't show its space (the lookup failed), or null. */
  var spaceProblem by mutableStateOf<String?>(null)

  // ── developer panel (debug builds) ──
  var developerOpen by mutableStateOf(false)
  var serverUrl by mutableStateOf(DEFAULT_BASE_URL)
  var visitorState by mutableStateOf("")
  var feed by mutableStateOf<FeedStatus?>(null)
  var itemCount by mutableStateOf(0)
  var modelTurn by mutableStateOf(true)
  var markerStatus by mutableStateOf("Waiting for permissions")
  /** Null until the camera is first started. */
  var cameraStatus by mutableStateOf<CameraStatus?>(null)
  var markerLines by mutableStateOf(RING_TEST_MARKERS.map { "${it.name}: not seen yet" })
  /** One line per test marker, after its [markerLines] entry: its world position and wall heading. */
  var poseLines by mutableStateOf(RING_TEST_MARKERS.map { "  not in view" })
  var wallStatus by mutableStateOf("Room scan not loaded yet")
  var lastRing by mutableStateOf("No ring marker read yet")
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

/** What the developer panel's buttons do. */
interface DeveloperActions {
  fun setModelTurn(on: Boolean)
  fun resetReadings()
  fun setOcclusion(o: Occlusion)
  fun setShowWalls(on: Boolean)
}
