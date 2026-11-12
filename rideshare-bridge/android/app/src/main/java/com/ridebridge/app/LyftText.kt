package com.ridebridge.app

/** Package names and light text heuristics shared by both readers. Full parsing happens on the server. */
object LyftText {
    val DRIVER_PACKAGES = setOf("com.lyft.android.driver")

    /** Maps what Lyft Driver is showing to a ride status the server understands, or null to ignore it. */
    fun classify(text: String): String? {
        val t = text.lowercase()
        return when {
            Regex("""\b(new )?(ride |trip )?request\b""").containsMatchIn(t) -> "request"
            Regex("""\$\s?\d""").containsMatchIn(t) && Regex("""\d+\s*min""").containsMatchIn(t) &&
                ("away" in t || "accept" in t) -> "request"
            "picking up" in t || "head to pickup" in t || "navigate to pickup" in t -> "accepted"
            "dropping off" in t || "drop off" in t || "drop-off" in t || "trip started" in t -> "in_trip"
            "ride complete" in t || "trip complete" in t || "rate your rider" in t -> "completed"
            "cancel" in t -> "cancelled"
            else -> null
        }
    }
}
