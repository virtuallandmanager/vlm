import ARKit
import RealityKit
import SwiftUI
import Vision

@main
struct VirviARApp: App {
    @StateObject private var model = AppModel()
    @StateObject private var markers = MarkerTestModel()

    var body: some SwiftUI.Scene {
        WindowGroup {
            ARScreen(model: model, markers: markers)
                .onAppear { model.connect() }
        }
    }
}

struct ARScreen: View {
    @ObservedObject var model: AppModel
    let markers: MarkerTestModel
    @State private var showSettings = false

    var body: some View {
        ZStack(alignment: .bottom) {
            ARContainer(model: model, markers: markers).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 8) {
                MarkerTestPanel(test: markers, showQR: true)
                Divider()
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
    let markers: MarkerTestModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model, markers: markers) }

    func makeUIView(context: Context) -> ARView {
        let view = ARView(frame: .zero)
        context.coordinator.view = view
        #if !targetEnvironment(simulator)
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal]
        config.environmentTexturing = .automatic
        // Marker test: track the printed markers, with ARKit estimating each one's real printed size.
        config.detectionImages = Set(TestMarker.all.compactMap { m -> ARReferenceImage? in
            guard let cg = markers.image(for: m) else { return nil }
            let ref = ARReferenceImage(cg, orientation: .up, physicalWidth: CGFloat(m.width))
            ref.name = m.code
            return ref
        })
        config.maximumNumberOfTrackedImages = TestMarker.all.count
        config.automaticImageScaleEstimationEnabled = true
        markers.status = "Looking for \(config.detectionImages.count) markers"
        view.session.delegate = context.coordinator
        let anchorRoot = AnchorEntity(world: .zero)
        anchorRoot.addChild(markers.overlays)
        view.scene.addAnchor(anchorRoot)
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
    final class Coordinator: NSObject, ARSessionDelegate {
        let model: AppModel
        let markers: MarkerTestModel
        weak var view: ARView?
        private var anchor: AnchorEntity?
        private var lastReport: TimeInterval = 0
        private var lastQR: TimeInterval = 0
        private var tracked: Set<String> = []
        private var qrBusy = false

        init(model: AppModel, markers: MarkerTestModel) {
            self.model = model
            self.markers = markers
        }

        nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
            let camera = frame.camera.transform.columns.3
            let readings = frame.anchors.compactMap { $0 as? ARImageAnchor }.compactMap { a -> (String, Bool, Double, simd_float4x4, Float)? in
                guard let code = a.referenceImage.name else { return nil }
                let p = a.transform.columns.3
                let d = Double(simd_distance(SIMD3(camera.x, camera.y, camera.z), SIMD3(p.x, p.y, p.z)))
                return (code, a.isTracked, d, a.transform, Float(a.estimatedScaleFactor))
            }
            let time = frame.timestamp
            let pixels = frame.capturedImage
            MainActor.assumeIsolated { self.report(readings, at: time, pixels: pixels) }
        }

        /// Readings at most 10 times a second (and on every found/lost change); a QR read twice a second.
        private func report(_ readings: [(String, Bool, Double, simd_float4x4, Float)], at time: TimeInterval, pixels: CVPixelBuffer) {
            let changed = readings.contains { tracked.contains($0.0) != $0.1 }
            if changed || time - lastReport > 0.1 {
                lastReport = time
                for (code, isTracked, d, t, scale) in readings {
                    markers.observe(code: code, tracked: isTracked, distance: d, transform: t)
                    if isTracked { tracked.insert(code) } else { tracked.remove(code) }
                    if isTracked, abs(scale - 1) > 0.03 {
                        markers.status = String(format: "%@ looks %.0f%% off its printed size: check the print", code, (scale - 1) * 100)
                    }
                }
            }
            guard !qrBusy, time - lastQR > 0.5 else { return }
            lastQR = time
            qrBusy = true
            let distances = Dictionary(readings.filter { $0.1 }.map { ($0.0, $0.2) }, uniquingKeysWith: { a, _ in a })
            Task.detached { [weak self] in
                let request = VNDetectBarcodesRequest()
                request.symbologies = [.qr]
                try? VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .right).perform([request])
                let codes = (request.results ?? []).compactMap { $0.payloadStringValue }.compactMap(TestMarker.code(fromQR:))
                await MainActor.run {
                    guard let self else { return }
                    self.qrBusy = false
                    for code in codes { self.markers.observeQR(code: code, distance: distances[code]) }
                }
            }
        }

        @objc func tap(_ g: UITapGestureRecognizer) {
            guard let view else { return }
            let point = g.location(in: view)
            guard let hit = view.raycast(from: point, allowing: .existingPlaneGeometry, alignment: .horizontal).first
                ?? view.raycast(from: point, allowing: .estimatedPlane, alignment: .horizontal).first else { return }
            anchor?.removeFromParent()
            let a = AnchorEntity(world: hit.worldTransform)
            // Turn the scene so Virvi north (+Z, RealityKit -Z) points away from the camera.
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
