package com.focusguard.sync

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.view.accessibility.AccessibilityManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Optional user-enabled command poller. WorkManager remains the fallback when this
 * service is not running, while this path keeps remote commands near-real-time.
 */
class SyncForegroundService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var pollJob: Job? = null
    private var lastCommand: CommandSyncUpdate? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopPolling()
            return START_NOT_STICKY
        }

        startForeground(NOTIFICATION_ID, notification(SyncState.Syncing, null))
        if (pollJob?.isActive != true) {
            pollJob = serviceScope.launch {
                while (isActive) {
                    runSync()
                    delay(POLL_INTERVAL_MS)
                }
            }
        }
        return START_STICKY
    }

    private suspend fun runSync() {
        try {
            val state = SyncCoordinator(this).sync(
                accessibilityEnabled = isAccessibilityEnabled(),
                onCommandStatus = { update ->
                    lastCommand = update
                    updateNotification(SyncState.Syncing, update)
                },
            )
            updateNotification(state, lastCommand)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            updateNotification(SyncState.ServerError(error.message ?: "sync failed"), lastCommand)
        }
    }

    private fun isAccessibilityEnabled(): Boolean {
        val manager = getSystemService(AccessibilityManager::class.java) ?: return false
        return manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any {
                it.resolveInfo.serviceInfo.packageName == packageName &&
                    it.resolveInfo.serviceInfo.name == "com.focusguard.enforcement.PolicyAccessibilityService"
            }
    }

    private fun updateNotification(state: SyncState, command: CommandSyncUpdate?) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.notify(NOTIFICATION_ID, notification(state, command))
    }

    private fun notification(state: SyncState, command: CommandSyncUpdate?): Notification {
        val commandText = command?.let { " · ${it.kind}: ${it.status}" }.orEmpty()
        val message = when (state) {
            SyncState.NotConfigured -> "API 未配置"
            SyncState.Unpaired -> "设备尚未配对"
            SyncState.Offline -> "设备离线，等待网络"
            SyncState.Syncing -> "正在同步命令"
            SyncState.Synced -> "同步正常"
            is SyncState.PermissionRequired -> if (state.accessibility) {
                "同步正常；使用情况权限 ${if (state.usageAccess) "已开启" else "未开启"}"
            } else {
                "同步正常；未开启无障碍服务，远程锁定无法拦截前台应用"
            }
            is SyncState.NetworkError -> "网络错误：${state.message}"
            is SyncState.ServerError -> "服务器错误：${state.message}"
        } + commandText
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("FocusGuard 同步")
            .setContentText(message)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "FocusGuard 同步", NotificationManager.IMPORTANCE_LOW),
        )
    }

    private fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        pollJob?.cancel()
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "com.focusguard.sync.START"
        const val ACTION_STOP = "com.focusguard.sync.STOP"
        const val POLL_INTERVAL_MS = 10_000L
        private const val CHANNEL_ID = "focusguard_sync"
        private const val NOTIFICATION_ID = 4201

        fun start(context: Context) {
            val intent = Intent(context.applicationContext, SyncForegroundService::class.java).setAction(ACTION_START)
            ContextCompat.startForegroundService(context.applicationContext, intent)
        }

        fun stop(context: Context) {
            context.applicationContext.startService(
                Intent(context.applicationContext, SyncForegroundService::class.java).setAction(ACTION_STOP),
            )
        }
    }
}
