package io.virvi.ar.roomscan

import io.virvi.ar.Vec3
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.roundToLong
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// What the headset reads from MRUK (`MainActivity.readRoomScanInput`), in the app's world frame: metres, Y up,
// exactly as MRUK reports it. Nothing is mirrored or recentred here; the server places the rooms on a plot.
//
// Yaw, everywhere in this file, is the turn about +Y that takes +x towards -z (the server's convention, and the
// Spatial SDK's: its Quaternion is Hamilton's w, x, y, z, so a positive angle about +Y maps +x to (cos t, 0, -sin t);
// see `MappingTest` and `RoomScanMapperTest`). Input yaw is in radians; the layout's is in degrees.

/** Every room MRUK returned, in one shared frame. */
data class RoomScanInput(val rooms: List<ScanRoom>)

/** A pose on the floor: a position and a yaw (radians). */
data class ScanPose(val position: Vec3, val yaw: Double)

/** One wall face: floor-plane endpoints (x, z) from its local -x end to its +x end, and its world bottom and top. */
data class ScanWall(val id: String, val a: Pair<Float, Float>, val b: Pair<Float, Float>, val bottom: Float, val top: Float)

enum class OpeningKind(val json: String) { DOOR("door"), WINDOW("window") }

/**
 * A door or window frame: its world [center], [width] along the wall, [height] and world [bottom]. [wallId] is the wall
 * MRUK parents it to, or null; an opening on no known wall is placed on the wall it lies on, if any.
 */
data class ScanOpening(val kind: OpeningKind, val wallId: String?, val center: Vec3, val width: Float, val height: Float, val bottom: Float)

/** A furniture volume: its MRUK label, world [center], [size] (along its yawed x, up, along its yawed z) and yaw (radians). */
data class ScanVolume(val label: String, val center: Vec3, val size: Vec3, val yaw: Double)

/** One MRUK room. [floorPolygon] is the floor's boundary in (x, z); [floorY] and [ceilingY] are world heights. */
data class ScanRoom(
    val roomUuid: String,
    val floorAnchorUuid: String?,
    val floorPose: ScanPose,
    val floorPolygon: List<Pair<Float, Float>>,
    val floorY: Float,
    val ceilingY: Float,
    val walls: List<ScanWall>,
    val openings: List<ScanOpening>,
    val volumes: List<ScanVolume>,
)

/** A box in world space: its centre, size (along its yawed x, up, along its yawed z) and yaw (radians). */
data class ScanBox(val center: Vec3, val size: Vec3, val yaw: Double)

/** The scan's default name: "My room" for one room, "My home" for several. */
fun defaultScanName(roomCount: Int): String = if (roomCount > 1) "My home" else "My room"

/**
 * The yaw (radians) of a frame whose local +x axis points along [xAxis] in world space: atan2(-x.z, x.x), so that a
 * turn of t about +Y, which maps +x to (cos t, 0, -sin t), gives t. Only the horizontal part of [xAxis] counts.
 */
fun yawOfXAxis(xAxis: Vec3): Double = atan2(-xAxis.z, xAxis.x)

/**
 * A box given by its world [center], its local axes in world space ([ax], [ay], [az], unit) and its local [extent]
 * (full size along each), as an upright yawed box. The local axis nearest world up is the height; of the other two,
 * the first (in x, y, z order) gives the yaw and the size's x, the second the size's z. MRUK volumes lie with local z
 * up (z is their anchor's normal), which this handles as well as a y-up box.
 */
fun boxOf(center: Vec3, ax: Vec3, ay: Vec3, az: Vec3, extent: Vec3): ScanBox {
  val axes = listOf(ax to extent.x, ay to extent.y, az to extent.z)
  val up = axes.indices.maxBy { abs(axes[it].first.y) }
  val (first, second) = axes.indices.filter { it != up }.map { axes[it] }
  return ScanBox(center, Vec3(first.second, axes[up].second, second.second), yawOfXAxis(first.first))
}

/** Turns a [RoomScanInput] into a `RoomScanLayout` (version 1, `packages/shared/src/room-scan.ts`). Pure. */
object RoomScanMapper {
  /** An opening with no known wall goes on a wall whose line is within this many metres of its centre. */
  const val OPENING_WALL_MAX_M = 0.3
  /** ...and whose ends it lies between, give or take this much. */
  private const val OPENING_WALL_SLACK_M = 0.1
  /** The ceiling heights the server accepts (`MIN_CEILING_M`, `MAX_CEILING_M`). */
  const val MIN_CEILING_M = 1.8
  const val MAX_CEILING_M = 8.0

  /**
   * The layout. A bad MRUK reading (NaN or infinite) never reaches it: a wall, opening or volume with one is left out,
   * and a room whose floor, ceiling or floor pose has one is dropped (the rest are labelled in order).
   */
  fun toLayoutJson(input: RoomScanInput): JsonObject = buildJsonObject {
    put("version", 1)
    put("rooms", JsonArray(input.rooms.mapNotNull(::finiteRoom).mapIndexed { i, r -> room(i, r) }))
  }

