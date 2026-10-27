import Foundation

/// The printed test markers from `tools/make_markers.py`. Their reference images are in `Shared/Markers/`.
struct TestMarker: Identifiable {
    let code: String
    /// The tracked square's printed width, in metres. Image tracking needs it to judge distance.
    let width: Double
    var id: String { code }

    static let all = [TestMarker(code: "TEST12", width: 0.12), TestMarker(code: "TEST17", width: 0.17)]

    /// The marker code in a marker QR payload (`HTTPS://VIRVI.IO/S/<CODE>`), or nil for any other link.
    static func code(fromQR payload: String) -> String? {
        let prefix = "HTTPS://VIRVI.IO/S/"
        let p = payload.uppercased()
        guard p.hasPrefix(prefix) else { return nil }
        let code = String(p.dropFirst(prefix.count))
        return code.isEmpty ? nil : code
    }
}

/// What the detection-range test records for one marker: where tracking started ("found") and where it stopped
/// ("lost"), as distances from the device in metres. Walk away until it's lost, then walk back until it's found.
struct MarkerReading {
    private(set) var tracked = false
    private(set) var now: Double?
    private(set) var foundAt: [Double] = []
    private(set) var lostAt: [Double] = []
    private(set) var farthestTracked: Double?

    var farthestFound: Double? { foundAt.max() }

    mutating func observe(tracked isTracked: Bool, distance: Double) {
        if isTracked {
            if !tracked { foundAt.append(distance) }
            farthestTracked = max(farthestTracked ?? 0, distance)
            now = distance
        } else {
            if tracked, let last = now { lostAt.append(last) }
            now = nil
        }
        tracked = isTracked
    }

    var summary: String {
        guard let lastFound = foundAt.last else { return "not seen yet" }
        let m = { (d: Double) in String(format: "%.2f m", d) }
        var parts = [now.map { "tracking at \(m($0))" } ?? "not tracking"]
        parts.append("found at \(m(lastFound)) (farthest \(m(farthestFound ?? lastFound)))")
        if let lost = lostAt.last { parts.append("lost at \(m(lost))") }
        return parts.joined(separator: " · ")
    }
}
