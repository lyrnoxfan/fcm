package com.focusguard.core

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyEngineTest {
    private val zone = ZoneId.of("Asia/Kolkata")
    private fun now(value: String) = ZonedDateTime.parse(value).withZoneSameInstant(zone)

    @Test fun appDailyLimitBlocksOnlyTheTargetApp() {
        val config = PolicyConfig(limits = listOf(UsageLimitRule(UsageTarget("video.app"), UsagePeriod.DAY, 60_000)))
        val snapshot = UsageSnapshot(now("2026-11-25T10:00:00Z"), appMillis = mapOf("video.app" to mapOf(UsagePeriod.DAY to 60_000)))
        val blocked = PolicyEngine.evaluate(config, snapshot, "video.app")
        assertTrue(blocked.blocked)
        assertEquals(BlockReason.APP_LIMIT, blocked.reason)
        assertFalse(PolicyEngine.evaluate(config, snapshot, "chat.app").blocked)
    }

    @Test fun deviceCapAppliesToAnyNonProtectedAppAndShowsUsage() {
        val config = PolicyConfig(
            limits = listOf(UsageLimitRule(UsageTarget(null), UsagePeriod.WEEK, 120_000)),
            protectedPackages = setOf("com.android.dialer"),
        )
        val snapshot = UsageSnapshot(now("2026-11-25T10:00:00Z"), deviceMillis = mapOf(UsagePeriod.WEEK to 130_000))
        val decision = PolicyEngine.evaluate(config, snapshot, "chat.app")
        assertEquals(BlockReason.DEVICE_LIMIT, decision.reason)
        assertEquals(130_000L, decision.usedMillis)
        assertFalse(PolicyEngine.evaluate(config, snapshot, "com.android.dialer").blocked)
    }

    @Test fun overnightScheduleUsesPreviousSelectedWeekday() {
        val rule = ScheduleRule(UsageTarget("game.app"), setOf(DayOfWeek.MONDAY), LocalTime.of(22, 0), LocalTime.of(6, 0))
        assertTrue(rule.isActiveAt(now("2026-11-23T19:30:00Z"))) // Tue 01:00 IST, Mon overnight
        assertFalse(rule.isActiveAt(now("2026-11-24T04:00:00Z"))) // Tue 09:30 IST, outside window
    }

    @Test fun extensionRaisesCapOnlyBeforeItsExpiry() {
        val config = PolicyConfig(
            limits = listOf(UsageLimitRule(UsageTarget("video.app"), UsagePeriod.DAY, 60_000)),
            extensions = listOf(TemporaryExtension(UsageTarget("video.app"), 30_000, now("2026-11-25T11:00:00Z"))),
        )
        val usage = mapOf("video.app" to mapOf(UsagePeriod.DAY to 75_000L))
        assertFalse(PolicyEngine.evaluate(config, UsageSnapshot(now("2026-11-25T10:00:00Z"), appMillis = usage), "video.app").blocked)
        assertTrue(PolicyEngine.evaluate(config, UsageSnapshot(now("2026-11-25T12:00:00Z"), appMillis = usage), "video.app").blocked)
    }

    @Test fun manualStopIsOverriddenByWhitelistButNotProtectedPackages() {
        val config = PolicyConfig(forceStopped = true, whitelist = setOf("chat.app"), protectedPackages = setOf("phone.app"))
        val snapshot = UsageSnapshot(now("2026-11-25T10:00:00Z"))
        assertFalse(PolicyEngine.evaluate(config, snapshot, "chat.app").blocked)
        assertFalse(PolicyEngine.evaluate(config, snapshot, "phone.app").blocked)
        assertTrue(PolicyEngine.evaluate(config, snapshot, "video.app").blocked)
    }

    @Test fun periodsStartOnLocalDayMondayAndMonthBoundaries() {
        val date = LocalDate.parse("2026-12-01")
        assertEquals(LocalDate.parse("2026-12-01"), PolicyEngine.periodStart(date, UsagePeriod.DAY))
        assertEquals(LocalDate.parse("2026-11-30"), PolicyEngine.periodStart(date, UsagePeriod.WEEK))
        assertEquals(LocalDate.parse("2026-12-01"), PolicyEngine.periodStart(date, UsagePeriod.MONTH))
    }
}
