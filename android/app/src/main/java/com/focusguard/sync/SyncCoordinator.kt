package com.focusguard.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.view.accessibility.AccessibilityManager
import android.accessibilityservice.AccessibilityServiceInfo
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.focusguard.data.PolicyStore
import com.focusguard.data.SyncCommandEntity
import com.focusguard.data.UsageDatabase
import com.focusguard.usage.UsageRepository
import kotlinx.coroutines.flow.first

sealed interface SyncState {
    data object NotConfigured : SyncState
    data object Unpaired : SyncState
    data object Offline : SyncState
    data class PermissionRequired(val usageAccess: Boolean, val accessibility: Boolean) : SyncState
    data object Syncing : SyncState
    data object Synced : SyncState
    data class NetworkError(val message: String) : SyncState
    data class ServerError(val message: String) : SyncState
}

class SyncCoordinator(context: Context) {
    private val appContext = context.applicationContext
    private val database = UsageDatabase.get(appContext)
    private val usage = UsageRepository(appContext)
    private val identity = DeviceIdentityStore(appContext)
    private val settings = SyncSettingsStore(appContext)
    private val policyStore = PolicyStore(database.policyDao())

    suspend fun register(pairingCode: String, baseUrl: String): DeviceRegistration {
        settings.setBaseUrl(baseUrl)
        settings.setPairingCode(pairingCode)
        val configured = settings.settings.first()
        val deviceId = identity.getOrCreateDeviceId()
        val registration = SyncApiClient(configured.baseUrl).register(pairingCode, deviceId, "0.1.0")
        // Pairing creates the server-side device identity; persist both returned values.
        identity.setDeviceId(registration.deviceId)
        identity.setDeviceToken(registration.deviceToken)
        settings.setPairingCode(null)
        return registration
    }

    suspend fun sync(usageAccess: Boolean = usage.hasUsageAccess(), accessibilityEnabled: Boolean = false): SyncState {
        val configured = settings.settings.first()
        if (configured.baseUrl.isBlank()) return SyncState.NotConfigured
        val credentials = identity.credentials.first()
        if (credentials.deviceToken.isNullOrBlank()) return SyncState.Unpaired
        if (!isOnline()) return SyncState.Offline
        return try {
            val client = SyncApiClient(configured.baseUrl)
            val deviceId = identity.getOrCreateDeviceId()
            client.heartbeat(deviceId, credentials.deviceToken, usageAccess, accessibilityEnabled)
            if (usageAccess) {
                usage.refreshHistory()
                val daily = database.usageDao().latestDaily()
                if (daily.isNotEmpty()) {
                    val batchId = "usage-${daily.first().localDate}-${daily.last().localDate}-${daily.maxOf { it.updatedAtMillis }}"
                    client.uploadUsage(deviceId, credentials.deviceToken, daily, batchId)
                }
            }
            client.fetchPolicy(deviceId, credentials.deviceToken, policyStore.version())?.let { remote ->
                policyStore.saveRemote(remote.config, remote.version)
            }
            processCommands(client, deviceId, credentials.deviceToken)
            if (!usageAccess || !accessibilityEnabled) SyncState.PermissionRequired(usageAccess, accessibilityEnabled) else SyncState.Synced
        } catch (error: SyncApiException.Network) {
            SyncState.NetworkError(error.message ?: "network unavailable")
        } catch (error: SyncApiException.Unauthorized) {
            identity.clearDeviceRegistration()
            SyncState.ServerError(error.message ?: "device authentication rejected")
        } catch (error: SyncApiException.Permission) {
            SyncState.PermissionRequired(usageAccess, accessibilityEnabled)
        } catch (error: SyncApiException) {
            SyncState.ServerError(error.message ?: "sync failed")
        }
    }

