import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("Fan-out viewport collapse (desktop parity)")
struct TranscriptFanoutCollapseTests {
    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: Data(json.utf8))
    }

    private func summary(_ json: String) throws -> RemoteThreadSnapshot.RunSummary {
        try JSONDecoder().decode(RemoteThreadSnapshot.RunSummary.self, from: Data(json.utf8))
    }

    @Test func collapsesACompletedScoutWaveAfterSerialHandoff() throws {
        let rows = [
            try row(
                """
                {"id":"dispatch","role":"system","kind":"system","ensembleRoundId":"round-1",
                 "preview":"Automatic read stage · 2 read-only participants dispatched concurrently."}
                """),
            try row(
                """
                {"id":"lane-a","role":"assistant","kind":"assistant","ensembleRoundId":"round-1",
                 "runId":"lane-run-a","preview":"Scout A result.","fanoutResult":{
                   "laneId":"lane-a","participantId":"claude-scout","provider":"claude",
                   "role":"Scout","model":"claude-opus-5","order":1}}
                """),
            try row(
                """
                {"id":"lane-b","role":"assistant","kind":"assistant","ensembleRoundId":"round-1",
                 "runId":"lane-run-b","preview":"Scout B result.","fanoutResult":{
                   "laneId":"lane-b","participantId":"grok-scout","provider":"grok",
                   "role":"Scout","model":"grok-4","order":2}}
                """),
            try row(
                """
                {"id":"writer","role":"assistant","kind":"assistant","ensembleRoundId":"round-1",
                 "runId":"writer-run","preview":"Now implementing the findings."}
                """)
        ]
        let summaries = [
            try summary(
                #"{"runId":"lane-run-a","ensembleRoundId":"round-1","status":"success","startedAt":"2026-08-03T18:00:00Z","endedAt":"2026-08-03T18:00:03Z"}"#),
            try summary(
                #"{"runId":"lane-run-b","ensembleRoundId":"round-1","status":"success","startedAt":"2026-08-03T18:00:00Z","endedAt":"2026-08-03T18:00:04Z"}"#),
            try summary(
                #"{"runId":"writer-run","ensembleRoundId":"round-1","status":"running","startedAt":"2026-08-03T18:00:05Z"}"#)
        ]

        let groups = twCollapsedFanoutViewportGroups(rows: rows, runSummaries: summaries)
        #expect(groups.count == 1)
        let group = try #require(groups.first)
        #expect(group.stage == .scout)
        #expect(group.dispatchLabel == "Automatic read stage")
        #expect(group.laneCount == 2)
        #expect(group.laneRows.map(\.id) == ["lane-a", "lane-b"])
        #expect(group.attributions.map(\.provider) == ["claude", "grok"])
        #expect(group.attributions.map(\.role) == ["Scout", "Scout"])
    }

    @Test func keepsIncompleteAndLiveWavesAsFullLaneCards() throws {
        let incomplete = [
            try row(
                #"{"id":"dispatch","role":"system","ensembleRoundId":"round-1","preview":"Scout fan-out · 2 read-only participants dispatched concurrently."}"#),
            try row(
                #"{"id":"lane-a","role":"assistant","ensembleRoundId":"round-1","runId":"lane-run-a","fanoutResult":{"laneId":"lane-a","provider":"claude"}}"#),
            try row(
                #"{"id":"writer","role":"assistant","ensembleRoundId":"round-1","runId":"writer-run","preview":"Work"}"#)
        ]
        let live = [
            try row(
                #"{"id":"dispatch","role":"system","ensembleRoundId":"round-2","preview":"Scout fan-out · 1 read-only participants dispatched concurrently."}"#),
            try row(
                #"{"id":"lane-a","role":"assistant","ensembleRoundId":"round-2","runId":"lane-run-a","fanoutResult":{"laneId":"lane-a","provider":"claude"}}"#),
            try row(
                #"{"id":"writer","role":"assistant","ensembleRoundId":"round-2","runId":"writer-run","preview":"Work"}"#)
        ]
        let terminalSummaries = [
            try summary(
                #"{"runId":"lane-run-a","ensembleRoundId":"round-1","status":"success","endedAt":"2026-08-03T18:00:03Z"}"#),
            try summary(
                #"{"runId":"writer-run","ensembleRoundId":"round-1","status":"running","startedAt":"2026-08-03T18:00:04Z"}"#)
        ]
        let liveSummaries = [
            try summary(
                #"{"runId":"lane-run-a","ensembleRoundId":"round-2","status":"running","startedAt":"2026-08-03T18:00:00Z"}"#),
            try summary(
                #"{"runId":"writer-run","ensembleRoundId":"round-2","status":"running","startedAt":"2026-08-03T18:00:04Z"}"#)
        ]

        // One of two declared lanes never arrived: no summary must hide it.
        #expect(twCollapsedFanoutViewportGroups(rows: incomplete, runSummaries: terminalSummaries).isEmpty)
        // A later serial turn does not make an active lane safe to fold.
        #expect(twCollapsedFanoutViewportGroups(rows: live, runSummaries: liveSummaries).isEmpty)
    }

    @Test func doesNotTreatALaneTerminalCodaAsALaterTurn() throws {
        let rows = [
            try row(
                #"{"id":"dispatch","role":"system","ensembleRoundId":"round-1","preview":"Scout fan-out · 1 read-only participants dispatched concurrently."}"#),
            try row(
                #"{"id":"lane-a","role":"assistant","ensembleRoundId":"round-1","runId":"lane-run-a","fanoutResult":{"laneId":"lane-a","provider":"claude"}}"#),
            // The lane's own later status has the same run id; this is still
            // part of the just-completed wave, not a handoff to another turn.
            try row(
                #"{"id":"lane-coda","role":"system","ensembleRoundId":"round-1","runId":"lane-run-a","preview":"Claude / Scout yielded."}"#)
        ]
        let summaries = [
            try summary(
                #"{"runId":"lane-run-a","ensembleRoundId":"round-1","status":"success","endedAt":"2026-08-03T18:00:03Z"}"#)
        ]

        #expect(twCollapsedFanoutViewportGroups(rows: rows, runSummaries: summaries).isEmpty)
    }

    @Test func keepsSuccessiveWaveStagesSeparate() throws {
        let rows = [
            try row(
                #"{"id":"scout-dispatch","role":"system","ensembleRoundId":"round-1","preview":"Scout fan-out · 1 read-only participants dispatched concurrently."}"#),
            try row(
                #"{"id":"scout-lane","role":"assistant","ensembleRoundId":"round-1","runId":"scout-run","fanoutResult":{"laneId":"scout-lane","provider":"claude","role":"Scout"}}"#),
            try row(
                #"{"id":"work-dispatch","role":"system","ensembleRoundId":"round-1","preview":"Write-scope work · 1 participant(s) dispatched concurrently (0 read / 1 write-intent)."}"#),
            try row(
                #"{"id":"work-lane","role":"assistant","ensembleRoundId":"round-1","runId":"work-run","fanoutResult":{"laneId":"work-lane","provider":"codex","role":"Writer"}}"#),
            try row(
                #"{"id":"reviewer","role":"assistant","ensembleRoundId":"round-1","runId":"review-run","preview":"Review starts."}"#)
        ]
        let summaries = [
            try summary(
                #"{"runId":"scout-run","ensembleRoundId":"round-1","status":"success","endedAt":"2026-08-03T18:00:03Z"}"#),
            try summary(
                #"{"runId":"work-run","ensembleRoundId":"round-1","status":"success","endedAt":"2026-08-03T18:00:05Z"}"#),
            try summary(
                #"{"runId":"review-run","ensembleRoundId":"round-1","status":"running","startedAt":"2026-08-03T18:00:06Z"}"#)
        ]

        let groups = twCollapsedFanoutViewportGroups(rows: rows, runSummaries: summaries)
        #expect(groups.map(\.stage) == [.scout, .work])
        #expect(groups.map(\.laneRows).map { $0.map(\.id) } == [["scout-lane"], ["work-lane"]])
    }
}
