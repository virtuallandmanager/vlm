package gg.vlm.spaces

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.meta.spatial.core.Color4
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Vector3
import com.meta.spatial.core.Vector4
import com.meta.spatial.runtime.AlphaMode
import com.meta.spatial.runtime.MaterialSidedness
import com.meta.spatial.runtime.SceneMaterial
import com.meta.spatial.runtime.PanelSceneObject
import com.meta.spatial.runtime.SceneMesh
import com.meta.spatial.runtime.SceneObject
import com.meta.spatial.runtime.SceneTexture
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.Box
import com.meta.spatial.toolkit.Material
import com.meta.spatial.toolkit.MediaPanelSettings
import com.meta.spatial.toolkit.Mesh
import com.meta.spatial.toolkit.MeshCollision
import com.meta.spatial.toolkit.Panel
import com.meta.spatial.toolkit.PanelCreationSystem
import com.meta.spatial.toolkit.PixelDisplayOptions
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Scale
import com.meta.spatial.toolkit.SceneObjectSystem
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.TransformParent
import com.meta.spatial.toolkit.VideoSurfacePanelRegistration
import com.meta.spatial.toolkit.Visible
import java.net.HttpURLConnection
import gg.vlm.spaces.space.RootPose
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

fun Quat.sdk() = Quaternion(w.toFloat(), x.toFloat(), y.toFloat(), z.toFloat())

fun Vec3.sdk() = Vector3(x.toFloat(), y.toFloat(), z.toFloat())

/**
 * Builds and updates Spatial SDK entities for a VLM scene plan. `root` is the VLM scene frame: its origin is the
 * parcel's south-west corner at ground level, and since Spatial SDK shares Decentraland's axes, items take their VLM
 * transforms unchanged. Like the other ports, each item gets a group entity carrying the position and rotation;
 * images and videos are sized planes inside it, models take the VLM scale (and, when `modelTurn` is on, a half turn
 * about Y) on a child entity.
 *
 * Images load through the `mesh://vlm-image` creator, which downloads the picture and returns a textured quad. Models
 * load straight from their https URL (NetworkedAssetLoader), so only .glb works. Sounds aren't played yet.
 *
 * The scene starts hidden. [setVisible] fades images and videos over [FADE_MS] by setting their materials' alpha
 * each [tick] (and a video layer's colour scale); models and sounds show and hide at the end of the fade.
 */
class SceneRenderer(private val activity: AppSystemActivity) {
  val root: Entity = Entity.create(listOf(Transform(Pose())))

  /**
   * Whether models get a half turn about Y. Decentraland shows a glTF x-mirrored; if Spatial SDK's glTF import mirrors
   * z instead, the two differ by exactly this turn. Which one it does is checked on the headset (see README).
   */
  var modelTurn = true
    set(value) {
      if (field != value) {
        field = value
        rebuild()
      }
    }

  var onApplied: ((PlanDiff) -> Unit)? = null

  private var plan: List<RenderItem> = emptyList()
  private val shown = mutableMapOf<String, Shown>()

  /** [faded] are the entities whose alpha the fade sets (an image's quad, a video's panel); models have none. */
  private class Shown(
      val entities: List<Entity>,
      val player: ExoPlayer? = null,
      val panelId: Int? = null,
      val faded: List<Entity> = emptyList(),
  )

  /** Where the fade is: [alpha] now, heading for [target] (0 or 1) since [fadeFrom] at [fadeStart]. */
  private var alpha = 0f
  private var target = 0f
  private var fadeFrom = 0f
  private var fadeStart = 0L
  /** Images and videos are drawn while fading or shown; models and sounds only once fully shown. */
  private var mediaOn = false
  private var solidOn = false
  private val sceneObjects = HashMap<Entity, SceneObject>()

  init {
    activity.registerAsyncMeshCreator(IMAGE_MESH) { _, uri -> imageMesh(uri) }
  }

  fun apply(next: List<RenderItem>) {
    val d = diffPlans(plan, next)
    d.remove.forEach(::remove)
    for (item in d.update) {
      remove(item.key)
      add(item)
    }
    d.add.forEach(::add)
    plan = next
    onApplied?.invoke(d)
  }

