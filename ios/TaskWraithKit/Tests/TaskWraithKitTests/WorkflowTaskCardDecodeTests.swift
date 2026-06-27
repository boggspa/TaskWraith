// Workflow-task decode — iOS preserves the Mac-projected remote draft variant
// so an empty workflow thread keeps its workflow welcome after reconnects.

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Workflow task-card decode")
struct WorkflowTaskCardDecodeTests {
    private func card(_ json: String) throws -> RemoteTaskCard {
        try JSONDecoder().decode(RemoteTaskCard.self, from: Data(json.utf8))
    }

    @Test("workflow draft variant decodes and drives the workflow-draft helper")
    func workflowDraftVariant() throws {
        let c = try card(#"{"id":"chat1","isDraft":true,"draftVariant":"workflow"}"#)
        #expect(c.isDraft == true)
        #expect(c.draftVariant == "workflow")
        #expect(c.isWorkflowDraft == true)
    }

    @Test("older cards without a draft variant are not workflow drafts")
    func olderMacNoDraftVariant() throws {
        let c = try card(#"{"id":"chat1","isDraft":true}"#)
        #expect(c.draftVariant == nil)
        #expect(c.isWorkflowDraft == false)
    }
}
