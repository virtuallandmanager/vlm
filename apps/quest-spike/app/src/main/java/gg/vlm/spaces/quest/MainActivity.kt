package gg.vlm.spaces.quest

import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import androidx.compose.ui.platform.ComposeView
import com.meta.spatial.compose.ComposeFeature
import com.meta.spatial.compose.ComposeViewPanelRegistration
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Query
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.Vector3
import com.meta.spatial.mruk.MRUKFeature
import com.meta.spatial.mruk.MRUKPlane
import com.meta.spatial.mruk.MRUKStartTrackerResult
import com.meta.spatial.mruk.TrackedQrCode
import com.meta.spatial.mruk.Tracker
import com.meta.spatial.mruk.TrackingStatus
import com.meta.spatial.okhttp3.OkHttpAssetFetcher
import com.meta.spatial.runtime.NetworkedAssetLoader
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.DpPerMeterDisplayOptions
import com.meta.spatial.toolkit.Grabbable
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.PanelStyleOptions
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.UIPanelSettings
import com.meta.spatial.toolkit.createPanelEntity
import com.meta.spatial.vr.VRFeature
import java.io.File
import kotlin.math.atan2
import kotlin.math.sqrt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/**
 * VLM Spaces for Meta Quest 3 / 3S (spike). Shows a VLM scene life-size in passthrough, fed by the same long-poll feed
 * as the Hyperfy app, and runs the marker detection-range test with Horizon OS's QR code tracking (MRUK trackables).
 */
class MainActivity : AppSystemActivity(), PanelActions {
  private lateinit var mruk: MRUKFeature
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private val state = AppState()
  private lateinit var renderer: SceneRenderer
  private lateinit var feed: FeedClient
  private var panel: Entity? = null

  /** The scene centre on the floor and VLM north's turn from world +Z, in radians. */
  private var centre = Vector3(0f, 0f, 2f)
  private var yaw = 0.0
  private var placedOnce = false

  private val readings = TestMarker.ALL.associate { it.code to MarkerReading() }
  private var lastUiUpdate = 0L
  private var lastMarkerPose: Pose? = null

  override fun registerFeatures(): List<SpatialFeature> {
    mruk = MRUKFeature(this, systemManager)
    return listOf(VRFeature(this), ComposeFeature(), mruk)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    NetworkedAssetLoader.init(File(cacheDir.canonicalPath), OkHttpAssetFetcher())
    renderer = SceneRenderer(this)
    renderer.onApplied = { state.itemCount = renderer.count() }
    feed = FeedClient(scope, onStatus = { state.feed = it }, onSnapshot = { renderer.apply(planScene(it)) })

    val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
    state.feedUrl = intent.getStringExtra("feedUrl") ?: prefs.getString("feedUrl", null) ?: state.feedUrl
    state.worldKey = intent.getStringExtra("worldKey") ?: prefs.getString("worldKey", null) ?: ""

    if (checkSelfPermission(PERMISSION_USE_SCENE) != PackageManager.PERMISSION_GRANTED) {
      state.markerStatus = "Waiting for the spatial data permission"
      requestPermissions(arrayOf(PERMISSION_USE_SCENE), REQUEST_USE_SCENE)
    } else {
      startTracking()
    }
    if (state.worldKey.isNotBlank()) connect()
  }

  override fun onSceneReady() {
    super.onSceneReady()
    scene.setReferenceSpace(ReferenceSpace.LOCAL_FLOOR)
    scene.enablePassthrough(true)
    scene.setLightingEnvironment(
        ambientColor = Vector3(0.6f),
        sunColor = Vector3(1.5f),
        sunDirection = -Vector3(1.0f, 3.0f, -2.0f),
        environmentIntensity = 0.4f,
    )
    scene.updateIBLEnvironment("environment.env")
    renderer.place(centre, yaw)
    panel = Entity.createPanelEntity(R.id.control_panel, Transform(Pose(Vector3(-0.5f, 1.3f, 0.8f))), Grabbable())
  }

  override fun registerPanels(): List<PanelRegistration> =
      listOf(
          ComposeViewPanelRegistration(
              R.id.control_panel,
              composeViewCreator = { _, ctx -> ComposeView(ctx).apply { setContent { ControlPanel(state, this@MainActivity) } } },
              settingsCreator = {
                UIPanelSettings(
                    shape = QuadShapeOptions(width = 0.7f, height = 0.9f),
                    style = PanelStyleOptions(themeResourceId = R.style.PanelAppThemeTransparent),
                    display = DpPerMeterDisplayOptions(),
                )
              },
          )
      )

  override fun onSceneTick() {
    super.onSceneTick()
    val head = scene.getViewerPose()
    if (!placedOnce && head != Pose()) {
      // The first real head pose: put the scene 2 m ahead and the panel in view.
      placedOnce = true
      placeAhead()
      panel?.setComponent(Transform(panelPose(head)))
    }
    trackMarkers(head)
  }

  // ── panel actions ────────────────────────────────────────────────────

  override fun connect() {
    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
        .putString("feedUrl", state.feedUrl.trim())
        .putString("worldKey", state.worldKey.trim())
        .apply()
    feed.start(state.feedUrl, state.worldKey)
  }

  override fun placeAhead() {
    val head = scene.getViewerPose()
    val fwd = flat(head.q.times(Vector3(0f, 0f, 1f))) ?: Vector3(0f, 0f, 1f)
    centre = Vector3(head.t.x + fwd.x * 2, 0f, head.t.z + fwd.z * 2)
    yaw = atan2(fwd.x.toDouble(), fwd.z.toDouble())
    renderer.place(centre, yaw)
    state.placement = "Scene centre 2 m ahead, north pointing away from you"
  }

