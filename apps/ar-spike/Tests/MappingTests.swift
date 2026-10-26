import simd
import XCTest

/// Ports of the numeric cases in packages/hyperfy-app/test/transform.test.ts.
final class MappingTests: XCTestCase {
    private func v(_ x: Double, _ y: Double, _ z: Double) -> Vec3 { Vec3(x: x, y: y, z: z) }
    private func rad(_ d: Double) -> Double { d * .pi / 180 }
    private let identity = Vec3(x: 0, y: 0, z: 0)
    private let one = Vec3(x: 1, y: 1, z: 1)

    private func assertClose(_ a: SIMD3<Double>, _ b: SIMD3<Double>, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(a.x, b.x, accuracy: 1e-9, file: file, line: line)
        XCTAssertEqual(a.y, b.y, accuracy: 1e-9, file: file, line: line)
        XCTAssertEqual(a.z, b.z, accuracy: 1e-9, file: file, line: line)
    }

    func testPositionZIsMirrored() {
        XCTAssertEqual(toRealityKitTransform(position: v(1, 2, 3), rotation: identity, scale: one).position, [1, 2, -3])
    }

    func testRotationDegreesBecomeRadiansWithXAndYNegated() {
        let t = toRealityKitTransform(position: identity, rotation: v(10, 20, 30), scale: one)
        assertClose(t.rotation, [-rad(10), -rad(20), rad(30)])
    }

    func testScaleIsUnchanged() {
        XCTAssertEqual(toRealityKitTransform(position: identity, rotation: identity, scale: v(2, 3, 4)).scale, [2, 3, 4])
    }

    func testA90DegreeYawFacesTheSameWay() {
        // DCL forward (0,0,1) yawed 90° is (1,0,0); in RealityKit (forward -Z) it is still (1,0,0).
        let t = toRealityKitTransform(position: identity, rotation: v(0, 90, 0), scale: one)
        assertClose(t.orientation.act([0, 0, -1]), [1, 0, 0])
    }

    func testCombinedRotationKeepsForwardUpAndRight() {
        let (rx, ry, rz) = (20.0, 135.0, -10.0)
        let dcl = quaternionYXZ([rad(rx), rad(ry), rad(rz)])
        let rk = toRealityKitTransform(position: identity, rotation: v(rx, ry, rz), scale: one).orientation
        let mirror = { (p: SIMD3<Double>) in SIMD3<Double>(p.x, p.y, -p.z) }
        for base in [SIMD3<Double>(0, 0, 1), [0, 1, 0], [1, 0, 0]] {
            assertClose(rk.act(mirror(base)), mirror(dcl.act(base)))
        }
    }

    func testModelTurnLandsWhereDecentralandShowsIt() {
        // Decentraland shows a glTF point g at local (-gx, gy, gz), then applies the element's transform.
        let (rx, ry, rz) = (20.0, 135.0, -10.0)
        let s = SIMD3<Double>(2, 3, 0.5)
        let dclQ = quaternionYXZ([rad(rx), rad(ry), rad(rz)])
        let t = toRealityKitTransform(position: v(4, 1, 7), rotation: v(rx, ry, rz), scale: v(2, 3, 0.5))
        let inner = quaternionYXZ(MODEL_TURN)
        for g in [SIMD3<Double>(1, 0, 0), [0, 0, 1], [0.3, -2, 5]] {
            let dcl = dclQ.act(SIMD3(-g.x, g.y, g.z) * s) + SIMD3(4, 1, 7)
            let expected = SIMD3(dcl.x, dcl.y, -dcl.z)
            // Entity transform order: scale, then rotate, then translate (same as three.js Matrix4.compose).
            let actual = t.orientation.act(inner.act(g) * t.scale) + t.position
            assertClose(actual, expected)
        }
    }
}

final class ScenePlanTests: XCTestCase {
    func testImagesVideosModelsAndSkips() throws {
        let json = """
        {"images":[{"sk":"img","textureSrc":"https://x/a.PNG?x=1","instances":[
            {"sk":"i1","position":{"x":1,"y":2,"z":3},"scale":{"x":4,"y":2,"z":1}},
            {"sk":"i2","enabled":false}]},
          {"sk":"gif","textureSrc":"https://x/a.gif","instances":[{"sk":"g"}]}],
         "videos":[{"sk":"vid","offType":1,"offImageSrc":"https://x/off.jpg","instances":[{"sk":"v1"}]},
                   {"sk":"pl","offType":2,"playlist":["https://x/p.mp4"],"volume":0.5,"instances":[{"sk":"p1"}]}],
         "models":[{"sk":"m","modelSrc":"https://x/m.glb","enabled":true,"instances":[{"sk":"m1"}]},
                   {"sk":"off","modelSrc":"https://x/o.glb","enabled":false,"instances":[{"sk":"o1"}]}],
         "sounds":[]}
        """
        let scene = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? Props)
        let items = planScene(scene)
        XCTAssertEqual(items.map(\.key), ["vid:v1", "pl:p1", "img:i1", "m:m1"])
        XCTAssertEqual(items[0].kind, .image)
        XCTAssertEqual(items[0].volume, 0)
        XCTAssertEqual(items[1].kind, .video)
        XCTAssertEqual(items[1].volume, 0.5)
        XCTAssertEqual(items[2].width, 4)
        XCTAssertEqual(items[2].height, 2)
        XCTAssertEqual(items[2].transform.position, [1, 2, -3])
        XCTAssertEqual(items[3].kind, .model)
    }

    func testDiff() {
        let a = planScene(["images": [["sk": "e", "textureSrc": "https://x/a.png", "instances": [["sk": "1"], ["sk": "2"]]]]])
        let b = planScene(["images": [["sk": "e", "textureSrc": "https://x/a.png", "instances": [["sk": "2", "scale": ["x": 2]], ["sk": "3"]]]]])
        let d = diffPlans(a, b)
        XCTAssertEqual(d.remove, ["e:1"])
        XCTAssertEqual(d.update.map(\.key), ["e:2"])
        XCTAssertEqual(d.add.map(\.key), ["e:3"])
    }
}
