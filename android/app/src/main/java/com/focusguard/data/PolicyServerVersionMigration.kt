package com.focusguard.data

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/** Separates the server policy version from local edits made while offline. */
object PolicyServerVersionMigration : Migration(3, 4) {
    override fun migrate(database: SupportSQLiteDatabase) {
        database.execSQL("ALTER TABLE local_policy ADD COLUMN serverVersion INTEGER NOT NULL DEFAULT 0")
    }
}
