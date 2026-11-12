package com.ridebridge.app

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject

data class Place(val address: String?, val lat: Double?, val lon: Double?) {
    val hasLocation get() = !address.isNullOrBlank() || (lat != null && lon != null)

    /** geo: URI understood by Google Maps, Waze and the Android Auto navigation intent. */
    fun geoUri(): String? = when {
        lat != null && lon != null -> "geo:$lat,$lon"
        !address.isNullOrBlank() -> "geo:0,0?q=" + android.net.Uri.encode(address)
        else -> null
    }
}

data class Ride(
    val id: String,
    val status: String,
    val service: String?,
    val fare: Double?,
    val riderRating: Double?,
    val pickup: Place,
    val pickupEtaMin: Int?,
    val pickupMi: Double?,
    val dropoff: Place,
    val tripMin: Int?,
    val tripMi: Double?,
    val verdict: String?,
    val perMile: Double?,
    val perHour: Double?,
    val reasons: List<String>,
) {
    companion object {
        private fun JSONObject.optDoubleOrNull(k: String) = if (isNull(k) || !has(k)) null else optDouble(k)
        private fun JSONObject.optIntOrNull(k: String) = if (isNull(k) || !has(k)) null else optInt(k)
        private fun JSONObject.optStringOrNull(k: String) = if (isNull(k) || !has(k)) null else optString(k)

        private fun place(o: JSONObject?) = Place(
            o?.optStringOrNull("address"), o?.optDoubleOrNull("lat"), o?.optDoubleOrNull("lon"),
        )

        /** Parses the ride JSON returned by the RideBridge server. */
        fun fromJson(j: JSONObject): Ride {
            val pickup = j.optJSONObject("pickup")
            val trip = j.optJSONObject("trip")
            val score = j.optJSONObject("score")
            val reasons = score?.optJSONArray("reasons")
            return Ride(
                id = j.getString("id"),
                status = j.optString("status", "request"),
                service = j.optStringOrNull("service"),
                fare = j.optDoubleOrNull("fare"),
                riderRating = j.optDoubleOrNull("riderRating"),
                pickup = place(pickup),
                pickupEtaMin = pickup?.optIntOrNull("etaMin"),
                pickupMi = pickup?.optDoubleOrNull("distanceMi"),
                dropoff = place(j.optJSONObject("dropoff")),
                tripMin = trip?.optIntOrNull("durationMin"),
                tripMi = trip?.optDoubleOrNull("distanceMi"),
                verdict = score?.optStringOrNull("verdict"),
                perMile = score?.optDoubleOrNull("perMile"),
                perHour = score?.optDoubleOrNull("perHour"),
                reasons = (0 until (reasons?.length() ?: 0)).map { reasons!!.getString(it) },
            )
        }
    }
}

/** Single source of truth shared by the readers, the phone UI and the Android Auto screen. */
object RideRepository {
    private val _current = MutableStateFlow<Ride?>(null)
    val current: StateFlow<Ride?> = _current

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError

    fun publish(ride: Ride) {
        _current.value = ride
        _lastError.value = null
    }

    fun error(message: String) {
        _lastError.value = message
    }
}
