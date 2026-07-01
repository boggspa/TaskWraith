// Proposed-plan row decode — the wire contract behind the iOS plan card.
//
// The Mac projects a Codex-style proposed plan as a structured
// `row.proposedPlan = {title, bodyPreview, status, artifactPath, bodyTruncated}` field
// (src/main/RemoteThreadProjection.ts buildProposedPlan). This pins the Swift
// decode: the field names must match the Mac 1:1, an absent field decodes to
// nil (older Mac builds stay compatible — additive optional + synthesized
// Codable), and an unexpected `status` string degrades to a plain String
// (read-only) rather than failing the whole-row decode.

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Proposed-plan row decode")
struct ProposedPlanDecodeTests {
    private func row(_ json: String) throws -> RemoteThreadSnapshot.Row {
        try JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: Data(json.utf8))
    }

    @Test("a pending plan decodes title/body/status/truncated 1:1 with the Mac projection")
    func pendingPlan() throws {
        let r = try row(
            """
            {"id":"m1","role":"assistant","kind":"assistant",
             "proposedPlan":{"title":"Add A Smoke Test",
                             "bodyPreview":"## Plan\\n\\n- step one\\n- step two",
                             "status":"pending","artifactPath":"docs/plans/ios-parity.md",
                             "bodyTruncated":false}}
            """)
        #expect(r.proposedPlan?.title == "Add A Smoke Test")
        #expect(r.proposedPlan?.bodyPreview?.contains("step one") == true)
        #expect(r.proposedPlan?.status == "pending")
        #expect(r.proposedPlan?.artifactPath == "docs/plans/ios-parity.md")
        #expect(r.proposedPlan?.bodyTruncated == false)
    }

    @Test("a decided plan round-trips its approved status; absent truncated is nil")
    func approvedPlan() throws {
        let r = try row(
            """
            {"id":"m1","proposedPlan":{"title":"T","bodyPreview":"b","status":"approved"}}
            """)
        #expect(r.proposedPlan?.status == "approved")
        #expect(r.proposedPlan?.bodyTruncated == nil)
    }

    @Test("a row from an older Mac (no proposedPlan field) decodes with a nil plan")
    func olderMacNoField() throws {
        let r = try row(
            """
            {"id":"m1","role":"assistant","preview":"hello"}
            """)
        #expect(r.proposedPlan == nil)
        #expect(r.id == "m1")
    }

    @Test("an unexpected status decodes as a plain String (degrades read-only, no crash)")
    func unknownStatus() throws {
        let r = try row(
            """
            {"id":"m1","proposedPlan":{"title":"T","bodyPreview":"b","status":"archived"}}
            """)
        // Decoded as-is; the UI treats any non-pending value as non-actionable.
        #expect(r.proposedPlan?.status == "archived")
    }
}
