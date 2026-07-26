import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

/// Wire + fold coverage for the two transcript row kinds that previously had no
/// iOS counterpart and fell through to a plain assistant bubble / bare error
/// row: the ensemble fan-out lane result and the provider run failure.
@Suite("Fan-out + run-failure rows (desktop card parity)")
struct FanoutAndRunFailureRowTests {
    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: Data(json.utf8))
    }

    private let laneJSON = """
        {"id":"lane-a","role":"assistant","kind":"assistant","preview":"Lane output.",
         "fanoutResult":{"laneId":"lane-a","intent":"write","provider":"claude",
                         "role":"Reviewer","model":"claude-opus-5","order":2,"partCount":3}}
        """

    private let failureJSON = """
        {"id":"fail-1","role":"error","kind":"error","preview":"boom",
         "runFailure":{"provider":"claude","headline":"Claude / Reviewer failed · exit 1",
                       "exitCode":1,"failureAt":"2026-05-28T11:59:00.000Z",
                       "lines":[{"text":"boom","timestamp":"2026-05-28T11:58:59.000Z"},
                                {"text":"stack trace line"}],
                       "hint":"Context window exhausted — run /compact."}}
        """

    @Test func decodesTheFanoutLaneHeader() throws {
        let lane = try row(laneJSON)
        let fanout = try #require(lane.fanoutResult)
        #expect(fanout.laneId == "lane-a")
        #expect(fanout.intent == "write")
        #expect(fanout.role == "Reviewer")
        #expect(fanout.order == 2)
        #expect(fanout.partCount == 3)
        // The row itself stays an ordinary assistant row so the prose and tool
        // branches keep rendering beneath the lane header.
        #expect(lane.role == "assistant")
    }

    @Test func decodesTheRunFailureCard() throws {
        let failure = try #require(try row(failureJSON).runFailure)
        #expect(failure.headline == "Claude / Reviewer failed · exit 1")
        #expect(failure.exitCode == 1)
        #expect(failure.lines?.count == 2)
        #expect(failure.lines?.first?.timestamp == "2026-05-28T11:58:59.000Z")
        // The hint is a SEPARATE field, never folded into the stderr dump.
        #expect(failure.hint?.contains("/compact") == true)
    }

    /// An unknown intent from a newer Mac must not fail the row decode — the
    /// card falls back to the generic lane label instead.
    @Test func toleratesAnUnknownLaneIntent() throws {
        let lane = try row(
            #"{"id":"l","role":"assistant","fanoutResult":{"laneId":"l","intent":"sideways"}}"#)
        #expect(lane.fanoutResult?.intent == "sideways")
    }

    /// Ollama-backed lanes wear their upstream brand, matching the desktop's
    /// live `resolveProviderHueClass(provider, model)`.
    @Test func resolvesTheParticipantBrandHueNotTheGenericProvider() throws {
        let lane = try row(laneJSON)
        #expect(lane.fanoutResult?.brandProviderKey == "claude")
        let ollama = try row(
            """
            {"id":"l","role":"assistant",
             "fanoutResult":{"laneId":"l","provider":"ollama","model":"qwen3-coder:30b"}}
            """)
        let key = try #require(ollama.fanoutResult?.brandProviderKey)
        #expect(key != "ollama")
    }

    /// The whole point of the cards: neither may be folded into a one-line
    /// activity summary. A failure hidden behind "Used 3 tools" reads as
    /// success, and a folded lane loses the only attribution to its seat.
    @Test func neitherCardFoldsIntoASettledStack() throws {
        let laneWithTools = try row(
            """
            {"id":"lane-a","role":"tool","toolSummary":{"activityCount":2,"status":"success"},
             "fanoutResult":{"laneId":"lane-a"}}
            """)
        #expect(!twCanCollapseIntoStack(laneWithTools))

        let failingTools = try row(
            """
            {"id":"fail","role":"tool","toolSummary":{"activityCount":3,"status":"error"},
             "runFailure":{"headline":"Claude failed","lines":[]}}
            """)
        #expect(!twCanCollapseIntoStack(failingTools))

        // Thinking-only variants of the same rows are equally unfoldable.
        let thinkingLane = try row(
            """
            {"id":"l","role":"assistant","thinking":{"preview":"pondering"},
             "fanoutResult":{"laneId":"l"}}
            """)
        #expect(!twIsThinkingOnlyRow(thinkingLane))

        // A system notice carrying either card keeps its full rendering.
        let systemWithFailure = try row(
            """
            {"id":"s","role":"system","preview":"Run failed.",
             "runFailure":{"headline":"Claude failed","lines":[]}}
            """)
        #expect(!twIsPlainSystemNoticeRow(systemWithFailure))
    }

    /// Guard the control case: without the new fields the same rows still fold,
    /// so the guards narrowed nothing that used to collapse.
    @Test func ordinaryRowsStillFold() throws {
        let tools = try row(
            #"{"id":"t","role":"tool","toolSummary":{"activityCount":2,"status":"success"}}"#)
        #expect(twCanCollapseIntoStack(tools))
        let notice = try row(#"{"id":"s","role":"system","preview":"Round closed."}"#)
        #expect(twIsPlainSystemNoticeRow(notice))
    }
}
