import RealityKit
import SwiftUI

@main
struct VLMSpacesApp: App {
    @StateObject private var model = AppModel()

    var body: some SwiftUI.Scene {
        WindowGroup {
            ContentView(model: model)
                .onAppear { model.connect() }
        }
        .defaultSize(width: 600, height: 760)

        ImmersiveSpace(id: ImmersiveSpaceID.vlm) {
            ImmersiveView(model: model)
        }
        .immersionStyle(selection: .constant(.mixed), in: .mixed)
    }
}

enum ImmersiveSpaceID {
    static let vlm = "vlm-space"
}

struct ContentView: View {
    @ObservedObject var model: AppModel
    @Environment(\.openImmersiveSpace) private var openImmersiveSpace
    @Environment(\.dismissImmersiveSpace) private var dismissImmersiveSpace
    @State private var inSpace = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // At the top so a short window can't push it out of sight below the settings.
                Button(inSpace ? "Leave space" : "Enter space") {
                    Task {
                        if inSpace {
                            await dismissImmersiveSpace()
                            inSpace = false
                        } else {
                            if case .opened = await openImmersiveSpace(id: ImmersiveSpaceID.vlm) { inSpace = true }
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding()
                SettingsForm(model: model)
            }
            .navigationTitle("VLM Spaces")
        }
        .task {
            // Debug: `-autoEnterSpace YES` as a launch argument opens the space without a tap (simulator checks).
            if UserDefaults.standard.bool(forKey: "autoEnterSpace"), !inSpace,
               case .opened = await openImmersiveSpace(id: ImmersiveSpaceID.vlm) { inSpace = true }
        }
    }
}

/// Life-size: the scene's centre 2 m in front of where the space opened, on the floor (an immersive space's
/// origin is at floor level below the user).
struct ImmersiveView: View {
    let model: AppModel

    var body: some View {
        RealityView { content in
            let floor = AnchorEntity(world: .zero)
            model.placement.position = [0, 0, -2]
            model.placement.orientation = simd_quatf(ix: 0, iy: 0, iz: 0, r: 1)
            floor.addChild(model.placement)
            content.add(floor)
        }
    }
}
