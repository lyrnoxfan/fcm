package com.focusguard.core

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZonedDateTime

enum class UsagePeriod { DAY, WEEK, MONTH }

data class UsageTarget(val packageName: String?) {
    val isDevice: Boolean get() = packageName == null
}

data class UsageLimitRule(
    val target: UsageTarget,
    val period: UsagePeriod,
    val limitMillis: Long,
    val enabled: Boolean = true,
) {
    init { require(limitMillis >= 0) }
}

data class ScheduleRule(
    val target: UsageTarget,
    val days: Set<DayOfWeek>,
    val start: LocalTime,
    val end: LocalTime,
    val enabled: Boolean = true,
) {
    init { require(days.isNotEmpty()); require(start != end) }

    fun isActiveAt(now: ZonedDateTime): Boolean {
        if (!enabled) return false
        val time = now.toLocalTime()
        return if (start < end) {
            now.dayOfWeek in days && time >= start && time < end
        } else {
            (now.dayOfWeek in days && time >= start) ||
                (now.toLocalDate().minusDays(1).dayOfWeek in days && time < end)
        }
    }
}

data class TemporaryExtension(
    val target: UsageTarget,
    val extraMillis: Long,
    val expiresAt: ZonedDateTime,
) {
    init { require(extraMillis > 0) }
}

data class PolicyConfig(
    val enabled: Boolean = true,
    val forceStopped: Boolean = false,
    val limits: List<UsageLimitRule> = emptyList(),
    val schedules: List<ScheduleRule> = emptyList(),
    val whitelist: Set<String> = emptySet(),
    val protectedPackages: Set<String> = emptySet(),
    val extensions: List<TemporaryExtension> = emptyList(),
)

data class UsageSnapshot(
    val now: ZonedDateTime,
    val deviceMillis: Map<UsagePeriod, Long> = emptyMap(),
    val appMillis: Map<String, Map<UsagePeriod, Long>> = emptyMap(),
)

enum class BlockReason { FORCE_STOP, SCHEDULE, DEVICE_LIMIT, APP_LIMIT }

data class PolicyDecision(
    val blocked: Boolean,
    val reason: BlockReason? = null,
    val packageName: String? = null,
    val usedMillis: Long = 0,
    val limitMillis: Long? = null,
    val remainingMillis: Long? = null,
)

/** Deterministic local policy evaluation. It performs no network or background scheduling. */
object PolicyEngine {
    private val essentialPackages = setOf(
        "com.android.phone", "com.android.dialer", "com.google.android.dialer",
        "com.android.emergency", "com.google.android.apps.emergencyassist",
        "com.android.settings", "com.android.systemui", "com.android.permissioncontroller",
        "com.google.android.permissioncontroller",
    )

    fun evaluate(config: PolicyConfig, snapshot: UsageSnapshot, foregroundPackage: String): PolicyDecision {
        if (!config.enabled || foregroundPackage in essentialPackages || foregroundPackage in config.protectedPackages || foregroundPackage in config.whitelist) {
            return PolicyDecision(false)
        }
        if (config.forceStopped) return PolicyDecision(true, BlockReason.FORCE_STOP, foregroundPackage)

        val activeSchedule = config.schedules.firstOrNull { rule ->
            rule.isActiveAt(snapshot.now) && (rule.target.isDevice || rule.target.packageName == foregroundPackage)
        }
        if (activeSchedule != null) return PolicyDecision(true, BlockReason.SCHEDULE, foregroundPackage)

        val applicable = config.limits.asSequence()
            .filter { it.enabled && (it.target.isDevice || it.target.packageName == foregroundPackage) }
            .map { rule ->
                val used = if (rule.target.isDevice) snapshot.deviceMillis[rule.period] ?: 0L
                    else snapshot.appMillis[foregroundPackage]?.get(rule.period) ?: 0L
                val extension = config.extensions.asSequence()
                    .filter { it.expiresAt.isAfter(snapshot.now) }
                    .filter { it.target == rule.target }
                    .sumOf { it.extraMillis }
                Triple(rule, used, rule.limitMillis + extension)
            }
            .filter { (_, used, limit) -> used >= limit }
            .minByOrNull { (_, used, limit) -> used - limit }
            ?: return PolicyDecision(false)

        val (rule, used, limit) = applicable
        return PolicyDecision(
            blocked = true,
            reason = if (rule.target.isDevice) BlockReason.DEVICE_LIMIT else BlockReason.APP_LIMIT,
            packageName = foregroundPackage,
            usedMillis = used,
            limitMillis = limit,
            remainingMillis = (limit - used).coerceAtLeast(0),
        )
    }

    fun periodStart(date: LocalDate, period: UsagePeriod): LocalDate = when (period) {
        UsagePeriod.DAY -> date
        UsagePeriod.WEEK -> date.minusDays((date.dayOfWeek.value - DayOfWeek.MONDAY.value).toLong())
        UsagePeriod.MONTH -> date.withDayOfMonth(1)
    }
}
