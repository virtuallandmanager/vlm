import ARKit
import QuartzCore
import RealityKit
import SwiftUI
import UIKit

enum SpaceMode: String, CaseIterable, Identifiable {
    case view = "View", place = "Place scene", edit = "Edit objects"
    var id: String { rawValue }
}

/// Marks the floor marker and footprint: in Place mode, gestures on them move or turn the whole scene.
struct PlaceHandleComponent: Component {}

/// Marks an item entity that can be edited locally; `bounds` is its visual bounds in its own space.
struct EditableItemComponent: Component {
    var bounds: BoundingBox
}

private enum PinKeys {
    static let anchorID = "pinnedWorldAnchorID"
}

/// visionOS-only state for the immersive space: the place/edit mode, the room pin (a `WorldAnchor`) and local,
/// unsaved edits to items. The scene's pivot is `model.placement`, which sits at the scene's centre (VLM 8, 0, 8).
@MainActor
final class SpaceController: ObservableObject {
    let model: AppModel
    let markers: MarkerTestModel
    let guides = Entity()

    @Published var mode: SpaceMode = .view { didSet { updateTargets() } }
    @Published private(set) var selectedKey: String?
    @Published private(set) var editedKeys: Set<String> = []
    @Published private(set) var pinStatus: String

    #if targetEnvironment(simulator)
    // The simulator can report world tracking, but anchors there don't mean anything: keep pinning off.
    private let trackingSupported = false
    #else
    private let trackingSupported = WorldTrackingProvider.isSupported
    #endif
    private var session: ARKitSession?
    private var world: WorldTrackingProvider?
    private var pinnedID: UUID? {
        didSet { UserDefaults.standard.set(pinnedID?.uuidString, forKey: PinKeys.anchorID) }
    }

    // Gesture start state (one gesture of each kind at a time).
    private var dragStart: SIMD3<Float>?
    private var rotateStart: simd_quatf?
    private var scaleStart: Float?
    private var placeGestureActive: Bool { dragStart != nil || rotateStart != nil }

    init(model: AppModel, markers: MarkerTestModel) {
        self.model = model
        self.markers = markers
        PlaceHandleComponent.registerComponent()
        EditableItemComponent.registerComponent()
        pinnedID = UserDefaults.standard.string(forKey: PinKeys.anchorID).flatMap(UUID.init(uuidString:))
        if !trackingSupported {
            pinStatus = "Pinning needs a device"
        } else {
            pinStatus = pinnedID == nil ? "Not pinned" : "Pinned · enter the space to restore"
        }

        guides.name = "vlm-guides"
        guides.addChild(Self.makeMarker())
        guides.addChild(Self.makeFootprint())
        model.placement.addChild(guides)

        model.renderer.onVisualsReady = { [weak self] key, entity in self?.makeEditable(key: key, entity: entity) }
        model.renderer.onApplied = { [weak self] d in self?.feedChanged(d) }
        updateTargets()
    }

    // MARK: - Space lifecycle and placement

    /// Called when the immersive space opens: places the scene and, on a device, starts world tracking and
    /// restores the pinned placement once the anchor is reported.
    func spaceOpened() async {
        placeAhead()
        guard trackingSupported else {
            print("[vlm] world tracking is not supported here (simulator?): pinning is off")
            pinStatus = "Pinning needs a device"
            return
        }
        let session = ARKitSession()
        let world = WorldTrackingProvider()
        let images = makeImageTracking()
        do {
            try await session.run(images.map { [world, $0] } ?? [world])
        } catch {
            print("[vlm] world tracking failed: \(error.localizedDescription)")
            pinStatus = "World tracking failed: \(error.localizedDescription)"
            return
        }
        self.session = session
        self.world = world
        if let images { Task { await self.trackMarkers(images, world: world) } }
        Task { await self.watchSessionEvents(session) }
        if pinnedID == nil {
            placeAhead() // now that the head pose is known
        } else {
            pinStatus = "Pinned · looking for the pinned spot…"
        }
        for await update in world.anchorUpdates {
            guard update.anchor.id == pinnedID else { continue }
            switch update.event {
            case .added, .updated:
                guard update.anchor.isTracked, !placeGestureActive else { continue }
                model.placement.setTransformMatrix(update.anchor.originFromAnchorTransform, relativeTo: nil)
                pinStatus = "Pinned to this room"
            case .removed:
                pinStatus = "Pinned spot lost · Re-place to start over"
            }
        }
    }

