package com.focusguard.usage

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Process
import android.provider.Settings
import com.focusguard.core.UsageAggregation
import com.focusguard.core.UsageInterval
import com.focusguard.data.UsageDailyEntity
import com.focusguard.data.UsageDatabase
import com.focusguard.data.UsageEventEntity
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import org.json.JSONObject

class UsageRepository(context: Context) {
    private val appContext = context.applicationContext
    private val database = UsageDatabase.get(appContext)

    fun hasUsageAccess(): Boolean {
        val appOps = appContext.getSystemService(AppOpsManager::class.java)
        return appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), appContext.packageName) == AppOpsManager.MODE_ALLOWED
    }

    fun usageAccessSettingsIntent(): Intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)

    fun dailyRows(from: String, through: String): Flow<List<UsageDailyEntity>> =
        database.usageDao().dailyBetween(from, through)

    suspend fun refreshHistory(now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()) = withContext(Dispatchers.IO) {
        if (!hasUsageAccess()) return@withContext
        val dao = database.usageDao()
        val manager = appContext.getSystemService(UsageStatsManager::class.java)
        val last = dao.latestEventMillis()
        val from = last?.minus(2 * 60 * 60 * 1000L) ?: now.minusSeconds(32L * 24 * 3600).toEpochMilli()
        val eventCursor = manager.queryEvents(from, now.toEpochMilli())
        val newEvents = mutableListOf<UsageEventEntity>()
        val event = UsageEvents.Event()
        while (eventCursor.hasNextEvent()) {
            eventCursor.getNextEvent(event)
            val packageName = event.packageName ?: continue
            newEvents += UsageEventEntity(event.timeStamp, packageName, event.eventType)
        }
        dao.insertEvents(newEvents.distinctBy { Triple(it.occurredAtMillis, it.packageName, it.eventType) })

        val intervals = mutableListOf<UsageInterval>()
        val activeCounts = mutableMapOf<String, Int>()
        val starts = mutableMapOf<String, Long>()
        val launches = mutableMapOf<LocalDate, MutableMap<String, Int>>()
        for (row in dao.allEvents()) {
            when (row.eventType) {
                UsageEvents.Event.ACTIVITY_RESUMED, UsageEvents.Event.MOVE_TO_FOREGROUND -> {
                    val count = activeCounts[row.packageName] ?: 0
                    if (count == 0) {
                        starts[row.packageName] = row.occurredAtMillis
                        val date = Instant.ofEpochMilli(row.occurredAtMillis).atZone(zone).toLocalDate()
                        val day = launches.getOrPut(date) { mutableMapOf() }
                        day[row.packageName] = (day[row.packageName] ?: 0) + 1
                    }
                    activeCounts[row.packageName] = count + 1
                }
                UsageEvents.Event.ACTIVITY_PAUSED, UsageEvents.Event.MOVE_TO_BACKGROUND -> {
                    val count = activeCounts[row.packageName] ?: continue
                    if (count <= 1) {
                        activeCounts.remove(row.packageName)
                        val start = starts.remove(row.packageName) ?: continue
                        if (row.occurredAtMillis >= start) intervals += UsageInterval(row.packageName, Instant.ofEpochMilli(start), Instant.ofEpochMilli(row.occurredAtMillis))
                    } else activeCounts[row.packageName] = count - 1
                }
            }
        }
        activeCounts.keys.forEach { packageName ->
            val start = starts[packageName] ?: return@forEach
            if (now.toEpochMilli() >= start) intervals += UsageInterval(packageName, Instant.ofEpochMilli(start), now)
        }

        val daily = UsageAggregation.byDay(intervals, zone, launches).map { row ->
            val apps = JSONObject().apply { row.appForegroundMillis.forEach { (pkg, millis) -> put(pkg, millis) } }
            val counts = JSONObject().apply { row.appLaunches.forEach { (pkg, count) -> put(pkg, count) } }
            UsageDailyEntity(row.date.toString(), zone.id, row.deviceForegroundMillis, apps.toString(), counts.toString(), now.toEpochMilli())
        }
        dao.clearDaily()
        dao.upsertDaily(daily)
    }
}
