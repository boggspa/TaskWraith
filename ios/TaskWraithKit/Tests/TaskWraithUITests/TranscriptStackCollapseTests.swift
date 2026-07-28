import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("Settled-stack collapse (desktop parity)")
struct TranscriptStackCollapseTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try decode(RemoteThreadSnapshot.Row.self, json)
    }

    @Test func toolAndThinkingRowsFoldIntoStacks() throws {
        let tool = try row(
            #"{"id":"t1","role":"tool","toolSummary":{"activityCount":2,"status":"success"}}"#)
        let thinking = try row(
            #"{"id":"th1","role":"assistant","thinking":{"preview":"pondering","status":"done"}}"#)
        let answer = try row(#"{"id":"a1","role":"assistant","preview":"Answer body"}"#)
        let question = try row(
            #"{"id":"q1","role":"tool","toolSummary":{"activityCount":1},"agentQuestion":{"promptId":"p1","question":"Pick one"}}"#
        )

        #expect(twCanCollapseIntoStack(tool))
        #expect(twCanCollapseIntoStack(thinking))
        #expect(!twCanCollapseIntoStack(answer))
        // Interactive cards never fold away.
        #expect(!twCanCollapseIntoStack(question))
        // A thinking trace attached to an answer body is not thinking-only.
        let thinkingWithBody = try row(
            #"{"id":"th2","preview":"body","thinking":{"preview":"pondering"}}"#)
        #expect(!twIsThinkingOnlyRow(thinkingWithBody))
    }

    @Test func summaryLeadsWithThinkingAndFollowsFamilyOrder() throws {
        let rows = [
            try row(
                #"{"id":"th1","role":"assistant","thinking":{"preview":"pondering"}}"#),
            try row(
                """
                {"id":"t1","role":"tool","toolSummary":{"activityCount":4,"status":"success","tools":[
                  {"name":"Search","category":"search","status":"success"},
                  {"name":"Search","category":"search","status":"success"},
                  {"name":"Read","category":"read","status":"success","file":"a/Blackboard.ts"},
                  {"name":"Read","category":"read","status":"success","file":"a/types.ts"}
                ]}}
                """),
            try row(
                """
                {"id":"t2","role":"tool","toolSummary":{"activityCount":2,"status":"success","tools":[
                  {"name":"Edit","category":"write","status":"success","file":"a/Blackboard.ts"},
                  {"name":"Shell","category":"shell","status":"success"}
                ]}}
                """)
        ]
        let summary = twCollapsedStackSummary(rows: rows)
        #expect(
            summary.label == "Thought · Searched ×2 · Read 2 files · Edited 1 file · Ran 1 command")
        #expect(summary.errorCount == 0)
        #expect(summary.rowCount == 3)
    }

    @Test func summarySurfacesErrorsAndWireTruncatedEntries() throws {
        let rows = [
            try row(
                """
                {"id":"t1","role":"tool","toolSummary":{"activityCount":5,"status":"error","tools":[
                  {"name":"Shell","category":"shell","status":"error"},
                  {"name":"Shell","category":"shell","status":"success"}
                ]}}
                """)
        ]
        let summary = twCollapsedStackSummary(rows: rows)
        // 5 activities, 2 detailed → 3 fold into the generic bucket.
        #expect(summary.label == "Ran 2 commands · Used 3 tools · 1 error")
        #expect(summary.errorCount == 1)
    }

    @Test func plainSystemNoticesCollapseButSpecialSystemSurfacesDoNot() throws {
        let notice = try row(
            #"{"id":"s1","role":"system","preview":"@-mention: extra turn appended for kimi."}"#)
        #expect(twIsPlainSystemNoticeRow(notice))
        #expect(
            twCollapsedSystemNoticeLabel("\n@-mention: extra turn appended for kimi.\nmore")
                == "@-mention: extra turn appended for kimi.")
        #expect(twCollapsedSystemNoticeLabel("") == "System notice")

        let compaction = try row(
            #"{"id":"s2","role":"system","preview":"Context compacted: 80% -> 20%"}"#)
        #expect(!twIsPlainSystemNoticeRow(compaction))
        let empty = try row(#"{"id":"s3","role":"system"}"#)
        #expect(!twIsPlainSystemNoticeRow(empty))
        let assistant = try row(#"{"id":"a1","role":"assistant","preview":"hello"}"#)
        #expect(!twIsPlainSystemNoticeRow(assistant))
    }
}

extension TranscriptStackCollapseTests {
    @Test func superStackSummaryMergesStacksAndAppendsNoticeCount() throws {
        let rows = [
            try row(#"{"id":"th1","role":"assistant","thinking":{"preview":"pondering"}}"#),
            try row(
                """
                {"id":"t1","role":"tool","toolSummary":{"activityCount":2,"status":"success","tools":[
                  {"name":"Shell","category":"shell","status":"success"},
                  {"name":"Shell","category":"shell","status":"success"}
                ]}}
                """)
        ]
        let summary = twCollapsedSuperStackSummary(
            stackRows: rows, systemCount: 2, firstSystemPreview: "Blackboard updated.")
        #expect(summary.label == "Thought · Ran 2 commands · 2 system notices")
    }

    @Test func superStackSummaryLeadsWithNoticesWhenAllSystem() {
        let summary = twCollapsedSuperStackSummary(
            stackRows: [], systemCount: 3, firstSystemPreview: "Round closed.")
        #expect(summary.label == "3 system notices · Round closed.")
        #expect(summary.rowCount == 0)
    }
}

/// F7 (2026-07): a failed run must never leave the Task-complete card telling
/// the reader to "see the transcript above" when the transcript above is bare.
extension TranscriptStackCollapseTests {
    @Test func runFailureExplanationFoundViaCardOrErrorRow() throws {
        let card = try row(
            #"{"id":"e1","role":"error","runId":"r1","preview":"boom","runFailure":{"headline":"Ollama failed","lines":[]}}"#
        )
        let plainError = try row(#"{"id":"e2","role":"error","runId":"r1","preview":"boom"}"#)
        let errorByKind = try row(#"{"id":"e3","kind":"error","runId":"r1","preview":"boom"}"#)

        #expect(twRunHasFailureExplanation(rows: [card], runId: "r1"))
        #expect(twRunHasFailureExplanation(rows: [plainError], runId: "r1"))
        #expect(twRunHasFailureExplanation(rows: [errorByKind], runId: "r1"))
    }

    @Test func runFailureExplanationIgnoresOtherRunsAndOrdinaryRows() throws {
        let otherRunError = try row(#"{"id":"e1","role":"error","runId":"r2","preview":"boom"}"#)
        let assistant = try row(#"{"id":"a1","role":"assistant","runId":"r1","preview":"hi"}"#)
        let tools = try row(
            #"{"id":"t1","role":"tool","runId":"r1","toolSummary":{"activityCount":3,"status":"error"}}"#
        )

        // A run whose only rows are prose and tool calls explains nothing —
        // that is exactly the empty tail this predicate must report.
        #expect(!twRunHasFailureExplanation(rows: [otherRunError, assistant, tools], runId: "r1"))
        #expect(!twRunHasFailureExplanation(rows: [], runId: "r1"))
        #expect(!twRunHasFailureExplanation(rows: [assistant], runId: nil))
        #expect(!twRunHasFailureExplanation(rows: [assistant], runId: ""))
    }
}