    // MARK: - Marker detection-range test

    /// Image tracking for the printed test markers, or nil (with the reason in the test panel) when it can't run.
    private func makeImageTracking() -> ImageTrackingProvider? {
        guard ImageTrackingProvider.isSupported else {
            markers.status = "Image tracking isn't supported here"
            return nil
        }
        var refs: [ReferenceImage] = []
        for m in TestMarker.all {
            guard let cg = markers.image(for: m) else {
                markers.status = "Missing reference image for \(m.code)"
                continue
            }
            var ref = ReferenceImage(cgimage: cg, physicalSize: CGSize(width: m.width, height: m.width))
            ref.name = m.code
            refs.append(ref)
        }
        guard !refs.isEmpty else { return nil }
        markers.status = "Looking for \(refs.count) markers"
        return ImageTrackingProvider(referenceImages: refs)
    }

    /// Distance from the headset to each marker on every image anchor update.
    private func trackMarkers(_ images: ImageTrackingProvider, world: WorldTrackingProvider) async {
        for await update in images.anchorUpdates {
            let anchor = update.anchor
            guard let code = anchor.referenceImage.name else { continue }
            let m = anchor.originFromAnchorTransform
            var distance = 0.0
            if let head = world.queryDeviceAnchor(atTimestamp: CACurrentMediaTime()) {
                let h = head.originFromAnchorTransform.columns.3
                distance = Double(simd_distance(SIMD3(h.x, h.y, h.z), SIMD3(m.columns.3.x, m.columns.3.y, m.columns.3.z)))
            }
            let tracked = update.event != .removed && anchor.isTracked
            markers.observe(code: code, tracked: tracked, distance: distance, transform: m)
            let scale = anchor.estimatedScaleFactor
            if tracked, abs(scale - 1) > 0.03 {
                markers.status = String(format: "%@ looks %.0f%% off its printed size: check the print", code, (scale - 1) * 100)
            }
        }
    }

    /// Provider errors (Apple's forums report intermittent "Adding reference image failed") go to the test panel.
    private func watchSessionEvents(_ session: ARKitSession) async {
        for await event in session.events {
            if case .dataProviderStateChanged(_, let newState, let error) = event, let error {
                markers.status = "Tracking stopped (\(newState)): \(error.localizedDescription)"
            }
        }
    }

    func spaceClosed() {
        session?.stop()
        session = nil
        world = nil
    }

    /// The scene's centre 2 m ahead of the user on the floor, with VLM north pointing away from them.
    private func placeAhead() {
        var position = SIMD3<Float>(0, 0, -2)
        var yaw: Float = 0
        if let world, world.state == .running,
           let head = world.queryDeviceAnchor(atTimestamp: CACurrentMediaTime()) {
            let m = head.originFromAnchorTransform
            var f = SIMD2<Float>(-m.columns.2.x, -m.columns.2.z) // the head looks down its -Z
            if simd_length(f) > 0.01 {
                f = simd_normalize(f)
                position = [m.columns.3.x + 2 * f.x, 0, m.columns.3.z + 2 * f.y]
                yaw = atan2(-f.x, -f.y)
            }
        }
        model.placement.setPosition(position, relativeTo: nil)
        model.placement.setOrientation(simd_quatf(angle: yaw, axis: [0, 1, 0]), relativeTo: nil)
    }

    func pin() async {
        guard trackingSupported else {
            print("[vlm] pin: world tracking is not supported here")
            pinStatus = "Pinning needs a device"
            return
        }
        guard let world, world.state == .running else {
            pinStatus = "Enter the space first, then pin"
            return
        }
        if let old = pinnedID { try? await world.removeAnchor(forID: old) }
        let anchor = WorldAnchor(originFromAnchorTransform: model.placement.transformMatrix(relativeTo: nil))
        do {
            try await world.addAnchor(anchor)
            pinnedID = anchor.id
            pinStatus = "Pinned to this room"
        } catch {
            print("[vlm] pin failed: \(error.localizedDescription)")
            pinStatus = "Pin failed: \(error.localizedDescription)"
        }
    }

