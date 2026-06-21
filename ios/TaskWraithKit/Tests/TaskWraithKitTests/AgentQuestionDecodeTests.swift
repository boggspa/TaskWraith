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

    @Test("a row from an older Mac (no agentQuestion field) decodes with a nil question")
    func olderMac() throws {
        let r = try row(#"{"id":"m1","role":"system","preview":"hi"}"#)
        #expect(r.agentQuestion == nil)
        #expect(r.id == "m1")
    }
}
