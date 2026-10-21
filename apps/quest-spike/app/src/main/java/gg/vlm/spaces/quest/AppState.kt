package gg.vlm.spaces.quest

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** What the control panel shows. Written on the main thread by MainActivity, read by the Compose panel. */
class AppState {
  var feedUrl by mutableStateOf("https://vlm.gg")
  var worldKey by mutableStateOf("")
  var feed by mutableStateOf(FeedStatus())
  var itemCount by mutableStateOf(0)
  var modelTurn by mutableStateOf(true)
  var placement by mutableStateOf("Scene 2 m ahead of where you started")
  var markerStatus by mutableStateOf("Marker tracking not started")
  var markerLines by mutableStateOf(TestMarker.ALL.map { "${it.code}: not seen yet" })
  var lastQr by mutableStateOf("No QR code read yet")
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
