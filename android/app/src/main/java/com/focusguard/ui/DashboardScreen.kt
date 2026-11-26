package com.focusguard.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.graphics.Brush
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.focusguard.core.PolicyConfig
import com.focusguard.core.UsagePeriod
import com.focusguard.data.SyncCommandEntity
import com.focusguard.data.UsageDailyEntity
import com.focusguard.sync.SyncState
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    zoneId: String,
    hasUsageAccess: Boolean,
    accessibilityEnabled: Boolean,
    serviceConnected: Boolean,
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
    paired: Boolean,
    lastSyncAtMillis: Long?,
    lastSyncError: String?,
    recentCommands: List<SyncCommandEntity>,
     foregroundSyncEnabled: Boolean,
     onForegroundSyncChanged: (Boolean) -> Unit,
    syncState: SyncState?,
    message: String?,
    appLimitValue: (String) -> String,
    appSaving: (String) -> Boolean,
    onSyncNow: () -> Unit,
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
    val today = dailyRows.firstOrNull { it.localDate == LocalDate.now().toString() }
    val usedMinutes = (today?.deviceForegroundMillis ?: 0L) / 60_000L
    val dailyLimit = dailyLimitMinutes.toLongOrNull()
    val remainingMinutes = dailyLimit?.minus(usedMinutes)?.coerceAtLeast(0L)
    val readiness = when {
        !hasUsageAccess -> "需要授权使用情况访问"
        !accessibilityEnabled -> "无障碍未授权"
        !serviceConnected -> "无障碍已开启，服务未连接"
        policy.forceStopped -> "全局锁定规则已启用"
        paired && syncState is SyncState.Synced -> "设备已就绪"
        paired -> "已配对，等待同步"
        else -> "本机模式"
    }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val policyIndex = 5 + if (message == null) 0 else 1
    val syncIndex = 1 + if (message == null) 0 else 1
    var section by remember { mutableStateOf(0) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                title = {
                    Column {
                        Text("FocusGuard", fontWeight = FontWeight.Bold)
                        Text("数字专注 · 设备管理", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
            )
        },
    ) { innerPadding ->
        Box(Modifier.fillMaxWidth().padding(innerPadding), contentAlignment = Alignment.TopCenter) {
            Column(Modifier.widthIn(max = 760.dp).fillMaxWidth()) {
                Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("概览", "设备", "规则").forEachIndexed { index, label ->
                        FilterChip(selected = section == index, onClick = {
                            section = index
                            scope.launch { listState.scrollToItem(when (index) {
                                1 -> syncIndex
                                2 -> if (hasUsageAccess) policyIndex else syncIndex + 2
                                else -> 0
                            }) }
                        }, label = { Text(label) })
                    }
                }
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(start = 16.dp, top = 8.dp, end = 16.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    item {
                        SummaryCard(
                            readiness = readiness,
                            usedMinutes = usedMinutes,
                            remainingMinutes = remainingMinutes,
                            zoneId = zoneId,
                            policyEnabled = policy.enabled,
                            onOpenPolicy = if (hasUsageAccess) {
                                { scope.launch { listState.animateScrollToItem(policyIndex) } }
                            } else {
                                null
                            },
                        )
                    }
                    message?.let { text -> item { StatusCard(text) } }
                    item {
                        SyncCard(
                            baseUrl = syncBaseUrl,
                            paired = paired,
                            syncBusy = syncBusy,
                            syncState = syncState,
                             foregroundSyncEnabled = foregroundSyncEnabled,
                             onForegroundSyncChanged = onForegroundSyncChanged,
                            lastSyncAtMillis = lastSyncAtMillis,
                            lastSyncError = lastSyncError,
                            zoneId = zoneId,
                            onSyncNow = onSyncNow,
                        )
                    }
                    item {
                        CommandCard(commands = recentCommands, zoneId = zoneId)
                    }
                    item {
                        PermissionCard(
                            hasUsageAccess = hasUsageAccess,
                            accessibilityEnabled = accessibilityEnabled,
                            serviceConnected = serviceConnected,
                            loading = loading,
                            onOpenUsageSettings = onOpenUsageSettings,
                            onOpenAccessibilitySettings = onOpenAccessibilitySettings,
                            onRefreshPermission = onRefreshPermission,
                            onRefreshUsage = onRefreshUsage,
                        )
                    }
                    item {
                        UsageCard(dailyRows = dailyRows, loading = loading, onRefresh = onRefreshUsage)
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
                            AppLimitsSection(
                                apps = apps,
                                appLimitValue = appLimitValue,
                                appSaving = appSaving,
                                onAppLimitChanged = onAppLimitChanged,
                                onSaveAppLimit = onSaveAppLimit,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SummaryCard(
    readiness: String,
    usedMinutes: Long,
    remainingMinutes: Long?,
    zoneId: String,
    policyEnabled: Boolean,
    onOpenPolicy: (() -> Unit)?,
) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
        val tones = MaterialTheme.colorScheme
        Column(Modifier.background(Brush.horizontalGradient(listOf(tones.primaryContainer, tones.secondaryContainer))).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("今天", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onPrimaryContainer)
                    Text(formatMinutes(usedMinutes), style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onPrimaryContainer)
                    Text("前台应用使用时长", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.78f))
                }
                Surface(color = MaterialTheme.colorScheme.primary, shape = MaterialTheme.shapes.small) {
                    Text(readiness, Modifier.padding(horizontal = 10.dp, vertical = 7.dp), color = MaterialTheme.colorScheme.onPrimary)
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.16f))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                SummaryMetric("剩余", remainingMinutes?.let(::formatMinutes) ?: "未设置")
                SummaryMetric("规则", if (policyEnabled) "已启用" else "已暂停")
                SummaryMetric("时区", zoneId.substringAfterLast('/'))
            }
            onOpenPolicy?.let { openPolicy ->
                TextButton(onClick = openPolicy, modifier = Modifier.fillMaxWidth()) { Text("编辑策略") }
            }
        }
    }
}

