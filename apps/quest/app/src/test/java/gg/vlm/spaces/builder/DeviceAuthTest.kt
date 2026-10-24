package gg.vlm.spaces.builder

import gg.vlm.spaces.api.ArApi
import gg.vlm.spaces.api.DeviceCall
import gg.vlm.spaces.api.DeviceKind
import java.time.Instant
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FakeSecureStore : SecureStore {
  val map = HashMap<String, String>()

  override fun get(key: String) = map[key]

  override fun put(key: String, value: String?) {
    if (value == null) map.remove(key) else map[key] = value
  }
}

class DeviceAuthTest {
  private val server = MockWebServer()
  private val store = FakeSecureStore()
  private var now = 1_800_000_000_000L

  @After
  fun tearDown() {
    runCatching { server.shutdown() }
  }

  private fun auth(): DeviceAuth {
    server.start()
    return DeviceAuth(ArApi(server.url("/").toString()), store, { now }, pollMs = 1)
  }

  private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()

  private fun json(body: String, status: Int = 200) = MockResponse().setResponseCode(status).setBody(body)

  private fun start() = json("""{"code":"ABC123","approveUrl":"https://vlm.gg/pair/headset/ABC123","codeExpiresAt":"${iso(now + 600_000)}"}""")

  private val pending = json("""{"status":"pending"}""")

  private fun approved(kind: String = "personal") = json("""{"status":"approved","deviceId":"dev1","kind":"$kind","expiresAt":"${iso(now + 86_400_000)}"}""")

  private fun pass(leftMs: Long, token: String = "jwt") = json("""{"pass":"$token","passExpiresAt":"${iso(now + leftMs)}","sceneId":"sc1"}""")

  private fun pairedAuth(kind: String = "personal"): DeviceAuth {
    server.enqueue(start())
    server.enqueue(approved(kind))
    val a = auth()
    runBlocking { a.beginPairing() }
    server.takeRequest()
    server.takeRequest()
    return a
  }

  @Test
  fun `pairs and stores the device`() {
    server.enqueue(start())
    server.enqueue(pending)
    server.enqueue(pending)
    server.enqueue(approved())
    val a = auth()
    runBlocking { a.beginPairing() }
    assertEquals(AuthState.Paired("dev1", DeviceKind.PERSONAL), a.state.value)
    assertEquals("dev1", store.get(DeviceAuth.KEY_ID))
    val secret = store.get(DeviceAuth.KEY_SECRET)
    assertNotNull(secret)
    assertEquals(64, secret!!.length)
    assertEquals(4, server.requestCount)
  }

  @Test
  fun `refused or expired goes back to signed out`() {
    server.enqueue(start())
    server.enqueue(json("""{"status":"refused"}"""))
    val a = auth()
    runBlocking { a.beginPairing() }
    assertEquals(AuthState.SignedOut, a.state.value)
    assertNull(store.get(DeviceAuth.KEY_SECRET))

    server.enqueue(start())
    server.enqueue(json("""{"error":"not_found"}""", 404))
    runBlocking { a.beginPairing() }
    assertEquals(AuthState.SignedOut, a.state.value)
    assertTrue(store.map.isEmpty())
  }

  @Test
  fun `a code that outlives its time signs out`() {
    server.enqueue(start())
    val a = auth()
    now += 700_000
    runBlocking { a.beginPairing() }
    assertEquals(AuthState.SignedOut, a.state.value)
    assertTrue(store.map.isEmpty())
  }

  @Test
  fun `re-mints a pass before it expires`() {
    val a = pairedAuth()
    server.enqueue(pass(30_000, "old"))
    server.enqueue(pass(900_000, "new"))
    assertEquals(PassResult.Ok("old", "sc1"), runBlocking { a.passFor("sp1") })
    assertEquals(PassResult.Ok("new", "sc1"), runBlocking { a.passFor("sp1") })
    // The fresh one has plenty left: cached.
    assertEquals(PassResult.Ok("new", "sc1"), runBlocking { a.passFor("sp1") })
    assertEquals(2, server.requestCount - 2)
  }

  @Test
  fun `revoked clears everything`() {
    val a = pairedAuth()
    server.enqueue(json("""{"error":"device_revoked"}""", 401))
    assertEquals(PassResult.Revoked, runBlocking { a.passFor("sp1") })
    assertTrue(store.map.isEmpty())
    assertEquals(AuthState.SignedOut, a.state.value)
  }

