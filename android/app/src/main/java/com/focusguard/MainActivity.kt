package com.focusguard

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.os.Bundle
import android.os.Build
import android.content.pm.PackageManager
import androidx.activity.result.contract.ActivityResultContracts
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.focusguard.core.PolicyConfig
import com.focusguard.core.UsageLimitRule
import com.focusguard.core.UsagePeriod
import com.focusguard.core.UsageTarget
import com.focusguard.enforcement.PolicyAccessibilityService
import com.focusguard.data.SyncCommandEntity
import com.focusguard.data.UsageDailyEntity
import com.focusguard.sync.DeviceIdentityStore
import com.focusguard.sync.SyncCoordinator
import com.focusguard.sync.SyncScheduler
import com.focusguard.sync.SyncState
import com.focusguard.sync.SyncSettingsStore
import com.focusguard.ui.DashboardScreen
import com.focusguard.ui.FocusGuardTheme
import com.focusguard.ui.PermissionOnboarding
import com.focusguard.usage.UsageRepository
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private val repository by lazy { UsageRepository(this) }
    private val syncSettings by lazy { SyncSettingsStore(this) }
    private val identity by lazy { DeviceIdentityStore(this) }

    private val onboarding by lazy { getSharedPreferences("permission_onboarding", MODE_PRIVATE) }
    private var notificationsGranted by mutableStateOf<Boolean?>(null)
    private val notificationRequest = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        updateNotificationGrant()
    }

    private fun updateNotificationGrant() {
        notificationsGranted = if (Build.VERSION.SDK_INT >= 33)
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        else null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncScheduler.schedule(this)
        updateNotificationGrant()
        setContent {
            FocusGuardTheme {
                var showPermissionOnboarding by remember { mutableStateOf(!onboarding.getBoolean("finished", false)) }
                var hasPermission by remember { mutableStateOf(repository.hasUsageAccess()) }
                var loading by remember { mutableStateOf(false) }
                var savingPolicy by remember { mutableStateOf(false) }
                var savingAppPackage by remember { mutableStateOf<String?>(null) }
                var message by remember { mutableStateOf<String?>(null) }
                var apps by remember { mutableStateOf(emptyList<Pair<String, String>>()) }
                var dailyRows by remember { mutableStateOf(emptyList<UsageDailyEntity>()) }
                var policy by remember { mutableStateOf(PolicyConfig()) }
                var pendingLock by remember { mutableStateOf<Boolean?>(null) }
                val serviceConnected by PolicyAccessibilityService.connection.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    repository.observePolicy().collectLatest { policy = repository.loadPolicy() }
                }
                var dailyLimitMinutes by remember { mutableStateOf("") }
                val appLimitInputs = remember { mutableStateMapOf<String, String>() }
                val devicePeriodInputs = remember {
                    mutableStateMapOf(UsagePeriod.WEEK to "", UsagePeriod.MONTH to "")
                }
                var refreshKey by remember { mutableStateOf(0) }
                var accessibilityEnabled by remember { mutableStateOf(isPolicyServiceEnabled()) }
                var syncBaseUrl by remember { mutableStateOf("") }
                var pairingCode by remember { mutableStateOf("") }
                var syncBusy by remember { mutableStateOf(false) }
                var syncState by remember { mutableStateOf<SyncState?>(null) }
                 var foregroundSyncEnabled by remember { mutableStateOf(false) }
                var paired by remember { mutableStateOf(false) }
                var lastSyncAtMillis by remember { mutableStateOf<Long?>(null) }
                var lastSyncError by remember { mutableStateOf<String?>(null) }
                var recentCommands by remember { mutableStateOf(emptyList<SyncCommandEntity>()) }
                val scope = rememberCoroutineScope()

                DisposableEffect(this) {
                    val observer = LifecycleEventObserver { _, event ->
                        if (event == Lifecycle.Event.ON_RESUME) {
                            updateNotificationGrant()
                            hasPermission = repository.hasUsageAccess()
                            accessibilityEnabled = isPolicyServiceEnabled()
                        }
                    }
                    lifecycle.addObserver(observer)
                    onDispose { lifecycle.removeObserver(observer) }
                }

                LaunchedEffect(Unit) {
                    syncSettings.settings.map { it.baseUrl }.distinctUntilChanged().collectLatest { stored ->
                        syncBaseUrl = stored
                    }
                }

                LaunchedEffect(Unit) {
                    syncSettings.settings.collectLatest { settings ->
                         foregroundSyncEnabled = settings.foregroundSyncEnabled
                        lastSyncAtMillis = settings.lastSyncAtMillis
                        lastSyncError = settings.lastSyncError
                    }
                }

                LaunchedEffect(Unit) {
                    identity.credentials.collectLatest { credentials ->
                        val stillPaired = credentials.deviceToken?.isNotBlank() == true
                        if (paired && !stillPaired) {
                            syncState = SyncState.Unpaired
                            policy = repository.loadPolicy()
                        }
                        paired = stillPaired
                    }
                }

                LaunchedEffect(Unit) {
                    repository.recentCommands().collectLatest { recentCommands = it }
                }

                LaunchedEffect(Unit) {
                    try {
                        policy = repository.loadPolicy()
                        dailyLimitMinutes = policy.limits.firstOrNull {
                            it.target.isDevice && it.period == UsagePeriod.DAY
                        }?.limitMillis?.div(60_000)?.toString().orEmpty()
                        listOf(UsagePeriod.WEEK, UsagePeriod.MONTH).forEach { period ->
                            devicePeriodInputs[period] = policy.limits.firstOrNull {
                                it.target.isDevice && it.period == period
                            }?.limitMillis?.div(60_000)?.toString().orEmpty()
                        }
                    } catch (error: Exception) {
                        message = "读取本地限制规则失败：${error.localizedMessage ?: error.javaClass.simpleName}"
                    }
                }

                LaunchedEffect(hasPermission, refreshKey) {
                    if (hasPermission) {
                        loading = true
                        try {
                            repository.refreshHistory()
                            apps = withContext(Dispatchers.IO) { listManageableApps() }
                            message = "使用事件已同步到本机历史库。"
                        } catch (error: Exception) {
                            message = "读取使用记录失败：${error.localizedMessage ?: error.javaClass.simpleName}"
                        } finally {
                            loading = false
                        }
                    }
                }

                LaunchedEffect(hasPermission) {
                    if (hasPermission) {
                        val today = LocalDate.now()
                        val monthStart = today.withDayOfMonth(1)
                        repository.dailyRows(monthStart.toString(), today.toString()).collectLatest { rows ->
                            dailyRows = rows
                        }
                    }
                }

                if (showPermissionOnboarding) {
                    PermissionOnboarding(
                        usage = hasPermission,
                        accessibility = accessibilityEnabled,
                        notifications = notificationsGranted,
                        onUsage = { startActivity(repository.usageAccessSettingsIntent()) },
                        onAccessibility = { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) },
                        onNotifications = {
                            if (Build.VERSION.SDK_INT >= 33) notificationRequest.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                        },
                        onDone = {
                            onboarding.edit().putBoolean("finished", true).apply()
                            showPermissionOnboarding = false
                        },
                    )
                }

                DashboardScreen(
                    zoneId = ZoneId.systemDefault().id,
                    hasUsageAccess = hasPermission,
                    accessibilityEnabled = accessibilityEnabled,
                    serviceConnected = serviceConnected,
                    loading = loading,
                    syncBusy = syncBusy,
                    savingPolicy = savingPolicy,
                    apps = apps,
                    dailyRows = dailyRows,
                    policy = policy.copy(forceStopped = pendingLock ?: policy.forceStopped),
                    dailyLimitMinutes = dailyLimitMinutes,
                    weeklyLimitMinutes = devicePeriodInputs[UsagePeriod.WEEK].orEmpty(),
                    monthlyLimitMinutes = devicePeriodInputs[UsagePeriod.MONTH].orEmpty(),
                    syncBaseUrl = syncBaseUrl,
                    pairingCode = pairingCode,
                    paired = paired,
                    lastSyncAtMillis = lastSyncAtMillis,
                    lastSyncError = lastSyncError,
                    recentCommands = recentCommands,
                    syncState = syncState,
                     foregroundSyncEnabled = foregroundSyncEnabled,
                    message = message,
                    appLimitValue = { packageName ->
                        appLimitInputs[packageName] ?: policy.limits.firstOrNull {
                            it.target.packageName == packageName && it.period == UsagePeriod.DAY
                        }?.limitMillis?.div(60_000)?.toString().orEmpty()
                    },
                    appSaving = { packageName -> savingAppPackage == packageName },
                    onSyncBaseUrlChanged = { syncBaseUrl = it },
                    onPairingCodeChanged = { pairingCode = it },
                    onPairDevice = {
                        scope.launch {
                            syncBusy = true
                            try {
                                val coordinator = SyncCoordinator(this@MainActivity)
                                coordinator.register(pairingCode.trim(), syncBaseUrl.trim())
                                pairingCode = ""
                                message = "设备已配对，令牌已保存到 Android Keystore。"
                                syncState = coordinator.sync(accessibilityEnabled = PolicyAccessibilityService.connected)
                                foregroundSyncEnabled = true
                                 syncSettings.setForegroundSyncEnabled(true)
                                 SyncScheduler.requestNow(this@MainActivity)
                            } catch (error: Exception) {
                                message = "设备配对失败：${error.localizedMessage ?: error.javaClass.simpleName}"
                            } finally {
                                syncBusy = false
                            }
                        }
                    },
                    onForegroundSyncChanged = { enabled ->
                         foregroundSyncEnabled = enabled
                         scope.launch { syncSettings.setForegroundSyncEnabled(enabled) }
                         if (enabled) SyncScheduler.enableForegroundSync(this@MainActivity) else SyncScheduler.disableForegroundSync(this@MainActivity)
                     },
                     onSyncNow = {
                        scope.launch {
                            syncBusy = true
                            try {
                                syncSettings.setBaseUrl(syncBaseUrl.trim())
                                syncState = SyncCoordinator(this@MainActivity)
                                    .sync(accessibilityEnabled = PolicyAccessibilityService.connected)
                                message = syncState?.toUserMessage()
                            } catch (error: Exception) {
                                message = "同步失败：${error.localizedMessage ?: error.javaClass.simpleName}"
                            } finally {
                                syncBusy = false
                            }
                        }
                    },
                    onOpenUsageSettings = { startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) },
                    onOpenAccessibilitySettings = { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) },
                    onRefreshPermission = {
                        hasPermission = repository.hasUsageAccess()
                        accessibilityEnabled = isPolicyServiceEnabled()
                        if (hasPermission) refreshKey++ else message = "尚未授予使用情况访问权限。"
                    },
                    onRefreshUsage = { refreshKey++ },
                    onDailyLimitChanged = { dailyLimitMinutes = it },
                    onWeeklyLimitChanged = { devicePeriodInputs[UsagePeriod.WEEK] = it },
                    onMonthlyLimitChanged = { devicePeriodInputs[UsagePeriod.MONTH] = it },
                    onPolicyEnabledChanged = { policy = policy.copy(enabled = it) },
                    onForceStoppedChanged = { pendingLock = it },
                    onSavePolicy = {
                        val periodInputs = mapOf(
                            UsagePeriod.DAY to dailyLimitMinutes,
                            UsagePeriod.WEEK to devicePeriodInputs[UsagePeriod.WEEK].orEmpty(),
                            UsagePeriod.MONTH to devicePeriodInputs[UsagePeriod.MONTH].orEmpty(),
                        )
                        if (periodInputs.values.any { value ->
                                val parsed = value.toLongOrNull()
                                value.isNotBlank() && (parsed == null || parsed !in 1..525_600)
                            }) {
                            message = "设备日/周/月上限需为 1 至 525600 分钟，或留空关闭。"
                            return@DashboardScreen
                        }
                        val retained = policy.limits.filterNot { it.target.isDevice }
                        val next = policy.copy(limits = retained + periodInputs.mapNotNull { (period, value) ->
                            value.toLongOrNull()?.takeIf { it > 0 }
                                ?.let { UsageLimitRule(UsageTarget(null), period, it * 60_000) }
                        })
                        scope.launch {
                            savingPolicy = true
                            try {
                                val lock = pendingLock
                                repository.savePolicy(next.copy(forceStopped = lock ?: next.forceStopped), updateLock = lock != null)
                                pendingLock = null
                                PolicyAccessibilityService.requestForegroundReevaluation()
                                message = if (serviceConnected) {
                                    "规则已保存；限制执行服务会在前台应用变化或下一次轮询时评估。"
                                } else {
                                    "规则已保存到本机。开启限制执行权限后，服务才会评估前台应用。"
                                }
                            } catch (error: Exception) {
                                message = "保存规则失败：${error.localizedMessage ?: error.javaClass.simpleName}"
                            } finally {
                                savingPolicy = false
                            }
                        }
                    },
                    onAppLimitChanged = { packageName, value -> appLimitInputs[packageName] = value },
                    onSaveAppLimit = { packageName ->
                        val input = appLimitInputs[packageName].orEmpty()
                        val minutes = input.toLongOrNull()
                        if (input.isNotBlank() && (minutes == null || minutes !in 1..525_600)) {
                            message = "应用每日上限需为 1 至 525600 分钟，或留空关闭。"
                            return@DashboardScreen
                        }
                        val label = apps.firstOrNull { it.second == packageName }?.first ?: packageName
                        val retained = policy.limits.filterNot {
                            it.target.packageName == packageName && it.period == UsagePeriod.DAY
                        }
                        val next = policy.copy(limits = retained + listOfNotNull(
                            minutes?.takeIf { it > 0 }
                                ?.let { UsageLimitRule(UsageTarget(packageName), UsagePeriod.DAY, it * 60_000) },
                        ))
                        scope.launch {
                            savingAppPackage = packageName
                            try {
                                repository.savePolicy(next)
                                message = "已保存 $label 的本地每日限制。"
                            } catch (error: Exception) {
                                message = "保存限制失败：${error.localizedMessage ?: error.javaClass.simpleName}"
                            } finally {
                                savingAppPackage = null
                            }
                        }
                    },
                )
            }
        }
    }

    private fun isPolicyServiceEnabled(): Boolean {
        val manager = getSystemService(AccessibilityManager::class.java)
        return manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any {
                it.resolveInfo.serviceInfo.packageName == packageName &&
                    it.resolveInfo.serviceInfo.name == "com.focusguard.enforcement.PolicyAccessibilityService"
            }
    }

    private fun listManageableApps(): List<Pair<String, String>> {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return packageManager.queryIntentActivities(intent, 0)
            .map { it.loadLabel(packageManager).toString() to it.activityInfo.packageName }
            .distinctBy { it.second }
            .sortedBy { it.first.lowercase() }
    }
}

private fun SyncState.toUserMessage(): String = when (this) {
    SyncState.NotConfigured -> "请先配置 API 地址。"
    SyncState.Unpaired -> "设备尚未配对。"
    SyncState.Offline -> "设备当前离线，稍后会自动重试。"
    is SyncState.PermissionRequired -> "同步完成，但仍需补齐使用情况或限制执行权限。"
    SyncState.Syncing -> "已有同步任务正在执行，本次请求未重复发起。"
    SyncState.Synced -> "同步完成。"
    is SyncState.NetworkError -> "同步失败：$message"
    is SyncState.ServerError -> "同步失败：$message"
    else -> "同步完成，但命令确认仍待重试。"
}
