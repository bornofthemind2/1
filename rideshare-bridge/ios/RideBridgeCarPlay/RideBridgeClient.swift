import Foundation

struct Place: Codable {
    var address: String?
    var lat: Double?
    var lon: Double?
    var etaMin: Int?
    var distanceMi: Double?

    var hasLocation: Bool { (address?.isEmpty == false) || (lat != nil && lon != nil) }

    /// Apple Maps driving-directions URL (opens on the CarPlay screen).
    var appleMapsURL: URL? {
        var c = URLComponents(string: "https://maps.apple.com/")!
        if let lat, let lon {
            c.queryItems = [.init(name: "daddr", value: "\(lat),\(lon)"), .init(name: "dirflg", value: "d")]
        } else if let address, !address.isEmpty {
            c.queryItems = [.init(name: "daddr", value: address), .init(name: "dirflg", value: "d")]
        } else { return nil }
        return c.url
    }
}

struct Trip: Codable { var durationMin: Int?; var distanceMi: Double? }
struct Score: Codable { var verdict: String?; var perMile: Double?; var perHour: Double?; var reasons: [String]? }

struct Ride: Codable, Identifiable {
    var id: String
    var status: String
    var service: String?
    var fare: Double?
    var riderRating: Double?
    var pickup: Place
    var dropoff: Place
    var trip: Trip
    var score: Score?
}

/// Talks to the RideBridge server: live updates over Server-Sent Events, plus "send to Tesla".
/// Configure with the same URL/token as the Android app (e.g. from a settings screen or Keychain).
final class RideBridgeClient {
    static let shared = RideBridgeClient()

    var serverURL = URL(string: UserDefaults.standard.string(forKey: "serverURL") ?? "https://example.invalid")!
    var token = UserDefaults.standard.string(forKey: "token") ?? "" // move to Keychain for production

    var onRide: ((Ride) -> Void)?
    private var streamTask: Task<Void, Never>?

    func start() {
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.listen()
                try? await Task.sleep(nanoseconds: 3_000_000_000) // reconnect backoff
            }
        }
    }

    func stop() { streamTask?.cancel() }

    private func listen() async {
        var req = URLRequest(url: serverURL.appendingPathComponent("api/stream"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 120
        guard let (bytes, response) = try? await URLSession.shared.bytes(for: req),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return }

        var event = "message"
        var data = ""
        do {
            for try await line in bytes.lines {
                if line.hasPrefix("event:") {
                    event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                } else if line.hasPrefix("data:") {
                    data += line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                    // URLSession's `lines` skips blank lines, so dispatch once data is complete.
                    dispatch(event: event, data: data)
                    event = "message"; data = ""
                }
            }
        } catch { /* reconnect */ }
    }

    private func dispatch(event: String, data: String) {
        guard let json = data.data(using: .utf8) else { return }
        let ride: Ride?
        switch event {
        case "ride", "update":
            ride = try? JSONDecoder().decode(Ride.self, from: json)
        case "hello":
            struct Hello: Codable { var latest: Ride? }
            ride = (try? JSONDecoder().decode(Hello.self, from: json))?.latest
        default:
            ride = nil
        }
        if let ride { DispatchQueue.main.async { self.onRide?(ride) } }
    }

    func sendToTesla(rideId: String, target: String) async throws {
        var req = URLRequest(url: serverURL.appendingPathComponent("api/rides/\(rideId)/navigate"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["target": target])
        let (data, response) = try await URLSession.shared.data(for: req)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "request failed"
            throw NSError(domain: "RideBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: msg])
        }
    }
}
