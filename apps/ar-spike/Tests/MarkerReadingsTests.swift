import XCTest

final class MarkerReadingsTests: XCTestCase {
    func testFoundDistanceIsWhereTrackingStartsAndLostIsWhereItStops() {
        var r = MarkerReading()
        r.observe(tracked: true, distance: 3.1)
        r.observe(tracked: true, distance: 3.6)
        r.observe(tracked: false, distance: 4.2)
        r.observe(tracked: true, distance: 2.4)
        XCTAssertEqual(r.foundAt, [3.1, 2.4])
        XCTAssertEqual(r.lostAt, [3.6])
        XCTAssertEqual(r.farthestFound, 3.1)
        XCTAssertEqual(r.farthestTracked, 3.6)
        XCTAssertEqual(r.now, 2.4)
        XCTAssertTrue(r.tracked)
    }

    func testNotTrackedHasNoCurrentDistance() {
        var r = MarkerReading()
        r.observe(tracked: false, distance: 5)
        XCTAssertNil(r.now)
        XCTAssertEqual(r.foundAt, [])
        XCTAssertNil(r.farthestFound)
    }

    func testSummaryLine() {
        var r = MarkerReading()
        XCTAssertEqual(r.summary, "not seen yet")
        r.observe(tracked: true, distance: 2.345)
        XCTAssertEqual(r.summary, "tracking at 2.35 m · found at 2.35 m (farthest 2.35 m)")
        r.observe(tracked: false, distance: 4)
        XCTAssertEqual(r.summary, "not tracking · found at 2.35 m (farthest 2.35 m) · lost at 2.35 m")
    }

    func testMarkerForQRPayload() {
        XCTAssertEqual(TestMarker.code(fromQR: "HTTPS://VIRVI.IO/S/TEST12"), "TEST12")
        XCTAssertEqual(TestMarker.code(fromQR: "https://virvi.io/s/test17"), "TEST17")
        XCTAssertNil(TestMarker.code(fromQR: "https://example.com/s/TEST12"))
    }
}
