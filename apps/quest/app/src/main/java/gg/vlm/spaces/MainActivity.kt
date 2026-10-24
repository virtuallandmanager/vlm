package gg.vlm.spaces

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.compose.ui.platform.ComposeView
import com.meta.spatial.compose.ComposeFeature
import com.meta.spatial.compose.ComposeViewPanelRegistration
import com.meta.spatial.core.Color4
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.Vector3
import com.meta.spatial.mruk.AnchorProceduralMesh
import com.meta.spatial.mruk.AnchorProceduralMeshConfig
import com.meta.spatial.mruk.MRUKAnchor
import com.meta.spatial.mruk.MRUKFeature
import com.meta.spatial.mruk.MRUKLabel
import com.meta.spatial.mruk.MRUKLoadDeviceResult
import com.meta.spatial.mruk.MRUKPlane
import com.meta.spatial.mruk.MRUKSpawnMode
import com.meta.spatial.mruk.hasLabel
import com.meta.spatial.okhttp3.OkHttpAssetFetcher
import com.meta.spatial.runtime.AlphaMode
import com.meta.spatial.runtime.EnvironmentDepthMode
import com.meta.spatial.runtime.NetworkedAssetLoader
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.runtime.SceneMaterial
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.DpPerMeterDisplayOptions
import com.meta.spatial.toolkit.Grabbable
import com.meta.spatial.toolkit.Material
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.PanelStyleOptions
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.TransformParent
import com.meta.spatial.toolkit.UIPanelSettings
import com.meta.spatial.toolkit.createPanelEntity
import com.meta.spatial.vr.VRFeature
import gg.vlm.spaces.ring.CameraStatus
import gg.vlm.spaces.ring.PassthroughCamera
import gg.vlm.spaces.ring.PoseAverager
import gg.vlm.spaces.ring.RING_TEST_MARKERS
import gg.vlm.spaces.ring.RingDetection
import gg.vlm.spaces.ring.RingDetector
import gg.vlm.spaces.ring.RingTracker
import gg.vlm.spaces.ring.WALL_TOLERANCE_M
import gg.vlm.spaces.ring.WallPlane
import gg.vlm.spaces.ring.cameraToWorld
import gg.vlm.spaces.ring.markerInCamera
import gg.vlm.spaces.ring.nearestToCentre
import gg.vlm.spaces.ring.wallHeading
import java.io.File
import kotlin.math.atan2
import kotlin.math.sqrt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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
  /**
   * Each test marker's recent world positions, one per camera frame while it's tracked, cleared when it's lost (main
   * thread); and the marker Align uses: of those tracked in the latest calibrated frame, the one nearest the image
   * centre (kept when none is tracked, so Align can still say it was lost).
   */
  private val markerPositions = RING_TEST_MARKERS.associate { it.id to PoseAverager(AVERAGE_FRAMES, MIN_FRAMES) }
  private var lastMarkerId: Long? = null
  /** The camera frame ([RingFrame.receivedNs]) whose rings were last added to [markerPositions]. */
  private var lastAveragedNs = 0L

  /** The room scan's walls, re-read from MRUK on each panel update once the room has loaded (main thread). */
  private var walls: List<WallPlane> = emptyList()
  private var roomRequested = false
  private var roomLoaded = false
  private var roomAttempts = 0
  /** The room scan's walls and ceiling drawn as passthrough, while [Occlusion.WALLS] is on (main thread). */
  private var occluders: List<Entity> = emptyList()
  /** The same surfaces tinted, while [AppState.showWalls] is on (main thread). */
  private var wallTint: List<Entity> = emptyList()
  private var sceneReady = false

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
    state.occlusion = prefs.getString("occlusion", null)?.let { n -> Occlusion.entries.firstOrNull { it.name == n } } ?: Occlusion.DEPTH

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
    sceneReady = true
    applyOcclusion()
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
    // And a room scan made (or finished loading) while the app was in the background.
    if (sceneReady && !roomLoaded && !roomRequested && checkSelfPermission(PERMISSION_USE_SCENE) == PackageManager.PERMISSION_GRANTED) {
      roomAttempts = 0
      loadRoom()
    }
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

  override fun setOcclusion(o: Occlusion) {
    state.occlusion = o
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("occlusion", o.name).apply()
    applyOcclusion()
  }

  override fun setShowWalls(on: Boolean) {
    state.showWalls = on
    applyOcclusion()
  }

  override fun turn(degrees: Double) {
    yaw += Math.toRadians(degrees)
    renderer.place(centre, yaw)
    state.placement = "Turned ${"%+.0f".format(degrees)}° (north at ${"%.0f".format(Math.toDegrees(yaw))}°)"
  }

  /**
   * Puts the scene centre on the floor under the tracked test marker nearest the middle of the camera view, with VLM
   * north perpendicular to the scanned wall the marker is on, pointing into the wall (away from you, as before).
   * Without a wall near the marker, north points from you through the marker, and the panel says so. A spike stand-in for the real alignment, which stores a
   * position and a heading per marker.
   */
  override fun alignToMarker() {
    if (camera.intrinsics == null) {
      state.placement = "No camera calibration: marker positions are unknown, so Align can't place the scene"
      return
    }
    val id = lastMarkerId
    val avg = id?.let { markerPositions.getValue(it) }
    if (id == null || avg == null || avg.count == 0) {
      state.placement = "No marker in view: look at a printed marker first"
      return
    }
    if (!avg.ready) {
      state.placement = "Hold still, gathering frames (${avg.count} of $MIN_FRAMES)"
      return
    }
    val mean = avg.mean()!!
    val m = Vector3(mean.x.toFloat(), mean.y.toFloat(), mean.z.toFloat())
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
    Log.i(TAG, "Aligned to ${nameOf(id)} at $m (mean of ${avg.count}, spread ${"%.1f".format(avg.spread()!! * 100)} cm), yaw ${"%.2f".format(Math.toDegrees(yaw))}°, wall heading $heading")
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
    markerPositions.values.forEach { it.clear() }
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
    // Ticks outnumber camera frames: each frame adds one sample per marker, not one per tick.
    val newFrame = frame.receivedNs != lastAveragedNs
    lastAveragedNs = frame.receivedNs
    for ((id, r) in readings) {
      val d = seen[id]
      if (d == null) {
        if (r.tracked) r.observe(false, 0.0)
        markerPositions.getValue(id).clear()
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
      if (newFrame) {
        val w = cameraToWorld(p, head, k)
        markerPositions.getValue(id).add(Vec3(w.x.toDouble(), w.y.toDouble(), w.z.toDouble()))
      }
    }
    if (k != null) {
      nearestToCentre(frame.tracked.filter { it.id in readings }, PassthroughCamera.WIDTH, PassthroughCamera.HEIGHT)
          ?.let { lastMarkerId = it.id }
    }
    frame.last?.let { d ->
      state.lastRing =
          "Last raw ring (one frame, not yet trusted): ${nameOf(d.id)} at (${"%.0f".format(d.cx)}, ${"%.0f".format(d.cy)}) px, " +
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
    val avg = markerPositions.getValue(id)
    val p = avg.mean() ?: return "  not in view"
    val wall = wallHeading(Vector3(p.x.toFloat(), p.y.toFloat(), p.z.toFloat()), walls, head.t)
        ?.let { "wall faces ${"%.1f".format(it)}°" } ?: "no wall"
    val spread = "±${"%.1f".format(avg.spread()!! * 100)} cm over ${avg.count}"
    return "  at (${"%.2f".format(p.x)}, ${"%.2f".format(p.y)}, ${"%.2f".format(p.z)}) m $spread · $wall"
  }

  // ── room scan ────────────────────────────────────────────────────────

  /**
   * Loads the room scan from the headset, retrying a failed load a few times. It doesn't ask for a new scan when there is none (that would start
   * Space Setup unprompted); the panel says how to make one instead.
   */
  private fun loadRoom() {
    if (roomRequested) return
    roomRequested = true
    roomAttempts++
    state.wallStatus = "Loading the room scan…"
    mruk.loadSceneFromDevice(false).whenComplete { result, error ->
      runOnUiThread {
        if (error != null) Log.w(TAG, "Room scan failed to load", error)
        val ok = error == null && result == MRUKLoadDeviceResult.SUCCESS
        walls = if (ok) readWalls() else emptyList()
        roomLoaded = ok
        // Right after the headset wakes the load can also report no rooms, so that is retried too.
        val retry = !ok && roomAttempts < ROOM_ATTEMPTS
        if (retry) {
          Log.i(TAG, "Room scan: $result, retrying (attempt $roomAttempts of $ROOM_ATTEMPTS)")
          state.wallStatus = "Room scan not ready yet, trying again…"
          roomRequested = false
          scope.launch {
            delay(ROOM_RETRY_MS)
            loadRoom()
          }
          return@runOnUiThread
        }
        state.wallStatus =
            when {
              ok && walls.isNotEmpty() -> "Room scan loaded: ${walls.size} walls"
              ok || result == MRUKLoadDeviceResult.ERROR_NO_ROOMS_FOUND -> NO_ROOM_SCAN
              else -> "Room scan failed to load (${result ?: error?.javaClass?.simpleName}): no wall heading"
            }
        Log.i(TAG, "Room scan: $result, ${walls.size} walls")
        applyOcclusion()
      }
    }
  }

  /**
   * Turns on what [AppState.occlusion] asks for and off the rest. Walls are the room scan's wall faces and ceiling,
   * drawn with the hole-punch material, which clears to passthrough and writes depth, so anything virtual behind them isn't drawn. Live
   * depth is the SDK's environment depth occlusion.
   */
  private fun applyOcclusion() {
    if (!sceneReady) return
    val o = state.occlusion
    scene.setEnvironmentDepthMode(if (o == Occlusion.DEPTH) EnvironmentDepthMode.OCCLUSION else EnvironmentDepthMode.OFF)
    occluders = updateSurfaces(occluders, o == Occlusion.WALLS) {
      Material(baseColor = Color4(0f, 0f, 0f, 0f), alphaMode = AlphaMode.HOLE_PUNCH.mode, shader = SceneMaterial.HOLE_PUNCH_SHADER)
    }
    wallTint = updateSurfaces(wallTint, state.showWalls) {
      Material(baseColor = Color4(0.3f, 0.8f, 1f, 0.35f), unlit = true, alphaMode = AlphaMode.TRANSLUCENT.mode)
    }
    state.occlusionStatus =
        when (o) {
          Occlusion.OFF -> "Virtual things show through real walls"
          Occlusion.WALLS ->
              if (occluders.isNotEmpty()) "Hidden behind the room scan's ${walls.size} walls and ceiling"
              else "Walls need the room scan (${state.wallStatus})"
          Occlusion.DEPTH -> "Hidden behind anything real the headset's depth sees"
        }
    Log.i(TAG, "Occlusion: $o (${state.occlusionStatus})")
  }

  /**
   * The room scan's wall faces and ceiling drawn with [material]: [current] when [on] and already spawned, newly spawned
   * when [on] and the room has loaded, and none (destroying [current]) when off. The entities are destroyed here, since
   * [AnchorProceduralMesh.destroy] only removes meshes it spawned for its own scene listener.
   */
  private fun updateSurfaces(current: List<Entity>, on: Boolean, material: () -> Material): List<Entity> {
    if (!on) {
      current.forEach { it.destroy() }
      return emptyList()
    }
    if (current.isNotEmpty() || !roomLoaded) return current
    val config = AnchorProceduralMeshConfig(material(), false)
    val labels = mapOf(MRUKLabel.WALL_FACE to config, MRUKLabel.CEILING to config)
    val mesh = AnchorProceduralMesh(mruk, labels, MRUKSpawnMode.NONE)
    val spawned = mesh.spawnMeshes(mruk.rooms).flatMap { listOfNotNull(it.mesh, it.physics) }
    mesh.destroy()
    return spawned.filter { it != Entity.nullEntity() }
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
    occluders.forEach { it.destroy() }
    wallTint.forEach { it.destroy() }
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
    private const val ROOM_ATTEMPTS = 5
    private const val ROOM_RETRY_MS = 3000L
    /** Frames averaged per marker position, and how many Align to the marker needs. */
    private const val AVERAGE_FRAMES = 15
    private const val MIN_FRAMES = 5
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