    /// Clears the pin and puts the scene 2 m ahead again.
    func replace() async {
        if let old = pinnedID, let world, world.state == .running { try? await world.removeAnchor(forID: old) }
        pinnedID = nil
        pinStatus = trackingSupported ? "Not pinned" : "Pinning needs a device"
        placeAhead()
    }

    // MARK: - Gestures

    /// The entity a gesture on `entity` should move in the current mode, or nil when it shouldn't do anything.
    func target(for entity: Entity) -> Entity? {
        switch mode {
        case .view:
            return nil
        case .place:
            return entity.components.has(PlaceHandleComponent.self) ? model.placement : nil
        case .edit:
            guard let key = model.renderer.key(of: entity) else { return nil }
            select(key)
            return model.renderer.entity(for: key)
        }
    }

    /// `translation` is in the target's parent space, measured from where the drag started.
    func drag(_ target: Entity, by translation: SIMD3<Float>) {
        if dragStart == nil { dragStart = target.position }
        var t = translation
        if mode == .place { t.y = 0 } // the scene stays on the floor
        target.position = dragStart! + t
    }

    /// `yaw` in radians about world up, measured from where the rotation started.
    func rotate(_ target: Entity, yaw: Float) {
        if rotateStart == nil { rotateStart = target.orientation(relativeTo: nil) }
        target.setOrientation(simd_quatf(angle: yaw, axis: [0, 1, 0]) * rotateStart!, relativeTo: nil)
    }

    func magnify(_ target: Entity, by magnification: Float) {
        guard mode == .edit, let key = model.renderer.key(of: target),
              let feed = model.renderer.feedTransform(for: key) else { return }
        if scaleStart == nil { scaleStart = target.scale.x / max(feed.scale.x, 0.0001) }
        let factor = min(max(scaleStart! * magnification, 0.1), 10)
        target.scale = feed.scale * factor
    }

    func gestureEnded() {
        let moved = dragStart != nil || rotateStart != nil || scaleStart != nil
        dragStart = nil
        rotateStart = nil
        scaleStart = nil
        guard moved else { return }
        switch mode {
        case .edit:
            if let key = selectedKey { editedKeys.insert(key) }
        case .place:
            if pinnedID != nil, world != nil { Task { await pin() } } // keep the pin where the scene now is
        case .view:
            break
        }
    }

    // MARK: - Selection and local edits

    var selectedName: String? { selectedKey.map { model.renderer.item(for: $0)?.name ?? $0 } }

    func select(_ key: String) {
        guard key != selectedKey else { return }
        if let old = selectedKey, let e = model.renderer.entity(for: old) { Self.setHighlight(false, on: e) }
        selectedKey = key
        if let e = model.renderer.entity(for: key) { Self.setHighlight(true, on: e) }
    }

    func resetSelected() {
        guard let key = selectedKey, let e = model.renderer.entity(for: key),
              let t = model.renderer.feedTransform(for: key) else { return }
        e.transform = t
        editedKeys.remove(key)
    }

    /// The feed wins: an item the feed changed was rebuilt from the feed, so its local edit is gone.
    private func feedChanged(_ d: PlanDiff) {
        let changed = Set(d.update.map(\.key) + d.add.map(\.key) + d.remove)
        editedKeys.subtract(changed)
        if let key = selectedKey, d.remove.contains(key) { selectedKey = nil }
    }

    private func makeEditable(key: String, entity: Entity) {
        var b = entity.visualBounds(recursive: true, relativeTo: entity)
        if b.isEmpty { b = BoundingBox(min: [-0.25, 0, -0.25], max: [0.25, 0.5, 0.25]) }
        let size = simd_max(b.extents, SIMD3<Float>(repeating: 0.02)) // planes get a thin box
        entity.components.set(CollisionComponent(shapes: [ShapeResource.generateBox(size: size).offsetBy(translation: b.center)]))
        var input = InputTargetComponent()
        input.isEnabled = mode == .edit
        entity.components.set(input)
        entity.components.set(HoverEffectComponent())
        entity.components.set(EditableItemComponent(bounds: BoundingBox(min: b.center - size / 2, max: b.center + size / 2)))
        if key == selectedKey { Self.setHighlight(true, on: entity) }
    }

    private static let highlightName = "vlm-selection"

