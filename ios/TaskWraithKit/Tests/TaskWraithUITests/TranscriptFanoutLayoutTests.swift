import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("Fan-out lane layout (iPad pairing + six-plus compact band)")
struct TranscriptFanoutLayoutTests {
    private func laneRow(_ id: String) throws -> RemoteThreadSnapshot.Row {
        try row(
            """
            {"id":"\(id)","role":"assistant","kind":"assistant","runId":"run-\(id)",
             "preview":"Lane \(id) result.","fanoutResult":{
               "laneId":"\(id)","provider":"claude","role":"Scout","model":"claude-opus-5"}}
            """)
    }

    private func plainRow(_ id: String) throws -> RemoteThreadSnapshot.Row {
        try row(#"{"id":"\#(id)","role":"assistant","kind":"assistant","preview":"Prose."}"#)
    }

    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: Data(json.utf8))
    }

    // MARK: - Two-across pairing

    @Test func pairsAnEvenRunFromItsStart() throws {
        let rows = [try laneRow("a"), try laneRow("b"), try laneRow("c"), try laneRow("d")]
        let placements = twPairFanoutLaneRun(rows)
        #expect(placements.count == 2)
        #expect(placements[0] == .pair(lead: rows[0], trail: rows[1]))
        #expect(placements[1] == .pair(lead: rows[2], trail: rows[3]))
    }

    @Test func leavesTheOddRemainderSoloAtFullWidth() throws {
        let rows = [try laneRow("a"), try laneRow("b"), try laneRow("c")]
        let placements = twPairFanoutLaneRun(rows)
        #expect(placements.count == 2)
        #expect(placements[0] == .pair(lead: rows[0], trail: rows[1]))
        #expect(placements[1] == .solo(rows[2]))
    }

    @Test func aSingleLaneStaysSolo() throws {
        let rows = [try laneRow("a")]
        #expect(twPairFanoutLaneRun(rows) == [.solo(rows[0])])
        #expect(twPairFanoutLaneRun([]) == [])
    }

    /// Desktop parity: pairing from the run's START keeps earlier slots stable
    /// while lanes stream in — appending a lane may only change the placement
    /// of the run's last row.
    @Test func appendingALaneOnlyChangesTheLastPlacement() throws {
        let rows = [try laneRow("a"), try laneRow("b"), try laneRow("c"), try laneRow("d")]
        let before = twPairFanoutLaneRun(Array(rows.prefix(3)))
        let after = twPairFanoutLaneRun(rows)
        #expect(before[0] == after[0])
        #expect(before[1] == .solo(rows[2]))
        #expect(after[1] == .pair(lead: rows[2], trail: rows[3]))
    }

    @Test func placementIdentityAnchorsOnTheLeadRow() throws {
        let rows = [try laneRow("a"), try laneRow("b"), try laneRow("c")]
        let placements = twPairFanoutLaneRun(rows)
        #expect(placements[0].id == "fanout-pair-a")
        #expect(placements[1].id == "fanout-solo-c")
    }

    // MARK: - Pairing enablement

    @Test func pairsOnlyOnARegularWidthPad() {
        #expect(twFanoutLanePairingEnabled(isPadInterface: true, isRegularWidth: true))
        // Slide-over narrow iPads read like phones.
        #expect(!twFanoutLanePairingEnabled(isPadInterface: true, isRegularWidth: false))
        // A landscape Max iPhone reports regular width and deliberately stays
        // single-column — the phone band is sized for one lane per line.
        #expect(!twFanoutLanePairingEnabled(isPadInterface: false, isRegularWidth: true))
        #expect(!twFanoutLanePairingEnabled(isPadInterface: false, isRegularWidth: false))
    }

    // MARK: - Six-plus compact band

    @Test func compactsEveryLaneOfASixPlusRunRetroactively() throws {
        var rows: [RemoteThreadSnapshot.Row] = [try plainRow("dispatch")]
        for index in 0..<6 { rows.append(try laneRow("lane-\(index)")) }
        rows.append(try plainRow("writer"))
        let compact = twCompactFanoutLaneRowIds(rows)
        #expect(compact == Set((0..<6).map { "lane-\($0)" }))
    }

    @Test func fiveAdjacentLanesKeepTheFullBand() throws {
        var rows: [RemoteThreadSnapshot.Row] = []
        for index in 0..<5 { rows.append(try laneRow("lane-\(index)")) }
        #expect(twCompactFanoutLaneRowIds(rows).isEmpty)
    }

    /// Any other row ends a run: two three-lane waves never merge into a
    /// six-lane run merely because they share a transcript.
    @Test func aNonLaneRowSplitsTheRun() throws {
        var rows: [RemoteThreadSnapshot.Row] = []
        for index in 0..<3 { rows.append(try laneRow("first-\(index)")) }
        rows.append(try plainRow("writer"))
        for index in 0..<3 { rows.append(try laneRow("second-\(index)")) }
        #expect(twCompactFanoutLaneRowIds(rows).isEmpty)
    }

    @Test func onlyTheBigRunCompactsWhenWavesCoexist() throws {
        var rows: [RemoteThreadSnapshot.Row] = []
        for index in 0..<6 { rows.append(try laneRow("big-\(index)")) }
        rows.append(try plainRow("handoff"))
        for index in 0..<2 { rows.append(try laneRow("small-\(index)")) }
        let compact = twCompactFanoutLaneRowIds(rows)
        #expect(compact == Set((0..<6).map { "big-\($0)" }))
    }

    @Test func thresholdMatchesDesktopParity() {
        #expect(twFanoutLaneCompactThreshold == 6)
    }

    // MARK: - Band selection

    @Test func compactBandIsShorterThanTheFullBandWithScaledFade() {
        #expect(TWFanoutResultViewport.collapsedMaxHeight(compact: false) == 92)
        #expect(TWFanoutResultViewport.collapsedMaxHeight(compact: true) == 62)
        #expect(TWFanoutResultViewport.edgeFadeHeight(compact: false) == 17)
        #expect(TWFanoutResultViewport.edgeFadeHeight(compact: true) == 11)
        #expect(
            TWFanoutResultViewport.collapsedMaxHeight(compact: true)
                < TWFanoutResultViewport.collapsedMaxHeight(compact: false))
        #expect(
            TWFanoutResultViewport.edgeFadeHeight(compact: true)
                < TWFanoutResultViewport.edgeFadeHeight(compact: false))
    }
}
