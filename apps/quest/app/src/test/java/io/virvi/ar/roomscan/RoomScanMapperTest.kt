package io.virvi.ar.roomscan

import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Vector3
import io.virvi.ar.Quat
import io.virvi.ar.Vec3
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomScanMapperTest {
  private val eps = 1e-4

  /** A 4 × 3 m room with its floor at [y], its corner at ([x0], [z0]), walls 0..3 running round it. */
  private fun room(
      x0: Float = 0f,
      z0: Float = 0f,
      y: Float = 0f,
      openings: List<ScanOpening> = emptyList(),
      volumes: List<ScanVolume> = emptyList(),
      uuid: String = "room-1",
  ): ScanRoom {
    val c = listOf(x0 to z0, x0 + 4f to z0, x0 + 4f to z0 + 3f, x0 to z0 + 3f)
    return ScanRoom(
        roomUuid = uuid,
        floorAnchorUuid = "$uuid-floor",
        floorPose = ScanPose(Vec3(x0 + 2.0, y.toDouble(), z0 + 1.5), 0.0),
        floorPolygon = c,
        floorY = y,
        ceilingY = y + 2.5f,
        walls = c.indices.map { i -> ScanWall("$uuid-w$i", c[i], c[(i + 1) % 4], y, y + 2.5f) },
        openings = openings,
        volumes = volumes,
    )
  }

  private fun JsonObject.rooms() = this["rooms"]!!.jsonArray.map { it.jsonObject }

  private fun JsonObject.num(key: String) = this[key]!!.jsonPrimitive.double

  private fun JsonArray.nums() = map { it.jsonPrimitive.double }

  @Test
  fun `a door centred 1_45 m along wall 0 maps to offset 1_0, width 0_9, sill 0, height 2_1`() {
    val door = ScanOpening(OpeningKind.DOOR, "room-1-w0", Vec3(1.45, 1.05, 0.0), width = 0.9f, height = 2.1f, bottom = 0f)
    val out = RoomScanMapper.toLayoutJson(RoomScanInput(listOf(room(openings = listOf(door)))))
    assertEquals(1, out["version"]!!.jsonPrimitive.int)
    val r = out.rooms().single()
    assertEquals(2.5, r.num("ceilingHeight"), eps)
    assertEquals(0.0, r.num("floorY"), eps)
    val walls = r["walls"]!!.jsonArray.map { it.jsonObject }
    assertEquals(4, walls.size)
    val o = walls[0]["openings"]!!.jsonArray.single().jsonObject
    assertEquals("door", o["kind"]!!.jsonPrimitive.content)
    assertEquals(1.0, o.num("offset"), eps)
    assertEquals(0.9, o.num("width"), eps)
    assertEquals(0.0, o.num("sill"), eps)
    assertEquals(2.1, o.num("height"), eps)
    assertTrue(walls.drop(1).all { it["openings"]!!.jsonArray.isEmpty() })
  }

  @Test
  fun `a window's sill is its bottom above the room's floor`() {
    val window = ScanOpening(OpeningKind.WINDOW, "room-1-w1", Vec3(4.0, 2.0, 1.5), width = 1.2f, height = 1.0f, bottom = 1.5f)
    val out = RoomScanMapper.toLayoutJson(RoomScanInput(listOf(room(y = 0.5f, openings = listOf(window)))))
    val o = out.rooms().single()["walls"]!!.jsonArray[1].jsonObject["openings"]!!.jsonArray.single().jsonObject
    assertEquals("window", o["kind"]!!.jsonPrimitive.content)
    assertEquals(0.9, o.num("offset"), eps) // wall 1 runs (4,0) to (4,3); centre 1.5 along, half width 0.6
    assertEquals(1.0, o.num("sill"), eps)
  }

  @Test
  fun `two rooms keep their relative positions`() {
    val out = RoomScanMapper.toLayoutJson(RoomScanInput(listOf(room(), room(x0 = 4f, z0 = -1f, uuid = "room-2"))))
    val rooms = out.rooms()
    assertEquals(2, rooms.size)
    assertEquals(listOf(0.0, 0.0), rooms[0]["floor"]!!.jsonArray[0].jsonArray.nums())
    assertEquals(listOf(4.0, -1.0), rooms[1]["floor"]!!.jsonArray[0].jsonArray.nums())
    assertEquals(listOf(8.0, 2.0), rooms[1]["floor"]!!.jsonArray[2].jsonArray.nums())
    assertEquals(listOf(4.0, -1.0), rooms[1]["walls"]!!.jsonArray[0].jsonObject["a"]!!.jsonArray.nums())
    val anchor = rooms[1]["anchor"]!!.jsonObject
    assertEquals("quest-mruk", anchor["source"]!!.jsonPrimitive.content)
    assertEquals("room-2", anchor["roomId"]!!.jsonPrimitive.content)
    assertEquals("room-2-floor", anchor["floorAnchorId"]!!.jsonPrimitive.content)
    assertEquals(listOf(6.0, 0.0, 0.5), anchor["floorPose"]!!.jsonObject["position"]!!.jsonArray.nums())
  }

  @Test
  fun `an opening matched to no wall is dropped`() {
    val stray = ScanOpening(OpeningKind.DOOR, null, Vec3(2.0, 1.0, 1.5), width = 0.9f, height = 2.1f, bottom = 0f)
    val unknown = ScanOpening(OpeningKind.DOOR, "not-a-wall", Vec3(2.0, 1.0, 1.5), width = 0.9f, height = 2.1f, bottom = 0f)
    val out = RoomScanMapper.toLayoutJson(RoomScanInput(listOf(room(openings = listOf(stray, unknown)))))
    assertTrue(out.rooms().single()["walls"]!!.jsonArray.all { it.jsonObject["openings"]!!.jsonArray.isEmpty() })
  }

  @Test
  fun `an opening with no wall id goes on the wall it lies on`() {
    val door = ScanOpening(OpeningKind.DOOR, null, Vec3(0.02, 1.0, 2.0), width = 0.8f, height = 2.0f, bottom = 0f)
    val walls = RoomScanMapper.toLayoutJson(RoomScanInput(listOf(room(openings = listOf(door))))).rooms().single()["walls"]!!.jsonArray
    // Wall 3 runs (0,3) to (0,0): the centre is 1.0 along it.
    val o = walls[3].jsonObject["openings"]!!.jsonArray.single().jsonObject
    assertEquals(0.6, o.num("offset"), eps)
  }

  @Test
  fun `volume labels pass through in lowercase, with yaw in degrees`() {
    val couch = ScanVolume("COUCH", Vec3(1.0, 0.4, 2.0), Vec3(2.0, 0.8, 0.9), yaw = Math.PI / 2)
    val obj = RoomScanMapper.toLayoutJson(RoomScanInput(listOf(room(volumes = listOf(couch))))).rooms().single()["objects"]!!
        .jsonArray.single().jsonObject
    assertEquals("couch", obj["label"]!!.jsonPrimitive.content)
    assertEquals(listOf(1.0, 0.4, 2.0), obj["center"]!!.jsonArray.nums())
    assertEquals(listOf(2.0, 0.8, 0.9), obj["size"]!!.jsonArray.nums())
    assertEquals(90.0, obj.num("yaw"), eps)
  }

  @Test
  fun `a volume with a NaN reading is dropped, the rest kept`() {
    val bad = ScanVolume("TABLE", Vec3(Double.NaN, 0.4, 2.0), Vec3(1.0, 0.8, 1.0), yaw = 0.0)
    val badYaw = ScanVolume("BED", Vec3(1.0, 0.4, 2.0), Vec3(2.0, 0.6, 1.6), yaw = Double.POSITIVE_INFINITY)
    val good = ScanVolume("COUCH", Vec3(1.0, 0.4, 2.0), Vec3(2.0, 0.8, 0.9), yaw = 0.0)
    val objects = RoomScanMapper.toLayoutJson(RoomScanInput(listOf(room(volumes = listOf(bad, badYaw, good))))).rooms().single()["objects"]!!.jsonArray
    assertEquals(listOf("couch"), objects.map { it.jsonObject["label"]!!.jsonPrimitive.content })
  }

  @Test
  fun `non-finite walls and openings are dropped`() {
    val r = room(openings = listOf(ScanOpening(OpeningKind.DOOR, "room-1-w0", Vec3(1.45, 1.05, 0.0), width = Float.NaN, height = 2.1f, bottom = 0f)))
    val walls = r.walls.toMutableList().also { it[2] = it[2].copy(top = Float.NaN) }
    val out = RoomScanMapper.toLayoutJson(RoomScanInput(listOf(r.copy(walls = walls)))).rooms().single()["walls"]!!.jsonArray
    assertEquals(3, out.size)
    assertTrue(out.all { it.jsonObject["openings"]!!.jsonArray.isEmpty() })
  }

  @Test
  fun `a room with a NaN floor height, ceiling, pose or outline is dropped`() {
    val good = room(uuid = "good")
    val rooms =
        RoomScanMapper.toLayoutJson(
                RoomScanInput(
                    listOf(
                        room(uuid = "nan-floor").copy(floorY = Float.NaN),
                        good,
                        room(uuid = "inf-ceiling").copy(ceilingY = Float.POSITIVE_INFINITY),
                        room(uuid = "nan-pose").copy(floorPose = ScanPose(Vec3(Double.NaN, 0.0, 0.0), 0.0)),
                        room(uuid = "nan-yaw").copy(floorPose = ScanPose(Vec3(0.0, 0.0, 0.0), Double.NaN)),
                        room(uuid = "nan-outline").copy(floorPolygon = listOf(0f to 0f, Float.NaN to 0f, 1f to 1f)),
                    ),
                ),
            )
            .rooms()
    assertEquals(listOf("good"), rooms.map { it["anchor"]!!.jsonObject["roomId"]!!.jsonPrimitive.content })
    assertEquals("Room 1", rooms.single()["label"]!!.jsonPrimitive.content)
  }

  @Test
  fun `ceiling height is the ceiling above the floor, kept within 1_8 to 8 m`() {
    val base = room(y = 0.3f)
    val rooms =
        RoomScanMapper.toLayoutJson(
                RoomScanInput(listOf(base, base.copy(ceilingY = 1.5f), base.copy(ceilingY = 12f))),
            )
            .rooms()
    assertEquals(listOf(2.5, 1.8, 8.0), rooms.map { it.num("ceilingHeight") }.map { Math.round(it * 1e4) / 1e4 })
    assertEquals(listOf("Room 1", "Room 2", "Room 3"), rooms.map { it["label"]!!.jsonPrimitive.content })
  }

  @Test
  fun `a floor with no anchor id is null`() {
    val r = room().copy(floorAnchorUuid = null)
    val anchor = RoomScanMapper.toLayoutJson(RoomScanInput(listOf(r))).rooms().single()["anchor"]!!.jsonObject
    assertEquals(kotlinx.serialization.json.JsonNull, anchor["floorAnchorId"])
    assertEquals(JsonPrimitive(0.0), anchor["floorPose"]!!.jsonObject["yaw"])
  }

  // ── yaw: the server's convention is degrees about +Y where +yaw turns +x towards -z ──

  @Test
  fun `the Spatial SDK's positive turn about +Y is positive yaw, turning +x towards -z`() {
    val q = Quat.axisAngle(0.0, 1.0, 0.0, Math.toRadians(30.0))
    val sdk = Quaternion(q.w.toFloat(), q.x.toFloat(), q.y.toFloat(), q.z.toFloat())
    val x = sdk.times(Vector3(1f, 0f, 0f))
    assertTrue(x.z < 0) // +x has turned towards -z
    assertEquals(Math.toRadians(30.0), yawOfXAxis(Vec3(x.x.toDouble(), x.y.toDouble(), x.z.toDouble())), 1e-5)
  }

  @Test
  fun `yaw matches the server's box corners`() {
    // The server's yawBox puts a box's +x half-axis at (cos t, -sin t) in (x, z) for yaw t.
    for (deg in listOf(-170.0, -45.0, 0.0, 60.0, 135.0)) {
      val t = Math.toRadians(deg)
      val yaw = yawOfXAxis(Vec3(Math.cos(t), 0.0, -Math.sin(t)))
      assertEquals(deg, Math.toDegrees(yaw), 1e-9)
    }
  }

  @Test
  fun `a volume whose local z is up (MRUK) is sized and turned by its horizontal axes`() {
    // MRUK volumes and floors lie with local z along the normal: here up, after -90° about x, then a 30° yaw.
    val q = Quat.axisAngle(0.0, 1.0, 0.0, Math.toRadians(30.0)) * Quat.axisAngle(1.0, 0.0, 0.0, Math.toRadians(-90.0))
    val ax = q.rotate(Vec3(1.0, 0.0, 0.0))
    val ay = q.rotate(Vec3(0.0, 1.0, 0.0))
    val az = q.rotate(Vec3(0.0, 0.0, 1.0))
    assertEquals(1.0, az.y, 1e-9)
    val box = boxOf(Vec3(1.0, 0.5, 2.0), ax, ay, az, Vec3(2.0, 0.9, 1.0))
    assertEquals(Vec3(1.0, 0.5, 2.0), box.center)
    assertEquals(2.0, box.size.x, 1e-9) // along local x
    assertEquals(1.0, box.size.y, 1e-9) // local z: the height
    assertEquals(0.9, box.size.z, 1e-9) // local y: the other horizontal
    assertEquals(Math.toRadians(30.0), box.yaw, 1e-9)
  }

  @Test
  fun `a box whose local y is up keeps x, y, z`() {
    val q = Quat.axisAngle(0.0, 1.0, 0.0, Math.toRadians(-60.0))
    val box = boxOf(Vec3(0.0, 0.0, 0.0), q.rotate(Vec3(1.0, 0.0, 0.0)), q.rotate(Vec3(0.0, 1.0, 0.0)), q.rotate(Vec3(0.0, 0.0, 1.0)), Vec3(1.0, 2.0, 3.0))
    assertEquals(Vec3(1.0, 2.0, 3.0), box.size)
    assertEquals(Math.toRadians(-60.0), box.yaw, 1e-9)
  }

  @Test
  fun `default names are My room for one room and My home for several`() {
    assertEquals("My room", defaultScanName(1))
    assertEquals("My home", defaultScanName(3))
  }
}
