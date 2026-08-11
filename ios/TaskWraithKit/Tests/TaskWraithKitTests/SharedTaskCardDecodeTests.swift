// Shared-task decode — iOS derives its read-only Shared section from optional
// taskCard.isShared/sharedMode metadata projected by the Mac.

import Foundation
import Testing

@Suite("Safety projection decode")
struct SafetyProjectionDecodeTests {
    @Test func externalGrantsCountDecodesAndDefaultsAbsent() throws {
        let with = try JSONDecoder().decode(
            RemoteTaskCard.self,
            from: Data(
                #"{"id":"t1","capabilities":{"approve":true},"externalGrantsCount":3}"#.utf8))
        #expect(with.externalGrantsCount == 3)
        let without = try JSONDecoder().decode(
            RemoteTaskCard.self, from: Data(#"{"id":"t2"}"#.utf8))
        #expect(without.externalGrantsCount == nil)
    }
}

@testable import TaskWraithKit

@Suite("Shared task-card decode")
struct SharedTaskCardDecodeTests {
    private func card(_ json: String) throws -> RemoteTaskCard {
        try JSONDecoder().decode(RemoteTaskCard.self, from: Data(json.utf8))
    }

    @Test("shared metadata decodes as optional task-card fields")
    func sharedMetadata() throws {
        let c = try card(#"{"id":"chat1","isShared":true,"sharedMode":"comments"}"#)
        #expect(c.isShared == true)
        #expect(c.sharedMode == "comments")
    }

    @Test("older Mac cards without shared metadata remain unshared")
    func olderMacNoSharedField() throws {
        let c = try card(#"{"id":"chat1","title":"Build the thing"}"#)
        #expect(c.isShared == nil)
        #expect(c.sharedMode == nil)
    }

    @Test("Kimi composer controls decode from the Mac projection")
    func kimiComposerControls() throws {
        let c = try card(
            #"{"id":"chat1","provider":"kimi","selectedModelType":"kimi-k3","kimiFastMode":false,"kimiReasoningEffort":"high","kimiThinkingEnabled":true}"#)
        #expect(c.kimiFastMode == false)
        #expect(c.kimiReasoningEffort == "high")
        #expect(c.kimiThinkingEnabled == true)
    }
}
