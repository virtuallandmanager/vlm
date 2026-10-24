package gg.vlm.spaces.builder

import gg.vlm.spaces.api.ArApi
import gg.vlm.spaces.api.BuilderCall
import gg.vlm.spaces.api.DeviceKind
import gg.vlm.spaces.api.DeviceSpace
import gg.vlm.spaces.api.MintedPass
import gg.vlm.spaces.api.PairClaim
import java.security.MessageDigest
import java.security.SecureRandom
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

sealed interface AuthState {
  data object SignedOut : AuthState
  data class Pairing(val code: String, val approveUrl: String, val expiresAtMs: Long) : AuthState {
    /** The code is a credential: it is not printed. */
    override fun toString() = "Pairing(expiresAtMs=$expiresAtMs)"
  }
  data class Paired(val deviceId: String, val kind: DeviceKind) : AuthState
}

sealed interface PassResult {
  data class Ok(val token: String, val sceneId: String) : PassResult {
    override fun toString() = "Ok(sceneId=$sceneId)"
  }
  data object NoAccess : PassResult
  /** The headset was unpaired on the website: the store is cleared and the state is [AuthState.SignedOut]. */
  data object Revoked : PassResult
  data object Offline : PassResult
  /** The server answered something unexpected (including a 401 that isn't a revocation). */
  data class Failed(val status: Int) : PassResult
}

/**
 * The headset's identity: pairs it with a VLM account, keeps the device id and secret in [store], and mints (and
 * caches) AR passes. The secret and passes are never logged, and only the secret's SHA-256 goes out when pairing.
 */
