import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

/// Wire decode for Task-complete epic-stack tables projected on close-out rows.
@Suite("Task-complete epic stack (desktop Participants/Commits parity)")
struct RunCompleteEpicStackTests {
    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: Data(json.utf8))
    }

    @Test func decodesCloseoutParticipantAndCommitTables() throws {
        let decoded = try row(
            """
            {"id":"closeout-epic","role":"system","kind":"system","speaker":"TaskWraith",
             "preview":"Worked for 1m","ensembleRoundId":"round-1",
             "closeoutParticipantTable":{
               "totalWorkLabel":"202k Tks / 1 Turn",
               "rows":[{
                 "participantId":"p1","seatText":"#2 SparkDocs",
                 "workLabel":"202k Tks / 1 Turn","status":"answered",
                 "seatLink":{"participantId":"p1",
                   "after":{"provider":"codex","model":"gpt-5.3-codex-spark",
                            "role":"SparkDocs","seatNumber":2,
                            "permissionPresetId":"workspace_write"}}
               }]},
             "closeoutFileChanges":[{
               "path":"src/main/RemoteThreadProjection.ts","status":"modified",
               "additions":18,"deletions":2
             }],"closeoutFileChangesTotal":75,
             "closeoutCommits":[{
               "hash":"18003ca96abcdef","subject":"Add TaskWraith transcript closeouts",
               "stats":"21 files","participantId":"p1",
               "seatLink":{"participantId":"p1",
                 "after":{"provider":"codex","model":"gpt-5.3-codex-spark",
                          "role":"SparkDocs","seatNumber":2,
                          "permissionPresetId":"workspace_write"}}
             }]}
            """)
        let table = try #require(decoded.closeoutParticipantTable)
        #expect(table.totalWorkLabel == "202k Tks / 1 Turn")
        #expect(table.rows?.count == 1)
        #expect(table.rows?.first?.status == "answered")
        #expect(table.rows?.first?.seatLink?.renderableLink?.after.provider == "codex")
        let files = try #require(decoded.closeoutFileChanges)
        #expect(files.count == 1)
        #expect(files.first?.path == "src/main/RemoteThreadProjection.ts")
        #expect(files.first?.status == "modified")
        #expect(files.first?.additions == 18)
        #expect(decoded.closeoutFileChangesTotal == 75)
        let commits = try #require(decoded.closeoutCommits)
        #expect(commits.count == 1)
        #expect(commits.first?.hash == "18003ca96abcdef")
        #expect(commits.first?.seatLink?.renderableLink != nil)
    }

    @Test func toleratesCloseoutRowsWithoutEpicTables() throws {
        let decoded = try row(
            #"{"id":"closeout-legacy","role":"system","kind":"system","speaker":"TaskWraith","preview":"done"}"#
        )
        #expect(decoded.closeoutParticipantTable == nil)
        #expect(decoded.closeoutCommits == nil)
        #expect(decoded.closeoutFileChanges == nil)
    }
}

@Suite("Task-complete close-out authority")
struct TaskCompleteCloseoutAuthorityTests {
    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: Data(json.utf8))
    }

    private func summary(_ json: String) throws -> RemoteThreadSnapshot.RunSummary {
        try JSONDecoder().decode(RemoteThreadSnapshot.RunSummary.self, from: Data(json.utf8))
    }

    @Test func preservesRoundCloseoutAuthorityOnTheWire() throws {
        let decoded = try row(
            """
            {"id":"round-closeout","role":"system","kind":"system","speaker":"TaskWraith",
             "ensembleRoundId":"round-1","isCloseout":true,"closeoutScope":"ensembleRound",
             "closeoutRoundId":"round-1","closeoutStatus":"cancelled","closeoutDurationMs":42000,
             "closeoutSubThreads":[{"subThreadId":"sub-1","status":"returned"}]}
            """
        )

        #expect(decoded.isCloseout == true)
        #expect(decoded.closeoutScope == "ensembleRound")
        #expect(decoded.closeoutRoundId == "round-1")
        #expect(decoded.closeoutStatus == "cancelled")
        #expect(decoded.closeoutDurationMs == 42_000)
    }

    @Test func explicitRoundCloseoutBeatsTheFinalParticipantLane() throws {
        let aggregate = try summary(
            #"{"runId":"last-lane","ensembleRoundId":"round-1","status":"success"}"#)
        let roundCloseout = try row(
            """
            {"id":"round-closeout","role":"system","speaker":"TaskWraith",
             "ensembleRoundId":"round-1","isCloseout":true,"closeoutScope":"ensembleRound",
             "closeoutRoundId":"round-1","closeoutStatus":"cancelled",
             "closeoutParticipantTable":{"rows":[{"participantId":"p1"}]}}
            """
        )
        let finalLaneCloseout = try row(
            """
            {"id":"last-lane-closeout","role":"system","speaker":"TaskWraith","runId":"last-lane",
             "ensembleRoundId":"round-1","isCloseout":true,"closeoutScope":"run",
             "closeoutStatus":"success","closeoutParticipantTable":{"rows":[{"participantId":"p1"}]}}
            """
        )

        let selected = twPreferredCloseoutRow(
            for: aggregate, rows: [roundCloseout, finalLaneCloseout])
        #expect(selected?.id == "round-closeout")
        #expect(selected?.closeoutStatus == "cancelled")
    }

    @Test func terminalEvidenceRejectsActiveStatusesAndKeepsKnownTerminalOutcomes() throws {
        for status in [
            "active", "cancelling", "idle", "paused", "pending", "queued", "running", "sleeping",
            "starting", "waiting"
        ] {
            let active = try summary("{\"status\":\"\(status)\"}")
            #expect(!twIsTerminalRunSummary(active))
        }
        #expect(!twIsTerminalRunSummary(try summary(
            #"{"status":"running","endedAt":"2026-08-24T12:00:00Z"}"#)))
        #expect(twIsTerminalRunSummary(try summary(#"{"status":"success_with_warnings"}"#)))
        #expect(twIsTerminalRunSummary(try summary(#"{"status":"cancelled"}"#)))
        #expect(twIsTerminalRunSummary(try summary(
            #"{"status":"future-terminal","endedAt":"2026-08-24T12:00:00Z"}"#)))
    }

    @Test func titleUsesCancelledLanguageAndNoRunRoundCanRender() throws {
        #expect(twTaskCompleteTitle(for: "cancelled") == "Run cancelled")
        #expect(twTaskCompleteTitle(for: "canceled") == "Run cancelled")
        #expect(twTaskCompleteTitle(for: "failed") == "Run failed")
        #expect(
            twTaskCompleteEffectiveStatus(
                closeoutStatus: "cancelled", runStatus: "success", exitCode: 0) == "cancelled")
        #expect(
            twTaskCompleteEffectiveStatus(
                closeoutStatus: nil, runStatus: nil, exitCode: 130) == "cancelled")

        let closeout = try row(
            """
            {"id":"preflight-closeout","role":"system","ensembleRoundId":"round-empty",
             "isCloseout":true,"closeoutScope":"ensembleRound","closeoutRoundId":"round-empty",
             "closeoutStatus":"cancelled","closeoutDurationMs":1200,
             "closeoutSubThreads":[{"subThreadId":"sub-1","status":"cancelled"}]}
            """
        )
        let synthetic = twSyntheticRoundCloseoutSummary(roundId: "round-empty", closeout: closeout)
        #expect(synthetic.runId == nil)
        #expect(synthetic.ensembleRoundId == "round-empty")
        #expect(synthetic.status == "cancelled")
        #expect(synthetic.durationMs == 1200)
    }
}
