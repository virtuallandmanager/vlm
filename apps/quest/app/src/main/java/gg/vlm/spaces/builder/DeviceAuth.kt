package gg.vlm.spaces.builder

import gg.vlm.spaces.api.ArApi
import gg.vlm.spaces.api.DeviceCall
import gg.vlm.spaces.api.DeviceKind
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
  data class Pairing(val code: String, val approveUrl: String, val expiresAtMs: Long) : AuthState
  data class Paired(val deviceId: String, val kind: DeviceKind) : AuthState
}

sealed interface PassResult {
  data class Ok(val token: String, val sceneId: String) : PassResult
  data object NoAccess : PassResult
  /** The headset was unpaired on the website: the store is cleared and the state is [AuthState.SignedOut]. */
  data object Revoked : PassResult
  data object Offline : PassResult
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
    val secret = newSecret()
    store.put(KEY_SECRET, secret)
    try {
      val start =
          when (val r = api.startPairing(sha256Hex(secret), deviceName)) {
            is DeviceCall.Ok -> r.value
            else -> return signOut()
          }
      _state.value = AuthState.Pairing(start.code, start.approveUrl, start.codeExpiresAtMs)
      while (clock() < start.codeExpiresAtMs) {
        delay(pollMs)
        when (val r = api.claim(start.code, secret)) {
          is DeviceCall.Ok ->
              when (val c = r.value) {
                PairClaim.Pending -> Unit
                PairClaim.Refused -> return signOut()
                is PairClaim.Approved -> {
                  store.put(KEY_ID, c.deviceId)
                  store.put(KEY_KIND, c.kind.name)
                  _state.value = AuthState.Paired(c.deviceId, c.kind)
                  return
                }
              }
          // Offline, rate limited or a server hiccup: keep trying until the code runs out.
          DeviceCall.Offline, DeviceCall.RateLimited, is DeviceCall.Failed -> Unit
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
    val cached = passes[spaceId]
    if (cached != null && cached.expiresAtMs - clock() > MIN_LEFT_MS) return PassResult.Ok(cached.pass, cached.sceneId)
    val id = store.get(KEY_ID)
    val secret = store.get(KEY_SECRET)
    if (id == null || secret == null) return PassResult.Revoked
    return when (val r = api.mintPass(id, secret, spaceId)) {
      is DeviceCall.Ok -> {
        passes[spaceId] = r.value
        PassResult.Ok(r.value.pass, r.value.sceneId)
      }
      DeviceCall.NoAccess, DeviceCall.NotFound -> PassResult.NoAccess
      DeviceCall.Revoked, DeviceCall.BadSecret -> {
        signOut()
        PassResult.Revoked
      }
      else -> PassResult.Offline
    }
  }

  /**
   * Runs [block] with a pass for [spaceId]. If it answers [DeviceCall.Unauthorized] (the pass expired mid-call) the
   * cached pass is dropped and [block] runs once more with a fresh one. A revoked device ends as [DeviceCall.Revoked].
   */
  suspend fun <T> withPass(spaceId: String, block: suspend (token: String) -> DeviceCall<T>): DeviceCall<T> {
    for (attempt in 1..2) {
      val pass =
          when (val p = passFor(spaceId)) {
            is PassResult.Ok -> p
            PassResult.NoAccess -> return DeviceCall.NoAccess
            PassResult.Revoked -> return DeviceCall.Revoked
            PassResult.Offline -> return DeviceCall.Offline
          }
      val r = block(pass.token)
      if (r is DeviceCall.Revoked) {
        signOut()
        return r
      }
      if (r !is DeviceCall.Unauthorized || attempt == 2) return r
      mintLock.withLock { passes.remove(spaceId) }
    }
    return DeviceCall.Unauthorized
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

  /** The secret for headset-secret calls (the spaces list); null when signed out. */
  fun credentials(): Pair<String, String>? {
    val id = store.get(KEY_ID) ?: return null
    val secret = store.get(KEY_SECRET) ?: return null
    return id to secret
  }

  private fun signOut() {
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