  /** [r] with its non-finite walls, openings and volumes left out, or null when the room itself isn't finite. */
  private fun finiteRoom(r: ScanRoom): ScanRoom? {
    val roomOk =
        fin(r.floorY, r.ceilingY) && fin(r.floorPose.position) && r.floorPose.yaw.isFinite() &&
            r.floorPolygon.all { fin(it.first, it.second) }
    if (!roomOk) return null
    return r.copy(
        walls = r.walls.filter { fin(it.a.first, it.a.second, it.b.first, it.b.second, it.bottom, it.top) },
        openings = r.openings.filter { fin(it.center) && fin(it.width, it.height, it.bottom) },
        volumes = r.volumes.filter { fin(it.center) && fin(it.size) && it.yaw.isFinite() },
    )
  }

  private fun fin(vararg v: Float) = v.all { it.isFinite() }

  private fun fin(v: Vec3) = v.x.isFinite() && v.y.isFinite() && v.z.isFinite()

  private fun room(index: Int, r: ScanRoom): JsonObject {
    val openings = r.walls.associate { it.id to ArrayList<JsonObject>() }
    for (o in r.openings) {
      val wall = r.walls.firstOrNull { it.id == o.wallId } ?: wallUnder(r.walls, o) ?: continue
      openings.getValue(wall.id) += opening(wall, o, r.floorY)
    }
    return buildJsonObject {
      put("label", "Room ${index + 1}")
      put("floor", JsonArray(r.floorPolygon.map { pair(it) }))
      put("floorY", m(r.floorY.toDouble()))
      put("ceilingHeight", m((r.ceilingY.toDouble() - r.floorY).coerceIn(MIN_CEILING_M, MAX_CEILING_M)))
      put(
          "walls",
          JsonArray(
              r.walls.map { w ->
                buildJsonObject {
                  put("a", pair(w.a))
                  put("b", pair(w.b))
                  put("openings", JsonArray(openings.getValue(w.id)))
                }
              },
          ),
      )
      put(
          "objects",
          JsonArray(
              r.volumes.map { v ->
                buildJsonObject {
                  put("label", v.label.lowercase())
                  put("center", vec(v.center))
                  put("size", vec(v.size))
                  put("yaw", degrees(v.yaw))
                }
              },
          ),
      )
      put(
          "anchor",
          buildJsonObject {
            put("source", "quest-mruk")
            put("roomId", r.roomUuid)
            put("floorAnchorId", r.floorAnchorUuid?.let(::JsonPrimitive) ?: JsonNull)
            put(
                "floorPose",
                buildJsonObject {
                  put("position", vec(r.floorPose.position))
                  put("yaw", degrees(r.floorPose.yaw))
                },
            )
          },
      )
    }
  }

  /** [o] projected onto [wall]: `offset` from the wall's start to the opening's near edge, sill above [floorY]. */
  private fun opening(wall: ScanWall, o: ScanOpening, floorY: Float): JsonObject = buildJsonObject {
    put("kind", o.kind.json)
    put("offset", m(along(wall, o.center) - o.width / 2.0))
    put("width", m(o.width.toDouble()))
    put("sill", m(o.bottom.toDouble() - floorY))
    put("height", m(o.height.toDouble()))
  }

  /** The wall [o] lies on: the nearest whose line is within [OPENING_WALL_MAX_M] and whose ends it lies between. */
  private fun wallUnder(walls: List<ScanWall>, o: ScanOpening): ScanWall? =
      walls
          .filter { w ->
            val t = along(w, o.center)
            t >= -OPENING_WALL_SLACK_M && t <= length(w) + OPENING_WALL_SLACK_M && across(w, o.center) <= OPENING_WALL_MAX_M
          }
          .minByOrNull { across(it, o.center) }

  private fun length(w: ScanWall) = hypot((w.b.first - w.a.first).toDouble(), (w.b.second - w.a.second).toDouble())

  /** How far along [w] (from a towards b) [p] lies, in the floor plane. */
  private fun along(w: ScanWall, p: Vec3): Double {
    val len = length(w)
    if (len < 1e-9) return 0.0
    return ((p.x - w.a.first) * (w.b.first - w.a.first) + (p.z - w.a.second) * (w.b.second - w.a.second)) / len
  }

  /** How far [p] lies from [w]'s line, in the floor plane. */
  private fun across(w: ScanWall, p: Vec3): Double {
    val len = length(w)
    if (len < 1e-9) return hypot(p.x - w.a.first, p.z - w.a.second)
    return abs((p.x - w.a.first) * (w.b.second - w.a.second) - (p.z - w.a.second) * (w.b.first - w.a.first)) / len
  }

  private fun pair(p: Pair<Float, Float>) = buildJsonArray {
    add(JsonPrimitive(m(p.first.toDouble())))
    add(JsonPrimitive(m(p.second.toDouble())))
  }

  private fun vec(v: Vec3) = buildJsonArray {
    add(JsonPrimitive(m(v.x)))
    add(JsonPrimitive(m(v.y)))
    add(JsonPrimitive(m(v.z)))
  }

  private fun degrees(radians: Double) = round(Math.toDegrees(radians), 1e3)

  /** Metres to a tenth of a millimetre: MRUK's floats carry no more, and it keeps the upload small. */
  private fun m(v: Double) = round(v, 1e4)

  private fun round(v: Double, scale: Double): Double {
    // Inputs are finite (see [finiteRoom]); roundToLong would throw on NaN and clip infinities.
    require(v.isFinite()) { "non-finite value in a room scan" }
    val r = (v * scale).roundToLong() / scale
    return if (r == 0.0) 0.0 else r
  }
}
