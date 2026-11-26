package com.focusguard.data

import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import com.focusguard.core.PolicyConfig
import com.focusguard.core.ScheduleRule
import com.focusguard.core.TemporaryExtension
import com.focusguard.core.UsageLimitRule
import com.focusguard.core.UsagePeriod
import com.focusguard.core.UsageTarget
import java.time.DayOfWeek
import java.time.LocalTime
import java.time.ZonedDateTime
import kotlinx.coroutines.flow.Flow
import org.json.JSONArray
import org.json.JSONObject

@Entity(tableName = "local_policy")
data class PolicyEntity(
    @PrimaryKey val id: Int = 1,
    val version: Long,
    val serverVersion: Long,
    val configJson: String,
    val updatedAtMillis: Long,
)

@Dao
interface PolicyDao {
    @Query("SELECT * FROM local_policy WHERE id = 1")
    fun observe(): Flow<PolicyEntity?>

    @Query("SELECT * FROM local_policy WHERE id = 1")
    suspend fun get(): PolicyEntity?

    @Upsert
    suspend fun save(policy: PolicyEntity)
}

object PolicyDatabaseMigration : Migration(1, 2) {
    override fun migrate(database: SupportSQLiteDatabase) {
        database.execSQL("CREATE TABLE IF NOT EXISTS local_policy (id INTEGER NOT NULL PRIMARY KEY, version INTEGER NOT NULL, configJson TEXT NOT NULL, updatedAtMillis INTEGER NOT NULL)")
    }
}

class PolicyStore(private val dao: PolicyDao) {
    fun observe(): Flow<PolicyEntity?> = dao.observe()
    suspend fun load(): PolicyConfig = runCatching {
        dao.get()?.configJson?.let(PolicyCodec::decode) ?: PolicyConfig()
    }.getOrElse { PolicyConfig() }

    /** Last server policy version used for conditional sync. Local edits do not advance it. */
    suspend fun version(): Long = dao.get()?.serverVersion ?: 0L

    suspend fun save(config: PolicyConfig, nowMillis: Long = System.currentTimeMillis()): Long {
        val current = dao.get()
        val version = (current?.version ?: 0L) + 1L
        dao.save(PolicyEntity(version = version, serverVersion = current?.serverVersion ?: 0L, configJson = PolicyCodec.encode(config), updatedAtMillis = nowMillis))
        return version
    }

    suspend fun saveRemote(config: PolicyConfig, version: Long, nowMillis: Long = System.currentTimeMillis()): Boolean {
        val current = dao.get()
        if (version <= (current?.serverVersion ?: 0L)) return false
        dao.save(PolicyEntity(version = (current?.version ?: 0L) + 1L, serverVersion = version, configJson = PolicyCodec.encode(config), updatedAtMillis = nowMillis))
        return true
    }
}

object PolicyCodec {
    fun encode(config: PolicyConfig): String = JSONObject().apply {
        put("enabled", config.enabled)
        put("forceStopped", config.forceStopped)
        put("whitelist", JSONArray(config.whitelist.sorted()))
        put("protectedPackages", JSONArray(config.protectedPackages.sorted()))
        put("limits", JSONArray().apply {
            config.limits.forEach { rule ->
                put(JSONObject().put("packageName", rule.target.packageName ?: JSONObject.NULL)
                    .put("period", rule.period.name).put("limitMillis", rule.limitMillis).put("enabled", rule.enabled))
            }
        })
        put("schedules", JSONArray().apply {
            config.schedules.forEach { rule ->
                put(JSONObject().put("packageName", rule.target.packageName ?: JSONObject.NULL)
                    .put("days", JSONArray(rule.days.map { it.name }.sorted()))
                    .put("start", rule.start.toString()).put("end", rule.end.toString()).put("enabled", rule.enabled))
            }
        })
        put("extensions", JSONArray().apply {
            config.extensions.forEach { extension ->
                put(JSONObject().put("packageName", extension.target.packageName ?: JSONObject.NULL)
                    .put("extraMillis", extension.extraMillis).put("expiresAt", extension.expiresAt.toString()))
            }
        })
    }.toString()

    fun decode(json: String): PolicyConfig {
        val root = JSONObject(json)
        fun strings(name: String): Set<String> = root.optJSONArray(name).toStringSet()
        val limits = root.optJSONArray("limits").objects().map { item ->
            UsageLimitRule(
                UsageTarget(item.optString("packageName").takeUnless { item.isNull("packageName") }),
                UsagePeriod.valueOf(item.getString("period")),
                item.getLong("limitMillis"),
                item.optBoolean("enabled", true),
            )
        }
        val schedules = root.optJSONArray("schedules").objects().map { item ->
            ScheduleRule(
                UsageTarget(item.optString("packageName").takeUnless { item.isNull("packageName") }),
                item.optJSONArray("days").strings().map(DayOfWeek::valueOf).toSet(),
                LocalTime.parse(item.getString("start")),
                LocalTime.parse(item.getString("end")),
                item.optBoolean("enabled", true),
            )
        }
        val extensions = root.optJSONArray("extensions").objects().map { item ->
            TemporaryExtension(
                UsageTarget(item.optString("packageName").takeUnless { item.isNull("packageName") }),
                item.getLong("extraMillis"),
                ZonedDateTime.parse(item.getString("expiresAt")),
            )
        }
        return PolicyConfig(
            root.optBoolean("enabled", true), root.optBoolean("forceStopped", false),
            limits, schedules, strings("whitelist"), strings("protectedPackages"), extensions,
        )
    }

    private fun JSONArray?.objects(): List<JSONObject> = (0 until (this?.length() ?: 0)).mapNotNull { this?.optJSONObject(it) }
    private fun JSONArray?.strings(): List<String> = (0 until (this?.length() ?: 0)).mapNotNull { this?.optString(it)?.takeIf(String::isNotBlank) }
    private fun JSONArray?.toStringSet(): Set<String> = strings().toSet()
}
