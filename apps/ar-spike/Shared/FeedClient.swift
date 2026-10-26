import Foundation

struct FeedStatus: Equatable {
    var state: String = "Idle"
    /// First 8 hex chars of the scene version.
    var version: String?
    var itemCount: Int = 0
    var lastError: String?
}

/// Long-polls `GET {feedUrl}/api/hyperfy/feed?since=<version>` (see packages/hyperfy-app/src/poller.ts).
/// Each answer is a whole snapshot; `onSnapshot` fires only when the version changes. Failures back off
/// (doubling, 1 s to 30 s) and keep the last snapshot, except a 404 (scene gone), which clears it once.
/// The world key is only ever put in the Authorization header; it is never logged or shown.
@MainActor
final class FeedClient: ObservableObject {
    @Published var status = FeedStatus()
    var onSnapshot: ((Props?) -> Void)?

    private var task: Task<Void, Never>?
    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 40 // server holds up to 25 s
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }()

    func start(feedUrl: String, worldKey: String) {
        stop()
        var base = feedUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        while base.hasSuffix("/") { base.removeLast() }
        let key = worldKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            status = FeedStatus(state: "Missing world key", lastError: "Paste a world key in Settings")
            return
        }
        guard let url = URL(string: base + "/api/hyperfy/feed"), url.scheme?.hasPrefix("http") == true else {
            status = FeedStatus(state: "Bad feed URL", lastError: "Feed URL must start with http(s)://")
            return
        }
        status = FeedStatus(state: "Connecting…")
        task = Task { [weak self] in await self?.loop(endpoint: url, key: key) }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func loop(endpoint: URL, key: String) async {
        var version = ""
        var delay: Double = 0
        while !Task.isCancelled {
            var comps = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
            comps.queryItems = [URLQueryItem(name: "since", value: version)]
            var req = URLRequest(url: comps.url!)
            req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
            req.setValue("1", forHTTPHeaderField: "X-VLM-App-Version")

            var failure: String
            do {
                let (data, resp) = try await session.data(for: req)
                if Task.isCancelled { return }
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if code == 200, let snap = Self.parse(data) {
                    delay = 0
                    status.lastError = nil
                    status.state = "Live"
                    if snap.version != version {
                        version = snap.version
                        status.version = String(snap.version.prefix(8))
                        onSnapshot?(snap.scene)
                    }
                    continue
                }
                switch code {
                case 200: failure = "Unexpected feed response"
                case 401: failure = "Invalid world key (401)"
                case 404:
                    failure = "Scene not found (404)"
                    if !version.isEmpty {
                        version = ""
                        status.version = nil
                        onSnapshot?(nil)
                    }
                case 429: failure = "Rate limited (429)"
                default: failure = "HTTP \(code)"
                }
            } catch {
                if Task.isCancelled { return }
                failure = (error as? URLError)?.localizedDescription ?? "Network error"
            }
            delay = min(max(delay * 2, 1), 30)
            status.lastError = failure
            status.state = "Retrying in \(Int(delay)) s"
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }

    /// `{ v: 1, version: string, scene: object | null }`
    nonisolated static func parse(_ data: Data) -> (version: String, scene: Props?)? {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? Props,
              (o["v"] as? NSNumber)?.intValue == 1,
              let version = o["version"] as? String,
              o.keys.contains("scene") else { return nil }
        return (version, o["scene"] as? Props)
    }
}
