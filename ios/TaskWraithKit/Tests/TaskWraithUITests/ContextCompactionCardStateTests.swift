import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("Context-compaction card detection and state")
struct ContextCompactionCardStateTests {
    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: Data(json.utf8))
    }

    @Test func structuralFieldDetectsRegardlessOfWording() throws {
        // The exact failure this field exists for: the Mac reworded the
        // one-liner and the phone's card silently vanished. Detection must
        // not depend on the English prefix when the wire says what this is.
        let reworded = try row(
            #"{"id":"c1","role":"system","preview":"Kontext verdichtet · 80k → 20k","contextCompaction":{"phase":"completed"}}"#
        )
        #expect(
            ContextCompactionSummaryCard.matches(
                compaction: reworded.contextCompaction,
                preview: reworded.preview, role: reworded.role, kind: reworded.kind))
    }

    @Test func legacyTextPrefixStillDetectsForOlderMacs() throws {
        let legacy = try row(
            #"{"id":"c2","role":"system","preview":"Context compacted · 80k → 20k tokens"}"#)
        #expect(
            ContextCompactionSummaryCard.matches(
                compaction: legacy.contextCompaction,
                preview: legacy.preview, role: legacy.role, kind: legacy.kind))
        let unrelated = try row(#"{"id":"c3","role":"system","preview":"Round closed."}"#)
        #expect(
            !ContextCompactionSummaryCard.matches(
                compaction: unrelated.contextCompaction,
                preview: unrelated.preview, role: unrelated.role, kind: unrelated.kind))
    }

    @Test func phaseOutranksContradictingText() {
        // A failed compaction whose wording the phone has never seen must
        // still read as FAILED — state comes from the wire when present.
        #expect(
            ContextCompactionSummaryCard.state(phase: "failed", preview: "Some future wording")
                == .failed)
        #expect(
            ContextCompactionSummaryCard.state(phase: "started", preview: "Some future wording")
                == .inProgress)
        #expect(
            ContextCompactionSummaryCard.state(
                phase: "completed", preview: "Context compaction failed.") == .completed)
    }

    @Test func textPrefixesDriveStateWhenNoPhaseShipped() {
        #expect(
            ContextCompactionSummaryCard.state(phase: nil, preview: "Context compaction failed — x")
                == .failed)
        #expect(
            ContextCompactionSummaryCard.state(phase: nil, preview: "Compacting context…")
                == .inProgress)
        #expect(
            ContextCompactionSummaryCard.state(phase: nil, preview: "Context compacted · 1 → 2")
                == .completed)
    }
}
