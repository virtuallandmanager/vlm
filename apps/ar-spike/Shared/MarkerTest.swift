import RealityKit
import SwiftUI
import UIKit

/// The detection-range test's state, shared by both apps: each marker's readings, plus (iPhone) the last QR read.
@MainActor
final class MarkerTestModel: ObservableObject {
    @Published private(set) var readings: [String: MarkerReading] = [:]
    @Published private(set) var qr: String = "No QR code read yet"
    @Published var status: String = "Not started"
    /// A translucent square drawn over each tracked marker, so you can see how well it lines up.
    let overlays = Entity()
    private var boxes: [String: ModelEntity] = [:]

    func image(for marker: TestMarker) -> CGImage? {
        UIImage(named: "\(marker.code)-reference")?.cgImage
    }

    func observe(code: String, tracked: Bool, distance: Double, transform: simd_float4x4?) {
        readings[code, default: MarkerReading()].observe(tracked: tracked, distance: distance)
        let box = boxes[code] ?? makeBox(code)
        box.isEnabled = tracked
        if tracked, let transform { box.setTransformMatrix(transform, relativeTo: nil) }
    }

    func observeQR(code: String, distance: Double?) {
        let at = distance.map { String(format: " at %.2f m", $0) } ?? " (marker not tracked, distance unknown)"
        qr = "QR \(code) read\(at) · \(Date.now.formatted(date: .omitted, time: .standard))"
    }

    func reset() {
        readings = [:]
        qr = "No QR code read yet"
    }

    func summary(_ marker: TestMarker) -> String {
        readings[marker.code]?.summary ?? "not seen yet"
    }

    private func makeBox(_ code: String) -> ModelEntity {
        let width = Float(TestMarker.all.first { $0.code == code }?.width ?? 0.12)
        // Image anchors put the image in their x-z plane, facing +y.
        let box = ModelEntity(
            mesh: .generateBox(width: width, height: 0.004, depth: width),
            materials: [UnlitMaterial(color: UIColor.systemGreen.withAlphaComponent(0.45))]
        )
        box.isEnabled = false
        overlays.addChild(box)
        boxes[code] = box
        return box
    }
}

/// One line per marker, plus the QR line (iPhone) and a Reset button.
struct MarkerTestPanel: View {
    @ObservedObject var test: MarkerTestModel
    var showQR: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Marker test").font(.headline)
                Spacer()
                Button("Reset") { test.reset() }
            }
            Text(test.status).font(.footnote).foregroundStyle(.secondary)
            ForEach(TestMarker.all) { m in
                Text("\(m.code) (\(Int(m.width * 1000)) mm): \(test.summary(m))").font(.footnote.monospaced())
            }
            if showQR { Text(test.qr).font(.footnote.monospaced()) }
        }
    }
}
