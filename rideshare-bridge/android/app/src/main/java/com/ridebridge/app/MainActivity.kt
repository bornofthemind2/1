package com.ridebridge.app

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/** Phone-side setup: server URL, token, and shortcuts to grant the two read permissions. */
class MainActivity : AppCompatActivity() {
    private lateinit var client: BridgeClient
    private lateinit var status: TextView
    private lateinit var latest: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        client = BridgeClient(this)
        val pad = (16 * resources.displayMetrics.density).toInt()

        val url = EditText(this).apply {
            hint = "https://your-bridge.example.com"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(client.serverUrl)
        }
        val token = EditText(this).apply {
            hint = "Bridge token"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText(client.token)
        }
        status = TextView(this)
        latest = TextView(this).apply { setPadding(0, pad, 0, 0) }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(TextView(context).apply { text = "RideBridge"; textSize = 24f })
            addView(url)
            addView(token)
            addView(Button(context).apply {
                text = "Save"
                setOnClickListener {
                    client.serverUrl = url.text.toString()
                    client.token = token.text.toString()
                    if (!client.configured) {
                        Toast.makeText(context, "Use an https:// URL and a token", Toast.LENGTH_LONG).show()
                    }
                    refreshStatus()
                }
            })
            addView(Button(context).apply {
                text = "1. Allow notification access"
                setOnClickListener { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
            })
            addView(Button(context).apply {
                text = "2. (Optional) Enable request-card reader"
                setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
            })
            addView(status)
            addView(latest)
        }
        setContentView(root)

        lifecycleScope.launch {
            RideRepository.current.combine(RideRepository.lastError) { r, e -> r to e }.collect { (r, e) ->
                latest.text = buildString {
                    if (r != null) {
                        append("Latest: ${r.status} · ${r.fare?.let { "$%.2f".format(it) } ?: "—"} · ${r.verdict ?: ""}\n")
                        append("Pickup: ${r.pickup.address ?: "—"}\n")
                    }
                    if (e != null) append("Error: $e")
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun refreshStatus() {
        val listening = packageName in NotificationManagerCompat.getEnabledListenerPackages(this)
        status.text = buildString {
            append(if (client.configured) "✓ Server set\n" else "✗ Server not set\n")
            append(if (listening) "✓ Notification access granted\n" else "✗ Notification access needed\n")
        }
    }
}
