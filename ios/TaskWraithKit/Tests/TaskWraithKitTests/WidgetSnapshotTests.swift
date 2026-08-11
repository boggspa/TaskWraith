import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Glance widget snapshot")
struct WidgetSnapshotTests {
    private func row(_ index: Int, status: String = "running") -> TWWidgetSnapshot.Row {
        TWWidgetSnapshot.Row(
            threadId: "t-\(index)", title: "Task \(index)", status: status,
            providerLabel: "Claude", tintHex: 0x5A8CFF,
            updatedAt: 1_700_000_000_000)
    }

    @Test func roundTripsThroughTheSharedSuiteAndCapsAtFour() {
        let suite = "tw.tests.widget-snapshot"
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let snapshot = TWWidgetSnapshot(
            generatedAt: 1_700_000_000_000, hostName: "Chris's Mac",
            rows: (0..<9).map { row($0) })
        snapshot.save(suiteName: suite)
        let loaded = TWWidgetSnapshot.load(suiteName: suite)
        // Capped at WRITE so the defaults payload stays bounded.
        #expect(loaded?.rows.count == TWWidgetSnapshot.maxRows)
        #expect(loaded?.rows.first?.title == "Task 0")
        #expect(loaded?.hostName == "Chris's Mac")
    }

    @Test func stalenessIsThirtyMinutes() {
        let generatedAt: Int64 = 1_700_000_000_000
        let snapshot = TWWidgetSnapshot(generatedAt: generatedAt, hostName: nil, rows: [])
        let fresh = Date(timeIntervalSince1970: Double(generatedAt) / 1000 + 60)
        let stale = Date(timeIntervalSince1970: Double(generatedAt) / 1000 + 31 * 60)
        #expect(!snapshot.isStale(now: fresh))
        #expect(snapshot.isStale(now: stale))
    }

    @Test func aFutureStatusDecodesAsIs() throws {
        // A newer app writes statuses this widget build has never seen — the
        // decode must carry them through (the view renders them neutral).
        let json = """
            {"generatedAt":1700000000000,"hostName":null,
             "rows":[{"threadId":"t","title":"X","status":"hibernating",
                      "providerLabel":null,"tintHex":null,"updatedAt":null}]}
            """
        let decoded = try JSONDecoder().decode(TWWidgetSnapshot.self, from: Data(json.utf8))
        #expect(decoded.rows.first?.status == "hibernating")
        #expect(decoded.rows.first?.tintHex == nil)
    }
}
