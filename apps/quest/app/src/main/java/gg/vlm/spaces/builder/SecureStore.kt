package gg.vlm.spaces.builder

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Small private key/value storage for the device id and secret. A null value removes the key. */
interface SecureStore {
  fun get(key: String): String?
  fun put(key: String, value: String?)
}

/** [SecureStore] on [EncryptedSharedPreferences]: values are encrypted with a key held in the Android Keystore. */
class EncryptedSecureStore(context: Context) : SecureStore {
  private val prefs =
      EncryptedSharedPreferences.create(
          context,
          FILE,
          MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
          EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
          EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
      )

  override fun get(key: String): String? = prefs.getString(key, null)

  override fun put(key: String, value: String?) {
    val edit = prefs.edit()
    // A removal is a sign-out: it must be on disk before we return, so commit() rather than apply().
    if (value == null) edit.remove(key).commit() else edit.putString(key, value).apply()
  }

  private companion object {
    const val FILE = "vlm_device_auth"
  }
}
