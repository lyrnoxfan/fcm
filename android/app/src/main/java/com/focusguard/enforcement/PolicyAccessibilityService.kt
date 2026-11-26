package com.focusguard.enforcement

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.telecom.TelecomManager
import android.view.accessibility.AccessibilityEvent
import com.focusguard.core.PolicyEngine
import com.focusguard.sync.SyncCoordinator
import com.focusguard.usage.UsageRepository
import java.time.ZonedDateTime
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest

/** Best-effort enforcement. It never changes system permissions or takes over the keyguard. */
class PolicyAccessibilityService : AccessibilityService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val handler = Handler(Looper.getMainLooper())
    private val repository by lazy { UsageRepository(this) }
    private var foregroundPackage: String? = null
    private var evaluation: Job? = null
    private var sync: Job? = null
    private var policyObserver: Job? = null
    private var lastLaunchAt = 0L
    private var reconnectRecoveryUntil = 0L

    private val reevaluate = object : Runnable {
        override fun run() {
            foregroundPackage?.takeIf { evaluation?.isActive != true }?.let(::evaluatePackage)
            if (foregroundPackage == null || android.os.SystemClock.elapsedRealtime() < reconnectRecoveryUntil) scope.launch(Dispatchers.IO) {
                val recovered = runCatching { repository.mostRecentForegroundPackage() }.getOrNull()
                if (recovered != null) withContext(Dispatchers.Main.immediate) {
                    if (recovered != foregroundPackage) {
                        lastLaunchAt = 0L
                        foregroundPackage = recovered
                        android.util.Log.i("FocusGuard", "Recovered foreground package after service reconnect")
                        evaluatePackage(recovered)
                    }
                }
            }
            if (sync?.isActive != true) sync = scope.launch(Dispatchers.IO) {
                runCatching { SyncCoordinator(this@PolicyAccessibilityService).sync(accessibilityEnabled = true) }
            }
            handler.postDelayed(this, EVALUATION_INTERVAL_MS)
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        activeInstance = this
        _connection.value = true
        // Do not trust a package cached before a disconnect: Android may not replay the resumed window event.
        foregroundPackage = null
        reconnectRecoveryUntil = android.os.SystemClock.elapsedRealtime() + 30_000L
        android.util.Log.i("FocusGuard", "Accessibility service connected")
        policyObserver?.cancel()
        policyObserver = scope.launch {
            repository.observePolicy().collectLatest { foregroundPackage?.let(::evaluatePackage) }
        }
        handler.removeCallbacks(reevaluate)
        handler.post(reevaluate)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val name = event.packageName?.toString() ?: return
        if (name == packageName && (event.className?.toString() == BlockedActivity::class.java.name || BlockedActivity.isResumed)) return
        if (foregroundPackage != name) lastLaunchAt = 0L
        foregroundPackage = name
        if (evaluation?.isActive != true || name != evaluatedPackage) evaluatePackage(name)
    }

    private var evaluatedPackage: String? = null
    private fun evaluatePackage(name: String) {
        evaluation?.cancel()
        evaluatedPackage = name
        evaluation = scope.launch {
            try {
                val config = repository.loadPolicy()
                val exemptions = buildSet {
                    getSystemService(TelecomManager::class.java)?.defaultDialerPackage?.let(::add)
                    getSystemService(TelecomManager::class.java)?.systemDialerPackage?.let(::add)
                    // Resolve Android's own Settings app, not arbitrary packages handling the intent.
                    packageManager.resolveActivity(Intent(Settings.ACTION_SETTINGS), android.content.pm.PackageManager.MATCH_SYSTEM_ONLY)
                        ?.activityInfo?.packageName?.let(::add)
                }
                val decision = PolicyEngine.forceStopDecision(config, name, exemptions) ?: run {
                    if (name == packageName || !config.enabled || !repository.hasUsageAccess()) return@launch
                    repository.refreshHistory()
                    PolicyEngine.evaluate(config, repository.snapshotAt(ZonedDateTime.now()), name, exemptions)
                }
                if (foregroundPackage != name || !decision.blocked || BlockedActivity.isResumed) return@launch
                if (getSystemService(KeyguardManager::class.java)?.isKeyguardLocked == true ||
                    getSystemService(PowerManager::class.java)?.isInteractive != true) return@launch
                val now = android.os.SystemClock.elapsedRealtime()
                if (lastLaunchAt != 0L && now - lastLaunchAt < 1000L) return@launch
                lastLaunchAt = now
                startActivity(
                    Intent(this@PolicyAccessibilityService, BlockedActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        .putExtra(BlockedActivity.EXTRA_PACKAGE_NAME, name)
                        .putExtra(BlockedActivity.EXTRA_REASON, decision.reason?.name)
                        .putExtra(BlockedActivity.EXTRA_USED_MILLIS, decision.usedMillis)
                        .putExtra(BlockedActivity.EXTRA_LIMIT_MILLIS, decision.limitMillis ?: -1L),
                )
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                android.util.Log.w("FocusGuard", "Restriction could not be shown (${error.javaClass.simpleName})")
            }
        }
    }

    override fun onInterrupt() = Unit

    private fun disconnect() {
        handler.removeCallbacks(reevaluate)
        policyObserver?.cancel()
        evaluation?.cancel()
        sync?.cancel()
        foregroundPackage = null
        evaluatedPackage = null
        if (activeInstance === this) {
            activeInstance = null
            _connection.value = false
            android.util.Log.i("FocusGuard", "Accessibility service disconnected")
        }
    }

    override fun onUnbind(intent: Intent?): Boolean {
        disconnect()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        disconnect()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val EVALUATION_INTERVAL_MS = 5_000L
        @Volatile private var activeInstance: PolicyAccessibilityService? = null
        private val _connection = MutableStateFlow(false)
        val connection = _connection.asStateFlow()
        val connected: Boolean get() = _connection.value

        /** Called by sync workers/services after a policy or lock command is applied. */
        fun requestForegroundReevaluation() {
            val service = activeInstance ?: return
            service.handler.post { service.foregroundPackage?.let(service::evaluatePackage) }
        }
    }
}