class DeviceAuth(
    private val api: ArApi,
    private val store: SecureStore,
    private val clock: () -> Long,
    private val pollMs: Long = POLL_MS,
    private val deviceName: String? = null,
) {
  private val _state = MutableStateFlow<AuthState>(restored())
  val state: StateFlow<AuthState> = _state.asStateFlow()

  private val passes = java.util.concurrent.ConcurrentHashMap<String, MintedPass>()
  private val mintLock = Mutex()

  /** Bumped by every sign-out, so a mint that was in flight across one can tell and discards its pass. */
  @Volatile private var epoch = 0

  private fun restored(): AuthState {
    val id = store.get(KEY_ID)
    val kind = store.get(KEY_KIND)?.let { k -> DeviceKind.entries.firstOrNull { it.name == k } }
    return if (id != null && kind != null && store.get(KEY_SECRET) != null) AuthState.Paired(id, kind) else AuthState.SignedOut
  }

  /**
   * Makes a secret, starts a pairing and polls until the approver answers, the code expires (10 minutes) or the caller
   * cancels. Ends in [AuthState.Paired] or [AuthState.SignedOut].
   */
  suspend fun beginPairing() {
    // Pairing again is an explicit re-pair: forget the old pairing first.
    if (_state.value is AuthState.Paired) signOut()
    val secret = newSecret()
    try {
      val start =
          when (val r = api.startPairing(sha256Hex(secret), deviceName)) {
            is BuilderCall.Ok -> r.value
            else -> return signOut()
          }
      _state.value = AuthState.Pairing(start.code, start.approveUrl, start.codeExpiresAtMs)
      while (clock() < start.codeExpiresAtMs) {
        delay(pollMs)
        when (val r = api.claim(start.code, secret)) {
          is BuilderCall.Ok ->
              when (val c = r.value) {
                PairClaim.Pending -> Unit
                PairClaim.Refused -> return signOut()
                is PairClaim.Approved -> {
                  store.put(KEY_SECRET, secret)
                  store.put(KEY_ID, c.deviceId)
                  store.put(KEY_KIND, c.kind.name)
                  _state.value = AuthState.Paired(c.deviceId, c.kind)
                  return
                }
              }
          // Offline, rate limited or a server hiccup: keep trying until the code runs out.
          BuilderCall.Offline, BuilderCall.RateLimited, is BuilderCall.Failed -> Unit
          else -> return signOut()
        }
      }
      signOut()
    } finally {
      // Cancelled (or failed) while pairing: don't leave a half-made secret behind.
      if (_state.value !is AuthState.Paired) signOut()
    }
  }

  /** A pass for [spaceId]: the cached one while it has more than 60 s left, else a freshly minted one. */
  suspend fun passFor(spaceId: String): PassResult = mintLock.withLock { passLocked(spaceId) }

  private suspend fun passLocked(spaceId: String): PassResult {
    val id = store.get(KEY_ID)
    val secret = store.get(KEY_SECRET)
    if (id == null || secret == null) return PassResult.Revoked
    val cached = passes[spaceId]
    if (cached != null && cached.expiresAtMs - clock() > MIN_LEFT_MS) return PassResult.Ok(cached.pass, cached.sceneId)
    val startEpoch = epoch
    val r = api.mintPass(id, secret, spaceId)
    // Signed out (or re-paired) while the mint was in flight: its pass belongs to nobody now.
    if (epoch != startEpoch || store.get(KEY_ID) != id) return PassResult.Revoked
    return when (r) {
      is BuilderCall.Ok -> {
        passes[spaceId] = r.value
        PassResult.Ok(r.value.pass, r.value.sceneId)
      }
      BuilderCall.NoAccess, BuilderCall.NotFound -> PassResult.NoAccess
      BuilderCall.Revoked, BuilderCall.BadSecret -> {
        signOut()
        PassResult.Revoked
      }
      BuilderCall.Offline -> PassResult.Offline
      BuilderCall.RateLimited -> PassResult.Failed(429)
      BuilderCall.Unauthorized -> PassResult.Failed(401)
      is BuilderCall.Failed -> PassResult.Failed(r.status)
    }
  }

  /**
   * Runs [block] with a pass for [spaceId]. If it answers [BuilderCall.Unauthorized] (the pass expired mid-call) the
   * cached pass is dropped and [block] runs once more with a fresh one. A revoked device ends as [BuilderCall.Revoked].
   */
  suspend fun <T> withPass(spaceId: String, block: suspend (token: String) -> BuilderCall<T>): BuilderCall<T> {
    for (attempt in 1..2) {
      val pass =
          when (val p = passFor(spaceId)) {
            is PassResult.Ok -> p
            PassResult.NoAccess -> return BuilderCall.NoAccess
            PassResult.Revoked -> return BuilderCall.Revoked
            PassResult.Offline -> return BuilderCall.Offline
            is PassResult.Failed -> return BuilderCall.Failed(p.status)
          }
      val r = block(pass.token)
      if (r is BuilderCall.Revoked) {
        signOut()
        return r
      }
      if (r !is BuilderCall.Unauthorized || attempt == 2) return r
      mintLock.withLock { passes.remove(spaceId) }
    }
    return BuilderCall.Unauthorized
  }

  /** Shared headset: ends the session on the server and forgets the pairing. Personal: only drops the cached passes. */
  suspend fun endSession() {
    val s = _state.value as? AuthState.Paired ?: return
    if (s.kind == DeviceKind.PERSONAL) {
      mintLock.withLock { passes.clear() }
      return
    }
    val secret = store.get(KEY_SECRET)
    if (secret != null) api.endSession(s.deviceId, secret)
    // Even when the server can't be reached, a shared headset must not stay signed in.
    signOut()
  }

  /** The spaces the approver can build on. A revoked device is signed out here like everywhere else. */
  suspend fun spaces(): BuilderCall<List<DeviceSpace>> {
    val id = store.get(KEY_ID)
    val secret = store.get(KEY_SECRET)
    if (id == null || secret == null) return BuilderCall.Revoked
    val r = api.deviceSpaces(id, secret)
    if (r is BuilderCall.Revoked || r is BuilderCall.BadSecret) {
      if (store.get(KEY_ID) == id) signOut()
      return BuilderCall.Revoked
    }
    return r
  }

  private fun signOut() {
    epoch++
    store.put(KEY_ID, null)
    store.put(KEY_KIND, null)
    store.put(KEY_SECRET, null)
    passes.clear()
    _state.value = AuthState.SignedOut
  }

  private fun newSecret(): String {
    val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
    return hex(bytes)
  }

  companion object {
    const val POLL_MS = 2_000L
    const val MIN_LEFT_MS = 60_000L
    const val KEY_ID = "device_id"
    const val KEY_SECRET = "device_secret"
    const val KEY_KIND = "device_kind"

    /** Hex SHA-256 of the UTF-8 [s]: how the server hashes a secret. */
    fun sha256Hex(s: String): String = hex(MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)))

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
  }
}
