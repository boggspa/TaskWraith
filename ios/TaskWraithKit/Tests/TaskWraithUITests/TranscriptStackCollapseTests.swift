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
        let delegation = try row(
            #"{"id":"d1","role":"system","preview":"Delegated","subThreadDelegation":{"subThreadId":"sub-1"}}"#
        )

        #expect(twCanCollapseIntoStack(tool))
        #expect(twCanCollapseIntoStack(thinking))
        #expect(!twCanCollapseIntoStack(answer))
        // Interactive cards never fold away.
        #expect(!twCanCollapseIntoStack(question))
        #expect(!twCanCollapseIntoStack(delegation))
        #expect(!twIsPlainSystemNoticeRow(delegation))
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

    @Test func plainSystemNoticesAndCompactionRecordsCollapseButCardsDoNot() throws {
        let notice = try row(
            #"{"id":"s1","role":"system","preview":"@-mention: extra turn appended for kimi."}"#)
        #expect(twIsPlainSystemNoticeRow(notice))
        #expect(
            twCollapsedSystemNoticeLabel("\n@-mention: extra turn appended for kimi.\nmore")
                == "@-mention: extra turn appended for kimi.")
        #expect(twCollapsedSystemNoticeLabel("") == "System notice")

        let compaction = try row(
            #"{"id":"s2","role":"system","preview":"Context compacted: 80% -> 20%"}"#)
        // Electron treats settled context-compaction records as ordinary
        // collapsed notices; expanding the iOS one-liner restores the card.
        #expect(twIsPlainSystemNoticeRow(compaction))
        let compactionFailure = try row(
            #"{"id":"s2-failed","role":"system","preview":"Context compaction failed · retry"}"#)
        #expect(twIsPlainSystemNoticeRow(compactionFailure))
        let question = try row(
            #"{"id":"q1","role":"system","preview":"Pick one","agentQuestion":{"promptId":"p1","question":"Pick one"}}"#)
        #expect(!twIsPlainSystemNoticeRow(question))
        let empty = try row(#"{"id":"s3","role":"system"}"#)
        #expect(!twIsPlainSystemNoticeRow(empty))
        let assistant = try row(#"{"id":"a1","role":"assistant","preview":"hello"}"#)
        #expect(!twIsPlainSystemNoticeRow(assistant))
    }

    @Test func peopleContributionsNeverFoldToAnonymousSystemNotices() throws {
        // Desktop parity (TranscriptPanel `plainSystemNoticeMessage`): a
        // DELIVERED contribution is a person's words, not app chrome. Folded,
        // it reads "System · …" and can disappear entirely behind
        // "System · 2 system notices" — with its trust framing.
        let delivered = try row(
            #"{"id":"pc1","role":"system","preview":"Looks good — ship the auth branch.","peopleContribution":{"collaboratorDisplayName":"Ana","delivery":"delivered","sourceTrust":"external"}}"#
        )
        #expect(!twIsPlainSystemNoticeRow(delivered))
        #expect(!twCanCollapseIntoStack(delivered))

        let queued = try row(
            #"{"id":"pc2","role":"system","preview":"Consider the retry path too.","peopleContribution":{"collaboratorDisplayName":"Ana","delivery":"queued","insertedAsDraft":false}}"#
        )
        #expect(!twIsPlainSystemNoticeRow(queued))

        // A peer thread message is a card surface for the same reason. Today
        // its rows arrive role:"tool" without activities (unfoldable only by
        // accident); this pins the card against any future role/activity
        // change rather than leaning on that coincidence.
        let peerMessage = try row(
            #"{"id":"tm1","role":"system","preview":"Handing off: auth branch is yours.","threadMessage":{"threadMessageId":"m1","fromChatTitle":"Planning","trust":"peer"}}"#
        )
        #expect(!twIsPlainSystemNoticeRow(peerMessage))
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

@Suite("Collapsed one-liner failure accent (desktop b0cebe3fc parity)")
struct CollapsedStackFailureAccentTests {
    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: Data(json.utf8))
    }

    @Test func failureAttributionNeverBleedsToNeighbourFamilies() throws {
        let rows = [
            try row(
                """
                {"id":"t1","role":"tool","toolSummary":{"activityCount":3,"status":"error","tools":[
                  {"name":"Read","category":"read","status":"success","file":"a.ts"},
                  {"name":"Shell","category":"shell","status":"error"},
                  {"name":"Shell","category":"shell","status":"success"}
                ]}}
                """)
        ]
        let summary = twCollapsedStackSummary(rows: rows)
        let read = summary.parts.first { $0.verb == "Read" }
        let ran = summary.parts.first { $0.verb == "Ran" }
        #expect(read?.failed == false)
        #expect(ran?.failed == true)
        // The joined label is byte-equal to the parts join — a11y and
        // cross-surface parity rely on it.
        #expect(summary.label == summary.parts.map(\.text).joined(separator: " · "))
    }

    @Test func errorTallyIsAVerblessFailedPart() throws {
        let rows = [
            try row(
                """
                {"id":"t1","role":"tool","toolSummary":{"activityCount":1,"status":"error","tools":[
                  {"name":"Shell","category":"shell","status":"error"}
                ]}}
                """)
        ]
        let summary = twCollapsedStackSummary(rows: rows)
        let tally = summary.parts.last
        #expect(tally?.text == "1 error")
        #expect(tally?.verb == "")
        #expect(tally?.failed == true)
    }

    @Test func genericToolFailuresAccentTheUsedVerb() throws {
        let rows = [
            try row(
                """
                {"id":"t1","role":"tool","toolSummary":{"activityCount":2,"status":"error","tools":[
                  {"name":"Custom","category":"task","status":"error"},
                  {"name":"Read","category":"read","status":"success","file":"a.ts"}
                ]}}
                """)
        ]
        let summary = twCollapsedStackSummary(rows: rows)
        let used = summary.parts.first { $0.verb == "Used" }
        let read = summary.parts.first { $0.verb == "Read" }
        #expect(used?.failed == true)
        #expect(read?.failed == false)
    }

    @Test func superGroupNoticeSuffixNeverAccents() throws {
        let rows = [
            try row(
                """
                {"id":"t1","role":"tool","toolSummary":{"activityCount":1,"status":"error","tools":[
                  {"name":"Shell","category":"shell","status":"error"}
                ]}}
                """)
        ]
        let summary = twCollapsedSuperStackSummary(
            stackRows: rows, systemCount: 2, firstSystemPreview: "round closed")
        let suffix = summary.parts.last
        #expect(suffix?.text == "2 system notices")
        #expect(suffix?.failed == false)
        #expect(suffix?.verb == "")
        #expect(summary.label == summary.parts.map(\.text).joined(separator: " · "))
        // The member failure still accents its own family part.
        #expect(summary.parts.first { $0.verb == "Ran" }?.failed == true)
    }

    @Test func allSystemSuperGroupsNeverAccent() {
        let summary = twCollapsedSuperStackSummary(
            stackRows: [], systemCount: 3, firstSystemPreview: "@-mention: extra turn appended")
        #expect(summary.parts.allSatisfy { !$0.failed && $0.verb.isEmpty })
        #expect(summary.label == summary.parts.map(\.text).joined(separator: " · "))
    }

    /// The Mac carries participant-authored conversation on a SYSTEM record so
    /// it never becomes a completed assistant turn in provider history, then
    /// promotes the row to `kind: "assistant"` for presentation
    /// (`classifyRemoteKind`, whose own comment says remote clients group by
    /// `kind`). Reading `role` here instead folded a seat's message to another
    /// seat — and a guest's entire reply — into "System · N system notices",
    /// while the desktop gives both a full assistant-level row.
    @Test func kindPromotedParticipantRowsNeverFold() throws {
        let interSeatNote = try row(
            """
            {"id":"s1","role":"system","kind":"assistant",
             "preview":"↪ Claude to Codex: can you take the parser?",
             "ensembleParticipantId":"p1","speaker":"Claude / Writer"}
            """)
        let guestReply = try row(
            """
            {"id":"s2","role":"system","kind":"assistant","preview":"Needs tests.",
             "guestReply":{"guestChatId":"guest-1","provider":"claude"}}
            """)

        #expect(!twIsPlainSystemNoticeRow(interSeatNote))
        #expect(!twIsPlainSystemNoticeRow(guestReply))
        // The promotion must not swallow ordinary chrome: an unpromoted system
        // row still folds exactly as before.
        let notice = try row(
            #"{"id":"s3","role":"system","kind":"system","preview":"Round closed."}"#)
        #expect(twIsPlainSystemNoticeRow(notice))
    }

    /// Fleet waves, Boss polls and hop-limit changes carry no structured card,
    /// so on the wire they were indistinguishable from round-close chrome and
    /// folded here while the desktop excluded each by name. The Mac now stamps
    /// `noticeKind`; the phone keys on PRESENCE, so a kind the Mac learns to
    /// stamp later keeps its standing on this build too.
    @Test func distinguishedSystemNoticesNeverFold() throws {
        for kind in ["fleetWave", "ensembleBossmanPoll", "continuationHopsChange", "somethingNewer"]
        {
            let notice = try row(
                """
                {"id":"n-\(kind)","role":"system","kind":"system",
                 "noticeKind":"\(kind)","preview":"Fleet wave 2 dispatched to 4 seats."}
                """)
            #expect(!twIsPlainSystemNoticeRow(notice))
            #expect(!twCanCollapseIntoStack(notice))
        }

        // An unstamped system row is still ordinary chrome.
        let chrome = try row(
            #"{"id":"n0","role":"system","kind":"system","preview":"Round closed."}"#)
        #expect(twIsPlainSystemNoticeRow(chrome))
    }

    /// An older Mac that populates the guest payload without promoting `kind`
    /// must still keep the reply whole — the card guard is the second line.
    @Test func guestRepliesSurviveAnUnpromotedCarrier() throws {
        let legacyGuestReply = try row(
            """
            {"id":"s4","role":"system","kind":"system","preview":"Needs tests.",
             "guestReply":{"guestChatId":"guest-1","provider":"claude"}}
            """)
        #expect(!twIsPlainSystemNoticeRow(legacyGuestReply))
        #expect(!twCanCollapseIntoStack(legacyGuestReply))
    }

    @Test func cleanStacksCarryNoFailedParts() throws {
        let rows = [
            try row(
                #"{"id":"th1","role":"assistant","thinking":{"preview":"pondering"}}"#),
            try row(
                """
                {"id":"t1","role":"tool","toolSummary":{"activityCount":1,"status":"success","tools":[
                  {"name":"Read","category":"read","status":"success","file":"a.ts"}
                ]}}
                """)
        ]
        let summary = twCollapsedStackSummary(rows: rows)
        #expect(summary.parts.allSatisfy { !$0.failed })
        #expect(summary.errorCount == 0)
    }
}
