package gg.vlm.spaces.builder

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.api.ArApi
import gg.vlm.spaces.api.BuilderCall
import gg.vlm.spaces.api.MarkerPose
import java.time.Instant
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BuilderApiTest {
  private val server = MockWebServer()
  private val now = 1_800_000_000_000L
  private val seen = ArrayList<String>()
  private val bodies = ArrayList<String>()

  /** Answers for the builder routes by "METHOD /path"; the pairing routes are built in. */
  private val routes = HashMap<String, MockResponse>()

  @After
  fun tearDown() {
    runCatching { server.shutdown() }
  }

  private fun json(body: String, status: Int = 200) = MockResponse().setResponseCode(status).setBody(body)

  private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()

  private fun api(): BuilderApi {
    server.dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse {
            val key = "${request.method} ${request.path}"
            return when {
              request.path == "/api/ar/pair" ->
                  json("""{"code":"ABC123","approveUrl":"u","codeExpiresAt":"${iso(now + 600_000)}"}""")
              request.path!!.endsWith("/claim") ->
                  json("""{"status":"approved","deviceId":"dev1","kind":"personal","expiresAt":"${iso(now + 86_400_000)}"}""")
              request.path!!.endsWith("/pass") ->
                  json("""{"pass":"jwt","passExpiresAt":"${iso(now + 3_600_000)}","sceneId":"sc1"}""")
              else -> {
                seen += key
                bodies += request.body.readUtf8()
                assertEquals("Bearer jwt", request.getHeader("Authorization"))
                routes[key] ?: json("""{"error":"unrouted"}""", 500)
              }
            }
          }
        }
    server.start()
    val ar = ArApi(server.url("/").toString())
    val auth = DeviceAuth(ar, FakeSecureStore(), { now }, pollMs = 1)
    runBlocking { auth.beginPairing() }
    return BuilderApi(ar, auth)
  }

  private val t = ItemTransform(Vec3(1.0, 2.0, 3.0), Vec3(0.0, 90.0, 0.0), Vec3(1.0, 1.0, 1.0))

  @Test
  fun `a 409 held maps to Held with the holder's name`() {
    routes["POST /api/ar/drafts"] = json("""{"error":"held","holderName":"Sam"}""", 409)
    val r = runBlocking { api().draft("sp1", "sk1", "image", t) }
    assertEquals(BuilderCall.Ok(DraftAnswer.Held("Sam")), r)
  }

  @Test
  fun `a 503 maps to Unavailable`() {
    routes["POST /api/ar/drafts"] = json("""{"error":"drafts_unavailable"}""", 503)
    assertEquals(BuilderCall.Ok(DraftAnswer.Unavailable), runBlocking { api().draft("sp1", "sk1", "image", t) })
  }

  @Test
  fun `a 204 is Ok and the body carries the draft`() {
    routes["POST /api/ar/drafts"] = MockResponse().setResponseCode(204)
    assertEquals(BuilderCall.Ok(DraftAnswer.Ok), runBlocking { api().draft("sp1", "sk1", "image", t) })
    val b = bodies.single()
    assertTrue(b, b.contains("\"sk\":\"sk1\"") && b.contains("\"element\":\"image\"") && b.contains("\"y\":90.0"))
  }

  @Test
  fun `placeModel deletes the element when the instance call fails`() {
    routes["POST /api/presets/pr1/elements"] = json("""{"element":{"id":"el9"}}""", 201)
    routes["POST /api/elements/el9/instances"] = json("""{"error":"x"}""", 500)
    routes["DELETE /api/elements/el9"] = MockResponse().setResponseCode(204)
    val r = runBlocking { api().placeModel("sp1", "pr1", "Chair", "https://x/chair.glb", t) }
    assertEquals(BuilderCall.Failed(500), r)
    assertEquals(
        listOf("POST /api/presets/pr1/elements", "POST /api/elements/el9/instances", "DELETE /api/elements/el9"),
        seen,
    )
    assertTrue(bodies[0], bodies[0].contains("\"type\":\"model\"") && bodies[0].contains("\"modelSrc\":\"https://x/chair.glb\""))
  }

  @Test
  fun `placeModel returns both ids and keeps the element on success`() {
    routes["POST /api/presets/pr1/elements"] = json("""{"element":{"id":"el9"}}""", 201)
    routes["POST /api/elements/el9/instances"] = json("""{"instance":{"id":"in9"}}""", 201)
    val r = runBlocking { api().placeImage("sp1", "pr1", "Poster", "https://x/p.png", t) }
    assertEquals(BuilderCall.Ok(PlacedItem("el9", "in9")), r)
    assertEquals(2, seen.size)
    assertTrue(bodies[0], bodies[0].contains("\"type\":\"image\"") && bodies[0].contains("\"textureSrc\""))
  }

  @Test
  fun `placeVideo makes a one-video playlist screen`() {
    routes["POST /api/presets/pr1/elements"] = json("""{"element":{"id":"el8"}}""", 201)
    routes["POST /api/elements/el8/instances"] = json("""{"instance":{"id":"in8"}}""", 201)
    val r = runBlocking { api().placeVideo("sp1", "pr1", "Clip", "https://x/c.mp4", t) }
    assertEquals(BuilderCall.Ok(PlacedItem("el8", "in8")), r)
    assertTrue(bodies[0], bodies[0].contains("\"type\":\"video\"") && bodies[0].contains("\"playlist\":[\"https://x/c.mp4\"]") && bodies[0].contains("\"offType\":2"))
  }

  @Test
  fun `placeEntry sends each library kind to its place call`() {
    routes["POST /api/presets/pr1/elements"] = json("""{"element":{"id":"el7"}}""", 201)
    routes["POST /api/elements/el7/instances"] = json("""{"instance":{"id":"in7"}}""", 201)
    val a = api()
    runBlocking {
      a.placeEntry("sp1", "pr1", LibraryEntry("1", LibraryKind.MODEL, "Chair", "https://x/c.glb", null), t)
      a.placeEntry("sp1", "pr1", LibraryEntry("2", LibraryKind.IMAGE, "P", "https://x/p.png", null), t)
      a.placeEntry("sp1", "pr1", LibraryEntry("3", LibraryKind.VIDEO, "V", "https://x/v.mp4", null), t)
    }
    assertTrue(bodies[0], bodies[0].contains("\"modelSrc\":\"https://x/c.glb\""))
    assertTrue(bodies[2], bodies[2].contains("\"textureSrc\":\"https://x/p.png\""))
    assertTrue(bodies[4], bodies[4].contains("\"type\":\"video\""))
  }

  @Test
  fun `putAdjustment and savePose send their bodies and read the warnings`() {
    routes["PUT /api/ar/spaces/sp1/adjustments/in1"] = json("""{"dPosition":{"x":0,"y":0,"z":0}}""")
    routes["PUT /api/ar/markers/m1/pose"] = json("""{"marker":{},"warnings":["floor_far"]}""")
    val a = api()
    val adj = Adjustment(Vec3(0.5, 0.0, 0.0), Vec3(0.0, 10.0, 0.0), Vec3(0.5, 1.0, 1.0))
    assertEquals(BuilderCall.Ok(Unit), runBlocking { a.putAdjustment("sp1", "in1", adj) })
    assertEquals(BuilderCall.Ok(listOf("floor_far")), runBlocking { a.savePose("sp1", "m1", MarkerPose(1.0, 2.0, 3.0, 45.0), 1.4) })
    assertTrue(bodies[0], bodies[0].contains("\"scaleFactor\":{\"x\":0.5"))
    assertTrue(bodies[1], bodies[1].contains("\"heightAboveFloorM\":1.4") && bodies[1].contains("\"headingDeg\":45.0"))
  }

  @Test
  fun `sceneSpaces reads the scene's spaces and otherPlaces leaves this one out`() {
    routes["GET /api/scenes/sc1/ar/spaces"] =
        json("""[{"id":"sp1","name":"Lobby","floors":[]},{"id":"sp2","name":"Gallery"},{"id":"sp3"},{"id":"sp4","name":"Shop"}]""")
    val r = runBlocking { api().sceneSpaces("sp1", "sc1") }
    val spaces = (r as BuilderCall.Ok).value
    assertEquals(listOf(SpaceName("sp1", "Lobby"), SpaceName("sp2", "Gallery"), SpaceName("sp4", "Shop")), spaces)
    assertEquals(listOf("Gallery", "Shop"), otherPlaces(spaces, "sp1"))
  }

  @Test
  fun `deleteAdjustment and endDraft hit their routes`() {
    routes["DELETE /api/ar/spaces/sp1/adjustments/in1"] = MockResponse().setResponseCode(204)
    routes["POST /api/ar/drafts/end"] = MockResponse().setResponseCode(204)
    val a = api()
    assertEquals(BuilderCall.Ok(Unit), runBlocking { a.deleteAdjustment("sp1", "in1") })
    assertEquals(BuilderCall.Ok(Unit), runBlocking { a.endDraft("sp1", "in1", false) })
    assertTrue(bodies[1], bodies[1].contains("\"saved\":false") && bodies[1].contains("\"sk\":\"in1\""))
  }
}
