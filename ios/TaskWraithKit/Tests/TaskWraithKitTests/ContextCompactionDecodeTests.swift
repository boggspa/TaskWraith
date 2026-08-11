import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Context-compaction row decode")
struct ContextCompactionDecodeTests {
    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: Data(json.utf8))
    }

    @Test func decodesStructuralPhase() throws {
        let failed = try row(
            #"{"id":"c1","role":"system","preview":"Context compaction failed.","contextCompaction":{"phase":"failed"}}"#
        )
        #expect(failed.contextCompaction?.phase == "failed")

        let started = try row(
            #"{"id":"c2","role":"system","preview":"Compacting context…","contextCompaction":{"phase":"started"}}"#
        )
        #expect(started.contextCompaction?.phase == "started")
    }

    @Test func olderMacOmitsTheField() throws {
        let legacy = try row(
            #"{"id":"c3","role":"system","preview":"Context compacted · 80k → 20k tokens"}"#)
        #expect(legacy.contextCompaction == nil)
    }
}
