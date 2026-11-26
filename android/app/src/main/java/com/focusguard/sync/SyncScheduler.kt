package com.focusguard.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

object SyncScheduler {
    private const val PERIODIC_NAME = "focusguard-periodic-sync"
    private const val NOW_NAME = "focusguard-on-demand-sync"

    fun schedule(context: Context) {
        val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
            PERIODIC_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            PeriodicWorkRequestBuilder<FocusGuardSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build(),
        )
    }

    /** Optional notification/push integrations can call this without requiring FCM in the app. */
    fun requestNow(context: Context) {
        val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            NOW_NAME,
            ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<FocusGuardSyncWorker>().setConstraints(constraints).build(),
        )
    }

    /** Explicit opt-in hook for settings/UI without coupling the scheduler to UI code. */
    fun enableForegroundSync(context: Context) = SyncForegroundService.start(context)

    /** Explicit opt-out hook; WorkManager fallback remains available. */
    fun disableForegroundSync(context: Context) = SyncForegroundService.stop(context)
}
