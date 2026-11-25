package com.focusguard.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Entity(
    tableName = "usage_events",
    primaryKeys = ["occurredAtMillis", "packageName", "eventType"],
    indices = [Index("occurredAtMillis")],
)
data class UsageEventEntity(
    val occurredAtMillis: Long,
    val packageName: String,
    val eventType: Int,
)

@Entity(tableName = "usage_daily")
data class UsageDailyEntity(
    @PrimaryKey val localDate: String,
    val zoneId: String,
    val deviceForegroundMillis: Long,
    val appForegroundJson: String,
    val appLaunchesJson: String,
    val updatedAtMillis: Long,
)

@Dao
interface UsageDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertEvents(events: List<UsageEventEntity>): List<Long>

    @Query("SELECT * FROM usage_events ORDER BY occurredAtMillis, packageName")
    suspend fun allEvents(): List<UsageEventEntity>

    @Query("SELECT MAX(occurredAtMillis) FROM usage_events")
    suspend fun latestEventMillis(): Long?

    @Query("DELETE FROM usage_daily")
    suspend fun clearDaily()

    @Upsert
    suspend fun upsertDaily(rows: List<UsageDailyEntity>)

    @Query("SELECT * FROM usage_daily WHERE localDate BETWEEN :from AND :through ORDER BY localDate")
    fun dailyBetween(from: String, through: String): Flow<List<UsageDailyEntity>>

    @Query("SELECT * FROM usage_daily ORDER BY localDate DESC")
    suspend fun latestDaily(): List<UsageDailyEntity>
}

@Database(entities = [UsageEventEntity::class, UsageDailyEntity::class, PolicyEntity::class], version = 2, exportSchema = false)
abstract class UsageDatabase : RoomDatabase() {
    abstract fun usageDao(): UsageDao
    abstract fun policyDao(): PolicyDao

    companion object {
        @Volatile private var instance: UsageDatabase? = null

        fun get(context: Context): UsageDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                UsageDatabase::class.java,
                "focusguard-usage.db",
            ).addMigrations(PolicyDatabaseMigration).build().also { instance = it }
        }
    }
}