  @Test
  fun `no access and offline are reported`() {
    val a = pairedAuth()
    server.enqueue(json("""{"error":"no_access"}""", 403))
    assertEquals(PassResult.NoAccess, runBlocking { a.passFor("sp1") })
    server.shutdown()
    assertEquals(PassResult.Offline, runBlocking { a.passFor("sp1") })
    assertTrue(a.state.value is AuthState.Paired)
  }

  @Test
  fun `a 401 Session expired during a save is retried once with a fresh pass`() {
    val a = pairedAuth()
    server.enqueue(pass(900_000, "p1"))
    server.enqueue(pass(900_000, "p2"))
    val seen = ArrayList<String>()
    val r =
        runBlocking {
          a.withPass("sp1") { token ->
            seen += token
            if (token == "p1") DeviceCall.Unauthorized else DeviceCall.Ok("saved")
          }
        }
    assertEquals(DeviceCall.Ok("saved"), r)
    assertEquals(listOf("p1", "p2"), seen)

    // Twice unauthorized: gives up after the one retry.
    server.enqueue(pass(900_000, "p3"))
    var calls = 0
    val r2 = runBlocking { a.withPass("sp1") { _: String -> calls++; DeviceCall.Unauthorized } }
    assertEquals(DeviceCall.Unauthorized, r2)
    assertEquals(2, calls)
  }

  @Test
  fun `withPass treats device_revoked as revoked and does not retry`() {
    val a = pairedAuth()
    server.enqueue(pass(900_000))
    var calls = 0
    val r = runBlocking { a.withPass("sp1") { _: String -> calls++; DeviceCall.Revoked } }
    assertEquals(DeviceCall.Revoked, r)
    assertEquals(1, calls)
    assertEquals(AuthState.SignedOut, a.state.value)
    assertTrue(store.map.isEmpty())
  }

  @Test
  fun `the secret never appears in the request log`() {
    server.enqueue(start())
    server.enqueue(approved())
    val a = auth()
    runBlocking { a.beginPairing() }
    val secret = store.get(DeviceAuth.KEY_SECRET)!!
    val startReq = server.takeRequest()
    assertEquals("/api/ar/pair", startReq.path)
    assertEquals("""{"secretHash":"${DeviceAuth.sha256Hex(secret)}"}""", startReq.body.readUtf8())
    assertFalse(startReq.headers.toString().contains(secret))
    // The claim carries it in the body only, never in the URL.
    val claimReq = server.takeRequest()
    assertFalse(claimReq.path!!.contains(secret))
  }

  @Test
  fun `shared end calls the server and clears, personal only drops passes`() {
    val shared = pairedAuth("shared")
    server.enqueue(MockResponse().setResponseCode(204))
    runBlocking { shared.endSession() }
    assertEquals("/api/ar/devices/dev1/end", server.takeRequest().path)
    assertTrue(store.map.isEmpty())
    assertEquals(AuthState.SignedOut, shared.state.value)
  }

  @Test
  fun `personal end keeps the pairing`() {
    val a = pairedAuth()
    val before = server.requestCount
    runBlocking { a.endSession() }
    assertEquals(before, server.requestCount)
    assertTrue(a.state.value is AuthState.Paired)
    assertEquals("dev1", store.get(DeviceAuth.KEY_ID))
  }

  @Test
  fun `a stored pairing is restored`() {
    store.put(DeviceAuth.KEY_ID, "dev9")
    store.put(DeviceAuth.KEY_SECRET, "s")
    store.put(DeviceAuth.KEY_KIND, "SHARED")
    assertEquals(AuthState.Paired("dev9", DeviceKind.SHARED), auth().state.value)
  }

  @Test
  fun `the pairing code is shown as XXX-XXX`() {
    assertEquals("ABC-123", formatPairingCode("abc123"))
    assertEquals("ABC-123", formatPairingCode("ABC-123"))
  }

  @Test
  fun `deviceSpaces parses the list and sends the secret`() {
    val a = pairedAuth()
    server.enqueue(json("""[{"spaceId":"sp1","spaceName":"Loft","sceneId":"sc1","sceneName":"Scene","markers":[{"markerId":"m1","floorId":"f1","code":"ABCD"}]}]"""))
    val (id, secret) = a.credentials()!!
    val r = runBlocking { ArApi(server.url("/").toString()).deviceSpaces(id, secret) }
    val spaces = (r as DeviceCall.Ok).value
    assertEquals("Loft", spaces[0].spaceName)
    assertEquals("ABCD", spaces[0].markers[0].code)
    val req = server.takeRequest()
    assertEquals("/api/ar/devices/dev1/spaces", req.path)
    assertEquals("""{"secret":"$secret"}""", req.body.readUtf8())
  }
}
