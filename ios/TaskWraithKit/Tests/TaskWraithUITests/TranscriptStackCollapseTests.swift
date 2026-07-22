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