    private suspend fun processCommands(client: SyncApiClient, deviceId: String, token: String) {
        var cursor: String? = null
        repeat(MAX_COMMAND_PAGES) {
            val page = client.pollCommands(deviceId, token, cursor)
            page.commands.forEach { command ->
                val now = System.currentTimeMillis()
                val existing = database.syncCommandDao().get(command.id)
                if (existing != null) {
                    if (existing.acknowledgedAtMillis == null) {
                        ack(client, deviceId, token, command.id, existing.status, existing.detail)
                        database.syncCommandDao().mark(command.id, existing.status, now, existing.detail)
                    }
                    return@forEach
                }
                database.syncCommandDao().insert(
                    SyncCommandEntity(command.id, command.type, STATUS_PENDING, now, command.expiresAtMillis, null, null),
                )
                val expired = command.expiresAtMillis?.let { it <= now } == true
                val outcome = if (expired) STATUS_EXPIRED else applyCommand(command)
                val detail = if (expired) "command expired" else null
                database.syncCommandDao().mark(command.id, outcome, null, detail)
                ack(client, deviceId, token, command.id, outcome, detail)
                database.syncCommandDao().mark(command.id, outcome, now, detail)
            }
            cursor = page.nextCursor
            if (cursor == null || page.commands.isEmpty()) return
        }
    }

    private suspend fun applyCommand(command: RemoteCommand): String {
        return when (command.type.lowercase()) {
        "refresh", "sync", "heartbeat" -> STATUS_APPLIED
        "lock", "stop", "force_stop" -> {
            policyStore.save(policyStore.load().copy(forceStopped = true))
            STATUS_APPLIED
        }
        "unlock", "resume", "restore" -> {
            policyStore.save(policyStore.load().copy(forceStopped = false))
            STATUS_APPLIED
        }
        "policy", "policy_update", "set_policy" -> {
            val version = command.payload.optLong("version", -1L)
            val config = command.payload.optJSONObject("config") ?: command.payload.optJSONObject("policy")
            if (version < 0L || config == null) return STATUS_REJECTED
            val saved = runCatching { policyStore.saveRemote(com.focusguard.data.PolicyCodec.decode(config.toString()), version) }.getOrDefault(false)
            if (saved) STATUS_APPLIED else STATUS_REJECTED
        }
        else -> STATUS_REJECTED
        }
    }

    private fun ack(client: SyncApiClient, deviceId: String, token: String, commandId: String, status: String, detail: String?) {
        val remoteStatus = when (status) {
            STATUS_APPLIED -> "executed"
            STATUS_REJECTED -> "failed"
            STATUS_EXPIRED -> "failed"
            else -> "delivered"
        }
        client.ackCommand(deviceId, token, commandId, remoteStatus, detail)
    }

    private fun isOnline(): Boolean {
        val manager = appContext.getSystemService(ConnectivityManager::class.java) ?: return false
        val network = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    companion object {
        const val STATUS_PENDING = "pending"
        const val STATUS_APPLIED = "applied"
        const val STATUS_EXPIRED = "expired"
        const val STATUS_REJECTED = "rejected"
        private const val MAX_COMMAND_PAGES = 3
    }
}

class FocusGuardSyncWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        val accessibility = applicationContext.getSystemService(AccessibilityManager::class.java)
        val accessibilityEnabled = accessibility?.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            ?.any { it.resolveInfo.serviceInfo.packageName == applicationContext.packageName && it.resolveInfo.serviceInfo.name == "com.focusguard.enforcement.PolicyAccessibilityService" }
            ?: false
        val state = SyncCoordinator(applicationContext).sync(accessibilityEnabled = accessibilityEnabled)
        return when (state) {
            SyncState.Synced -> Result.success()
            SyncState.Offline, is SyncState.NetworkError -> Result.retry()
            SyncState.NotConfigured, SyncState.Unpaired, is SyncState.PermissionRequired, is SyncState.ServerError -> Result.success()
            SyncState.Syncing -> Result.retry()
        }
    }
}
