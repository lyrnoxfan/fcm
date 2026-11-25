package com.focusguard.enforcement

import android.app.Activity
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

class BlockedActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val packageName = intent.getStringExtra(EXTRA_PACKAGE_NAME).orEmpty()
        val reason = intent.getStringExtra(EXTRA_REASON).orEmpty()
        val usedMillis = intent.getLongExtra(EXTRA_USED_MILLIS, 0L)
        val limitMillis = intent.getLongExtra(EXTRA_LIMIT_MILLIS, -1L)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("暂时限制此应用", style = MaterialTheme.typography.headlineSmall)
                        Text("应用：$packageName")
                        Text("原因：${reasonLabel(reason)}")
                        if (limitMillis >= 0) Text("已使用 ${usedMillis / 60_000} 分钟 / 上限 ${limitMillis / 60_000} 分钟")
                        Text("此限制由用户授权的无障碍服务展示，普通模式不是不可绕过的系统级禁用。电话与系统紧急功能始终可用。")
                        Button(onClick = { finish() }) { Text("返回桌面") }
                        Button(onClick = {
                            startActivity(android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS))
                        }) { Text("管理无障碍权限") }
                    }
                }
            }
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        // Back navigation remains available; this is not a system lock screen.
        super.onBackPressed()
    }

    private fun reasonLabel(value: String): String = when (value) {
        "FORCE_STOP" -> "设备处于立即停止状态"
        "SCHEDULE" -> "当前处于设定的限制时段"
        "DEVICE_LIMIT" -> "设备使用时长达到上限"
        "APP_LIMIT" -> "此应用使用时长达到上限"
        else -> "本地规则要求限制"
    }

    companion object {
        const val EXTRA_PACKAGE_NAME = "focusguard.package"
        const val EXTRA_REASON = "focusguard.reason"
        const val EXTRA_USED_MILLIS = "focusguard.used"
        const val EXTRA_LIMIT_MILLIS = "focusguard.limit"
    }
}
