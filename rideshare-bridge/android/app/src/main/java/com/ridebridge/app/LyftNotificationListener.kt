package com.ridebridge.app

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Reads notifications posted by Lyft Driver. Enable it under
 * Settings → Notifications → Device & app notifications (Notification access) → RideBridge.
 *
 * Read-only: it never dismisses, replies to or acts on Lyft's notifications.
 */
class LyftNotificationListener : NotificationListenerService() {
    private val client by lazy { BridgeClient(this) }
    private var lastFingerprint: String? = null

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in LyftText.DRIVER_PACKAGES) return
        val extras = sbn.notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
        val big = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
        val lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.map { it.toString() }.orEmpty()

        val all = listOfNotNull(title, text, big).plus(lines).joinToString("\n")
        val status = LyftText.classify(all) ?: return

        // Lyft updates the same notification repeatedly (countdowns); only forward real changes.
        val fingerprint = "$status|$all"
        if (fingerprint == lastFingerprint) return
        lastFingerprint = fingerprint

        client.submit(source = "android-notification", status = status, title = title, text = big ?: text, lines = lines)
    }
}
