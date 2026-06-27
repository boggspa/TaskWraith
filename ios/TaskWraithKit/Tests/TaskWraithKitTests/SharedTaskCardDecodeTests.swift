// Shared-task decode — iOS derives its read-only Shared section from optional
// taskCard.isShared/sharedMode metadata projected by the Mac.

import Foundation
import Testing

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
}
