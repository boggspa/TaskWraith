import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("Trust-aware transcript row wire and adapters")
struct TrustAwareTranscriptRowTests {
    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: Data(json.utf8))
    }

    @Test func decodesPeerIdentityWakeAndContainmentMetadata() throws {
        let decoded = try row(
            """
            {"id":"thread-message-event-1","role":"tool","kind":"tool",
             "preview":"Check [this](https://attacker.example/pixel.png).","truncated":false,
             "timestamp":"2026-08-03T19:00:00.000Z",
             "threadMessage":{"threadMessageId":"event-1","fromChatId":"sender-chat",
                              "fromChatTitle":"Build audit","origin":"user",
                              "requestedDelivery":"wake",
                              "trust":"untrusted-thread-message","truncated":true}}
            """
        )

        let input = try #require(TrustAwareTranscriptRowAdapter.peerInput(for: decoded))
        #expect(input.id == "event-1")
        #expect(input.fromChatId == "sender-chat")
        #expect(input.fromChatTitle == "Build audit")
        #expect(input.origin == .user)
        #expect(input.requestedDelivery == .wake)
        #expect(input.body == "Check [this](https://attacker.example/pixel.png).")
        #expect(input.truncated)
        #expect(input.createdAt > 0)
    }

    @Test func unknownPeerEnumsStayOnTheContainedPath() throws {
        let decoded = try row(
            """
            {"id":"legacy-peer","role":"tool","kind":"tool","preview":"<img src=x>",
             "threadMessage":{"origin":"new-origin","requestedDelivery":"later",
                              "trust":"future-trust"}}
            """
        )

        let input = try #require(TrustAwareTranscriptRowAdapter.peerInput(for: decoded))
        #expect(input.origin == .agent)
        #expect(input.requestedDelivery == .queue)
        #expect(input.body == "<img src=x>")
    }

    @Test func queuedPeopleActionMapsToExternalDraftChrome() throws {
        let decoded = try row(
            """
            {"id":"people-1","role":"system","kind":"system","preview":"Please run the tests.",
             "peopleContribution":{"collaboratorDisplayName":"Alex",
                                   "delivery":"queuedComment",
                                   "intent":"requestHostAction",
                                   "sourceTrust":"external_untrusted",
                                   "insertedAsDraft":true}}
            """
        )

        let model = try #require(TrustAwareTranscriptRowAdapter.peopleModel(for: decoded))
        #expect(model.displayName == "Alex")
        #expect(model.attribution == .externalUntrusted)
        #expect(model.badges.map(\.label) == ["External", "Action request"])
        #expect(model.showsInsertAsDraft)
        #expect(model.insertedAsDraftStatus == "Inserted as draft")
    }

    @Test func unknownPeopleDeliveryCannotAcquireADraftAction() throws {
        let decoded = try row(
            """
            {"id":"people-future","role":"system","kind":"system","preview":"New shape.",
             "peopleContribution":{"delivery":"future-delivery",
                                   "intent":"requestHostAction",
                                   "sourceTrust":"future-trust"}}
            """
        )

        let model = try #require(TrustAwareTranscriptRowAdapter.peopleModel(for: decoded))
        #expect(model.attribution == .externalUntrusted)
        #expect(model.showsInsertAsDraft == false)
        #expect(model.badges.map(\.label) == ["External"])
    }
}
