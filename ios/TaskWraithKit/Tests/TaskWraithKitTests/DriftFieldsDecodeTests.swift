import Foundation
import Testing

@testable import TaskWraithKit

/// Decode coverage for the 2026-08 wire-drift closure: the close-out
/// Sub-threads table, the mirrored guest-reply identity, and the
/// side-chat/sub-thread relation on return cards. Each was projected by the
/// Mac and silently dropped (or never shipped) on this side.
@Suite("Wire-drift field decode")
struct DriftFieldsDecodeTests {
    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: Data(json.utf8))
    }

    @Test func closeoutSubThreadsDecodeInOrder() throws {
        let r = try row(
            """
            {"id":"closeout-1","role":"system","preview":"Close-out.",
             "closeoutSubThreads":[
               {"subThreadId":"sub-1","identitySeed":"seed-1","title":"Audit the projection",
                "provider":"claude","parentProvider":"codex","status":"returned"},
               {"subThreadId":"sub-2","provider":"grok","status":"someFutureStatus"}]}
            """)
        let rows = r.closeoutSubThreads ?? []
        #expect(rows.count == 2)
        #expect(rows.first?.title == "Audit the projection")
        #expect(rows.first?.parentProvider == "codex")
        // A status this build has never heard of decodes as-is; the view maps
        // it to the neutral tint rather than the decode deciding.
        #expect(rows.last?.status == "someFutureStatus")
    }

    @Test func guestReplyIdentityDecodes() throws {
        let r = try row(
            """
            {"id":"guest-1","role":"assistant","kind":"assistant","preview":"Here you go.",
             "guestReply":{"provider":"mistral","role":"Guest","model":"mistral-large-3",
                           "guestChatId":"guest-chat-9"}}
            """)
        #expect(r.guestReply?.provider == "mistral")
        #expect(r.guestReply?.guestChatId == "guest-chat-9")
        let plain = try row(#"{"id":"a1","role":"assistant","preview":"hi"}"#)
        #expect(plain.guestReply == nil)
    }

    @Test func linkedChildRelationDecodesAndDefaultsToSubThread() throws {
        let side = try row(
            """
            {"id":"ret-1","role":"tool","preview":"Done.",
             "subThreadReturn":{"subThreadId":"side-1","title":"Quick check",
                                "linkedChildRelation":"sideChat"}}
            """)
        #expect(side.subThreadReturn?.linkedChildRelation == "sideChat")
        let legacy = try row(
            #"{"id":"ret-2","role":"tool","preview":"Done.","subThreadReturn":{"subThreadId":"sub-9"}}"#
        )
        #expect(legacy.subThreadReturn?.linkedChildRelation == nil)
    }
}
