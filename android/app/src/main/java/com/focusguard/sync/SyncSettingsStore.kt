package com.focusguard.sync

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.syncSettingsDataStore by preferencesDataStore(name = "focusguard_sync_settings")

data class SyncSettings(
    val baseUrl: String,
    val pairingCode: String?,
    val lastSyncAtMillis: Long?,
    val lastSyncError: String?,
    val foregroundSyncEnabled: Boolean,
)

class SyncSettingsStore(private val context: Context) {
    val settings: Flow<SyncSettings> = context.applicationContext.syncSettingsDataStore.data.map { prefs ->
        SyncSettings(
            baseUrl = prefs[BASE_URL].orEmpty(),
            pairingCode = prefs[PAIRING_CODE],
            lastSyncAtMillis = prefs[LAST_SYNC_AT_MILLIS],
            lastSyncError = prefs[LAST_SYNC_ERROR],
             foregroundSyncEnabled = prefs[FOREGROUND_SYNC_ENABLED] ?: false,
        )
    }

    suspend fun setBaseUrl(value: String) {
        context.applicationContext.syncSettingsDataStore.edit { prefs ->
            val normalized = value.trim().trimEnd('/')
            if (normalized.isBlank()) prefs.remove(BASE_URL) else prefs[BASE_URL] = normalized
        }
    }

    suspend fun setPairingCode(value: String?) {
        context.applicationContext.syncSettingsDataStore.edit { prefs ->
            if (value.isNullOrBlank()) prefs.remove(PAIRING_CODE) else prefs[PAIRING_CODE] = value.trim()
        }
    }

    suspend fun setForegroundSyncEnabled(value: Boolean) {
        context.applicationContext.syncSettingsDataStore.edit { prefs -> prefs[FOREGROUND_SYNC_ENABLED] = value }
    }

    suspend fun recordSync(atMillis: Long, error: String?) {
        context.applicationContext.syncSettingsDataStore.edit { prefs ->
            prefs[LAST_SYNC_AT_MILLIS] = atMillis
            if (error.isNullOrBlank()) prefs.remove(LAST_SYNC_ERROR) else prefs[LAST_SYNC_ERROR] = error.take(MAX_ERROR_LENGTH)
        }
    }

    private companion object {
        val BASE_URL = stringPreferencesKey("base_url")
        val PAIRING_CODE = stringPreferencesKey("pairing_code")
        val LAST_SYNC_AT_MILLIS = longPreferencesKey("last_sync_at_millis")
        val LAST_SYNC_ERROR = stringPreferencesKey("last_sync_error")
        val FOREGROUND_SYNC_ENABLED = booleanPreferencesKey("foreground_sync_enabled")
        const val MAX_ERROR_LENGTH = 500
    }
}