  /** Puts the scene origin at `pose.position`, turned `pose.yawDeg` degrees about +Y (level: no pitch or roll). */
  fun setRoot(pose: RootPose) {
    val q = Quat.axisAngle(0.0, 1.0, 0.0, Math.toRadians(pose.yawDeg))
    root.setComponent(
        Transform(Pose(Vector3(pose.position.x.toFloat(), pose.position.y.toFloat(), pose.position.z.toFloat()), q.sdk()))
    )
  }

  fun count() = plan.size

  /** Removes every item (the space was closed). */
  fun clear() = apply(emptyList())

  /** Fades the scene in or out over [FADE_MS] from wherever the current fade has got to. */
  fun setVisible(on: Boolean, nowMs: Long) {
    val t = if (on) 1f else 0f
    if (t == target) return
    target = t
    fadeFrom = alpha
    fadeStart = nowMs
    if (on) setMediaOn(true)
  }

  /** Advances the fade; call every frame. */
  fun tick(nowMs: Long) {
    if (alpha == target) return
    val k = ((nowMs - fadeStart).toFloat() / FADE_MS).coerceIn(0f, 1f)
    alpha = fadeFrom + (target - fadeFrom) * k
    if (k >= 1f) alpha = target
    shown.values.forEach { s -> s.faded.forEach { e -> sceneObjects[e]?.let { setAlpha(it, alpha) } } }
    if (alpha == target) {
      setSolidOn(target == 1f)
      if (target == 0f) setMediaOn(false)
    }
  }

  private fun setMediaOn(on: Boolean) {
    mediaOn = on
    shown.values.forEach { s -> if (s.faded.isNotEmpty()) s.entities.forEach { it.setComponent(Visible(on)) } }
  }

  private fun setSolidOn(on: Boolean) {
    solidOn = on
    shown.values.forEach { s -> if (s.faded.isEmpty()) s.entities.forEach { it.setComponent(Visible(on)) } }
  }

  /** Sets [so]'s alpha: its materials' albedo (images multiply their texture by it) and, for a panel, its layer. */
  private fun setAlpha(so: SceneObject, a: Float) {
    so.materials?.forEach { it.setAlbedoColor(android.graphics.Color.valueOf(1f, 1f, 1f, a)) }
    (so as? PanelSceneObject)?.layer?.setColorScaleBias(Vector4(a, a, a, a), Vector4(0f, 0f, 0f, 0f))
  }

  /** Remembers [e]'s scene object once it exists, and gives it the current alpha. */
  private fun watchAlpha(e: Entity) {
    val future = activity.systemManager.findSystem<SceneObjectSystem>().getSceneObject(e) ?: return
    future.thenAccept { so ->
      activity.runOnUiThread {
        if (shown.values.none { e in it.faded }) return@runOnUiThread
        sceneObjects[e] = so
        if (alpha < 1f) setAlpha(so, alpha)
      }
    }
  }

  private fun rebuild() {
    val current = plan
    current.forEach { remove(it.key) }
    plan = emptyList()
    apply(current)
  }

  private fun group(item: RenderItem): Entity =
      Entity.create(
          listOf(
              TransformParent(root),
              Transform(Pose(item.transform.position.sdk(), item.transform.rotation.sdk())),
          )
      )

  private fun add(item: RenderItem) {
    val g = group(item)
    val s =
        when (item.kind) {
          RenderItem.Kind.IMAGE -> child(g, imageMeshUri(item)).let { q -> Shown(listOf(g, q), faded = listOf(q)) }
          RenderItem.Kind.MODEL -> Shown(listOf(g, model(g, item)))
          RenderItem.Kind.VIDEO -> video(g, item)
          RenderItem.Kind.AUDIO -> Shown(listOf(g))
        }
    shown[item.key] = s
    val on = if (s.faded.isEmpty()) solidOn else mediaOn
    s.entities.forEach { it.setComponent(Visible(on)) }
    s.faded.forEach(::watchAlpha)
  }

  private fun remove(key: String) {
    val s = shown.remove(key) ?: return
    s.faded.forEach { sceneObjects.remove(it) }
    s.player?.release()
    s.panelId?.let {
      activity.panelRegistrations.remove(it)
      activity.systemManager.findSystem<PanelCreationSystem>().panelCreator.remove(it)
    }
    s.entities.asReversed().forEach { it.destroy() }
  }

  private fun child(parent: Entity, mesh: Uri, vararg extra: com.meta.spatial.core.ComponentBase): Entity =
      Entity.create(
          listOf(Mesh(mesh, hittable = MeshCollision.NoCollision), TransformParent(parent), Transform(Pose())) +
              extra.toList()
      )

