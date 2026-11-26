package com.focusguard.sync

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.deviceIdentityDataStore by preferencesDataStore(name = "focusguard_device_identity")

data class DeviceCredentials(
    val deviceId: String,
    val deviceToken: String?,
    val userToken: String?,
)

/** Keystore-backed values keep device authentication separate from any user session token. */
class DeviceIdentityStore(private val context: Context) {
    private val appContext = context.applicationContext

    val credentials: Flow<DeviceCredentials> = appContext.deviceIdentityDataStore.data.map { prefs ->
        DeviceCredentials(
            deviceId = decrypt(prefs[DEVICE_ID]).orEmpty(),
            deviceToken = decrypt(prefs[DEVICE_TOKEN]),
            userToken = decrypt(prefs[USER_TOKEN]),
        )
    }

    suspend fun getOrCreateDeviceId(): String {
        val existing = credentials.first().deviceId
        if (existing.isNotBlank()) return existing
        val generated = UUID.randomUUID().toString()
        appContext.deviceIdentityDataStore.edit { it[DEVICE_ID] = encrypt(generated) }
        return generated
    }

    suspend fun setDeviceId(deviceId: String) {
        require(deviceId.isNotBlank()) { "device id must not be blank" }
        appContext.deviceIdentityDataStore.edit { prefs -> prefs[DEVICE_ID] = encrypt(deviceId) }
    }

    suspend fun setDeviceToken(token: String?) {
        appContext.deviceIdentityDataStore.edit { prefs ->
            if (token.isNullOrBlank()) prefs.remove(DEVICE_TOKEN) else prefs[DEVICE_TOKEN] = encrypt(token)
        }
    }

    suspend fun setUserToken(token: String?) {
        appContext.deviceIdentityDataStore.edit { prefs ->
            if (token.isNullOrBlank()) prefs.remove(USER_TOKEN) else prefs[USER_TOKEN] = encrypt(token)
        }
    }

    suspend fun clearDeviceRegistration() {
        appContext.deviceIdentityDataStore.edit { prefs ->
            prefs.remove(DEVICE_TOKEN)
            prefs.remove(DEVICE_ID)
        }
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        val output = ByteArray(cipher.iv.size + encrypted.size)
        cipher.iv.copyInto(output)
        encrypted.copyInto(output, cipher.iv.size)
        return Base64.getEncoder().encodeToString(output)
    }

    private fun decrypt(value: String?): String? = value?.let {
        runCatching {
            val bytes = Base64.getDecoder().decode(it)
            require(bytes.size > GCM_IV_BYTES)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(GCM_TAG_BITS, bytes.copyOfRange(0, GCM_IV_BYTES)))
            String(cipher.doFinal(bytes.copyOfRange(GCM_IV_BYTES, bytes.size)), StandardCharsets.UTF_8)
        }.getOrNull()
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        val DEVICE_ID = stringPreferencesKey("device_id")
        val DEVICE_TOKEN = stringPreferencesKey("device_token")
        val USER_TOKEN = stringPreferencesKey("user_token")
        const val KEY_ALIAS = "focusguard.device.identity"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_IV_BYTES = 12
        const val GCM_TAG_BITS = 128
        @Suppress("unused")
        val random = SecureRandom()
    }
}
