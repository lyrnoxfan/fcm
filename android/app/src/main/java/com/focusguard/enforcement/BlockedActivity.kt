package com.focusguard.enforcement

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.focusguard.core.BlockReason
import com.focusguard.ui.FocusGuardTheme
import com.focusguard.usage.UsageRepository
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class BlockedActivity : ComponentActivity() {
    private val globalLock = mutableStateOf(false)
    private val restriction = mutableStateOf(Intent())
    private val repository by lazy { UsageRepository(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        updateRestriction(intent)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                while (true) {
                    if (!PolicyAccessibilityService.connected) { finish(); break }
                    val forced = repository.loadPolicy().forceStopped
                    if (globalLock.value && !forced) { finish(); break }
                    if (forced) globalLock.value = true
                    delay(400)
                }
            }
        }
        setContent {
            FocusGuardTheme {
                BackHandler(enabled = globalLock.value) { /* System Home, keyguard and Settings stay available. */ }
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    if (globalLock.value) {
                        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("设备已被锁定", Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium)
                        }
                    } else {
                        val details = restriction.value
                        val limit = details.getLongExtra(EXTRA_LIMIT_MILLIS, -1L)
                        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text("暂时限制此应用", style = MaterialTheme.typography.headlineSmall)
                            Text("应用：${details.getStringExtra(EXTRA_PACKAGE_NAME).orEmpty()}")
                            Text(when (details.getStringExtra(EXTRA_REASON)) {
                                "SCHEDULE" -> "当前处于设定的限制时段"
                                "DEVICE_LIMIT" -> "设备使用时长达到上限"
                                "APP_LIMIT" -> "此应用使用时长达到上限"
                                else -> "本地规则要求限制"
                            })
                            if (limit >= 0) Text("已使用 ${details.getLongExtra(EXTRA_USED_MILLIS, 0L) / 60_000} 分钟 / 上限 ${limit / 60_000} 分钟")
                            Button(onClick = { finish() }) { Text("返回") }
                        }
                    }
                }
            }
        }
    }

    private fun updateRestriction(intent: Intent) {
        restriction.value = intent
        globalLock.value = intent.getStringExtra(EXTRA_REASON) == BlockReason.FORCE_STOP.name
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        updateRestriction(intent)
    }

    override fun onResume() { super.onResume(); isResumed = true }
    override fun onPause() { isResumed = false; super.onPause() }

    companion object {
        var isResumed = false
            private set
        const val EXTRA_PACKAGE_NAME = "focusguard.package"
        const val EXTRA_REASON = "focusguard.reason"
        const val EXTRA_USED_MILLIS = "focusguard.used"
        const val EXTRA_LIMIT_MILLIS = "focusguard.limit"
    }
}