  private fun model(parent: Entity, item: RenderItem): Entity {
    val turn = if (modelTurn) Quat.axisAngle(0.0, 1.0, 0.0, Math.PI) else Quat.IDENTITY
    if (extOf(item.src) != "glb") {
      Log.w(TAG, "only .glb models load; showing a placeholder for ${item.name}")
      return Entity.create(
          listOf(
              Mesh(Uri.parse("mesh://box"), hittable = MeshCollision.NoCollision),
              Box(Vector3(-0.25f, 0f, -0.25f), Vector3(0.25f, 0.5f, 0.25f)),
              Material().apply { baseColor = Color4(1f, 0.2f, 0.6f, 1f) },
              TransformParent(parent),
              Transform(Pose()),
          )
      )
    }
    return Entity.create(
        listOf(
            Mesh(Uri.parse(item.src), hittable = MeshCollision.NoCollision),
            TransformParent(parent),
            Transform(Pose(Vector3(0f), turn.sdk())),
            Scale(item.transform.scale.sdk()),
        )
    )
  }

  private fun video(parent: Entity, item: RenderItem): Shown {
    val w = maxOf(Math.abs(item.width), 0.001).toFloat()
    val h = maxOf(Math.abs(item.height), 0.001).toFloat()
    val player =
        ExoPlayer.Builder(activity).build().apply {
          setMediaItem(MediaItem.fromUri(item.src))
          repeatMode = if (item.loop) Player.REPEAT_MODE_ALL else Player.REPEAT_MODE_OFF
          volume = 0f // muted, like the other spikes until Sound is on
          prepare()
          playWhenReady = true
        }
    val id = nextPanelId++
    activity.registerPanel(
        VideoSurfacePanelRegistration(
            id,
            surfaceConsumer = { _, surface -> player.setVideoSurface(surface) },
            settingsCreator = {
              MediaPanelSettings(
                  shape = QuadShapeOptions(width = w, height = h),
                  display = PixelDisplayOptions(width = 1280, height = 720),
              )
            },
        )
    )
    val panel = Entity.create(listOf(Panel(id), TransformParent(parent), Transform(Pose())))
    return Shown(listOf(parent, panel), player, id, faded = listOf(panel))
  }

  private suspend fun imageMesh(uri: Uri): SceneMesh {
    val src = uri.getQueryParameter("src") ?: ""
    val w = uri.getQueryParameter("w")?.toFloatOrNull() ?: 1f
    val h = uri.getQueryParameter("h")?.toFloatOrNull() ?: 1f
    // Download off the main thread; textures and meshes have to be made on it (the renderer asserts otherwise).
    val bitmap =
        try {
          withContext(Dispatchers.IO) {
            val c = URL(src).openConnection() as HttpURLConnection
            try {
              c.inputStream.use { BitmapFactory.decodeStream(it) }
            } finally {
              c.disconnect()
            }
          } ?: error("could not decode image")
        } catch (e: Exception) {
          Log.w(TAG, "image failed: $src ${e.message}")
          null
        }
    return withContext(Dispatchers.Main) {
      val texture = bitmap?.let { SceneTexture(it) } ?: SceneTexture(android.graphics.Color.valueOf(0.5f, 0.5f, 0.5f, 0.4f))
      val material = SceneMaterial(texture, AlphaMode.TRANSLUCENT, SceneMaterial.UNLIT_SHADER)
      material.setSidedness(MaterialSidedness.DOUBLE_SIDED)
      SceneMesh.quad(Vector3(-w / 2, -h / 2, 0f), Vector3(w / 2, h / 2, 0f), material)
    }
  }

  private fun imageMeshUri(item: RenderItem): Uri =
      Uri.parse(IMAGE_MESH)
          .buildUpon()
          .appendQueryParameter("src", item.src)
          .appendQueryParameter("w", maxOf(Math.abs(item.width), 0.001).toString())
          .appendQueryParameter("h", maxOf(Math.abs(item.height), 0.001).toString())
          .build()

  companion object {
    private const val TAG = "VLMSpaces"
    private const val IMAGE_MESH = "mesh://vlm-image"
    const val FADE_MS = 400L
    private var nextPanelId = 1_600_000
  }
}
