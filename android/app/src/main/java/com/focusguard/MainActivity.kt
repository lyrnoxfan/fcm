package com.focusguard

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.focusguard.core.PolicyConfig
import com.focusguard.core.UsageLimitRule
import com.focusguard.core.UsagePeriod
import com.focusguard.core.UsageTarget
import com.focusguard.data.UsageDailyEntity
import com.focusguard.sync.SyncCoordinator
import com.focusguard.sync.SyncScheduler
import com.focusguard.sync.SyncState
import com.focusguard.sync.SyncSettingsStore
import com.focusguard.ui.DashboardScreen
import com.focusguard.usage.UsageRepository
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private val repository by lazy { UsageRepository(this) }
    private val syncSettings by lazy { SyncSettingsStore(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncScheduler.schedule(this)
        setContent {
            MaterialTheme {
                var hasPermission by remember { mutableStateOf(repository.hasUsageAccess()) }
                var loading by remember { mutableStateOf(false) }
                var savingPolicy by remember { mutableStateOf(false) }
                var savingAppPackage by remember { mutableStateOf<String?>(null) }
                var message by remember { mutableStateOf<String?>(null) }
                var apps by remember { mutableStateOf(emptyList<Pair<String, String>>()) }
                var dailyRows by remember { mutableStateOf(emptyList<UsageDailyEntity>()) }
                var policy by remember { mutableStateOf(PolicyConfig()) }
                var dailyLimitMinutes by remember { mutableStateOf("") }
                val appLimitInputs = remember { mutableStateMapOf<String, String>() }
                val devicePeriodInputs = remember { mutableStateMapOf(UsagePeriod.WEEK to "", UsagePeriod.MONTH to "") }
                var refreshKey by remember { mutableStateOf(0) }
                var accessibilityEnabled by remember { mutableStateOf(isPolicyServiceEnabled()) }
                var syncBaseUrl by remember { mutableStateOf("") }
                var pairingCode by remember { mutableStateOf("") }
                var syncBusy by remember { mutableStateOf(false) }
                var syncState by remember { mutableStateOf<SyncState?>(null) }
                val scope = rememberCoroutineScope()

                DisposableEffect(this) {
                    val observer = LifecycleEventObserver { _, event ->
                        if (event == Lifecycle.Event.ON_RESUME) {
                            hasPermission = repository.hasUsageAccess()
                            accessibilityEnabled = isPolicyServiceEnabled()
                        }
                    }
                    lifecycle.addObserver(observer)
                    onDispose { lifecycle.removeObserver(observer) }
                }

                LaunchedEffect(Unit) {
                    syncBaseUrl = syncSettings.settings.first().baseUrl
                    try {
                        policy = repository.loadPolicy()
                        dailyLimitMinutes = policy.limits.firstOrNull { it.target.isDevice && it.period == UsagePeriod.DAY }
                            ?.limitMillis?.div(60_000)?.toString().orEmpty()
                        listOf(UsagePeriod.WEEK, UsagePeriod.MONTH).forEach { period ->
                            devicePeriodInputs[period] = policy.limits.firstOrNull { it.target.isDevice && it.period == period }
                                ?.limitMillis?.div(60_000)?.toString().orEmpty()
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
                            message = "使用事件已同步到本机历史库。屏幕亮屏时间不由此数据推算。"
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
                        val weekStart = today.minusDays((today.dayOfWeek.value - 1).toLong())
                        val monthStart = today.withDayOfMonth(1)
                        repository.dailyRows(monthStart.toString(), today.toString()).collectLatest { rows ->
                            dailyRows = rows
                            message = "本地汇总已更新 · 周起始 $weekStart · 月起始 $monthStart"
                        }
                    }
                }

                DashboardScreen(
                    zoneId = ZoneId.systemDefault().id,
                    hasUsageAccess = hasPermission,
                    accessibilityEnabled = accessibilityEnabled,
                    loading = loading,
                    syncBusy = syncBusy,
                    savingPolicy = savingPolicy,
                    apps = apps,
                    dailyRows = dailyRows,
                    policy = policy,
                    dailyLimitMinutes = dailyLimitMinutes,
                    weeklyLimitMinutes = devicePeriodInputs[UsagePeriod.WEEK].orEmpty(),
                    monthlyLimitMinutes = devicePeriodInputs[UsagePeriod.MONTH].orEmpty(),
                    syncBaseUrl = syncBaseUrl,
                    pairingCode = pairingCode,
                    syncState = syncState,
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
                                syncState = coordinator.sync(accessibilityEnabled = accessibilityEnabled)
                                SyncScheduler.requestNow(this@MainActivity)
                            } catch (error: Exception) {
                                message = "设备配对失败：${error.localizedMessage ?: error.javaClass.simpleName}"
                            } finally {
                                syncBusy = false
                            }
                        }
                    },
                    onSyncNow = {
                         scope.launch {
                             syncBusy = true
                             syncState = SyncCoordinator(this@MainActivity).sync(accessibilityEnabled = accessibilityEnabled)
                             message = when (val state = syncState) {
                                 is SyncState.ServerError -> "同步失败：${state.message}"
                                 is SyncState.NetworkError -> "同步失败：${state.message}"
                                 else -> "同步状态：${state?.javaClass?.simpleName ?: "未知"}"
                             }
                             syncBusy = false
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
                    onForceStoppedChanged = { policy = policy.copy(forceStopped = it) },
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
                                repository.savePolicy(next)
                                policy = next
                                message = if (accessibilityEnabled) {
                                    "规则已保存；无障碍服务将在下次前台应用切换时评估。"
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
                        val minutes = (appLimitInputs[packageName] ?: "").toLongOrNull()
                        if (appLimitInputs[packageName].orEmpty().isNotBlank() && (minutes == null || minutes !in 1..525_600)) {
                            message = "应用每日上限需为 1 至 525600 分钟，或留空关闭。"
                            return@DashboardScreen
                        }
                        val label = apps.firstOrNull { it.second == packageName }?.first ?: packageName
                        val retained = policy.limits.filterNot { it.target.packageName == packageName && it.period == UsagePeriod.DAY }
                        val next = policy.copy(limits = retained + listOfNotNull(
                            minutes?.takeIf { it > 0 }?.let { UsageLimitRule(UsageTarget(packageName), UsagePeriod.DAY, it * 60_000) },
                        ))
                        scope.launch {
                            savingAppPackage = packageName
                            try {
                                repository.savePolicy(next)
                                policy = next
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
