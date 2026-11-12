import CarPlay
import UIKit

/// CarPlay "driving task" scene. Shows the current Lyft request and lets the driver open
/// Apple Maps to the pickup / drop-off, or push it to their Tesla via the RideBridge server.
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?
    private var scene: CPTemplateApplicationScene?
    private var current: Ride?
    private var lastAlertedId: String?

    func templateApplicationScene(_ scene: CPTemplateApplicationScene,
                                  didConnect interfaceController: CPInterfaceController) {
        self.scene = scene
        self.interfaceController = interfaceController
        interfaceController.setRootTemplate(waitingTemplate(), animated: false, completion: nil)

        RideBridgeClient.shared.onRide = { [weak self] ride in self?.show(ride) }
        RideBridgeClient.shared.start()
    }

    func templateApplicationScene(_ scene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        RideBridgeClient.shared.stop()
        self.interfaceController = nil
    }

    private func waitingTemplate() -> CPInformationTemplate {
        CPInformationTemplate(title: "RideBridge", layout: .leading,
                              items: [CPInformationItem(title: "Waiting for a Lyft ride request…", detail: nil)],
                              actions: [])
    }

    private func show(_ ride: Ride) {
        current = ride
        let template = rideTemplate(ride)
        interfaceController?.setRootTemplate(template, animated: true, completion: nil)

        if ride.status == "request", ride.id != lastAlertedId {
            lastAlertedId = ride.id
            let title = "New request \(money(ride.fare)) · \((ride.score?.verdict ?? "").uppercased())"
            let alert = CPAlertTemplate(titleVariants: [title], actions: [
                CPAlertAction(title: "View", style: .default) { [weak self] _ in
                    self?.interfaceController?.dismissTemplate(animated: true, completion: nil)
                }
            ])
            interfaceController?.presentTemplate(alert, animated: true, completion: nil)
        }
    }

    private func rideTemplate(_ r: Ride) -> CPInformationTemplate {
        let earnings = [r.score?.perMile.map { "\(money($0))/mi" }, r.score?.perHour.map { "\(money($0))/hr" },
                        r.riderRating.map { "★ \($0)" }].compactMap { $0 }.joined(separator: " · ")
        let pickupDetail = [r.pickup.etaMin.map { "\($0) min" }, r.pickup.distanceMi.map { "\($0) mi" }]
            .compactMap { $0 }.joined(separator: " · ")
        let tripDetail = [r.trip.durationMin.map { "\($0) min" }, r.trip.distanceMi.map { "\($0) mi" }]
            .compactMap { $0 }.joined(separator: " · ")

        var items = [
            CPInformationItem(title: "\(money(r.fare))  \((r.score?.verdict ?? "new").uppercased())", detail: earnings),
            CPInformationItem(title: "Pickup", detail: [r.pickup.address ?? "Not shown", pickupDetail].filter { !$0.isEmpty }.joined(separator: "\n")),
            CPInformationItem(title: "Trip", detail: [tripDetail, r.dropoff.address.map { "To \($0)" } ?? ""].filter { !$0.isEmpty }.joined(separator: "\n")),
        ]
        if let reasons = r.score?.reasons, !reasons.isEmpty {
            items.append(CPInformationItem(title: "Flags", detail: reasons.joined(separator: " · ")))
        }

        let inTrip = r.status == "in_trip"
        let target = inTrip ? r.dropoff : r.pickup
        var actions: [CPTextButton] = []
        if target.hasLocation {
            actions.append(CPTextButton(title: inTrip ? "Maps to drop-off" : "Maps to pickup", textStyle: .confirm) { [weak self] _ in
                guard let url = target.appleMapsURL else { return }
                self?.scene?.open(url, options: nil, completionHandler: nil)
            })
            actions.append(CPTextButton(title: "Send to Tesla", textStyle: .normal) { _ in
                Task { try? await RideBridgeClient.shared.sendToTesla(rideId: r.id, target: inTrip ? "dropoff" : "pickup") }
            })
        }
        return CPInformationTemplate(title: r.service ?? "Lyft request", layout: .twoColumn, items: items, actions: actions)
    }

    private func money(_ v: Double?) -> String {
        guard let v else { return "$—" }
        return String(format: "$%.2f", v)
    }
}
