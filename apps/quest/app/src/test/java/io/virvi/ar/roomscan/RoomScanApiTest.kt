package io.virvi.ar.roomscan

import io.virvi.ar.api.ArApi
import io.virvi.ar.api.BuilderCall
import io.virvi.ar.builder.DeviceAuth
import io.virvi.ar.builder.FakeSecureStore
import java.time.Instant
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class RoomScanApiTest {
  private val server = MockWebServer()
  private val now = 1_800_000_000_000L
  private val seen = ArrayList<RecordedRequest>()
  private val bodies = ArrayList<String>()
  private var answer: MockResponse = MockResponse().setResponseCode(500)

  @After
  fun tearDown() {
    runCatching { server.shutdown() }
  }

  private fun json(body: String, status: Int) = MockResponse().setResponseCode(status).setBody(body)

  private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()

  private fun api(): RoomScanApi {
    server.dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse =
              when {
                request.path == "/api/ar/pair" ->
                    json("""{"code":"ABC123","approveUrl":"u","codeExpiresAt":"${iso(now + 600_000)}"}""", 200)
                request.path!!.endsWith("/claim") ->
                    json("""{"status":"approved","deviceId":"dev1","kind":"personal","expiresAt":"${iso(now + 86_400_000)}"}""", 200)
                request.path!!.endsWith("/pass") ->
                    json("""{"pass":"jwt","passExpiresAt":"${iso(now + 3_600_000)}","sceneId":"sc1"}""", 200)
                else -> {
                  seen += request
                  bodies += request.body.readUtf8()
                  answer
                }
              }
        }
    server.start()
    val ar = ArApi(server.url("/").toString())
    val auth = DeviceAuth(ar, FakeSecureStore(), { now }, pollMs = 1)
    runBlocking { auth.beginPairing() }
    return RoomScanApi(ar, auth)
  }

  private val layout = buildJsonObject {
    put("version", 1)
    put("rooms", JsonArray(emptyList()))
  }

  @Test
  fun `the upload POSTs the name and layout with the bearer pass`() {
    answer = json("""{"scan":{"id":"scan-1","name":"My room","createdAt":"2026-10-30T10:00:00.000Z"}}""", 201)
    val r = runBlocking { api().upload("sp1", "My room", layout) }
    assertEquals(BuilderCall.Ok(RoomScanUpload.Uploaded("scan-1", "My room")), r)
    val req = seen.single()
    assertEquals("POST", req.method)
    assertEquals("/api/ar/room-scans", req.path)
    assertEquals("Bearer jwt", req.getHeader("Authorization"))
    val body = Json.parseToJsonElement(bodies.single()).jsonObject
    assertEquals("My room", body["name"]!!.jsonPrimitive.content)
    assertEquals(1, body["layout"]!!.jsonObject["version"]!!.jsonPrimitive.int)
  }

  @Test
  fun `a 403 shared_device surfaces its message`() {
    answer =
        json("""{"error":"shared_device","message":"Room scans need a personal headset. This one is shared."}""", 403)
    val r = runBlocking { api().upload("sp1", "My room", layout) }
    assertEquals(BuilderCall.Ok(RoomScanUpload.Refused("Room scans need a personal headset. This one is shared.")), r)
  }

  @Test
  fun `a 403 shared_device without a message still says why`() {
    answer = json("""{"error":"shared_device"}""", 403)
    val r = runBlocking { api().upload("sp1", "My room", layout) }
    assertEquals(BuilderCall.Ok(RoomScanUpload.Refused(RoomScanCopy.SHARED_DEVICE)), r)
  }

  @Test
  fun `an empty or unreadable scan is refused with a line to show`() {
    val api = api()
    answer = json("""{"error":"empty_scan"}""", 400)
    assertEquals(BuilderCall.Ok(RoomScanUpload.Refused(RoomScanCopy.EMPTY_SCAN)), runBlocking { api.upload("sp1", "x", layout) })
    answer = json("""{"error":"invalid_layout","errors":["rooms[0].ceilingHeight must be between 1.8 and 8 m"]}""", 400)
    assertEquals(BuilderCall.Ok(RoomScanUpload.Refused(RoomScanCopy.INVALID_SCAN)), runBlocking { api.upload("sp1", "x", layout) })
  }

  @Test
  fun `a revoked headset is Revoked`() {
    answer = json("""{"error":"device_revoked"}""", 401)
    assertEquals(BuilderCall.Revoked, runBlocking { api().upload("sp1", "x", layout) })
  }
}
