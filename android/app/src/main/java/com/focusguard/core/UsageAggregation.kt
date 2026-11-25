package com.focusguard.core

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

data class UsageInterval(
    val packageName: String,
    val start: Instant,
    val end: Instant,
) {
    init {
        require(packageName.isNotBlank())
        require(end >= start)
    }
}

data class DailyUsage(
    val date: LocalDate,
    val deviceForegroundMillis: Long,
    val appForegroundMillis: Map<String, Long>,
    val appLaunches: Map<String, Int>,
)

object UsageAggregation {
    /** App time merges overlapping windows per package; device time unions all packages. */
    fun byDay(
        intervals: List<UsageInterval>,
        zone: ZoneId,
        launches: Map<LocalDate, Map<String, Int>> = emptyMap(),
    ): List<DailyUsage> {
        val slices = intervals.flatMap { splitAtLocalMidnight(it, zone) }
        return slices.groupBy { it.first }.toSortedMap().map { (date, daySlices) ->
            val appMillis = daySlices.groupBy { it.second.packageName }.mapValues { (_, rows) ->
                unionMillis(rows.map { it.second.start to it.second.end })
            }
            val deviceMillis = unionMillis(daySlices.map { it.second.start to it.second.end })
            DailyUsage(date, deviceMillis, appMillis, launches[date].orEmpty())
        }
    }

    fun weekStart(date: LocalDate): LocalDate =
        date.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))

    fun monthStart(date: LocalDate): LocalDate = date.withDayOfMonth(1)
    fun monthEndExclusive(date: LocalDate): LocalDate = YearMonth.from(date).plusMonths(1).atDay(1)

    private fun splitAtLocalMidnight(
        interval: UsageInterval,
        zone: ZoneId,
    ): List<Pair<LocalDate, UsageInterval>> {
        if (interval.start == interval.end) return emptyList()
        val result = mutableListOf<Pair<LocalDate, UsageInterval>>()
        var cursor = interval.start
        while (cursor < interval.end) {
            val date = cursor.atZone(zone).toLocalDate()
            val nextMidnight = date.plusDays(1).atStartOfDay(zone).toInstant()
            val boundary = minOf(interval.end, nextMidnight)
            result += date to interval.copy(start = cursor, end = boundary)
            cursor = boundary
        }
        return result
    }

    private fun unionMillis(intervals: List<Pair<Instant, Instant>>): Long {
        if (intervals.isEmpty()) return 0
        val sorted = intervals.sortedBy { it.first }
        var start = sorted.first().first
        var end = sorted.first().second
        var total = 0L
        for ((nextStart, nextEnd) in sorted.drop(1)) {
            if (nextStart <= end) {
                if (nextEnd > end) end = nextEnd
            } else {
                total += end.toEpochMilli() - start.toEpochMilli()
                start = nextStart
                end = nextEnd
            }
        }
        return total + end.toEpochMilli() - start.toEpochMilli()
    }
}
