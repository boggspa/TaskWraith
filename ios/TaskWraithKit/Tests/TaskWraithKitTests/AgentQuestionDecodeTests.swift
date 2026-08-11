// ask_user_question row decode — the wire contract for the inline question card.
// The Mac projects row.agentQuestion = {promptId, question, options?, context?}
// from the asking system message (RemoteThreadProjection buildAgentQuestion); this
// pins the Swift decode. Additive optional + synthesized Codable ⇒ an older Mac
// that doesn't send the field decodes to nil (the inline branch simply never
// fires and the top banner remains).

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Agent-question row decode")
struct AgentQuestionDecodeTests {
    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: Data(json.utf8))
    }

    @Test("an asking row decodes promptId/question/options/context")
    func decodesQuestion() throws {
        let r = try row(
            """
            {"id":"agent-question-q1","role":"system","kind":"attention",
             "agentQuestion":{"promptId":"q1","question":"Which DB?",
                              "options":["Postgres","SQLite"],"context":"analytics service"}}
            """)
        #expect(r.agentQuestion?.promptId == "q1")
        #expect(r.agentQuestion?.question == "Which DB?")
        #expect(r.agentQuestion?.options == ["Postgres", "SQLite"])
        #expect(r.agentQuestion?.context == "analytics service")
    }

    @Test("an asking row with no options/context decodes them nil")
    func optionalFields() throws {
        let r = try row(
            """
            {"id":"agent-question-q2","role":"system",
             "agentQuestion":{"promptId":"q2","question":"Proceed?"}}
            """)
        #expect(r.agentQuestion?.promptId == "q2")
        #expect(r.agentQuestion?.options == nil)
        #expect(r.agentQuestion?.context == nil)
    }

    @Test("settled fields decode, and isAnswered reads them")
    func settledFields() throws {
        let r = try row(
            """
            {"id":"agent-question-q3","role":"system",
             "agentQuestion":{"promptId":"q3","question":"Replace or alongside?",
               "options":["Replace","Alongside"],"answer":"Replace",
               "isCustomAnswer":false,"outcome":"answered",
               "replyRowId":"agent-question-reply-q3"}}
            """)
        let q = try #require(r.agentQuestion)
        #expect(q.answer == "Replace")
        #expect(q.isCustomAnswer == false)
        #expect(q.outcome == "answered")
        #expect(q.replyRowId == "agent-question-reply-q3")
        #expect(q.isAnswered)
    }

    /// `unanswered` is NOT `skipped`. The Mac cannot tell an open question from a
    /// dismissed one, so the card must not draw that conclusion from this field
    /// alone — only from it PLUS the absence of a live parked-tool card.
    @Test("an unanswered question is not treated as answered")
    func unansweredIsNotAnswered() throws {
        let r = try row(
            """
            {"id":"agent-question-q4","role":"system",
             "agentQuestion":{"promptId":"q4","question":"Proceed?","outcome":"unanswered"}}
            """)
        #expect(r.agentQuestion?.isAnswered == false)
        #expect(r.agentQuestion?.replyRowId == nil)
    }

    /// An older Mac sends no outcome at all. `isAnswered` must fall back to the
    /// presence of an answer rather than assuming either state.
    @Test("an answer with no outcome field still reads as answered")
    func answerWithoutOutcome() throws {
        let r = try row(
            """
            {"id":"agent-question-q5","role":"system",
             "agentQuestion":{"promptId":"q5","question":"Proceed?","answer":"Yes"}}
            """)
        #expect(r.agentQuestion?.isAnswered == true)
    }

    /// A value a NEWER Mac invents must not fail the decode — the field is a
    /// String, never an enum, precisely so the row still renders.
    @Test("an unknown outcome decodes and reads as not-answered")
    func unknownOutcome() throws {
        let r = try row(
            """
            {"id":"agent-question-q6","role":"system",
             "agentQuestion":{"promptId":"q6","question":"Proceed?","outcome":"deferred"}}
            """)
        #expect(r.agentQuestion?.outcome == "deferred")
        #expect(r.agentQuestion?.isAnswered == false)
    }

    @Test("a row from an older Mac (no agentQuestion field) decodes with a nil question")
    func olderMac() throws {
        let r = try row(#"{"id":"m1","role":"system","preview":"hi"}"#)
        #expect(r.agentQuestion == nil)
        #expect(r.id == "m1")
    }

    @Test("the asking seat decodes with its stage identity; absent stays nil")
    func askingSeat() throws {
        let r = try row(
            """
            {"id":"agent-question-q7","role":"system",
             "agentQuestion":{"promptId":"q7","question":"Pick one",
               "seat":{"provider":"grok","model":"grok-4.5-fast","role":"GrokCapt",
                       "seatNumber":15,"stageRole":"scout"}}}
            """)
        #expect(r.agentQuestion?.seat?.role == "GrokCapt")
        #expect(r.agentQuestion?.seat?.seatNumber == 15)
        #expect(r.agentQuestion?.seat?.stageRole == "scout")
        let solo = try row(
            #"{"id":"q8","role":"system","agentQuestion":{"promptId":"q8","question":"Go?"}}"#)
        #expect(solo.agentQuestion?.seat == nil)
    }
}
