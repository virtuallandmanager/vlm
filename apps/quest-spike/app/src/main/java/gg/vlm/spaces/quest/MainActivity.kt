package gg.vlm.spaces.quest

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import androidx.compose.ui.platform.ComposeView
import com.meta.spatial.compose.ComposeFeature
import com.meta.spatial.compose.ComposeViewPanelRegistration
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.Vector3
import com.meta.spatial.mruk.MRUKFeature
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
import gg.vlm.spaces.quest.ring.CameraStatus
import gg.vlm.spaces.quest.ring.PassthroughCamera
import gg.vlm.spaces.quest.ring.RING_TEST_MARKERS
import gg.vlm.spaces.quest.ring.RingDetection
import gg.vlm.spaces.quest.ring.RingDetector
import gg.vlm.spaces.quest.ring.RingTracker
import java.io.File
import kotlin.math.atan2
import kotlin.math.sqrt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/**
 * VLM Spaces for Meta Quest 3 / 3S (spike). Shows a VLM scene life-size in passthrough, fed by the same long-poll feed
 * as the Hyperfy app, and runs the marker detection-range test with VLM's ring markers, found in the left passthrough
 * camera's frames by [RingDetector].
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

  private val readings = RING_TEST_MARKERS.associate { it.id to MarkerReading() }
  private var lastUiUpdate = 0L
  /** The last tracked test marker's pose. Null until Task 8 turns ring detections into poses. */
  private var lastMarkerPose: Pose? = null

  private lateinit var camera: PassthroughCamera
  /** Only used on the camera's frame thread (PassthroughCamera runs one frame at a time). */
  private val detector = RingDetector()
  private val tracker = RingTracker(RING_TEST_MARKERS.map { it.id }.toSet())
  /** The newest frame's result, written on the frame thread and read by [trackRings] on the main thread. */
  @Volatile private var latestRings: RingFrame? = null
  /** Whether the camera should run while the activity is in front (permissions granted). */
  private var cameraWanted = false

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

    camera =
        PassthroughCamera(
            this,
            onFrame = { gray, w, h, stride, t ->
              val raw = detector.detect(gray, w, h, stride)
              latestRings = RingFrame(tracker.update(raw), raw.lastOrNull(), t)
            },
            onStatus = { st -> runOnUiThread { onCameraStatus(st) } },
        )
    val missing = PERMISSIONS.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
    if (missing.isNotEmpty()) {
      state.markerStatus = "Waiting for the camera and spatial data permissions"
      requestPermissions(missing.toTypedArray(), REQUEST_PERMISSIONS)
    } else {
      state.markerStatus = HOLD_MARKER
      startCamera()
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
    trackRings(head)
  }

  override fun onResume() {
    super.onResume()
    if (cameraWanted) camera.start()
  }

  override fun onPause() {
    camera.stop()
    latestRings = null
    super.onPause()
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
    // The marker's normal, flattened; a marker lying flat has none, so fall back to its up axis.
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
    readings.values.forEach { r -> if (r.tracked) r.observe(false, 0.0) }
    state.lastRing = "No ring marker read yet"
    lastUiUpdate = 0
  }

  // ── markers ──────────────────────────────────────────────────────────

  private fun startCamera() {
    cameraWanted = true
    camera.start()
  }

  private fun onCameraStatus(st: CameraStatus) {
    state.cameraStatus = st
    if (st != CameraStatus.STARTING && st != CameraStatus.RUNNING) latestRings = null
  }

  /**
   * Feeds the newest camera frame's trusted rings into the test markers' readings. The distance stays 0.0 until
   * Task 8 turns a detection into a position.
   */
  private fun trackRings(head: Pose) {
    val frame = latestRings ?: RingFrame(emptyList(), null, 0)
    val seen = frame.tracked.mapTo(HashSet()) { it.id }
    for ((id, r) in readings) {
      val tracked = id in seen
      if (tracked && !r.tracked) Log.i(TAG, "Ring ${nameOf(id)} tracked")
      if (tracked || r.tracked) r.observe(tracked, 0.0)
    }
    frame.last?.let { d ->
      state.lastRing =
          "Last ring: ${nameOf(d.id)} at (${"%.0f".format(d.cx)}, ${"%.0f".format(d.cy)}) px, " +
              "${"%.0f".format(2 * d.semiMajor)} px across, turned ${"%.0f".format(d.rotationDeg)}°, " +
              "${d.corrected} fixed"
    }

    val now = System.currentTimeMillis()
    if (now - lastUiUpdate < 100) return
    lastUiUpdate = now
    state.markerLines =
        RING_TEST_MARKERS.map { m -> "${m.name} (${(m.diameter * 1000).toInt()} mm): ${readings.getValue(m.id).summary}" }
  }

  private fun nameOf(id: Long): String =
      RING_TEST_MARKERS.firstOrNull { it.id == id }?.name ?: "id %08X (not a test marker)".format(id)

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != REQUEST_PERMISSIONS) return
    val cameraGranted =
        CAMERA_PERMISSIONS.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
    val sceneGranted = checkSelfPermission(PERMISSION_USE_SCENE) == PackageManager.PERMISSION_GRANTED
    state.markerStatus = if (sceneGranted) HOLD_MARKER else "Spatial data permission denied: room walls are unavailable"
    if (cameraGranted) startCamera() else state.cameraStatus = CameraStatus.NO_PERMISSION
  }

  override fun onSpatialShutdown() {
    cameraWanted = false
    camera.stop()
    feed.stop()
    scope.cancel()
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
    private val CAMERA_PERMISSIONS = listOf(Manifest.permission.CAMERA, PassthroughCamera.PERMISSION_HEADSET_CAMERA)
    private val PERMISSIONS = listOf(PERMISSION_USE_SCENE) + CAMERA_PERMISSIONS
    private const val REQUEST_PERMISSIONS = 1
    private const val HOLD_MARKER = "Hold a printed ring marker in view, then walk away and back"
  }
}

/** One camera frame's result: the trusted test-marker rings, and the last raw detection (any ID) for the panel. */
private class RingFrame(val tracked: List<RingDetection>, val last: RingDetection?, val timestampNs: Long)
