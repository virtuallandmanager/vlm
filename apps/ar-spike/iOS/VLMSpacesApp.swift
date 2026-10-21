import ARKit
import RealityKit
import SwiftUI

@main
struct VLMSpacesApp: App {
    @StateObject private var model = AppModel()

    var body: some SwiftUI.Scene {
        WindowGroup {
            ARScreen(model: model)
                .onAppear { model.connect() }
        }
    }
}

struct ARScreen: View {
    @ObservedObject var model: AppModel
    @State private var showSettings = false

    var body: some View {
        ZStack(alignment: .bottom) {
            ARContainer(model: model).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 8) {
                StatusLine(feed: model.feed)
                Text("Tap the floor to place the scene's centre.").font(.footnote)
                HStack {
                    Toggle("Tabletop 1:20", isOn: $model.tabletop).fixedSize()
                    Spacer()
                    Button("Settings") { showSettings = true }.buttonStyle(.borderedProminent)
                }
            }
            .padding()
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            .padding()
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                SettingsForm(model: model)
                    .navigationTitle("Settings")
                    .toolbar { Button("Done") { showSettings = false } }
            }
        }
    }
}

struct ARContainer: UIViewRepresentable {
    let model: AppModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> ARView {
        let view = ARView(frame: .zero)
        context.coordinator.view = view
        #if !targetEnvironment(simulator)
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal]
        config.environmentTexturing = .automatic
        view.session.run(config)
        let coaching = ARCoachingOverlayView()
        coaching.session = view.session
        coaching.goal = .horizontalPlane
        coaching.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(coaching)
        #endif
        view.addGestureRecognizer(UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap(_:))))
        return view
    }

    func updateUIView(_ uiView: ARView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject {
        let model: AppModel
        weak var view: ARView?
        private var anchor: AnchorEntity?

        init(model: AppModel) { self.model = model }

        @objc func tap(_ g: UITapGestureRecognizer) {
            guard let view else { return }
            let point = g.location(in: view)
            guard let hit = view.raycast(from: point, allowing: .existingPlaneGeometry, alignment: .horizontal).first
                ?? view.raycast(from: point, allowing: .estimatedPlane, alignment: .horizontal).first else { return }
            anchor?.removeFromParent()
            let a = AnchorEntity(world: hit.worldTransform)
            // Turn the scene so VLM north (+Z, RealityKit -Z) points away from the camera.
            let f = view.cameraTransform.matrix.columns.2 // camera looks down its -Z
            let fx = -f.x, fz = -f.z
            model.placement.orientation = simd_quatf(angle: atan2(-fx, -fz), axis: [0, 1, 0])
            // Keep the anchor's position but drop the plane's tilt.
            a.orientation = simd_quatf(ix: 0, iy: 0, iz: 0, r: 1)
            a.addChild(model.placement)
            view.scene.addAnchor(a)
            anchor = a
        }
    }
}
