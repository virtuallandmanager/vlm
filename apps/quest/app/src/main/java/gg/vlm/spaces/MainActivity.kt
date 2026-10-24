package gg.vlm.spaces

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.ComposeView
import com.meta.spatial.compose.ComposeFeature
import com.meta.spatial.compose.ComposeViewPanelRegistration
import com.meta.spatial.core.Color4
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Query
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
import com.meta.spatial.runtime.ButtonBits
import com.meta.spatial.runtime.EnvironmentDepthMode
import com.meta.spatial.runtime.NetworkedAssetLoader
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.runtime.SceneMaterial
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.Controller
import com.meta.spatial.toolkit.DpPerMeterDisplayOptions
import com.meta.spatial.toolkit.Grabbable
import com.meta.spatial.toolkit.Material
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.PanelStyleOptions
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.TransformParent
import com.meta.spatial.toolkit.UIPanelSettings
import com.meta.spatial.toolkit.Visible
import com.meta.spatial.toolkit.createPanelEntity
import com.meta.spatial.vr.VRFeature
import gg.vlm.spaces.ring.CameraStatus
import gg.vlm.spaces.ring.PassthroughCamera
import gg.vlm.spaces.ring.PoseAverager
import gg.vlm.spaces.ring.RING_TEST_MARKERS
import gg.vlm.spaces.ring.RingDetector
import gg.vlm.spaces.ring.RingTracker
import gg.vlm.spaces.ring.WallPlane
import gg.vlm.spaces.ring.cameraToWorld
import gg.vlm.spaces.ring.markerInCamera
import gg.vlm.spaces.ring.wallHeading
import gg.vlm.spaces.visitor.CameraRings
import gg.vlm.spaces.visitor.HintCard
import gg.vlm.spaces.visitor.LazyFollow
import gg.vlm.spaces.visitor.MenuActions
import gg.vlm.spaces.visitor.MenuButton
import gg.vlm.spaces.visitor.VisitorController
import gg.vlm.spaces.visitor.VisitorCopy
import gg.vlm.spaces.visitor.VisitorMenu
import gg.vlm.spaces.visitor.VisitorTuning
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
 * VLM Spaces for Meta Quest 3 / 3S, in visitor mode: a hint card asks the visitor to look at a ring marker, and the
 * space it belongs to appears life-size in passthrough, placed from the ring ([VisitorController]). This activity owns
 * the lifecycle, the passthrough camera (rings found by [RingDetector] in the left camera's frames), the room scan
 * (MRUK: wall headings and occlusion) and the panels. Debug builds add a Developer panel with the marker readings.
 */
class MainActivity : AppSystemActivity(), MenuActions, DeveloperActions {
  private lateinit var mruk: MRUKFeature
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private val state = AppState()
  private lateinit var prefs: AppPrefs
  private lateinit var renderer: SceneRenderer
  private lateinit var visitor: VisitorController

  private var hintPanel: Entity? = null
  private var menuButton: Entity? = null
  private var menuPanel: Entity? = null
  private var developerPanel: Entity? = null
  private val hintFollow = LazyFollow()
  /** The last [Visible] set on each panel, so it's only set when it changes. */
  private val panelShown = HashMap<Entity, Boolean>()

  /** Debug builds: the test markers' readings and recent world positions, for the Developer panel (main thread). */
  private val readings = RING_TEST_MARKERS.associate { it.id to MarkerReading() }
  private val markerPositions =
      RING_TEST_MARKERS.associate { it.id to PoseAverager(VisitorTuning.AVERAGE_FRAMES, VisitorTuning.MIN_FRAMES) }
  private var lastReadingsNs = 0L
  private var lastUiUpdate = 0L

  /** The room scan's walls, re-read from MRUK every [WALLS_EVERY_MS] once the room has loaded (main thread). */
  private var walls: List<WallPlane> = emptyList()
  private var wallsReadAt = 0L
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
  /** Accepts any ring while searching; the visitor flow narrows it to the space's rings once one is loaded. */
  private val tracker = RingTracker(null)
  /** The newest frame's rings, written on the frame thread and read on the main thread. */
  @Volatile private var latestRings: CameraRings? = null

  override fun registerFeatures(): List<SpatialFeature> {
    mruk = MRUKFeature(this, systemManager)
    return listOf(VRFeature(this), ComposeFeature(), mruk)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    NetworkedAssetLoader.init(File(cacheDir.canonicalPath), OkHttpAssetFetcher())
    prefs = AppPrefs(this)
    renderer = SceneRenderer(this)
    state.occlusion = prefs.occlusion
    // Release builds always use https://vlm.gg; debug builds take a `baseUrl` extra (saved for next time).
    state.serverUrl = prefs.baseUrl(intent.getStringExtra("baseUrl"))
    visitor = VisitorController(scope, state.serverUrl, renderer, prefs, state) { ids -> tracker.registered = ids }

    camera =
        PassthroughCamera(
            this,
            onFrame = { gray, w, h, stride, _ ->
              val f = detector.detectFrame(gray, w, h, stride)
              latestRings =
                  CameraRings(
                      tracker.update(f.detections),
                      f.detections.lastOrNull(),
                      f.unreadable.isNotEmpty(),
                      SystemClock.elapsedRealtimeNanos(),
                  )
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
    hintPanel = Entity.createPanelEntity(R.id.hint_card, Transform(Pose()))
    menuButton = Entity.createPanelEntity(R.id.menu_button, Transform(Pose()))
    menuPanel = Entity.createPanelEntity(R.id.visitor_menu, Transform(Pose())).also { show(it, false) }
    if (BuildConfig.DEBUG) {
      developerPanel = Entity.createPanelEntity(R.id.control_panel, Transform(Pose()), Grabbable()).also { show(it, false) }
    }
    sceneReady = true
    applyOcclusion()
    if (checkSelfPermission(PERMISSION_USE_SCENE) == PackageManager.PERMISSION_GRANTED) loadRoom()
  }

  override fun registerPanels(): List<PanelRegistration> =
      listOfNotNull(
          composePanel(R.id.hint_card, 0.5f, 0.3f) { HintCard(state.hint ?: "") },
          composePanel(R.id.menu_button, 0.08f, 0.08f) { MenuButton(this) },
          composePanel(R.id.visitor_menu, 0.5f, 0.6f) { VisitorMenu(state, this, BuildConfig.DEBUG) },
          if (BuildConfig.DEBUG) composePanel(R.id.control_panel, 0.7f, 0.9f) { ControlPanel(state, this) } else null,
      )

  private fun composePanel(id: Int, width: Float, height: Float, content: @Composable () -> Unit) =
      ComposeViewPanelRegistration(
          id,
          composeViewCreator = { _, ctx -> ComposeView(ctx).apply { setContent(content) } },
          settingsCreator = {
            UIPanelSettings(
                shape = QuadShapeOptions(width = width, height = height),
                style = PanelStyleOptions(themeResourceId = R.style.PanelAppThemeTransparent),
                display = DpPerMeterDisplayOptions(),
            )
          },
      )

  override fun onSceneTick() {
    super.onSceneTick()
    val head = scene.getViewerPose()
    val now = SystemClock.elapsedRealtime()
    if (roomLoaded && now - wallsReadAt >= WALLS_EVERY_MS) {
      walls = readWalls()
      wallsReadAt = now
    }
    val rings = latestRings
    visitor.tick(head, rings, camera.intrinsics, walls)
    if (head != Pose()) placePanels(head, now)
    if (menuPressed()) toggleMenu()
    if (BuildConfig.DEBUG) updateReadings(head, rings)
  }

  override fun onResume() {
    super.onResume()
    visitor.headsetOn()
    hintFollow.recentre()
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
    visitor.headsetOff()
    state.menuOpen = false
    super.onPause()
  }

  // ── panels and menu ──────────────────────────────────────────────────

  /** The hint card follows the head lazily; the "⋯" button sits 0.35 m below it; the menu stays where it opened. */
  private fun placePanels(head: Pose, now: Long) {
    val fwd = flat(head.q.times(Vector3(0f, 0f, 1f))) ?: Vector3(0f, 0f, 1f)
    val card = hintFollow.update(head.t.vec(), Math.toDegrees(atan2(fwd.x.toDouble(), fwd.z.toDouble())), now)
    val r = Math.toRadians(card.yawDeg)
    val facing = Quaternion.lookRotation(Vector3(Math.sin(r).toFloat(), 0f, Math.cos(r).toFloat()))
    val p = card.position.sdk()
    hintPanel?.let {
      it.setComponent(Transform(Pose(p, facing)))
      show(it, state.hint != null)
    }
    menuButton?.setComponent(Transform(Pose(Vector3(p.x, p.y - MENU_BUTTON_BELOW_M, p.z), facing)))
    menuPanel?.let { show(it, state.menuOpen) }
    developerPanel?.let { show(it, state.developerOpen) }
  }

  /** The left controller's menu button, pressed this frame. */
  private fun menuPressed(): Boolean {
    var pressed = false
    Query.where { has(Controller.id) }.eval().forEach { e ->
      val c = e.getComponent<Controller>()
      if (c.isActive && (c.changedButtons and c.buttonState and ButtonBits.ButtonMenu) != 0) pressed = true
    }
    return pressed
  }

  private fun show(e: Entity, on: Boolean) {
    if (panelShown[e] == on) return
    panelShown[e] = on
    e.setComponent(Visible(on))
  }

  override fun toggleMenu() {
    state.menuNote = null
    state.menuOpen = !state.menuOpen
    if (state.menuOpen) menuPanel?.setComponent(Transform(aheadPose(scene.getViewerPose(), 0.8f, -0.1f)))
  }

  override fun lookAgain() {
    visitor.lookAgain()
    state.menuOpen = false
    hintFollow.recentre()
  }

  override fun openBuilder() {
    state.menuNote = VisitorCopy.BUILDER_SOON
  }

  override fun toggleDeveloper() {
    if (!BuildConfig.DEBUG) return
    state.developerOpen = !state.developerOpen
    if (state.developerOpen) developerPanel?.setComponent(Transform(developerPose(scene.getViewerPose())))
  }

  override fun setOcclusion(o: Occlusion) {
    state.occlusion = o
    prefs.occlusion = o
    applyOcclusion()
  }

  override fun setShowWalls(on: Boolean) {
    state.showWalls = on
    applyOcclusion()
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
    state.lastRing = "No ring marker read yet"
    lastUiUpdate = 0
  }

  // ── developer readings ───────────────────────────────────────────────

  private fun cameraPermitted(): Boolean =
      CAMERA_PERMISSIONS.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

  private fun onCameraStatus(st: CameraStatus) {
    state.cameraStatus = st
    if (st != CameraStatus.STARTING && st != CameraStatus.RUNNING) latestRings = null
  }

  /**
   * Debug builds: feeds the newest camera frame's trusted test-marker rings into the Developer panel's readings, with
   * each one's distance from the camera and world position (see [cameraToWorld]). Without the camera's calibration the
   * distance is unknown and recorded as 0. Rings the tracker isn't accepting (another space's, once one is loaded)
   * aren't seen here either.
   */
  private fun updateReadings(head: Pose, rings: CameraRings?) {
    val frame = rings?.takeIf { SystemClock.elapsedRealtimeNanos() - it.receivedNs < STALE_NS }
    val k = camera.intrinsics
    val seen = frame?.tracked?.associateBy { it.id } ?: emptyMap()
    // Ticks outnumber camera frames: each frame adds one sample per marker, not one per tick.
    val newFrame = frame != null && frame.receivedNs != lastReadingsNs
    if (frame != null) lastReadingsNs = frame.receivedNs
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
      if (newFrame) markerPositions.getValue(id).add(cameraToWorld(p, head, k).vec())
    }
    frame?.last?.let { d ->
      state.lastRing =
          "Last raw ring (one frame, not yet trusted): ${nameOf(d.id)} at (${"%.0f".format(d.cx)}, ${"%.0f".format(d.cy)}) px, " +
              "${"%.0f".format(2 * d.semiMajor)} px across, turned ${"%.0f".format(d.rotationDeg)}°, " +
              "${d.corrected} fixed"
    }

    val now = System.currentTimeMillis()
    if (now - lastUiUpdate < 100) return
    lastUiUpdate = now
    state.markerLines =
        RING_TEST_MARKERS.map { m -> "${m.name} (${(m.diameter * 1000).toInt()} mm): ${readings.getValue(m.id).summary}" }
    state.poseLines = RING_TEST_MARKERS.map { m -> poseLine(m.id, head, k != null) }
  }

  /** The panel's position and wall line for one test marker. */
  private fun poseLine(id: Long, head: Pose, calibrated: Boolean): String {
    if (!calibrated) return "  no camera calibration: position unknown"
    val avg = markerPositions.getValue(id)
    val p = avg.mean() ?: return "  not in view"
    val wall = wallHeading(p.sdk(), walls, head.t)?.let { "wall faces ${"%.1f".format(it)}°" } ?: "no wall"
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
    visitor.stop()
    scope.cancel()
    super.onSpatialShutdown()
  }

  /** [distance] m ahead of [head] (level), [drop] m above its eyes, facing it. */
  private fun aheadPose(head: Pose, distance: Float, drop: Float): Pose {
    val fwd = flat(head.q.times(Vector3(0f, 0f, 1f))) ?: Vector3(0f, 0f, 1f)
    val t = head.t + fwd * distance
    return Pose(Vector3(t.x, head.t.y + drop, t.z), Quaternion.lookRotation(fwd))
  }

  private fun developerPose(head: Pose): Pose {
    val fwd = flat(head.q.times(Vector3(0f, 0f, 1f))) ?: Vector3(0f, 0f, 1f)
    val right = Vector3(fwd.z, 0f, -fwd.x)
    val t = head.t + fwd * 0.8f - right * 0.35f
    return Pose(Vector3(t.x, head.t.y - 0.15f, t.z), Quaternion.lookRotation(fwd))
  }

  private fun flat(v: Vector3): Vector3? {
    val len = sqrt(v.x * v.x + v.z * v.z)
    return if (len < 1e-3f) null else Vector3(v.x / len, 0f, v.z / len)
  }

  private fun Vector3.vec() = Vec3(x.toDouble(), y.toDouble(), z.toDouble())

  companion object {
    private const val TAG = "VLMSpaces"
    private const val PERMISSION_USE_SCENE = "com.oculus.permission.USE_SCENE"
    private val CAMERA_PERMISSIONS = listOf(Manifest.permission.CAMERA, PassthroughCamera.PERMISSION_HEADSET_CAMERA)
    private val PERMISSIONS = listOf(PERMISSION_USE_SCENE) + CAMERA_PERMISSIONS
    private const val REQUEST_PERMISSIONS = 1
    private const val STALE_NS = 250_000_000L
    private const val ROOM_ATTEMPTS = 5
    private const val ROOM_RETRY_MS = 3000L
    private const val WALLS_EVERY_MS = 100L
    /** The "⋯" button sits this far below the hint card's place. */
    private const val MENU_BUTTON_BELOW_M = 0.35f
    private const val NO_ROOM_SCAN = "No room scan: set up your space in Quest settings to get wall heading"
    private const val HOLD_MARKER = "Hold a printed ring marker in view, then walk away and back"
  }
}
