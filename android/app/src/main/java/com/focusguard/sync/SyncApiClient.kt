package com.focusguard.sync

import com.focusguard.core.PolicyConfig
import com.focusguard.data.PolicyCodec
import com.focusguard.data.UsageDailyEntity
import java.io.IOException
import java.util.UUID
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

sealed class SyncApiException(message: String, cause: Throwable? = null) : IOException(message, cause) {
    class Network(cause: Throwable) : SyncApiException("network unavailable", cause)
    class Unauthorized : SyncApiException("device authentication rejected")
    class Permission : SyncApiException("server permission denied")
    class Http(val code: Int, body: String) : SyncApiException("server returned HTTP $code: ${body.take(200)}")
    class InvalidResponse(cause: Throwable) : SyncApiException("invalid server response", cause)
}

data class DeviceRegistration(
    val deviceId: String,
    val deviceToken: String,
    val pairingExpiresAt: String?,
)

data class RemotePolicy(val version: Long, val config: PolicyConfig)

data class RemoteCommand(
    val id: String,
    val type: String,
    val payload: JSONObject,
    val expiresAtMillis: Long?,
)

data class CommandPage(val commands: List<RemoteCommand>, val nextCursor: String?)

/** Small JSON client so the backend contract remains explicit and configurable at runtime. */
class SyncApiClient(
    baseUrl: String,
    private val http: OkHttpClient = OkHttpClient.Builder().build(),
) {
    private val root = baseUrl.trimEnd('/').removeSuffix("/api/v1").removeSuffix("/api").removeSuffix("/v1").also {
        require(it.startsWith("https://") || it.startsWith("http://")) { "base URL must use HTTP(S)" }
    }
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    fun register(pairingCode: String, deviceId: String, appVersion: String): DeviceRegistration {
        val body = JSONObject()
            .put("code", pairingCode)
            .put("name", "Android device")
            .put("platform", "android")
            .put("app_version", appVersion)
        val response = execute("POST", "/api/v1/devices/pair", body.toString())
        return try {
            val device = response.optJSONObject("device")
            val id = device?.optString("id").orEmpty().ifBlank { response.optString("deviceId", deviceId) }
            val token = response.optString("device_token").ifBlank { response.optString("deviceToken") }
            require(id.isNotBlank() && token.isNotBlank()) { "missing device id or token" }
            DeviceRegistration(id, token, response.optString("pairingExpiresAt").takeIf { it.isNotBlank() })
        } catch (error: Exception) {
            throw SyncApiException.InvalidResponse(error)
        }
    }

    fun heartbeat(deviceId: String, deviceToken: String, usageAccess: Boolean, accessibility: Boolean): JSONObject =
        execute(
            "POST",
            "/api/v1/devices/$deviceId/heartbeat",
            JSONObject()
                .put("deviceId", deviceId)
                .put("usageAccessGranted", usageAccess)
                .put("accessibilityEnabled", accessibility)
                .put("clientTimeMillis", System.currentTimeMillis())
                .toString(),
            deviceToken,
        )

    fun fetchPolicy(deviceId: String, deviceToken: String, knownVersion: Long?): RemotePolicy? {
        val query = knownVersion?.let { "?version=$it" }.orEmpty()
        val response = execute("GET", "/api/v1/devices/$deviceId/policy$query", null, deviceToken)
        if (response.optBoolean("notModified", false) || response.optInt("status", 200) == 304) return null
        return try {
            val version = response.optLong("version", -1L)
            require(version >= 0L) { "missing policy version" }
            val configJson = when {
                response.optJSONObject("config") != null -> response.getJSONObject("config").toString()
                response.optString("configJson").isNotBlank() -> response.getString("configJson")
                response.optJSONObject("policy") != null -> response.getJSONObject("policy").toString()
                else -> throw IllegalArgumentException("missing policy config")
            }
            RemotePolicy(version, PolicyCodec.decode(configJson))
        } catch (error: Exception) {
            throw SyncApiException.InvalidResponse(error)
        }
    }

    fun uploadUsage(deviceId: String, deviceToken: String, rows: List<UsageDailyEntity>, batchId: String = UUID.randomUUID().toString()) {
        val payload = JSONObject()
            .put("batchId", batchId)
            .put("deviceId", deviceId)
            .put("rows", JSONArray().also { array -> rows.forEach { array.put(rowJson(it)) } })
        execute("POST", "/api/v1/devices/$deviceId/usage", payload.toString(), deviceToken)
    }

    fun pollCommands(deviceId: String, deviceToken: String, cursor: String?): CommandPage {
        val query = cursor?.takeIf { it.isNotBlank() }?.let { "?cursor=${java.net.URLEncoder.encode(it, Charsets.UTF_8.name())}" }.orEmpty()
        val response = execute("GET", "/api/v1/devices/$deviceId/commands$query", null, deviceToken)
        return try {
            val array = response.optJSONArray("commands") ?: JSONArray()
            val commands = (0 until array.length()).mapNotNull { index -> array.optJSONObject(index)?.toCommand() }
            CommandPage(commands, response.optString("nextCursor").takeIf { it.isNotBlank() })
        } catch (error: Exception) {
            throw SyncApiException.InvalidResponse(error)
        }
    }

    fun ackCommand(deviceId: String, deviceToken: String, commandId: String, status: String, detail: String? = null) {
        val payload = JSONObject().put("commandId", commandId).put("status", status)
        detail?.let { payload.put("detail", it).put("error_message", it) }
        execute("POST", "/api/v1/devices/$deviceId/commands/$commandId/ack", payload.toString(), deviceToken)
    }

    private fun rowJson(row: UsageDailyEntity): JSONObject = JSONObject()
        .put("localDate", row.localDate)
        .put("zoneId", row.zoneId)
        .put("deviceForegroundMillis", row.deviceForegroundMillis)
        .put("appForeground", JSONObject(row.appForegroundJson))
        .put("app_foreground", JSONObject(row.appForegroundJson))
        .put("appLaunches", JSONObject(row.appLaunchesJson))
        .put("updatedAtMillis", row.updatedAtMillis)

    private fun JSONObject.toCommand(): RemoteCommand? {
        val id = optString("id").ifBlank { optString("commandId") }.ifBlank { return null }
        val type = optString("type").ifBlank { optString("kind") }.ifBlank { return null }
        val expires = when {
            has("expiresAtMillis") -> optLong("expiresAtMillis")
            has("expiresAt") -> parseExpiry(opt("expiresAt"))
            has("expires_at") -> parseExpiry(opt("expires_at"))
            else -> null
        }
        val payload = optJSONObject("payload") ?: optString("payload_json").takeIf { it.isNotBlank() }?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()
        return RemoteCommand(id, type, payload, expires)
    }

    private fun parseExpiry(value: Any?): Long? = when (value) {
        is Number -> value.toLong()
        is String -> value.toLongOrNull() ?: runCatching { java.time.Instant.parse(value).toEpochMilli() }.getOrNull()
        else -> null
    }

    private fun execute(method: String, path: String, body: String?, deviceToken: String? = null): JSONObject {
        val builder = Request.Builder().url(root + path).header("Accept", jsonType.toString())
        deviceToken?.let { builder.header("Authorization", "Device $it") }
        if (body != null) builder.method(method, body.toRequestBody(jsonType)) else builder.method(method, null)
        val request = builder.build()
        val response = try {
            http.newCall(request).execute()
        } catch (error: IOException) {
            throw SyncApiException.Network(error)
        }
        response.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) {
                when (it.code) {
                    401, 403 -> if (it.code == 401) throw SyncApiException.Unauthorized() else throw SyncApiException.Permission()
                    else -> throw SyncApiException.Http(it.code, text)
                }
            }
            if (text.isBlank()) return JSONObject()
            return try { JSONObject(text) } catch (error: Exception) { throw SyncApiException.InvalidResponse(error) }
        }
    }
}
