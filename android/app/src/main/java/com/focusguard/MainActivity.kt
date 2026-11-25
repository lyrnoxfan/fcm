package com.focusguard

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.focusguard.usage.UsageRepository
import java.time.LocalDate
import java.time.ZoneId
import com.focusguard.data.UsageDailyEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private val repository by lazy { UsageRepository(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                var hasPermission by remember { mutableStateOf(repository.hasUsageAccess()) }
                var loading by remember { mutableStateOf(false) }
                var message by remember { mutableStateOf<String?>(null) }
                var apps by remember { mutableStateOf(emptyList<Pair<String, String>>()) }
                var dailyRows by remember { mutableStateOf(emptyList<UsageDailyEntity>()) }
                LaunchedEffect(hasPermission) {
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
                                    if (!hasPermission) loading = false
                                }) { Text("刷新权限状态") }
                                Button(onClick = { loading = true; hasPermission = true }) { Text("同步使用事件") }
                            }
                            if (loading) CircularProgressIndicator()
                            message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                            val todayUsage = dailyRows.lastOrNull()?.deviceForegroundMillis ?: 0L
                            Text("今日设备前台使用：${todayUsage / 60_000} 分钟", style = MaterialTheme.typography.titleMedium)
                            Text("统计口径：前台应用区间的并集；不是屏幕亮屏时间。", style = MaterialTheme.typography.bodySmall)
                            Text("已安装且可启动的应用", style = MaterialTheme.typography.titleMedium)
                            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(apps, key = { it.first }) { (label, packageName) ->
                                    Card(modifier = Modifier.fillMaxWidth()) {
                                        Column(Modifier.padding(12.dp)) {
                                            Text(label, style = MaterialTheme.typography.titleSmall)
                                            Text(packageName, style = MaterialTheme.typography.bodySmall)
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

    override fun onResume() {
        super.onResume()
        // Compose state is refreshed by the user-facing button after returning from Settings.
    }

    private fun listManageableApps(): List<Pair<String, String>> {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return packageManager.queryIntentActivities(intent, 0)
            .map { it.loadLabel(packageManager).toString() to it.activityInfo.packageName }
            .distinctBy { it.second }
            .sortedBy { it.first.lowercase() }
    }
}
