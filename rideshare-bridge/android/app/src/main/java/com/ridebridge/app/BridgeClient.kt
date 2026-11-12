package com.ridebridge.app

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Settings + HTTP client for the RideBridge server. */
class BridgeClient(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("ridebridge", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("server_url", "") ?: ""
        set(v) = prefs.edit().putString("server_url", v.trim().trimEnd('/')).apply()

    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(v) = prefs.edit().putString("token", v.trim()).apply()

    val configured get() = serverUrl.startsWith("https://") && token.isNotEmpty()

    /**
     * Sends text captured from Lyft Driver. The server parses it, scores it and (for
     * status changes) drives Tesla navigation; the parsed ride comes back and is published.
     */
    fun submit(source: String, status: String, title: String?, text: String?, lines: List<String> = emptyList()) {
        if (!configured) return
        val body = JSONObject()
            .put("source", source)
            .put("status", status)
            .put("title", title ?: JSONObject.NULL)
            .put("text", text ?: JSONObject.NULL)
            .put("lines", JSONArray(lines))
        scope.launch {
            runCatching { post("/api/rides", body) }
                .onSuccess { res -> res.optJSONObject("ride")?.let { RideRepository.publish(Ride.fromJson(it)) } }
                .onFailure { RideRepository.error("Bridge: ${it.message}") }
        }
    }

    /** Asks the server to push the pickup or drop-off to the Tesla. */
    suspend fun sendToTesla(rideId: String, target: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching { post("/api/rides/$rideId/navigate", JSONObject().put("target", target)); Unit }
    }

    private fun post(path: String, body: JSONObject): JSONObject {
        val conn = URL(serverUrl + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 5000
            conn.readTimeout = 15000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = if (text.isNotBlank()) JSONObject(text) else JSONObject()
            if (code !in 200..299) error(json.optString("error", "HTTP $code"))
            return json
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
}
