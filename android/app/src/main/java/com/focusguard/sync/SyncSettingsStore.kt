package com.focusguard.sync

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.syncSettingsDataStore by preferencesDataStore(name = "focusguard_sync_settings")

data class SyncSettings(val baseUrl: String, val pairingCode: String?)

class SyncSettingsStore(private val context: Context) {
    val settings: Flow<SyncSettings> = context.applicationContext.syncSettingsDataStore.data.map { prefs ->
        SyncSettings(prefs[BASE_URL].orEmpty(), prefs[PAIRING_CODE])
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

    private companion object {
        val BASE_URL = stringPreferencesKey("base_url")
        val PAIRING_CODE = stringPreferencesKey("pairing_code")
    }
}
