package com.focusguard.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.view.accessibility.AccessibilityManager
import android.accessibilityservice.AccessibilityServiceInfo
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.focusguard.enforcement.PolicyAccessibilityService
import com.focusguard.data.PolicyStore
import com.focusguard.data.SyncCommandEntity
import com.focusguard.data.UsageDatabase
import com.focusguard.usage.UsageRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class CommandSyncUpdate(
    val commandId: String,
    val kind: String,
    val status: String,
    val detail: String? = null,
)

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

    suspend fun register(pairingCode: String, baseUrl: String): DeviceRegistration = withContext(Dispatchers.IO) {
        syncMutex.withLock {
            settings.setBaseUrl(baseUrl)
            settings.setPairingCode(pairingCode)
            val configured = settings.settings.first()
            val deviceId = identity.getOrCreateDeviceId()
            val registration = SyncApiClient(configured.baseUrl).register(pairingCode, deviceId, "0.1.0")
            // Pairing creates the server-side device identity; persist both returned values.
            identity.setDeviceId(registration.deviceId)
            identity.setDeviceToken(registration.deviceToken)
            settings.setPairingCode(null)
            registration
        }
    }

    /** Serializes button, worker, and accessibility-service syncs in this process. */
    suspend fun sync(
        usageAccess: Boolean = usage.hasUsageAccess(),
        accessibilityEnabled: Boolean = false,
        onCommandStatus: ((CommandSyncUpdate) -> Unit)? = null,
    ): SyncState = withContext(Dispatchers.IO) {
            if (!syncMutex.tryLock()) return@withContext SyncState.Syncing
            try {
                syncInternal(usageAccess, accessibilityEnabled, onCommandStatus)
            } finally {
                syncMutex.unlock()
            }
        }

    private suspend fun syncInternal(
        usageAccess: Boolean,
        accessibilityEnabled: Boolean,
        onCommandStatus: ((CommandSyncUpdate) -> Unit)?,
    ): SyncState {
        val configured = settings.settings.first()
        if (configured.baseUrl.isBlank()) return recordAndReturn(SyncState.NotConfigured)
        val credentials = identity.credentials.first()
        if (credentials.deviceToken.isNullOrBlank()) return recordAndReturn(SyncState.Unpaired)
        if (!isOnline()) return recordAndReturn(SyncState.Offline)
        return try {
            val client = SyncApiClient(configured.baseUrl)
            val deviceId = identity.getOrCreateDeviceId()
            client.heartbeat(deviceId, credentials.deviceToken, usageAccess, accessibilityEnabled)
            if (usageAccess) {
                usage.refreshHistory()
                val daily = database.usageDao().latestDaily()
                if (daily.isNotEmpty()) {
                    val batchId = "usage-${daily.first().localDate}-${daily.last().localDate}-${daily.maxOf { it.updatedAtMillis }}"
                    runCatching { client.uploadUsage(deviceId, credentials.deviceToken, daily, batchId) }
                        .onFailure { error ->
                            // Usage expansion/validation errors must remain visible but must not
                            // prevent policy fetch or remote command delivery/ACK.
                            settings.recordSync(System.currentTimeMillis(), error.message ?: "usage upload failed")
                        }
                }
            }
            client.fetchPolicy(deviceId, credentials.deviceToken, policyStore.version())?.let { remote ->
                if (policyStore.saveRemote(remote.config, remote.version)) {
                    PolicyAccessibilityService.requestForegroundReevaluation()
                }
            }
            processCommands(client, deviceId, credentials.deviceToken, onCommandStatus)
            recordAndReturn(
                if (!usageAccess || !accessibilityEnabled) {
                    SyncState.PermissionRequired(usageAccess, accessibilityEnabled)
                } else {
                    SyncState.Synced
                },
            )
        } catch (error: SyncApiException.Network) {
            recordAndReturn(SyncState.NetworkError(error.message ?: "network unavailable"))
        } catch (error: SyncApiException.Unauthorized) {
            policyStore.clearPairingState()
            identity.clearDeviceRegistration()
            PolicyAccessibilityService.requestForegroundReevaluation()
            recordAndReturn(SyncState.Unpaired)
        } catch (error: SyncApiException.Permission) {
            recordAndReturn(SyncState.PermissionRequired(usageAccess, accessibilityEnabled))
        } catch (error: SyncApiException) {
            recordAndReturn(SyncState.ServerError(error.message ?: "sync failed"))
        }
    }

    private suspend fun recordAndReturn(state: SyncState): SyncState {
        val error = when (state) {
            is SyncState.NetworkError -> state.message
            is SyncState.ServerError -> state.message
            SyncState.Offline -> "device offline"
            else -> null
        }
        settings.recordSync(System.currentTimeMillis(), error)
        return state
    }

    private suspend fun processCommands(
        client: SyncApiClient,
        deviceId: String,
        token: String,
        onCommandStatus: ((CommandSyncUpdate) -> Unit)?,
    ): String? {
        var cursor: String? = null
        var firstAckError: String? = null
        repeat(MAX_COMMAND_PAGES) {
            val page = client.pollCommands(deviceId, token, cursor)
            page.commands.forEach { command ->
                val now = System.currentTimeMillis()
                val existing = database.syncCommandDao().get(command.id)
                if (existing?.acknowledgedAtMillis != null) return@forEach

                // A command already applied locally only needs its final ACK retried; do not repeat side effects.
                if (existing != null && existing.status !in setOf(STATUS_PENDING, STATUS_DELIVERED)) {
                    val error = ackError(client, deviceId, token, command.id, existing.status, existing.detail)
                    val detail = appendDetail(existing.detail, error?.let { "ACK 失败：$it" })
                    database.syncCommandDao().mark(command.id, existing.status, error?.let { null } ?: now, detail)
                    onCommandStatus?.invoke(CommandSyncUpdate(command.id, command.type, existing.status, detail))
                    if (error != null && firstAckError == null) firstAckError = error
                    return@forEach
                }

                if (existing == null) {
                    database.syncCommandDao().insert(
                        SyncCommandEntity(command.id, command.type, STATUS_DELIVERED, now, command.expiresAtMillis, null, null),
                    )
                }

                // A delivery ACK is separate from the final execution ACK on the server.
                onCommandStatus?.invoke(CommandSyncUpdate(command.id, command.type, STATUS_DELIVERED))
                val deliveryError = ackError(client, deviceId, token, command.id, STATUS_DELIVERED, null)
                var detail = appendDetail(existing?.detail, deliveryError?.let { "送达 ACK 失败：$it" })
                if (deliveryError != null && firstAckError == null) firstAckError = deliveryError

                val expired = command.expiresAtMillis?.let { it <= now } == true
                val outcome = if (expired) STATUS_EXPIRED else runCatching { applyCommand(command) }
                    .getOrElse {
                        detail = appendDetail(detail, "执行失败：${it.message ?: it.javaClass.simpleName}")
                        STATUS_REJECTED
                    }
                if (expired) detail = appendDetail(detail, "命令已过期")
                database.syncCommandDao().mark(command.id, outcome, null, detail)

                val executionError = ackError(client, deviceId, token, command.id, outcome, detail)
                detail = appendDetail(detail, executionError?.let { "ACK 失败：$it" })
                if (executionError != null && firstAckError == null) firstAckError = executionError
                database.syncCommandDao().mark(
                    command.id,
                    outcome,
                    executionError?.let { null } ?: System.currentTimeMillis(),
                    detail,
                )
                onCommandStatus?.invoke(CommandSyncUpdate(command.id, command.type, outcome, detail))
            }
            cursor = page.nextCursor
            if (cursor == null || page.commands.isEmpty()) return firstAckError
        }
        return firstAckError
    }

    private fun appendDetail(current: String?, addition: String?): String? = when {
        addition.isNullOrBlank() -> current
        current.isNullOrBlank() -> addition
        else -> "$current · $addition"
    }

    private fun ackError(
        client: SyncApiClient,
        deviceId: String,
        token: String,
        commandId: String,
        status: String,
        detail: String?,
    ): String? {
        return try {
            ack(client, deviceId, token, commandId, status, detail)
            null
        } catch (error: SyncApiException.Unauthorized) {
            throw error
        } catch (error: SyncApiException.Permission) {
            throw error
        } catch (error: SyncApiException) {
            error.message ?: error.javaClass.simpleName
        }
    }

    private suspend fun applyCommand(command: RemoteCommand): String {
        return when (command.type.lowercase()) {
        "refresh", "sync", "heartbeat" -> STATUS_APPLIED
        "lock", "stop", "force_stop" -> {
            policyStore.save(policyStore.load().copy(forceStopped = true))
            PolicyAccessibilityService.requestForegroundReevaluation()
            STATUS_APPLIED
        }
        "unlock", "resume", "restore" -> {
            policyStore.save(policyStore.load().copy(forceStopped = false))
            PolicyAccessibilityService.requestForegroundReevaluation()
            STATUS_APPLIED
        }
        "policy", "policy_update", "set_policy" -> {
            val version = command.payload.optLong("version", -1L)
            val config = command.payload.optJSONObject("config") ?: command.payload.optJSONObject("policy")
            if (version < 0L || config == null) return STATUS_REJECTED
            val decoded = runCatching { com.focusguard.data.PolicyCodec.decode(config.toString()) }.getOrNull()
                ?: return STATUS_REJECTED
            val saved = policyStore.saveRemote(decoded, version)
            if (saved) {
                PolicyAccessibilityService.requestForegroundReevaluation()
                STATUS_APPLIED
            } else {
                STATUS_REJECTED
            }
        }
        else -> STATUS_REJECTED
        }
    }

    private fun ack(client: SyncApiClient, deviceId: String, token: String, commandId: String, status: String, detail: String?) {
        val remoteStatus = when (status) {
            STATUS_APPLIED -> "executed"
            STATUS_REJECTED, STATUS_EXPIRED -> "failed"
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
        const val STATUS_DELIVERED = "delivered"
        const val STATUS_APPLIED = "applied"
        const val STATUS_EXPIRED = "expired"
        const val STATUS_REJECTED = "rejected"
        private const val MAX_COMMAND_PAGES = 3
        private val syncMutex = Mutex()
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
            SyncState.Syncing -> Result.success()
        }
    }
}
