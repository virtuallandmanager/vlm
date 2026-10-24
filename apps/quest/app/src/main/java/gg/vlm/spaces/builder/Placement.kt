package gg.vlm.spaces.builder

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.space.RootPose
import gg.vlm.spaces.space.rotateY
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Where a new item goes: [distanceM] ahead of the head at [head] (world, facing [headYawDeg], degrees from +Z toward
 * +X), at eye height, turned to face the builder, in scene coordinates (so the item's rotation y is the head's yaw
 * + 180 − the root's yaw, in [0, 360)). Scale 1.
 */
fun placeAhead(head: Vec3, headYawDeg: Double, root: RootPose, distanceM: Double = 1.0): ItemTransform {
  val yaw = Math.toRadians(headYawDeg)
  val world = Vec3(head.x + Math.sin(yaw) * distanceM, head.y, head.z + Math.cos(yaw) * distanceM)
  val d = Vec3(world.x - root.position.x, world.y - root.position.y, world.z - root.position.z)
  val p = rotateY(-root.yawDeg, d)
  val turn = headYawDeg + 180.0 - root.yawDeg
  return ItemTransform(p, Vec3(0.0, turn - Math.floor(turn / 360.0) * 360.0, 0.0), Vec3(1.0, 1.0, 1.0))
}

/**
 * The item to pick once the feed shows it: a placed item reaches the editor with the next snapshot, not with the
 * place call. Main thread only.
 */
class PendingPick {
  private var sk: String? = null

  /** [sk] (the new instance's id) is picked when it appears; a later call replaces an earlier one. */
  fun expect(sk: String) {
    this.sk = sk
  }

  fun clear() {
    sk = null
  }

  /** The sk to pick now, once, if [items] has the expected item; null otherwise. */
  fun resolve(items: List<BuilderItem>): String? {
    val want = sk ?: return null
    if (items.none { it.sk == want }) return null
    sk = null
    return want
  }
}

enum class LibraryKind { IMAGE, VIDEO, MODEL }

/** A library item that can be placed. [thumbnailUrl] is set where the library gives one (an image is its own). */
data class LibraryEntry(val id: String, val kind: LibraryKind, val name: String, val url: String, val thumbnailUrl: String?)

/**
 * The placeable items of `GET /api/scenes/:id/library` (`{ items }`): ready ones with a url that are models, or media
 * whose contentType is an image or a video (sounds and untyped files are left out).
 */
fun libraryEntries(body: JsonObject): List<LibraryEntry> =
    ((body["items"] as? JsonArray) ?: emptyList<Nothing>()).mapNotNull { e ->
      val o = e as? JsonObject ?: return@mapNotNull null
      fun s(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
      val id = s("id") ?: return@mapNotNull null
      val url = s("url")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
      if (s("status") != "ready") return@mapNotNull null
      val kind =
          when (s("kind")) {
            "model" -> LibraryKind.MODEL
            "media" ->
                when {
                  s("contentType")?.startsWith("image/") == true -> LibraryKind.IMAGE
                  s("contentType")?.startsWith("video/") == true -> LibraryKind.VIDEO
                  else -> return@mapNotNull null
                }
            else -> return@mapNotNull null
          }
      LibraryEntry(id, kind, s("name") ?: kind.name.lowercase(), url, url.takeIf { kind == LibraryKind.IMAGE })
    }

/** The active preset's id from `GET /api/scenes/:id` (`{ scene: { activePresetId } }`). */
fun activePresetId(body: JsonObject): String? =
    (((body["scene"] as? JsonObject)?.get("activePresetId")) as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }

/** Creates [entry] in the scene's [presetId] at [t]: always the shared scene, whatever the Everywhere switch says. */
suspend fun BuilderApi.placeEntry(spaceId: String, presetId: String, entry: LibraryEntry, t: ItemTransform) =
    when (entry.kind) {
      LibraryKind.IMAGE -> placeImage(spaceId, presetId, entry.name, entry.url, t)
      LibraryKind.VIDEO -> placeVideo(spaceId, presetId, entry.name, entry.url, t)
      LibraryKind.MODEL -> placeModel(spaceId, presetId, entry.name, entry.url, t)
    }
