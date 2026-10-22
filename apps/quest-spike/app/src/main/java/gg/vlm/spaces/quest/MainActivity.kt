package gg.vlm.spaces.quest

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.compose.ui.platform.ComposeView
import com.meta.spatial.compose.ComposeFeature
import com.meta.spatial.compose.ComposeViewPanelRegistration
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.Vector3
import com.meta.spatial.mruk.MRUKAnchor
import com.meta.spatial.mruk.MRUKFeature
import com.meta.spatial.mruk.MRUKLabel
import com.meta.spatial.mruk.MRUKLoadDeviceResult
import com.meta.spatial.mruk.MRUKPlane
import com.meta.spatial.mruk.hasLabel
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
import com.meta.spatial.toolkit.TransformParent
import com.meta.spatial.toolkit.UIPanelSettings
import com.meta.spatial.toolkit.createPanelEntity
import com.meta.spatial.vr.VRFeature
import gg.vlm.spaces.quest.ring.CameraStatus
import gg.vlm.spaces.quest.ring.PassthroughCamera
import gg.vlm.spaces.quest.ring.RING_TEST_MARKERS
import gg.vlm.spaces.quest.ring.RingDetection
import gg.vlm.spaces.quest.ring.RingDetector
import gg.vlm.spaces.quest.ring.RingTracker
import gg.vlm.spaces.quest.ring.WALL_TOLERANCE_M
import gg.vlm.spaces.quest.ring.WallPlane
import gg.vlm.spaces.quest.ring.cameraToWorld
import gg.vlm.spaces.quest.ring.markerInCamera
import gg.vlm.spaces.quest.ring.wallHeading
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
 * camera's frames by [RingDetector]. A marker's position comes from its size and place in the image; its heading comes
 * from the scanned wall it's on (MRUK), not from the ellipse's squash.
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
  /** Each test marker's last world position (main thread), and which marker was tracked most recently. */
  private val markerPositions = HashMap<Long, Vector3>()
  private var lastMarkerId: Long? = null

  /** The room scan's walls, re-read from MRUK on each panel update once the room has loaded (main thread). */
  private var walls: List<WallPlane> = emptyList()
  private var roomRequested = false
  private var roomLoaded = false

  private lateinit var camera: PassthroughCamera
  /** Only used on the camera's frame thread (PassthroughCamera runs one frame at a time). */
  private val detector = RingDetector()
  private val tracker = RingTracker(RING_TEST_MARKERS.map { it.id }.toSet())
  /** The newest frame's result, written on the frame thread and read by [trackRings] on the main thread. */
  @Volatile private var latestRings: RingFrame? = null

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
              latestRings = RingFrame(tracker.update(raw), raw.lastOrNull(), t, SystemClock.elapsedRealtimeNanos())
            },
            onStatus = { st -> runOnUiThread { onCameraStatus(st) } },
            onRunStart = { tracker.reset() },
        )
    val missing = PERMISSIONS.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
    if (missing.isNotEmpty()) {
      state.markerStatus = "Waiting for the camera and spatial data permissions"
      requestPermissions(missing.toTypedArray(), REQUEST_PERMISSIONS)
    } else {
      state.markerStatus = HOLD_MARKER // onResume starts the camera
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
    if (checkSelfPermission(PERMISSION_USE_SCENE) == PackageManager.PERMISSION_GRANTED) loadRoom()
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
    // Also catches permissions granted later in Settings.
    if (cameraPermitted()) camera.start()
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
   * Puts the scene centre on the floor under the last tracked test marker, with VLM north perpendicular to the scanned
   * wall the marker is on, pointing into the wall (away from you, as before). Without a wall near the marker, north
   * points from you through the marker, and the panel says so. A spike stand-in for the real alignment, which stores a
   * position and a heading per marker.
   */
  override fun alignToMarker() {
    val id = lastMarkerId
    val m = id?.let { markerPositions[it] } ?: run {
      state.placement = "No marker tracked yet: look at a printed marker first"
      return
    }
    val head = scene.getViewerPose()
    if (roomLoaded) walls = readWalls()
    val heading = wallHeading(m, walls, head.t)
    centre = Vector3(m.x, 0f, m.z)
    if (heading != null) {
      // wallHeading points into the room; north points into the wall.
      yaw = Math.toRadians(heading + 180.0)
      state.placement = "Aligned to ${nameOf(id)}: centre under it, north into its wall (wall faces ${"%.1f".format(heading)}°)"
    } else {
      val toMarker = flat(m - head.t) ?: Vector3(0f, 0f, 1f)
      yaw = atan2(toMarker.x.toDouble(), toMarker.z.toDouble())
      state.placement =
          "Aligned to ${nameOf(id)} without a wall (${noWallReason()}): centre under it, north from you through it"
    }
    renderer.place(centre, yaw)
    Log.i(TAG, "Aligned to ${nameOf(id)} at $m, yaw ${"%.2f".format(Math.toDegrees(yaw))}°, wall heading $heading")
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
    markerPositions.clear()
    lastMarkerId = null
    state.lastRing = "No ring marker read yet"
    lastUiUpdate = 0
  }

  // ── markers ──────────────────────────────────────────────────────────

  private fun cameraPermitted(): Boolean =
      CAMERA_PERMISSIONS.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

  private fun onCameraStatus(st: CameraStatus) {
    state.cameraStatus = st
    if (st != CameraStatus.STARTING && st != CameraStatus.RUNNING) latestRings = null
  }

  /**
   * Feeds the newest camera frame's trusted rings into the test markers' readings, with each one's distance from the
   * camera, and turns each into a world position with the current head pose (see [cameraToWorld]). Without the
   * camera's calibration the distance is unknown and recorded as 0.
   */
  private fun trackRings(head: Pose) {
    // A frame older than STALE_NS (camera stalled or stopped) tracks nothing.
    val frame = latestRings?.takeIf { SystemClock.elapsedRealtimeNanos() - it.receivedNs < STALE_NS } ?: NO_RINGS
    val k = camera.intrinsics
    val seen = frame.tracked.associateBy { it.id }
    for ((id, r) in readings) {
      val d = seen[id]
      if (d == null) {
        if (r.tracked) r.observe(false, 0.0)
        continue
      }
      if (!r.tracked) Log.i(TAG, "Ring ${nameOf(id)} tracked")
      val diameter = RING_TEST_MARKERS.first { it.id == id }.diameter
      if (k == null) {
        r.observe(true, 0.0)
        continue
      }
      val p = markerInCamera(d, k, diameter)
      r.observe(true, sqrt(p.x * p.x + p.y * p.y + p.z * p.z))
      markerPositions[id] = cameraToWorld(p, head, k)
      lastMarkerId = id
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
    if (roomLoaded) walls = readWalls()
    state.markerLines =
        RING_TEST_MARKERS.map { m -> "${m.name} (${(m.diameter * 1000).toInt()} mm): ${readings.getValue(m.id).summary}" }
    state.poseLines = RING_TEST_MARKERS.map { m -> poseLine(m.id, head, k != null) }
  }

  /** The panel's position and wall line for one test marker. */
  private fun poseLine(id: Long, head: Pose, calibrated: Boolean): String {
    if (!calibrated) return "  no camera calibration: position unknown"
    val p = markerPositions[id] ?: return "  position not known yet"
    val wall = wallHeading(p, walls, head.t)?.let { "wall faces ${"%.1f".format(it)}°" } ?: "no wall"
    return "  at (${"%.2f".format(p.x)}, ${"%.2f".format(p.y)}, ${"%.2f".format(p.z)}) m · $wall"
  }

  // ── room scan ────────────────────────────────────────────────────────

  /**
   * Loads the room scan from the headset, once. It doesn't ask for a new scan when there is none (that would start
   * Space Setup unprompted); the panel says how to make one instead.
   */
  private fun loadRoom() {
    if (roomRequested) return
    roomRequested = true
    state.wallStatus = "Loading the room scan…"
    mruk.loadSceneFromDevice(false).whenComplete { result, error ->
      runOnUiThread {
        if (error != null) Log.w(TAG, "Room scan failed to load", error)
        val ok = error == null && result == MRUKLoadDeviceResult.SUCCESS
        walls = if (ok) readWalls() else emptyList()
        roomLoaded = ok
        state.wallStatus =
            when {
              ok && walls.isNotEmpty() -> "Room scan loaded: ${walls.size} walls"
              ok || result == MRUKLoadDeviceResult.ERROR_NO_ROOMS_FOUND -> NO_ROOM_SCAN
              else -> "Room scan failed to load (${result ?: error?.javaClass?.simpleName}): no wall heading"
            }
        Log.i(TAG, "Room scan: $result, ${walls.size} walls")
      }
    }
  }

  private fun noWallReason(): String =
      when {
        !roomLoaded -> "no room scan"
        walls.isEmpty() -> "the room scan has no walls"
        else -> "the marker isn't within ${"%.0f".format(WALL_TOLERANCE_M * 100)} cm of a wall"
      }

  /** Every wall face in the loaded rooms, in world space. MRUK walls are planes in their anchor's local x-y. */
  private fun readWalls(): List<WallPlane> =
      mruk.rooms.flatMap { it.walls }.mapNotNull { e ->
        val anchor = e.tryGetComponent<MRUKAnchor>()
        if (anchor != null && !anchor.hasLabel(MRUKLabel.WALL_FACE)) return@mapNotNull null
        val plane = e.tryGetComponent<MRUKPlane>() ?: return@mapNotNull null
        val pose = worldPose(e) ?: return@mapNotNull null
        val mid = Vector3((plane.min.x + plane.max.x) / 2, (plane.min.y + plane.max.y) / 2, 0f)
        WallPlane(
            pose.times(mid),
            pose.q.times(Vector3(0f, 0f, 1f)),
            (plane.max.x - plane.min.x) / 2,
            (plane.max.y - plane.min.y) / 2,
        )
      }

  /** [e]'s pose in world space: its Transform, under its TransformParent chain (MRUK parents child anchors). */
  private fun worldPose(e: Entity): Pose? {
    var pose = e.tryGetComponent<Transform>()?.transform ?: return null
    var parent = e.tryGetComponent<TransformParent>()?.entity
    var depth = 0
    while (parent != null && parent != Entity.nullEntity() && depth++ < 8) {
      val up = parent.tryGetComponent<Transform>()?.transform ?: break
      pose = up.times(pose)
      parent = parent.tryGetComponent<TransformParent>()?.entity
    }
    return pose
  }

  private fun nameOf(id: Long): String =
      RING_TEST_MARKERS.firstOrNull { it.id == id }?.name ?: "id %08X (not a test marker)".format(id)

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != REQUEST_PERMISSIONS) return
    val sceneGranted = checkSelfPermission(PERMISSION_USE_SCENE) == PackageManager.PERMISSION_GRANTED
    state.markerStatus = if (sceneGranted) HOLD_MARKER else "Spatial data permission denied: room walls are unavailable"
    if (sceneGranted) loadRoom() else state.wallStatus = "Spatial data permission denied: no wall heading"
    if (cameraPermitted()) camera.start() else state.cameraStatus = CameraStatus.NO_PERMISSION
  }

  override fun onSpatialShutdown() {
    camera.close()
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
    private const val STALE_NS = 250_000_000L
    private val NO_RINGS = RingFrame(emptyList(), null, 0, 0)
    private const val NO_ROOM_SCAN = "No room scan: set up your space in Quest settings to get wall heading"
    private const val HOLD_MARKER = "Hold a printed ring marker in view, then walk away and back"
  }
}

/**
 * One camera frame's result: the trusted test-marker rings, the last raw detection (any ID) for the panel, the
 * frame's camera timestamp, and when it was processed (SystemClock.elapsedRealtimeNanos).
 */
private class RingFrame(
    val tracked: List<RingDetection>,
    val last: RingDetection?,
    val timestampNs: Long,
    val receivedNs: Long,
)
