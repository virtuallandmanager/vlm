import RealityKit
import SwiftUI

@main
struct VirviARApp: App {
    @StateObject private var model: AppModel
    @StateObject private var space: SpaceController
    @StateObject private var markers: MarkerTestModel

    init() {
        let model = AppModel()
        let markers = MarkerTestModel()
        _model = StateObject(wrappedValue: model)
        _markers = StateObject(wrappedValue: markers)
        _space = StateObject(wrappedValue: SpaceController(model: model, markers: markers))
    }

    var body: some SwiftUI.Scene {
        WindowGroup {
            ContentView(model: model, space: space, markers: markers)
                .onAppear { model.connect() }
        }
        .defaultSize(width: 640, height: 820)

        ImmersiveSpace(id: ImmersiveSpaceID.virvi) {
            ImmersiveView(model: model, space: space, markers: markers)
        }
        .immersionStyle(selection: .constant(.mixed), in: .mixed)
    }
}

enum ImmersiveSpaceID {
    static let virvi = "virvi-space"
}

struct ContentView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var space: SpaceController
    @ObservedObject var markers: MarkerTestModel
    @Environment(\.openImmersiveSpace) private var openImmersiveSpace
    @Environment(\.dismissImmersiveSpace) private var dismissImmersiveSpace
    @State private var inSpace = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Space controls first, so a short window can't push them out of sight below the settings.
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 12) {
                        Picker("Mode", selection: $space.mode) {
                            ForEach(SpaceMode.allCases) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        Button(inSpace ? "Leave space" : "Enter space") {
                            Task {
                                if inSpace {
                                    await dismissImmersiveSpace()
                                    inSpace = false
                                } else {
                                    if case .opened = await openImmersiveSpace(id: ImmersiveSpaceID.virvi) { inSpace = true }
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    Text(modeHint).font(.footnote).foregroundStyle(.secondary)

                    HStack(spacing: 12) {
                        Button("Pin to this room") { Task { await space.pin() } }
                        Button("Re-place") { Task { await space.replace() } }
                        Text(space.pinStatus).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            if let name = space.selectedName {
                                VStack(alignment: .leading) {
                                    Text(name).font(.headline).lineLimit(1)
                                    Text(space.editedKeys.contains(space.selectedKey ?? "") ? "Changed on this headset" : "As in Virvi")
                                        .font(.footnote).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Reset object") { space.resetSelected() }
                            } else {
                                Text("No object selected").foregroundStyle(.secondary)
                                Spacer()
                            }
                        }
                        Text("Changes stay on this headset for now. They aren't saved to Virvi, and an edit in Virvi replaces them.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    .padding(12)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))

                    VStack(alignment: .leading, spacing: 6) {
                        MarkerTestPanel(test: markers, showQR: false)
                        Text("Enter the space first: visionOS only tracks images while it's open. Walk back from a marker until it's lost, then walk toward it until it's found again.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    .padding(12)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
                }
                .padding()
                SettingsForm(model: model)
            }
            .navigationTitle("Virvi AR")
        }
        .task {
            // Debug: `-autoEnterSpace YES` as a launch argument opens the space without a tap (simulator checks).
            if UserDefaults.standard.bool(forKey: "autoEnterSpace"), !inSpace,
               case .opened = await openImmersiveSpace(id: ImmersiveSpaceID.virvi) { inSpace = true }
        }
    }

    private var modeHint: String {
        switch space.mode {
        case .view: return "Look around. Gestures are off."
        case .place: return "Pinch and drag the floor marker or the outline to move the scene. Pinch with both hands on the marker and twist to turn it."
        case .edit: return "Pinch an object to select it. Drag to move, twist with both hands to turn, pinch both hands apart or together to resize."
        }
    }
}

/// Life-size: the scene's centre on the floor (an immersive space's origin is at floor level below the user).
/// `SpaceController` places it 2 m ahead, or restores a room pin.
struct ImmersiveView: View {
    let model: AppModel
    let space: SpaceController
    let markers: MarkerTestModel

    var body: some View {
        RealityView { content in
            let floor = AnchorEntity(world: .zero)
            floor.addChild(model.placement)
            content.add(floor)
            content.add(markers.overlays)
        }
        .gesture(
            DragGesture()
                .targetedToAnyEntity()
                .onChanged { v in
                    guard let target = space.target(for: v.entity), let parent = target.parent else { return }
                    let now = v.convert(v.location3D, from: .local, to: parent)
                    let start = v.convert(v.startLocation3D, from: .local, to: parent)
                    space.drag(target, by: now - start)
                }
                .onEnded { _ in space.gestureEnded() }
        )
        .simultaneousGesture(
            RotateGesture3D(constrainedToAxis: .y)
                .targetedToAnyEntity()
                .onChanged { v in
                    guard let target = space.target(for: v.entity) else { return }
                    // SwiftUI's y axis points down; a turn about its +y is a turn about RealityKit's +y with
                    // x and z flipped, so the angle keeps the sign of axis.y.
                    let r = v.rotation
                    space.rotate(target, yaw: Float(r.angle.radians) * (r.axis.y >= 0 ? 1 : -1))
                }
                .onEnded { _ in space.gestureEnded() }
        )
        .simultaneousGesture(
            MagnifyGesture()
                .targetedToAnyEntity()
                .onChanged { v in
                    guard let target = space.target(for: v.entity) else { return }
                    space.magnify(target, by: Float(v.magnification))
                }
                .onEnded { _ in space.gestureEnded() }
        )
        .simultaneousGesture(
            SpatialTapGesture()
                .targetedToAnyEntity()
                .onEnded { v in _ = space.target(for: v.entity) } // selects in Edit mode
        )
        .task { await space.spaceOpened() }
        .onDisappear { space.spaceClosed() }
    }
}
