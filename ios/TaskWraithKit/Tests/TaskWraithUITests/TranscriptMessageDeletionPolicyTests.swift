import Foundation
import Testing
@testable import TaskWraithUI

@Suite("Transcript message deletion policy")
struct TranscriptMessageDeletionPolicyTests {
    @Test func emptyMessageIdIsUnavailable() {
        let decision = TranscriptMessageDeletionPolicyModel.evaluate(
            messageId: "   ",
            content: "body"
        )
        #expect(decision == .unavailable)
        #expect(TranscriptMessageDeletionPresentation.from(decision) == nil)
        #expect(
            TranscriptMessageDeletionPolicyModel.showsDeleteAffordance(messageId: nil) == false
        )
    }

    @Test func blocksWhenMessageAnchorsPendingAgentQuestion() throws {
        let decision = TranscriptMessageDeletionPolicyModel.evaluate(
            messageId: "agent-question-42",
            role: "assistant",
            content: "Pick one",
            pendingAgentQuestionMessageId: "agent-question-42"
        )
        guard case .blocked(let blocked) = decision else {
            Issue.record("expected blocked decision, got \(decision)")
            return
        }
        #expect(blocked.messageId == "agent-question-42")
        #expect(blocked.reason == TranscriptMessageDeletionCopy.blockedReason)
        #expect(blocked.reason.contains("open prompt"))
        #expect(blocked.dismissActionLabel == "OK")
        #expect(blocked.accessibilityLabel.contains("Cannot delete"))
    }

    @Test func blocksWhenMessageAnchorsPendingPlanChoice() throws {
        let decision = TranscriptMessageDeletionPolicyModel.evaluate(
            messageId: "m7",
            content: "Plan body",
            pendingPlanChoiceMessageId: "m7"
        )
        guard case .blocked(let blocked) = decision else {
            Issue.record("expected blocked decision, got \(decision)")
            return
        }
        #expect(blocked.messageId == "m7")
        #expect(blocked.reason == TranscriptMessageDeletionCopy.blockedReason)
    }

    @Test func blocksWhenMessageAppearsInAgentQuestionQueueSet() {
        let decision = TranscriptMessageDeletionPolicyModel.evaluate(
            TranscriptMessageDeletionInput(
                messageId: "message-a",
                content: "Question row",
                pendingAgentQuestionMessageIds: ["message-a", "other"],
                pendingPlanChoiceMessageId: nil
            )
        )
        guard case .blocked = decision else {
            Issue.record("expected blocked for queued question anchor, got \(decision)")
            return
        }
    }

    @Test func doesNotBlockUnrelatedMessageWhilePromptsPendingElsewhere() {
        let decision = TranscriptMessageDeletionPolicyModel.evaluate(
            messageId: "m1",
            content: "Ordinary row",
            pendingAgentQuestionMessageId: "agent-question-42",
            pendingPlanChoiceMessageId: "m7"
        )
        guard case .requiresConfirmation(let confirmation) = decision else {
            Issue.record("expected confirmation, got \(decision)")
            return
        }
        #expect(confirmation.messageId == "m1")
        #expect(confirmation.preview == "Ordinary row")
    }

    @Test func requiresExplicitConfirmationWithDesktopTitleAndPreview() throws {
        let decision = TranscriptMessageDeletionPolicyModel.evaluate(
            messageId: "del-1",
            role: "user",
            content: "Please remove me"
        )
        guard case .requiresConfirmation(let confirmation) = decision else {
            Issue.record("expected confirmation, got \(decision)")
            return
        }
        #expect(confirmation.title == TranscriptMessageDeletionCopy.confirmTitle)
        #expect(confirmation.preview == "Please remove me")
        #expect(confirmation.confirmText == "\(confirmation.title)\n\nPlease remove me")
        #expect(confirmation.confirmActionLabel == "Delete")
        #expect(confirmation.cancelActionLabel == "Cancel")
        let intent = try #require(
            TranscriptMessageDeletionPolicyModel.confirmedIntent(from: confirmation)
        )
        #expect(intent.messageId == "del-1")
    }

    @Test func truncatesPreviewAtEightyCharactersLikeDesktop() {
        let long = String(repeating: "a", count: 90)
        let preview = TranscriptMessageDeletionPolicyModel.makePreview(content: long, role: "user")
        #expect(preview.count == 78)  // 77 + ellipsis
        #expect(preview.hasSuffix("…"))
        #expect(preview.hasPrefix(String(repeating: "a", count: 77)))

        let decision = TranscriptMessageDeletionPolicyModel.evaluate(
            messageId: "long-1",
            content: long
        )
        guard case .requiresConfirmation(let confirmation) = decision else {
            Issue.record("expected confirmation, got \(decision)")
            return
        }
        #expect(confirmation.preview == preview)
    }

    @Test func emptyContentFallsBackToRoleMessagePreview() {
        #expect(
            TranscriptMessageDeletionPolicyModel.makePreview(content: nil, role: "assistant")
                == "(assistant message)"
        )
        #expect(
            TranscriptMessageDeletionPolicyModel.makePreview(content: "", role: "tool")
                == "(tool message)"
        )
        #expect(
            TranscriptMessageDeletionPolicyModel.makePreview(content: nil, role: "  ")
                == "(message)"
        )
        #expect(
            TranscriptMessageDeletionPolicyModel.makePreview(content: nil, role: nil)
                == "(message)"
        )
        let decision = TranscriptMessageDeletionPolicyModel.evaluate(
            messageId: "empty-body",
            role: "system",
            content: nil
        )
        guard case .requiresConfirmation(let confirmation) = decision else {
            Issue.record("expected confirmation, got \(decision)")
            return
        }
        #expect(confirmation.preview == "(system message)")
    }

    @Test func messageAnchorsActivePromptMirrorsDesktopGuard() {
        #expect(
            TranscriptMessageDeletionPolicyModel.messageAnchorsActivePrompt(
                messageId: "agent-question-42",
                pendingAgentQuestionMessageId: "agent-question-42",
                pendingPlanChoiceMessageId: nil
            )
        )
        #expect(
            TranscriptMessageDeletionPolicyModel.messageAnchorsActivePrompt(
                messageId: "m7",
                pendingAgentQuestionMessageId: nil,
                pendingPlanChoiceMessageId: "m7"
            )
        )
        #expect(
            TranscriptMessageDeletionPolicyModel.messageAnchorsActivePrompt(
                messageId: "m1",
                pendingAgentQuestionMessageId: "agent-question-42",
                pendingPlanChoiceMessageId: "m7"
            ) == false
        )
        #expect(
            TranscriptMessageDeletionPolicyModel.messageAnchorsActivePrompt(
                messageId: "",
                pendingAgentQuestionMessageId: "",
                pendingPlanChoiceMessageId: ""
            ) == false
        )
    }

    @Test func agentQuestionQueueHasMessageTrimsAndMatches() {
        #expect(
            TranscriptMessageDeletionPolicyModel.agentQuestionQueueHasMessage(
                pendingMessageIds: ["  message-a  ", "message-b"],
                messageId: "message-a"
            )
        )
        #expect(
            TranscriptMessageDeletionPolicyModel.agentQuestionQueueHasMessage(
                pendingMessageIds: ["message-a"],
                messageId: "message-b"
            ) == false
        )
        #expect(
            TranscriptMessageDeletionPolicyModel.agentQuestionQueueHasMessage(
                pendingMessageIds: ["message-a"],
                messageId: "  "
            ) == false
        )
    }

    @Test func presentationMapsDecisionWithoutAutoDelete() throws {
        let confirmDecision = TranscriptMessageDeletionPolicyModel.evaluate(
            messageId: "p1",
            content: "hi"
        )
        let presentation = try #require(
            TranscriptMessageDeletionPresentation.from(confirmDecision)
        )
        guard case .confirmation(let confirmation) = presentation else {
            Issue.record("expected confirmation presentation")
            return
        }
        #expect(confirmation.messageId == "p1")
        #expect(presentation.id == "confirm:p1")

        let blockedDecision = TranscriptMessageDeletionPolicyModel.evaluate(
            messageId: "p2",
            content: "q",
            pendingPlanChoiceMessageId: "p2"
        )
        let blockedPresentation = try #require(
            TranscriptMessageDeletionPresentation.from(blockedDecision)
        )
        guard case .blocked = blockedPresentation else {
            Issue.record("expected blocked presentation")
            return
        }
        #expect(blockedPresentation.id == "blocked:p2")
    }

    @Test func affordanceLabelsMatchDesktopVerbs() {
        #expect(
            TranscriptMessageDeletionPolicyModel.deleteAffordanceTitle() == "Delete message"
        )
        #expect(
            TranscriptMessageDeletionPolicyModel.deleteAffordanceAccessibilityLabel()
                == "Delete message from transcript"
        )
        #expect(TranscriptMessageDeletionPolicyModel.showsDeleteAffordance(messageId: "x"))
    }
}
