package com.focusguard.enforcement

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import com.focusguard.core.PolicyEngine
import com.focusguard.usage.UsageRepository
import com.focusguard.sync.SyncCoordinator
import java.time.ZonedDateTime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/** User-enabled observer; ordinary apps cannot provide unbypassable app disabling. */
class PolicyAccessibilityService : AccessibilityService() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val handler = Handler(Looper.getMainLooper())
    private val repository by lazy { UsageRepository(this) }
    private var foregroundPackage: String? = null
    private val restrictionVisible = AtomicBoolean(false)
    private val syncInFlight = AtomicBoolean(false)

    private val reevaluate = object : Runnable {
        override fun run() {
            if (!restrictionVisible.get()) foregroundPackage?.let(::evaluatePackage)
            if (syncInFlight.compareAndSet(false, true)) {
                serviceScope.launch {
                    try { SyncCoordinator(this@PolicyAccessibilityService).sync(accessibilityEnabled = true) }
                    finally { syncInFlight.set(false) }
                }
            }
            handler.postDelayed(this, EVALUATION_INTERVAL_MS)
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        activeInstance = this
        handler.removeCallbacks(reevaluate)
        handler.post(reevaluate)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val packageName = event.packageName?.toString() ?: return
        if (packageName == applicationContext.packageName) {
            restrictionVisible.set(true)
            return
        }
        if (packageName != foregroundPackage || restrictionVisible.get()) {
            restrictionVisible.set(false)
            foregroundPackage = packageName
            handler.removeCallbacks(reevaluate)
            evaluatePackage(packageName)
            handler.postDelayed(reevaluate, EVALUATION_INTERVAL_MS)
        }
    }

    private fun evaluatePackage(packageName: String) {
        serviceScope.launch {
            runCatching {
                repository.refreshHistory()
                val decision = PolicyEngine.evaluate(
                    repository.loadPolicy(),
                    repository.snapshotAt(ZonedDateTime.now()),
                    packageName,
                )
                if (decision.blocked && restrictionVisible.compareAndSet(false, true)) {
                    handler.removeCallbacks(reevaluate)
                    startActivity(
                        Intent(this@PolicyAccessibilityService, BlockedActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                            .putExtra(BlockedActivity.EXTRA_PACKAGE_NAME, packageName)
                            .putExtra(BlockedActivity.EXTRA_REASON, decision.reason?.name)
                            .putExtra(BlockedActivity.EXTRA_USED_MILLIS, decision.usedMillis)
                            .putExtra(BlockedActivity.EXTRA_LIMIT_MILLIS, decision.limitMillis ?: -1L),
                    )
                }
            }
        }
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        handler.removeCallbacks(reevaluate)
        if (activeInstance === this) activeInstance = null
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun reevaluateCurrentForeground() {
        handler.post {
            val packageName = foregroundPackage ?: return@post
            // A remote lock/unlock/policy update must not wait for a window event.
            restrictionVisible.set(false)
            handler.removeCallbacks(reevaluate)
            evaluatePackage(packageName)
            handler.postDelayed(reevaluate, EVALUATION_INTERVAL_MS)
        }
    }

    companion object {
        private const val EVALUATION_INTERVAL_MS = 5_000L
        @Volatile private var activeInstance: PolicyAccessibilityService? = null

        /** Called by sync workers/services after a policy or lock command is applied. */
        fun requestForegroundReevaluation() {
            activeInstance?.reevaluateCurrentForeground()
        }
    }
}
