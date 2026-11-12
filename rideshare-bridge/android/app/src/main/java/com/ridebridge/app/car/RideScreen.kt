package com.ridebridge.app.car

import android.content.Intent
import android.net.Uri
import androidx.car.app.AppManager
import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.Alert
import androidx.car.app.model.AlertCallback
import androidx.car.app.model.CarColor
import androidx.car.app.model.CarText
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Pane
import androidx.car.app.model.PaneTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.car.app.versioning.CarAppApiLevels
import androidx.lifecycle.lifecycleScope
import com.ridebridge.app.BridgeClient
import com.ridebridge.app.Place
import com.ridebridge.app.Ride
import com.ridebridge.app.RideRepository
import kotlinx.coroutines.launch

/**
 * Android Auto screen: shows the latest Lyft request with earnings and a verdict, raises an
 * alert when a new request arrives, and offers one-tap navigation (phone nav app or Tesla).
 * Accepting the ride still happens in the Lyft Driver app.
 */
class RideScreen(carContext: CarContext) : Screen(carContext) {
    private val client = BridgeClient(carContext)
    private var ride: Ride? = null
    private var lastAlertedId: String? = null

    init {
        lifecycleScope.launch {
            RideRepository.current.collect { r ->
                ride = r
                if (r != null && r.status == "request" && r.id != lastAlertedId) {
                    lastAlertedId = r.id
                    showAlert(r)
                }
                invalidate()
            }
        }
    }

    override fun onGetTemplate(): Template {
        val r = ride ?: return MessageTemplate.Builder("Waiting for a Lyft ride request…")
            .setTitle("RideBridge")
            .setHeaderAction(Action.APP_ICON)
            .build()

        val target = if (r.status == "in_trip") r.dropoff else r.pickup
        val pane = Pane.Builder()
            .addRow(
                Row.Builder()
                    .setTitle(colored("${money(r.fare)}  ${(r.verdict ?: "new").uppercase()}", verdictColor(r.verdict)))
                    .addText(listOfNotNull(r.perMile?.let { "${money(it)}/mi" }, r.perHour?.let { "${money(it)}/hr" }, r.riderRating?.let { "★ $it" }).joinToString(" · ").ifEmpty { r.service ?: "Lyft" })
                    .build(),
            )
            .addRow(
                Row.Builder()
                    .setTitle("Pickup: ${r.pickup.address ?: "not shown"}")
                    .addText(listOfNotNull(r.pickupEtaMin?.let { "$it min" }, r.pickupMi?.let { "$it mi" }).joinToString(" · ").ifEmpty { "—" })
                    .build(),
            )
            .addRow(
                Row.Builder()
                    .setTitle("Trip: " + (listOfNotNull(r.tripMin?.let { "$it min" }, r.tripMi?.let { "$it mi" }).joinToString(" · ").ifEmpty { "—" }))
                    .addText(r.dropoff.address?.let { "To $it" } ?: r.reasons.joinToString(" · ").ifEmpty { r.status })
                    .build(),
            )

        if (target.hasLocation) {
            pane.addAction(
                Action.Builder()
                    .setTitle(if (r.status == "in_trip") "Navigate to drop-off" else "Navigate to pickup")
                    .setFlags(Action.FLAG_PRIMARY)
                    .setOnClickListener { navigate(target) }
                    .build(),
            )
            pane.addAction(
                Action.Builder()
                    .setTitle("Send to Tesla")
                    .setOnClickListener { sendToTesla(r, if (r.status == "in_trip") "dropoff" else "pickup") }
                    .build(),
            )
        }

        return PaneTemplate.Builder(pane.build())
            .setTitle(r.service ?: "Lyft request")
            .setHeaderAction(Action.APP_ICON)
            .build()
    }

    private fun navigate(place: Place) {
        val uri = place.geoUri() ?: return
        runCatching { carContext.startCarApp(Intent(CarContext.ACTION_NAVIGATE, Uri.parse(uri))) }
            .onFailure { CarToast.makeText(carContext, "No navigation app available", CarToast.LENGTH_LONG).show() }
    }

    private fun sendToTesla(r: Ride, target: String) {
        lifecycleScope.launch {
            val result = client.sendToTesla(r.id, target)
            val msg = result.fold({ "Sent to Tesla" }, { "Tesla: ${it.message}" })
            CarToast.makeText(carContext, msg, CarToast.LENGTH_SHORT).show()
        }
    }

    private fun showAlert(r: Ride) {
        if (carContext.carAppApiLevel < CarAppApiLevels.LEVEL_5) {
            CarToast.makeText(carContext, "New Lyft request ${money(r.fare)}", CarToast.LENGTH_LONG).show()
            return
        }
        val alert = Alert.Builder(
            r.id.hashCode(),
            colored("New request ${money(r.fare)} · ${(r.verdict ?: "").uppercase()}", verdictColor(r.verdict)),
            15_000,
        )
            .setSubtitle(CarText.create(listOfNotNull(r.pickupEtaMin?.let { "$it min away" }, r.pickup.address).joinToString(" · ")))
            .addAction(Action.Builder().setTitle("Navigate").setOnClickListener { navigate(r.pickup) }.build())
            .setCallback(object : AlertCallback {
                override fun onCancel(reason: Int) = Unit
                override fun onDismiss() = Unit
            })
            .build()
        carContext.getCarService(AppManager::class.java).showAlert(alert)
    }

    private fun money(v: Double?) = v?.let { "$" + String.format("%.2f", it) } ?: "$—"

    private fun verdictColor(v: String?) = when (v) {
        "go" -> CarColor.GREEN
        "maybe" -> CarColor.YELLOW
        "skip" -> CarColor.RED
        else -> CarColor.DEFAULT
    }

    private fun colored(text: String, color: CarColor): CarText {
        val s = android.text.SpannableString(text)
        s.setSpan(androidx.car.app.model.ForegroundCarColorSpan.create(color), 0, text.length, 0)
        return CarText.create(s)
    }
}
