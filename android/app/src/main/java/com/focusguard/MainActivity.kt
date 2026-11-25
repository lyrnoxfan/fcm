package com.focusguard

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.accessibility.AccessibilityManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.focusguard.usage.UsageRepository
import com.focusguard.sync.SyncScheduler
import com.focusguard.core.PolicyConfig
import com.focusguard.core.UsageLimitRule
import com.focusguard.core.UsagePeriod
import com.focusguard.core.UsageTarget
import java.time.LocalDate
import java.time.ZoneId
import com.focusguard.data.UsageDailyEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private val repository by lazy { UsageRepository(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncScheduler.schedule(this)
        setContent {
            MaterialTheme {
                var hasPermission by remember { mutableStateOf(repository.hasUsageAccess()) }
                var loading by remember { mutableStateOf(false) }
                var message by remember { mutableStateOf<String?>(null) }
                var apps by remember { mutableStateOf(emptyList<Pair<String, String>>()) }
                var dailyRows by remember { mutableStateOf(emptyList<UsageDailyEntity>()) }
                var policy by remember { mutableStateOf(PolicyConfig()) }
                var dailyLimitMinutes by remember { mutableStateOf("120") }
                val appLimitInputs = remember { mutableStateMapOf<String, String>() }
                val devicePeriodInputs = remember { mutableStateMapOf(UsagePeriod.WEEK to "", UsagePeriod.MONTH to "") }
                var refreshKey by remember { mutableStateOf(0) }
                var accessibilityEnabled by remember { mutableStateOf(isPolicyServiceEnabled()) }
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
                            message = "本地汇总已更新 · 周起始 ${weekStart} · 月起始 ${monthStart}"
                        }
                    }
                }
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column(
                        modifier = Modifier.fillMaxSize().padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text("FocusGuard", style = MaterialTheme.typography.headlineMedium)
                        Text("本机使用统计 · ${ZoneId.systemDefault().id}", style = MaterialTheme.typography.bodyMedium)
                        if (!hasPermission) {
                            Text("需要你主动授予“使用情况访问权限”才能读取前台应用时段。不会读取聊天、键盘、通知或屏幕内容。")
                            Button(onClick = { startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) }) {
                                Text("打开使用情况访问设置")
                            }
                        } else {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(onClick = {
                                    loading = true
                                    hasPermission = repository.hasUsageAccess()
                                    if (hasPermission) refreshKey++ else loading = false
                                }) { Text("刷新权限状态") }
                                Button(onClick = { refreshKey++ }) { Text("同步使用事件") }
                            }
                            if (loading) CircularProgressIndicator()
                            message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                            val todayUsage = dailyRows.lastOrNull()?.deviceForegroundMillis ?: 0L
                            Text("今日设备前台使用：${todayUsage / 60_000} 分钟", style = MaterialTheme.typography.titleMedium)
                            Text("统计口径：前台应用区间的并集；不是屏幕亮屏时间。", style = MaterialTheme.typography.bodySmall)
                            Text("本地限制规则", style = MaterialTheme.typography.titleMedium)
                            Text(if (accessibilityEnabled) "限制执行服务：已授权" else "限制执行服务：未授权（规则仍会离线保存）")
                            Button(onClick = { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }) {
                                Text("管理限制执行权限")
                            }
                            OutlinedTextField(
                                value = dailyLimitMinutes,
                                onValueChange = { value -> if (value.isEmpty() || value.all(Char::isDigit)) dailyLimitMinutes = value },
                                label = { Text("设备每日上限（分钟，留空关闭）") },
                                singleLine = true,
                            )
                            OutlinedTextField(
                                value = devicePeriodInputs[UsagePeriod.WEEK].orEmpty(),
                                onValueChange = { value -> if (value.isEmpty() || value.all(Char::isDigit)) devicePeriodInputs[UsagePeriod.WEEK] = value },
                                label = { Text("设备每周上限（分钟，留空关闭）") },
                                singleLine = true,
                            )
                            OutlinedTextField(
                                value = devicePeriodInputs[UsagePeriod.MONTH].orEmpty(),
                                onValueChange = { value -> if (value.isEmpty() || value.all(Char::isDigit)) devicePeriodInputs[UsagePeriod.MONTH] = value },
                                label = { Text("设备每月上限（分钟，留空关闭）") },
                                singleLine = true,
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("启用规则")
                                Switch(checked = policy.enabled, onCheckedChange = { policy = policy.copy(enabled = it) })
                                Text("立即停止")
                                Switch(checked = policy.forceStopped, onCheckedChange = { policy = policy.copy(forceStopped = it) })
                            }
                            Button(onClick = {
                                val minutes = dailyLimitMinutes.toLongOrNull()
                                if (dailyLimitMinutes.isNotBlank() && (minutes == null || minutes !in 1..525_600)) {
                                    message = "设备每日上限需为 1 至 525600 分钟，或留空关闭。"
                                    return@Button
                                }
                                val periodMinutes = mapOf(
                                    UsagePeriod.DAY to dailyLimitMinutes,
                                    UsagePeriod.WEEK to devicePeriodInputs[UsagePeriod.WEEK].orEmpty(),
                                    UsagePeriod.MONTH to devicePeriodInputs[UsagePeriod.MONTH].orEmpty(),
                                )
                                val invalidPeriod = periodMinutes.values.any { value ->
                                    val parsed = value.toLongOrNull()
                                    value.isNotBlank() && (parsed == null || parsed !in 1..525_600)
                                }
                                if (invalidPeriod) {
                                    message = "设备日/周/月上限需为 1 至 525600 分钟，或留空关闭。"
                                    return@Button
                                }
                                val retained = policy.limits.filterNot { it.target.isDevice }
                                val next = policy.copy(limits = retained + periodMinutes.mapNotNull { (period, value) ->
                                    value.toLongOrNull()?.takeIf { it > 0 }?.let { UsageLimitRule(UsageTarget(null), period, it * 60_000) }
                                })
                                scope.launch {
                                    try {
                                        repository.savePolicy(next)
                                        policy = next
                                        message = if (accessibilityEnabled) "规则已保存；无障碍服务将在下次前台应用切换时评估。普通模式不具备不可绕过的系统禁用能力。" else "规则已保存到本机。请手动开启限制执行权限后，服务才会评估前台应用。"
                                    } catch (error: Exception) {
                                        message = "保存规则失败：${error.localizedMessage ?: error.javaClass.simpleName}"
                                    }
                                }
                            }) { Text("保存规则") }
                            Text("已安装且可启动的应用", style = MaterialTheme.typography.titleMedium)
                            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(apps, key = { it.first }) { (label, packageName) ->
                                    Card(modifier = Modifier.fillMaxWidth()) {
                                        Column(Modifier.padding(12.dp)) {
                                            Text(label, style = MaterialTheme.typography.titleSmall)
                                            Text(packageName, style = MaterialTheme.typography.bodySmall)
                                            OutlinedTextField(
                                                value = appLimitInputs[packageName] ?: policy.limits.firstOrNull {
                                                    it.target.packageName == packageName && it.period == UsagePeriod.DAY
                                                }?.limitMillis?.div(60_000)?.toString().orEmpty(),
                                                onValueChange = { value -> if (value.isEmpty() || value.all(Char::isDigit)) appLimitInputs[packageName] = value },
                                                label = { Text("每日上限（分钟，留空关闭）") },
                                                singleLine = true,
                                            )
                                            Button(onClick = {
                                                val minutes = (appLimitInputs[packageName] ?: "").toLongOrNull()
                                                val retained = policy.limits.filterNot { it.target.packageName == packageName && it.period == UsagePeriod.DAY }
                                                val next = policy.copy(limits = retained + listOfNotNull(
                                                    minutes?.takeIf { it in 1..525_600 }?.let {
                                                        UsageLimitRule(UsageTarget(packageName), UsagePeriod.DAY, it * 60_000)
                                                    },
                                                ))
                                                scope.launch {
                                                    try {
                                                        repository.savePolicy(next)
                                                        policy = next
                                                        message = "已保存 $label 的本地每日限制。"
                                                    } catch (error: Exception) {
                                                        message = "保存限制失败：${error.localizedMessage ?: error.javaClass.simpleName}"
                                                    }
                                                }
                                            }) { Text("保存应用限制") }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private fun isPolicyServiceEnabled(): Boolean {
        val manager = getSystemService(AccessibilityManager::class.java)
        return manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any { it.resolveInfo.serviceInfo.packageName == packageName && it.resolveInfo.serviceInfo.name == "com.focusguard.enforcement.PolicyAccessibilityService" }
    }

    private fun listManageableApps(): List<Pair<String, String>> {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return packageManager.queryIntentActivities(intent, 0)
            .map { it.loadLabel(packageManager).toString() to it.activityInfo.packageName }
            .distinctBy { it.second }
            .sortedBy { it.first.lowercase() }
    }
}
