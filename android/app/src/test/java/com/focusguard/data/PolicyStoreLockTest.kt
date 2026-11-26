package com.focusguard.data

import com.focusguard.core.PolicyConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyStoreLockTest {
    private class InMemoryDao : PolicyDao {
        val row = MutableStateFlow<PolicyEntity?>(null)
        private val encoded = mutableListOf<PolicyConfig>()
        fun reopen() = PolicyStore(this, { config ->
            encoded.add(config)
            encoded.lastIndex.toString()
        }, { encoded[it.toInt()] })
        override fun observe() = row
        override suspend fun get() = row.value
        override suspend fun save(policy: PolicyEntity) { row.value = policy }
    }

    @Test fun explicitLockSurvivesNewStoreInstanceAndRuleWrites() = runTest {
        val dao = InMemoryDao()
        val initial = dao.reopen()
        initial.setLock(true)
        val reopened = dao.reopen()
        assertTrue(reopened.load().forceStopped)
        assertTrue(reopened.saveRemote(PolicyConfig(enabled = false), 12))
        assertTrue(reopened.load().forceStopped)
        assertFalse(reopened.load().enabled)
        initial.save(PolicyConfig(whitelist = setOf("com.example.app")))
        assertTrue(reopened.load().forceStopped)
        assertEquals(12L, reopened.version())
        reopened.setLock(false)
        assertFalse(initial.load().forceStopped)
        assertEquals(setOf("com.example.app"), initial.load().whitelist)
    }

    @Test fun confirmedUnbindClearsLockAndVersion() = runTest {
        val store = InMemoryDao().reopen()
        assertTrue(store.saveRemote(PolicyConfig(whitelist = setOf("com.example.app")), 5))
        store.save(store.load().copy(forceStopped = true), updateLock = true)
        assertTrue(store.load().forceStopped)
        store.clearPairingState()
        assertFalse(store.load().forceStopped)
        assertEquals(0L, store.version())
        assertEquals(setOf("com.example.app"), store.load().whitelist)
    }
}