    private static func setHighlight(_ on: Bool, on entity: Entity) {
        entity.findEntity(named: highlightName)?.removeFromParent()
        guard on, let b = entity.components[EditableItemComponent.self]?.bounds else { return }
        var mat = UnlitMaterial(color: UIColor(red: 0.2, green: 0.85, blue: 1, alpha: 1))
        mat.blending = .transparent(opacity: 0.22)
        let box = ModelEntity(mesh: .generateBox(size: b.extents * 1.04 + 0.03), materials: [mat])
        box.name = highlightName
        box.position = b.center
        entity.addChild(box)
    }

    private func updateTargets() {
        for e in guides.children {
            e.components[InputTargetComponent.self]?.isEnabled = mode == .place
        }
        for e in model.renderer.root.children {
            e.components[InputTargetComponent.self]?.isEnabled = mode == .edit
        }
    }

    // MARK: - Guides

    private static func translucent(_ color: UIColor, _ opacity: Float) -> UnlitMaterial {
        var m = UnlitMaterial(color: color)
        m.blending = .transparent(opacity: .init(floatLiteral: opacity))
        return m
    }

    private static func makeHandle(_ e: Entity, collision: ShapeResource) {
        e.components.set(CollisionComponent(shapes: [collision]))
        e.components.set(InputTargetComponent())
        e.components.set(HoverEffectComponent())
        e.components.set(PlaceHandleComponent())
    }

    /// A 0.6 m disc at the scene's centre with an arrow and an "N" pointing to VLM north (+Z, RealityKit -Z).
    static func makeMarker() -> Entity {
        let marker = Entity()
        marker.name = "vlm-marker"
        let accent = UIColor(red: 0.2, green: 0.85, blue: 1, alpha: 1)
        let disc = ModelEntity(mesh: .generateCylinder(height: 0.004, radius: 0.3), materials: [translucent(.white, 0.35)])
        disc.position.y = 0.002
        marker.addChild(disc)
        let shaft = ModelEntity(mesh: .generateBox(size: [0.04, 0.006, 0.3]), materials: [translucent(accent, 0.9)])
        shaft.position = [0, 0.006, -0.1]
        marker.addChild(shaft)
        let head = ModelEntity(mesh: .generateCone(height: 0.12, radius: 0.07), materials: [translucent(accent, 0.9)])
        head.orientation = simd_quatf(angle: -.pi / 2, axis: [1, 0, 0]) // cone tip (+Y) to -Z
        head.scale = [1, 1, 0.1] // flatten it onto the floor
        head.position = [0, 0.006, -0.31]
        marker.addChild(head)
        let n = ModelEntity(mesh: .generateText("N", extrusionDepth: 0.002, font: .boldSystemFont(ofSize: 0.12), alignment: .center),
                            materials: [UnlitMaterial(color: accent)])
        let nb = n.visualBounds(relativeTo: nil)
        n.orientation = simd_quatf(angle: -.pi / 2, axis: [1, 0, 0]) // lie flat, reading from the south
        n.position = [-nb.center.x, 0.006, -0.42 + nb.center.y]
        marker.addChild(n)
        makeHandle(marker, collision: .generateBox(size: [0.6, 0.06, 0.6]).offsetBy(translation: [0, 0.03, 0]))
        return marker
    }

    /// A thin outline of one 16 m parcel around the scene's centre (VLM 0…16 on x and z).
    static func makeFootprint() -> Entity {
        let footprint = Entity()
        footprint.name = "vlm-footprint"
        let mat = translucent(UIColor(red: 0.2, green: 0.85, blue: 1, alpha: 1), 0.6)
        let half: Float = 8, w: Float = 0.03
        for (pos, size) in [
            (SIMD3<Float>(0, 0.003, -half), SIMD3<Float>(2 * half, 0.005, w)),
            (SIMD3<Float>(0, 0.003, half), SIMD3<Float>(2 * half, 0.005, w)),
            (SIMD3<Float>(-half, 0.003, 0), SIMD3<Float>(w, 0.005, 2 * half)),
            (SIMD3<Float>(half, 0.003, 0), SIMD3<Float>(w, 0.005, 2 * half)),
        ] {
            let edge = ModelEntity(mesh: .generateBox(size: size), materials: [mat])
            edge.position = pos
            footprint.addChild(edge)
        }
        makeHandle(footprint, collision: .generateBox(size: [2 * half, 0.04, 2 * half]).offsetBy(translation: [0, 0.02, 0]))
        return footprint
    }
}
