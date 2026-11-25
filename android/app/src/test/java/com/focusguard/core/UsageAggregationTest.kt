package com.focusguard.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class UsageAggregationTest {
    private val zone = ZoneId.of("Asia/Kolkata")
    private fun at(value: String) = Instant.parse(value)

    @Test
    fun overlappingAppsAreDeduplicatedForDeviceAndPerApp() {
        val result = UsageAggregation.byDay(
            listOf(
                UsageInterval("app.a", at("2026-11-25T04:00:00Z"), at("2026-11-25T04:30:00Z")),
                UsageInterval("app.a", at("2026-11-25T04:20:00Z"), at("2026-11-25T04:40:00Z")),
                UsageInterval("app.b", at("2026-11-25T04:10:00Z"), at("2026-11-25T04:50:00Z")),
            ), zone,
        ).single()
        assertEquals(50 * 60_000L, result.deviceForegroundMillis)
        assertEquals(40 * 60_000L, result.appForegroundMillis["app.a"])
        assertEquals(40 * 60_000L, result.appForegroundMillis["app.b"])
    }

    @Test
    fun splitsAtLocalDayBoundaryWithoutLosingTime() {
        val rows = UsageAggregation.byDay(
            listOf(UsageInterval("app", at("2026-11-24T18:20:00Z"), at("2026-11-24T18:50:00Z"))), zone,
        )
        assertEquals(listOf(LocalDate.parse("2026-11-24"), LocalDate.parse("2026-11-25")), rows.map { it.date })
        assertEquals(listOf(10L, 20L), rows.map { it.deviceForegroundMillis / 60_000 })
    }

    @Test
    fun periodBoundariesUseMondayAndCalendarMonths() {
        val date = LocalDate.parse("2026-12-01")
        assertEquals(LocalDate.parse("2026-11-30"), UsageAggregation.weekStart(date))
        assertEquals(LocalDate.parse("2026-12-01"), UsageAggregation.monthStart(date))
        assertEquals(LocalDate.parse("2027-01-01"), UsageAggregation.monthEndExclusive(date))
    }

    @Test
    fun zeroLengthIntervalsDoNotProduceRows() {
        assertEquals(
            emptyList<DailyUsage>(),
            UsageAggregation.byDay(
                listOf(UsageInterval("app", at("2026-11-25T00:00:00Z"), at("2026-11-25T00:00:00Z"))), zone,
            ),
        )
    }
}