@Composable
private fun SummaryMetric(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun StatusCard(message: String) {
    val isError = listOf("失败", "错误", "拒绝", "过期").any { message.contains(it) }
    Card(colors = CardDefaults.cardColors(containerColor = if (isError) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer)) {
        Text(message, Modifier.padding(14.dp), color = if (isError) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSecondaryContainer)
    }
}

@Composable
private fun SyncCard(
    baseUrl: String,
    paired: Boolean,
    syncBusy: Boolean,
    syncState: SyncState?,
    foregroundSyncEnabled: Boolean,
    onForegroundSyncChanged: (Boolean) -> Unit,
    lastSyncAtMillis: Long?,
    lastSyncError: String?,
    zoneId: String,
    onSyncNow: () -> Unit,
) {
    var expanded by remember(paired) { mutableStateOf(!paired) }
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionHeader("设备同步", if (paired) "已配对" else "未配对", expanded) { expanded = !expanded }
            Text(
                if (paired) "设备令牌已保存在 Android Keystore，可直接同步策略、使用汇总和远程命令。"
                else "设备将自动注册到管理账号。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                DetailLine("API", baseUrl.ifBlank { "未配置" })
                DetailLine("状态", if (paired) syncState?.syncLabel() ?: "待同步" else "未配对")
            }
            lastSyncAtMillis?.let {
                Text("最后同步：${formatTimestamp(it, zoneId)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            lastSyncError?.let {
                Text("最近错误：$it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            SettingSwitch("连续同步服务（10 秒轮询命令）", foregroundSyncEnabled, onForegroundSyncChanged)
            if (!foregroundSyncEnabled && paired) {
                Text("未开启连续同步时，远程锁定只能等待系统周期同步。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            OutlinedButton(enabled = !syncBusy && paired, onClick = onSyncNow, modifier = Modifier.fillMaxWidth()) {
                BusyLabel(syncBusy, "立即同步")
            }
        }
    }
}

@Composable
private fun DetailLine(label: String, value: String) {
    Column(Modifier.fillMaxWidth(0.48f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun CommandCard(commands: List<SyncCommandEntity>, zoneId: String) {
    var expanded by remember { mutableStateOf(commands.isNotEmpty()) }
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionHeader("远程命令", if (commands.isEmpty()) "暂无记录" else "最近 ${commands.size} 条", expanded) { expanded = !expanded }
            Text("送达、执行、失败和过期都会写入本机记录；ACK 失败不会静默。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (expanded) {
                if (commands.isEmpty()) {
                    Text("同步后这里会显示管理端下发的命令。", style = MaterialTheme.typography.bodySmall)
                } else {
                    commands.forEachIndexed { index, command ->
                        if (index > 0) HorizontalDivider()
                        CommandRow(command, zoneId)
                    }
                }
            }
        }
    }
}

@Composable
private fun CommandRow(command: SyncCommandEntity, zoneId: String) {
    val statusColor = when (command.status) {
        "applied" -> MaterialTheme.colorScheme.primary
        "delivered", "pending" -> MaterialTheme.colorScheme.tertiary
        else -> MaterialTheme.colorScheme.error
    }
    Column(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(command.type, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            Text(command.status.toCommandLabel(), color = statusColor, style = MaterialTheme.typography.labelLarge)
        }
        Text(command.commandId, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(formatTimestamp(command.receivedAtMillis, zoneId), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        command.detail?.takeIf(String::isNotBlank)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = if (it.contains("失败")) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun PermissionCard(
    hasUsageAccess: Boolean,
    accessibilityEnabled: Boolean,
    serviceConnected: Boolean,
    loading: Boolean,
    onOpenUsageSettings: () -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
    onRefreshPermission: () -> Unit,
    onRefreshUsage: () -> Unit,
) {
    var showBackgroundHelp by remember { mutableStateOf(false) }
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Text("权限状态", style = MaterialTheme.typography.titleMedium)
            PermissionRow("使用情况访问", hasUsageAccess)
            PermissionRow("Android 无障碍授权", accessibilityEnabled)
            Text(when {
                serviceConnected -> "限制执行服务已连接"
                accessibilityEnabled -> "系统仍显示已授权，但服务尚未连接。请先稍候；若未恢复，可从系统设置检查。"
                else -> "限制执行服务未连接。请按需在 Android 设置手动启用。"
            }, style = MaterialTheme.typography.bodyMedium)
            Text("只使用系统提供的前台应用时段，不读取聊天、键盘、通知或屏幕内容。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(onClick = onOpenUsageSettings, modifier = Modifier.fillMaxWidth()) { Text("管理使用情况访问") }
            OutlinedButton(onClick = onOpenAccessibilitySettings, modifier = Modifier.fillMaxWidth()) { Text("管理限制执行服务") }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onRefreshPermission, enabled = !loading, modifier = Modifier.weight(1f)) { Text("刷新权限") }
                Button(onClick = onRefreshUsage, enabled = hasUsageAccess && !loading, modifier = Modifier.weight(1f)) { BusyLabel(loading, "同步使用事件") }
            }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            TextButton(onClick = { showBackgroundHelp = true }) { Text("后台运行与重启说明") }
        }
    }
    if (showBackgroundHelp) {
        AlertDialog(
            onDismissRequest = { showBackgroundHelp = false },
            title = { Text("后台运行与重启") },
            text = { Text("解锁 Android 且系统重新连接无障碍服务后，FocusGuard 才能继续执行本地规则。部分手机有自启动或后台活动开关；仅在遇到掉线时，按需到系统设置检查。无需开启悬浮窗或锁屏显示。系统锁屏、控制栏、紧急呼叫和授权撤销仍可用。") },
            confirmButton = { TextButton(onClick = { showBackgroundHelp = false }) { Text("知道了") } },
        )
    }
}

@Composable
private fun PermissionRow(label: String, enabled: Boolean) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label)
        Text(if (enabled) "已授权" else "未授权", color = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
private fun UsageCard(dailyRows: List<UsageDailyEntity>, loading: Boolean, onRefresh: () -> Unit) {
    val todayRow = dailyRows.firstOrNull { it.localDate == LocalDate.now().toString() }
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("今日使用", style = MaterialTheme.typography.titleMedium)
                OutlinedButton(onClick = onRefresh, enabled = !loading) { Text("刷新") }
            }
            Text(todayRow?.let { formatMinutes(it.deviceForegroundMillis / 60_000L) } ?: "暂无记录", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Text("统计口径为前台应用区间并集，不等同于屏幕亮屏时间。已载入 ${dailyRows.size} 天本地汇总。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
    var expanded by remember { mutableStateOf(true) }
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            SectionHeader("策略设置", if (policy.enabled) "已启用" else "已暂停", expanded) { expanded = !expanded }
            if (!accessibilityEnabled) {
                Text("规则可以保存，但需要限制执行服务才能真正拦截前台应用。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                OutlinedButton(onClick = onOpenAccessibilitySettings, modifier = Modifier.fillMaxWidth()) { Text("开启限制执行服务") }
            }
            if (expanded) {
                Text("设备总限制", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                LimitField("每日上限（分钟）", dailyLimitMinutes, onDailyLimitChanged)
                LimitField("每周上限（分钟）", weeklyLimitMinutes, onWeeklyLimitChanged)
                LimitField("每月上限（分钟）", monthlyLimitMinutes, onMonthlyLimitChanged)
                SettingSwitch("启用规则", policy.enabled, onPolicyEnabledChanged)
                SettingSwitch("全局锁定（保存后生效）", policy.forceStopped, onForceStoppedChanged)
                Button(onClick = onSave, enabled = !saving, modifier = Modifier.fillMaxWidth()) { BusyLabel(saving, "保存策略") }
            }
        }
    }
}

@Composable
private fun AppLimitsSection(
    apps: List<Pair<String, String>>,
    appLimitValue: (String) -> String,
    appSaving: (String) -> Boolean,
    onAppLimitChanged: (String, String) -> Unit,
    onSaveAppLimit: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            SectionHeader("应用限制", if (apps.isEmpty()) "暂无可管理应用" else "${apps.size} 个应用", expanded) { expanded = !expanded }
            Text("按应用设置每日上限；留空后保存会关闭该应用限制。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (expanded) {
                if (apps.isEmpty()) {
                    Text("授予使用情况访问权限后点击同步使用事件。", style = MaterialTheme.typography.bodySmall)
                } else {
                    apps.forEachIndexed { index, (label, packageName) ->
                        if (index > 0) HorizontalDivider(Modifier.padding(vertical = 4.dp))
                        AppLimitRow(label, packageName, appLimitValue(packageName), appSaving(packageName), onAppLimitChanged, onSaveAppLimit)
                    }
                }
            }
        }
    }
}

@Composable
private fun AppLimitRow(
    label: String,
    packageName: String,
    value: String,
    saving: Boolean,
    onValueChanged: (String, String) -> Unit,
    onSave: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(label, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(packageName, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            LimitField("每日上限（分钟）", value, { onValueChanged(packageName, it) }, Modifier.weight(1f))
            OutlinedButton(onClick = { onSave(packageName) }, enabled = !saving) { BusyLabel(saving, "保存") }
        }
    }
}

@Composable
private fun LimitField(label: String, value: String, onValueChanged: (String) -> Unit, modifier: Modifier = Modifier) {
    val parsed = value.toLongOrNull()
    val invalid = value.isNotBlank() && (parsed == null || parsed !in 1..525_600)
    OutlinedTextField(
        value = value,
        onValueChange = { next -> if (next.isEmpty() || next.all(Char::isDigit)) onValueChanged(next) },
        modifier = modifier.fillMaxWidth(),
        label = { Text(label) },
        singleLine = true,
        isError = invalid,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        supportingText = if (invalid) ({ Text("请输入 1 至 525600 分钟") }) else null,
    )
}

@Composable
private fun SettingSwitch(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
private fun SectionHeader(title: String, status: String, expanded: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(status, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(if (expanded) "收起" else "展开", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
private fun BusyLabel(busy: Boolean, label: String) {
    if (busy) {
        CircularProgressIndicator(Modifier.size(17.dp), strokeWidth = 2.dp)
        Spacer(Modifier.size(7.dp))
    }
    Text(if (busy) "处理中…" else label)
}

private fun SyncState.syncLabel(): String = when (this) {
    SyncState.NotConfigured -> "未配置"
    SyncState.Unpaired -> "未配对"
    SyncState.Offline -> "离线"
    is SyncState.PermissionRequired -> "等待权限"
    SyncState.Syncing -> "同步中"
    SyncState.Synced -> "已同步"
    is SyncState.NetworkError -> "网络错误"
    is SyncState.ServerError -> "服务器错误"
    else -> "命令确认失败"
}

private fun String.toCommandLabel(): String = when (this) {
    "pending" -> "待处理"
    "delivered" -> "已送达"
    "applied", "completed" -> "已执行"
    "rejected", "failed" -> "执行失败"
    "expired" -> "已过期"
    else -> this
}

private fun formatMinutes(minutes: Long): String = when {
    minutes >= 60L -> "${minutes / 60}小时 ${minutes % 60}分钟"
    else -> "${minutes}分钟"
}

private fun formatTimestamp(millis: Long, zoneId: String): String = runCatching {
    DateTimeFormatter.ofPattern("MM-dd HH:mm", Locale.getDefault())
        .withZone(ZoneId.of(zoneId))
        .format(Instant.ofEpochMilli(millis))
}.getOrElse { "时间未知" }
