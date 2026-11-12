package com.ridebridge.app

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Optional reader for the full-screen ride-request card in Lyft Driver, which usually shows
 * more than the notification (fare, trip length, rider rating).
 *
 * It is restricted to the Lyft Driver package in accessibility_config.xml and only reads
 * text. It deliberately performs no clicks or gestures: accepting a ride stays with the driver.
 */
class LyftScreenReaderService : AccessibilityService() {
    private val client by lazy { BridgeClient(this) }
    private val handler = Handler(Looper.getMainLooper())
    private var lastSent: String? = null
    private val readRunnable = Runnable { readScreen() }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.packageName?.toString() !in LyftText.DRIVER_PACKAGES) return
        // Content changes arrive in bursts while the card animates in; read once it settles.
        handler.removeCallbacks(readRunnable)
        handler.postDelayed(readRunnable, 400)
    }

    private fun readScreen() {
        val root = rootInActiveWindow ?: return
        val lines = mutableListOf<String>()
        collect(root, lines)
        if (lines.isEmpty()) return
        val joined = lines.joinToString("\n")
        val status = LyftText.classify(joined) ?: return
        val fingerprint = "$status|$joined"
        if (fingerprint == lastSent) return
        lastSent = fingerprint
        client.submit(source = "android-screen", status = status, title = null, text = null, lines = lines)
    }

    private fun collect(node: AccessibilityNodeInfo?, out: MutableList<String>, depth: Int = 0) {
        if (node == null || depth > 40 || out.size > 200) return
        node.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let(out::add)
            ?: node.contentDescription?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let(out::add)
        for (i in 0 until node.childCount) collect(node.getChild(i), out, depth + 1)
    }

    override fun onInterrupt() = Unit
}
