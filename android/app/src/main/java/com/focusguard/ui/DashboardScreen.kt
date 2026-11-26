package com.focusguard.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.focusguard.core.PolicyConfig
import com.focusguard.core.UsagePeriod
import com.focusguard.data.UsageDailyEntity
import com.focusguard.sync.SyncState
import java.time.LocalDate

/**
 * The dashboard is deliberately state-free. MainActivity owns repositories and callbacks;
 * this composable only renders the current, real local state and dispatches user actions.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    zoneId: String,
    hasUsageAccess: Boolean,
    accessibilityEnabled: Boolean,
    loading: Boolean,
    syncBusy: Boolean,
    savingPolicy: Boolean,
    apps: List<Pair<String, String>>,
    dailyRows: List<UsageDailyEntity>,
    policy: PolicyConfig,
    dailyLimitMinutes: String,
    weeklyLimitMinutes: String,
    monthlyLimitMinutes: String,
    syncBaseUrl: String,
    pairingCode: String,
    syncState: SyncState?,
    message: String?,
    appLimitValue: (String) -> String,
    appSaving: (String) -> Boolean,
    onSyncBaseUrlChanged: (String) -> Unit,
    onPairingCodeChanged: (String) -> Unit,
    onPairDevice: () -> Unit,
    onOpenUsageSettings: () -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
    onRefreshPermission: () -> Unit,
    onRefreshUsage: () -> Unit,
    onDailyLimitChanged: (String) -> Unit,
    onWeeklyLimitChanged: (String) -> Unit,
    onMonthlyLimitChanged: (String) -> Unit,
    onPolicyEnabledChanged: (Boolean) -> Unit,
    onForceStoppedChanged: (Boolean) -> Unit,
    onSavePolicy: () -> Unit,
    onAppLimitChanged: (String, String) -> Unit,
    onSaveAppLimit: (String) -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("FocusGuard")
                        Text("专注与设备使用控制", style = MaterialTheme.typography.labelSmall)
                    }
                },
            )
        },
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .padding(innerPadding),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item {
                Column {
                    Text("今日概览", style = MaterialTheme.typography.headlineSmall)
                    Text(
                        "统计时区：$zoneId",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            message?.let { text ->
                item { StatusCard(text) }
            }

            item {
                SyncCard(
                    baseUrl = syncBaseUrl,
                    pairingCode = pairingCode,
                    syncBusy = syncBusy,
                    syncState = syncState,
                    onBaseUrlChanged = onSyncBaseUrlChanged,
                    onPairingCodeChanged = onPairingCodeChanged,
                    onPair = onPairDevice,
                )
            }

            item {
                PermissionCard(
                    hasUsageAccess = hasUsageAccess,
                    accessibilityEnabled = accessibilityEnabled,
                    loading = loading,
                    onOpenUsageSettings = onOpenUsageSettings,
                    onOpenAccessibilitySettings = onOpenAccessibilitySettings,
                    onRefreshPermission = onRefreshPermission,
                    onRefreshUsage = onRefreshUsage,
                )
            }

            item {
                TodayStatsCard(
                    dailyRows = dailyRows,
                    loading = loading,
                    onRefresh = onRefreshUsage,
                )
            }

            if (hasUsageAccess) {
                item {
                    PolicyCard(
                        policy = policy,
                        dailyLimitMinutes = dailyLimitMinutes,
                        weeklyLimitMinutes = weeklyLimitMinutes,
                        monthlyLimitMinutes = monthlyLimitMinutes,
                        accessibilityEnabled = accessibilityEnabled,
                        saving = savingPolicy,
                        onDailyLimitChanged = onDailyLimitChanged,
                        onWeeklyLimitChanged = onWeeklyLimitChanged,
                        onMonthlyLimitChanged = onMonthlyLimitChanged,
                        onPolicyEnabledChanged = onPolicyEnabledChanged,
                        onForceStoppedChanged = onForceStoppedChanged,
                        onSave = onSavePolicy,
                        onOpenAccessibilitySettings = onOpenAccessibilitySettings,
                    )
                }

                item {
                    Text("应用限制", style = MaterialTheme.typography.titleLarge)
                }

                if (apps.isEmpty()) {
                    item {
                        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                            Text(
                                "未发现可启动的应用。授予使用情况访问权限后点击“同步使用事件”重试。",
                                modifier = Modifier.padding(16.dp),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                } else {
                    items(apps, key = { it.second }) { (label, packageName) ->
                        AppLimitCard(
                            label = label,
                            packageName = packageName,
                            value = appLimitValue(packageName),
                            saving = appSaving(packageName),
                            onValueChanged = { onAppLimitChanged(packageName, it) },
                            onSave = { onSaveAppLimit(packageName) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusCard(message: String) {
    val isError = message.contains("失败") || message.contains("错误") || message.contains("失败")
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (isError) {
                MaterialTheme.colorScheme.errorContainer
            } else {
                MaterialTheme.colorScheme.primaryContainer
            },
        ),
    ) {
        Text(
            message,
            modifier = Modifier.padding(16.dp),
            color = if (isError) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun SyncCard(
    baseUrl: String,
    pairingCode: String,
    syncBusy: Boolean,
    syncState: SyncState?,
    onBaseUrlChanged: (String) -> Unit,
    onPairingCodeChanged: (String) -> Unit,
    onPair: () -> Unit,
) {
    Card {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("设备同步", style = MaterialTheme.typography.titleLarge)
            Text(
                "将本机统计与策略同步到已配置的 FocusGuard 服务。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = baseUrl,
                onValueChange = onBaseUrlChanged,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("API 地址（HTTPS）") },
                singleLine = true,
            )
            OutlinedTextField(
                value = pairingCode,
                onValueChange = onPairingCodeChanged,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("一次性配对码") },
                singleLine = true,
            )
            Button(
                enabled = !syncBusy && baseUrl.isNotBlank() && pairingCode.isNotBlank(),
                onClick = onPair,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (syncBusy) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(8.dp))
                }
                Text(if (syncBusy) "配对中…" else "配对设备")
            }
            syncState?.let {
                Text(
                    "当前同步状态：${it.label()}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun PermissionCard(
    hasUsageAccess: Boolean,
    accessibilityEnabled: Boolean,
    loading: Boolean,
    onOpenUsageSettings: () -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
    onRefreshPermission: () -> Unit,
    onRefreshUsage: () -> Unit,
) {
    Card {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("权限状态", style = MaterialTheme.typography.titleLarge)
            PermissionRow("使用情况访问", hasUsageAccess)
            PermissionRow("限制执行服务", accessibilityEnabled)
            Text(
                "FocusGuard 仅使用系统提供的前台应用时段，不读取聊天、键盘、通知或屏幕内容。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onOpenUsageSettings) { Text("管理使用权限") }
                OutlinedButton(onClick = onOpenAccessibilitySettings) { Text("管理执行权限") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onRefreshPermission, enabled = !loading) { Text("刷新权限") }
                Button(onClick = onRefreshUsage, enabled = hasUsageAccess && !loading) {
                    if (loading) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.size(8.dp))
                    }
                    Text(if (loading) "同步中…" else "同步使用事件")
                }
            }
            if (loading) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun PermissionRow(label: String, enabled: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge)
        Text(
            if (enabled) "已授权" else "未授权",
            color = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.labelLarge,
        )
    }
}

@Composable
private fun TodayStatsCard(
    dailyRows: List<UsageDailyEntity>,
    loading: Boolean,
    onRefresh: () -> Unit,
) {
    val today = LocalDate.now().toString()
    val todayRow = dailyRows.firstOrNull { it.localDate == today }
    Card {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("今日统计", style = MaterialTheme.typography.titleLarge)
                OutlinedButton(onClick = onRefresh, enabled = !loading) { Text("刷新") }
            }
            if (todayRow == null) {
                Text("暂无今日使用记录", style = MaterialTheme.typography.headlineSmall)
            } else {
                Text(
                    "${todayRow.deviceForegroundMillis / 60_000} 分钟",
                    style = MaterialTheme.typography.headlineSmall,
                )
                Text("设备前台使用时长", style = MaterialTheme.typography.bodyMedium)
            }
            Text(
                "统计口径：前台应用区间的并集，不等同于屏幕亮屏时间。已载入 ${dailyRows.size} 天本地汇总。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun PolicyCard(
    policy: PolicyConfig,
    dailyLimitMinutes: String,
    weeklyLimitMinutes: String,
    monthlyLimitMinutes: String,
    accessibilityEnabled: Boolean,
    saving: Boolean,
    onDailyLimitChanged: (String) -> Unit,
    onWeeklyLimitChanged: (String) -> Unit,
    onMonthlyLimitChanged: (String) -> Unit,
    onPolicyEnabledChanged: (Boolean) -> Unit,
    onForceStoppedChanged: (Boolean) -> Unit,
    onSave: () -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
) {
    Card {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("策略设置", style = MaterialTheme.typography.titleLarge)
            Text(
                if (accessibilityEnabled) "限制执行服务已启用，规则将在前台应用切换时评估。"
                else "限制执行服务未授权；规则可以保存，但授权后才会评估。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (!accessibilityEnabled) {
                OutlinedButton(onClick = onOpenAccessibilitySettings) { Text("开启限制执行权限") }
            }
            LimitField("设备每日上限（分钟，留空关闭）", dailyLimitMinutes, onDailyLimitChanged)
            LimitField("设备每周上限（分钟，留空关闭）", weeklyLimitMinutes, onWeeklyLimitChanged)
            LimitField("设备每月上限（分钟，留空关闭）", monthlyLimitMinutes, onMonthlyLimitChanged)
            SettingSwitch("启用规则", policy.enabled, onPolicyEnabledChanged)
            SettingSwitch("立即停止", policy.forceStopped, onForceStoppedChanged)
            Button(onClick = onSave, enabled = !saving, modifier = Modifier.fillMaxWidth()) {
                if (saving) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(8.dp))
                }
                Text(if (saving) "保存中…" else "保存策略")
            }
        }
    }
}

@Composable
private fun LimitField(label: String, value: String, onValueChanged: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = { next ->
            if (next.isEmpty() || next.all(Char::isDigit)) onValueChanged(next)
        },
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        singleLine = true,
    )
}

@Composable
private fun SettingSwitch(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label)
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
private fun AppLimitCard(
    label: String,
    packageName: String,
    value: String,
    saving: Boolean,
    onValueChanged: (String) -> Unit,
    onSave: () -> Unit,
) {
    Card {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(label, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(packageName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            LimitField("每日上限（分钟，留空关闭）", value, onValueChanged)
            Button(onClick = onSave, enabled = !saving, modifier = Modifier.fillMaxWidth()) {
                if (saving) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(8.dp))
                }
                Text(if (saving) "保存中…" else "保存应用限制")
            }
        }
    }
}

private fun SyncState.label(): String = when (this) {
    SyncState.NotConfigured -> "未配置服务器"
    SyncState.Unpaired -> "尚未配对"
    SyncState.Offline -> "设备离线"
    is SyncState.PermissionRequired -> "等待权限（使用情况：${if (usageAccess) "已授权" else "未授权"}，执行服务：${if (accessibility) "已授权" else "未授权"}）"
    SyncState.Syncing -> "同步中"
    SyncState.Synced -> "已同步"
    is SyncState.NetworkError -> "网络错误：$message"
    is SyncState.ServerError -> "服务器错误：$message"
}