  override fun turn(degrees: Double) {
    yaw += Math.toRadians(degrees)
    renderer.place(centre, yaw)
    state.placement = "Turned ${"%+.0f".format(degrees)}° (north at ${"%.0f".format(Math.toDegrees(yaw))}°)"
  }

  /**
   * Puts the scene centre on the floor under the last tracked test marker, with north pointing through the marker
   * away from you. A spike stand-in for the real alignment (which stores a position and a heading per marker).
   */
  override fun alignToMarker() {
    val m = lastMarkerPose ?: run {
      state.placement = "No marker tracked yet: look at a printed marker first"
      return
    }
    val head = scene.getViewerPose()
    val toMarker = flat(m.t - head.t) ?: Vector3(0f, 0f, 1f)
    // The QR code's normal, flattened; a code lying flat has none, so fall back to its up axis.
    var dir = flat(m.q.times(Vector3(0f, 0f, 1f))) ?: flat(m.q.times(Vector3(0f, 1f, 0f))) ?: toMarker
    if (dir.dot(toMarker) < 0) dir = -dir
    centre = Vector3(m.t.x, 0f, m.t.z)
    yaw = atan2(dir.x.toDouble(), dir.z.toDouble())
    renderer.place(centre, yaw)
    state.placement = "Aligned to the marker (centre under it, north through it)"
  }

  override fun setModelTurn(on: Boolean) {
    state.modelTurn = on
    renderer.modelTurn = on
  }

  override fun resetReadings() {
    readings.values.forEach { r ->
      r.foundAt.clear()
      r.lostAt.clear()
    }
    TestMarker.ALL.forEach { readings[it.code]?.let { r -> if (r.tracked) r.observe(false, 0.0) } }
    state.lastQr = "No QR code read yet"
    lastUiUpdate = 0
  }

  // ── markers ──────────────────────────────────────────────────────────

  private fun startTracking() {
    state.markerStatus = "Starting QR code tracking…"
    mruk.configureTrackers(setOf(Tracker.QrCode)).whenComplete { result, err ->
      runOnUiThread {
        state.markerStatus =
            if (result == MRUKStartTrackerResult.SUCCESS) "Tracking QR codes: look at a printed marker"
            else "QR tracking failed to start: ${result ?: err?.message} (needs Quest 3/3S, Horizon OS v78+)"
      }
    }
  }

  private fun trackMarkers(head: Pose) {
    val seen = mutableSetOf<String>()
    for (e in Query.where { has(TrackedQrCode.id) }.eval()) {
      val payload = e.getComponent<TrackedQrCode>().payload
      val tracked = e.tryGetComponent<TrackingStatus>()?.isTracked ?: true
      val pose = e.tryGetComponent<Transform>()?.transform ?: continue
      val distance = (pose.t - head.t).length().toDouble()
      if (tracked) state.lastQr = "Last QR: $payload at ${"%.2f".format(distance)} m"
      val code = TestMarker.codeFromQr(payload) ?: continue
      val reading = readings[code] ?: continue
      if (tracked) {
        seen.add(code)
        lastMarkerPose = pose
        e.tryGetComponent<MRUKPlane>()?.let { p ->
          reading.measuredSide = maxOf(p.max.x - p.min.x, p.max.y - p.min.y).toDouble()
        }
      }
      if (tracked || reading.tracked) reading.observe(tracked, distance)
    }
    for ((code, r) in readings) if (code !in seen && r.tracked) r.observe(false, 0.0)

    val now = System.currentTimeMillis()
    if (now - lastUiUpdate < 100) return
    lastUiUpdate = now
    state.markerLines =
        TestMarker.ALL.map { m ->
          val r = readings.getValue(m.code)
          val size = r.measuredSide?.let { side ->
            val off = (side / m.qrSide - 1) * 100
            " · QR ${"%.0f".format(side * 1000)} mm" + if (Math.abs(off) > 3) " (${"%+.0f".format(off)}%: check print scale)" else ""
          } ?: ""
          "${m.code} (${(m.width * 1000).toInt()} mm): ${r.summary}$size"
        }
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != REQUEST_USE_SCENE) return
    if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startTracking()
    else state.markerStatus = "Spatial data permission denied: QR tracking is off"
  }

  override fun onSpatialShutdown() {
    feed.stop()
    scope.cancel()
    mruk.stopTrackers()
    super.onSpatialShutdown()
  }

  private fun panelPose(head: Pose): Pose {
    val fwd = flat(head.q.times(Vector3(0f, 0f, 1f))) ?: Vector3(0f, 0f, 1f)
    val right = Vector3(fwd.z, 0f, -fwd.x)
    val t = head.t + fwd * 0.8f - right * 0.35f
    return Pose(Vector3(t.x, head.t.y - 0.15f, t.z), Quaternion.lookRotation(fwd))
  }

  private fun flat(v: Vector3): Vector3? {
    val len = sqrt(v.x * v.x + v.z * v.z)
    return if (len < 1e-3f) null else Vector3(v.x / len, 0f, v.z / len)
  }

  companion object {
    private const val TAG = "VLMSpaces"
    private const val PREFS = "vlm-spaces"
    private const val PERMISSION_USE_SCENE = "com.oculus.permission.USE_SCENE"
    private const val REQUEST_USE_SCENE = 1
  }
}
