import Foundation
import RealityKit

enum SettingsKeys {
    static let feedUrl = "feedUrl"
    static let worldKey = "worldKey" // Spike only: production would keep this in the Keychain.
    static let soundOn = "soundOn"
    static let defaultFeedUrl = "https://api.virvi.io"
}

/// Ties the feed to the renderer. `placement` is what the platform code anchors in the world: it sits where the
/// scene's centre should be, and holds the scene root shifted so Virvi (8, 0, 8) lands on placement's origin.
@MainActor
final class AppModel: ObservableObject {
    let feed = FeedClient()
    let renderer = SceneRenderer()
    let placement = Entity()

    @Published var tabletop = false {
        didSet { placement.scale = .one * (tabletop ? 1.0 / 20 : 1) }
    }

    init() {
        let c = toRealityKitTransform(position: VIRVI_SCENE_CENTER, rotation: Vec3(x: 0, y: 0, z: 0), scale: Vec3(x: 1, y: 1, z: 1))
        renderer.root.position = -SIMD3<Float>(c.position)
        placement.addChild(renderer.root)
        feed.onSnapshot = { [weak self] scene in
            guard let self else { return }
            let items = planScene(scene)
            self.renderer.apply(items)
            self.feed.status.itemCount = items.count
        }
    }

    func connect() {
        let d = UserDefaults.standard
        renderer.soundOn = d.bool(forKey: SettingsKeys.soundOn)
        feed.start(
            feedUrl: d.string(forKey: SettingsKeys.feedUrl) ?? SettingsKeys.defaultFeedUrl,
            worldKey: d.string(forKey: SettingsKeys.worldKey) ?? ""
        )
    }
}
