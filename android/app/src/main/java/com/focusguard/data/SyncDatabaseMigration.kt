package com.focusguard.data

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

object SyncDatabaseMigration : Migration(2, 3) {
    override fun migrate(database: SupportSQLiteDatabase) {
        database.execSQL(
            "CREATE TABLE IF NOT EXISTS sync_commands (commandId TEXT NOT NULL PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, receivedAtMillis INTEGER NOT NULL, expiresAtMillis INTEGER, acknowledgedAtMillis INTEGER, detail TEXT)",
        )
    }
}
