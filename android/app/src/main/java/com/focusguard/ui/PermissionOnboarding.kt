package com.focusguard.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun PermissionOnboarding(
    usage: Boolean, accessibility: Boolean, notifications: Boolean?,
    onUsage: () -> Unit, onAccessibility: () -> Unit, onNotifications: () -> Unit,
    onDone: () -> Unit,
) {
    val complete = usage && accessibility && notifications != false
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text("设置 FocusGuard") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("按需前往系统设置授权。你可以现在跳过，也可以随时在 Android 设置里查看或撤销。")
                PermissionStep("使用情况访问", "统计应用使用时长。", usage, onUsage)
                PermissionStep("无障碍服务", "检测当前应用并按规则提示限制。不读取聊天、键盘或屏幕内容。", accessibility, onAccessibility)
                if (notifications != null) PermissionStep("通知 · 可选", "显示后台同步状态。", notifications, onNotifications)
            }
        },
        confirmButton = { TextButton(onClick = onDone) { Text(if (complete) "完成" else "稍后设置") } },
    )
}

@Composable
private fun PermissionStep(title: String, description: String, granted: Boolean, onRequest: () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(description, style = MaterialTheme.typography.bodySmall)
        }
        if (granted) Text("已授权", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
        else OutlinedButton(onClick = onRequest) { Text("授权") }
    }
}
