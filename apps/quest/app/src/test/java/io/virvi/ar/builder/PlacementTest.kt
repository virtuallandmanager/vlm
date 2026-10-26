package io.virvi.ar.builder

import io.virvi.ar.Vec3
import io.virvi.ar.space.RootPose
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlacementTest {
  private val identity = RootPose(Vec3(0.0, 0.0, 0.0), 0.0)

  private fun near(a: Double, b: Double) = assertEquals(a, b, 1e-9)

  @Test
  fun `one metre ahead at eye height facing the builder`() {
    val t = placeAhead(Vec3(0.0, 1.6, 0.0), 0.0, identity)
    near(0.0, t.position.x)
    near(1.6, t.position.y)
    near(1.0, t.position.z)
    near(180.0, t.rotation.y)
    near(0.0, t.rotation.x)
    near(0.0, t.rotation.z)
    assertEquals(Vec3(1.0, 1.0, 1.0), t.scale)
  }

  @Test
  fun `a head turned to face +X puts it on +X`() {
    val t = placeAhead(Vec3(2.0, 1.5, 3.0), 90.0, identity, distanceM = 2.0)
    near(4.0, t.position.x)
    near(1.5, t.position.y)
    near(3.0, t.position.z)
    near(270.0, t.rotation.y)
  }

  @Test
  fun `a turned root gives scene coordinates that round-trip to the world spot`() {
    val root = RootPose(Vec3(1.0, 0.0, 2.0), 90.0)
    val head = Vec3(0.5, 1.6, -1.0)
    val t = placeAhead(head, 30.0, root)
    // Back to the world through the root.
    val back = rotate(root.yawDeg, t.position)
    near(root.position.x + back.x, head.x + Math.sin(Math.toRadians(30.0)))
    near(root.position.y + back.y, 1.6)
    near(root.position.z + back.z, head.z + Math.cos(Math.toRadians(30.0)))
    // World facing = scene rotation + root yaw = head yaw + 180.
    near(210.0, ((t.rotation.y + root.yawDeg) % 360.0 + 360.0) % 360.0)
    near(30.0 + 180.0 - 90.0, t.rotation.y)
  }

  @Test
  fun `rotation is normalised to 0 until 360`() {
    val t = placeAhead(Vec3(0.0, 1.0, 0.0), 10.0, RootPose(Vec3(0.0, 0.0, 0.0), 300.0))
    near(10.0 + 180.0 - 300.0 + 360.0, t.rotation.y)
    assertTrue(t.rotation.y >= 0.0 && t.rotation.y < 360.0)
  }

  private fun rotate(deg: Double, v: Vec3): Vec3 {
    val r = Math.toRadians(deg)
    return Vec3(v.x * Math.cos(r) + v.z * Math.sin(r), v.y, -v.x * Math.sin(r) + v.z * Math.cos(r))
  }

  // ── pending pick ──

  private fun item(sk: String) = BuilderItem(sk, "el:$sk", "image", "x", tr(), tr(), null)

  private fun tr() = ItemTransform(Vec3(0.0, 0.0, 0.0), Vec3(0.0, 0.0, 0.0), Vec3(1.0, 1.0, 1.0))

  @Test
  fun `a pending pick waits until the feed has the item`() {
    val p = PendingPick()
    assertNull(p.resolve(listOf(item("a"))))
    p.expect("in9")
    assertNull(p.resolve(listOf(item("a"))))
    assertEquals("in9", p.resolve(listOf(item("a"), item("in9"))))
    // Once picked it is done.
    assertNull(p.resolve(listOf(item("a"), item("in9"))))
  }

  @Test
  fun `a newer placement replaces the pending one and clear drops it`() {
    val p = PendingPick()
    p.expect("in1")
    p.expect("in2")
    assertEquals("in2", p.resolve(listOf(item("in1"), item("in2"))))
    p.expect("in3")
    p.clear()
    assertNull(p.resolve(listOf(item("in3"))))
  }

  // ── the library ──

  private fun lib(s: String) = libraryEntries(Json.parseToJsonElement(s).jsonObject)

  @Test
  fun `library entries choose image video or model and skip what can't be placed`() {
    val l =
        lib(
            """{"items":[
              {"id":"1","kind":"media","name":"a.png","contentType":"image/png","url":"https://x/a.png","status":"ready"},
              {"id":"2","kind":"media","name":"b.mp4","contentType":"video/mp4","url":"https://x/b.mp4","status":"ready"},
              {"id":"3","kind":"model","name":"Chair","contentType":"model/gltf-binary","url":"https://x/c.glb","status":"ready"},
              {"id":"4","kind":"media","name":"s.mp3","contentType":"audio/mpeg","url":"https://x/s.mp3","status":"ready"},
              {"id":"5","kind":"media","name":"u.png","contentType":"image/png","url":"https://x/u.png","status":"uploading"},
              {"id":"6","kind":"media","name":"n.png","contentType":"image/png","url":"","status":"ready"},
              {"id":"7","kind":"media","name":"nul","contentType":null,"url":"https://x/n","status":"ready"}
            ]}""")
    assertEquals(
        listOf(
            LibraryEntry("1", LibraryKind.IMAGE, "a.png", "https://x/a.png", "https://x/a.png"),
            LibraryEntry("2", LibraryKind.VIDEO, "b.mp4", "https://x/b.mp4", null),
            LibraryEntry("3", LibraryKind.MODEL, "Chair", "https://x/c.glb", null),
        ),
        l)
  }

  @Test
  fun `a missing items array is an empty library`() {
    assertTrue(lib("""{}""").isEmpty())
  }

  @Test
  fun `the active preset comes from the scene`() {
    assertEquals("p1", activePresetId(Json.parseToJsonElement("""{"scene":{"activePresetId":"p1"}}""").jsonObject))
    assertNull(activePresetId(Json.parseToJsonElement("""{"scene":{"activePresetId":null}}""").jsonObject))
  }

  @Test
  fun `webm and gif entries are kept but not drawable, with no thumbnail`() {
    val l =
        lib(
            """{"items":[
              {"id":"1","kind":"media","name":"a.webm","contentType":"video/webm","url":"https://x/a.webm","status":"ready"},
              {"id":"2","kind":"media","name":"b.gif","contentType":"image/gif","url":"https://x/b.gif?v=2","status":"ready"},
              {"id":"3","kind":"media","name":"c.JPG","contentType":"image/jpeg","url":"https://x/c.JPG","status":"ready"},
              {"id":"4","kind":"media","name":"d.m3u8","contentType":"video/mp4","url":"https://x/d.m3u8","status":"ready"}
            ]}""")
    assertEquals(listOf(false, false, true, true), l.map { it.drawable })
    assertNull(l[1].thumbnailUrl)
  }

  @Test
  fun `a booking's preset is live when the active preset is a booking copy`() {
    fun body(name: String) =
        Json.parseToJsonElement(
                """{"scene":{"activePresetId":"p2","presets":[{"id":"p1","name":"booking:b0"},{"id":"p2","name":"$name"}]}}"""
            )
            .jsonObject
    assertTrue(activePresetIsBooking(body("booking:6f1c")))
    assertFalse(activePresetIsBooking(body("Main")))
    assertFalse(activePresetIsBooking(Json.parseToJsonElement("""{"scene":{"presets":[]}}""").jsonObject))
  }
}
