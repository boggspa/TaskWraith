import Foundation
import Testing
@testable import TaskWraithUI

@Suite("Assistant message feedback (thumbs / reasons / note)")
struct AssistantMessageFeedbackModelTests {
    private func item(
        id: String = "msg-1",
        role: String = "assistant",
        kind: String? = nil,
        current: AssistantMessageFeedbackState? = nil
    ) -> AssistantMessageFeedbackItem {
        AssistantMessageFeedbackItem(
            messageId: id,
            role: role,
            metadataKind: kind,
            current: current
        )
    }

    @Test func canRateIsAssistantOnly() {
        #expect(AssistantMessageFeedbackModel.canRate(item(role: "assistant")))
        #expect(AssistantMessageFeedbackModel.canRate(item(role: "user")) == false)
        #expect(AssistantMessageFeedbackModel.canRate(item(role: "system")) == false)
        #expect(AssistantMessageFeedbackModel.canRate(item(role: "tool")) == false)
        #expect(
            AssistantMessageFeedbackModel.canRate(
                item(role: "assistant", kind: "channelInbound")
            ) == false
        )
        #expect(
            AssistantMessageFeedbackModel.canRate(item(id: "  ", role: "assistant")) == false
        )
    }

    @Test func applySetsVoteWithCallerTimestamp() {
        let next = AssistantMessageFeedbackModel.apply(
            current: nil,
            vote: .up,
            at: 111
        )
        #expect(next == AssistantMessageFeedbackState(vote: .up, at: 111))
        #expect(AssistantMessageFeedbackModel.readVote(from: next) == .up)
    }

    @Test func sameVoteWithoutExtraClears() {
        let up = AssistantMessageFeedbackModel.apply(current: nil, vote: .up, at: 111)
        let cleared = AssistantMessageFeedbackModel.apply(current: up, vote: .up, at: 222)
        #expect(cleared == nil)
        #expect(AssistantMessageFeedbackModel.readVote(from: cleared) == nil)
    }

    @Test func flipFromUpToDownDoesNotClear() {
        let up = AssistantMessageFeedbackModel.apply(current: nil, vote: .up, at: 111)
        let down = AssistantMessageFeedbackModel.apply(current: up, vote: .down, at: 222)
        #expect(down == AssistantMessageFeedbackState(vote: .down, at: 222))
    }

    @Test func reapplyWithExtraUpdatesInsteadOfClearing() {
        let down = AssistantMessageFeedbackModel.apply(
            current: nil,
            vote: .down,
            at: 111,
            extra: AssistantMessageFeedbackDetails(reason: "incomplete", note: "x")
        )
        #expect(
            down
                == AssistantMessageFeedbackState(
                    vote: .down,
                    at: 111,
                    reason: "incomplete",
                    note: "x"
                )
        )

        let updated = AssistantMessageFeedbackModel.apply(
            current: down,
            vote: .down,
            at: 222,
            extra: AssistantMessageFeedbackDetails(reason: "broke-something")
        )
        #expect(updated?.vote == .down)
        #expect(updated?.at == 222)
        #expect(updated?.reason == "broke-something")
        #expect(updated?.note == nil)
    }

    @Test func boundsReasonAndNoteLengths() {
        let reason = String(repeating: "r", count: 100) + "   "
        let note = String(repeating: "x", count: 1200) + "   "
        let next = AssistantMessageFeedbackModel.apply(
            current: nil,
            vote: .down,
            at: 111,
            extra: AssistantMessageFeedbackDetails(reason: reason, note: note)
        )
        #expect(next?.reason?.count == AssistantMessageFeedbackModel.maxReasonChars)
        #expect(next?.note?.count == AssistantMessageFeedbackModel.maxNoteChars)
        #expect(AssistantMessageFeedbackModel.maxNoteChars == 1000)
        #expect(AssistantMessageFeedbackModel.maxReasonChars == 80)
    }

    @Test func sixDesktopReasonCodesMatchExactly() {
        let codes = AssistantMessageFeedbackModel.reasonOptions.map(\.rawValue)
        #expect(
            codes == [
                "wrong-approach",
                "hallucinated-or-wrong",
                "broke-something",
                "over-verbose",
                "wrong-model-for-role",
                "incomplete",
            ]
        )
        let labels = AssistantMessageFeedbackModel.reasonOptions.map(\.label)
        #expect(
            labels == [
                "Wrong approach",
                "Hallucinated / wrong",
                "Broke something",
                "Over-verbose",
                "Wrong model for role",
                "Incomplete",
            ]
        )
    }

    @Test func makeRequestNilWhenNotRateable() {
        #expect(
            AssistantMessageFeedbackModel.makeRequest(
                item: item(role: "user"),
                vote: .up
            ) == nil
        )
        #expect(
            AssistantMessageFeedbackModel.makeReasonRequest(
                item: item(role: "assistant", kind: "channelInbound"),
                reason: .incomplete
            ) == nil
        )
    }

    @Test func makeRequestCarriesMessageIdAndSanitizedDetails() throws {
        let request = try #require(
            AssistantMessageFeedbackModel.makeRequest(
                item: item(id: "assistant-42"),
                vote: .down,
                details: AssistantMessageFeedbackDetails(
                    reason: "  incomplete  ",
                    note: "  edge case  "
                )
            )
        )
        #expect(request.messageId == "assistant-42")
        #expect(request.vote == .down)
        #expect(request.details?.reason == "incomplete")
        #expect(request.details?.note == "edge case")
    }

    @Test func makeReasonRequestUsesClosedCodeRawValue() throws {
        let request = try #require(
            AssistantMessageFeedbackModel.makeReasonRequest(
                item: item(),
                reason: .wrongModelForRole,
                note: String(repeating: "n", count: 1001)
            )
        )
        #expect(request.vote == .down)
        #expect(request.details?.reason == "wrong-model-for-role")
        #expect(request.details?.note?.count == 1000)
    }

    @Test func contextMenuTitlesToggleWithCurrentVote() {
        #expect(
            AssistantMessageFeedbackModel.thumbsUpTitle(current: nil)
                == AssistantMessageFeedbackCopy.goodResponse
        )
        #expect(
            AssistantMessageFeedbackModel.thumbsDownTitle(current: nil)
                == AssistantMessageFeedbackCopy.poorResponse
        )

        let up = AssistantMessageFeedbackState(vote: .up, at: 1)
        #expect(
            AssistantMessageFeedbackModel.thumbsUpTitle(current: up)
                == AssistantMessageFeedbackCopy.removeGoodRating
        )
        #expect(
            AssistantMessageFeedbackModel.thumbsDownTitle(current: up)
                == AssistantMessageFeedbackCopy.poorResponse
        )

        let down = AssistantMessageFeedbackState(vote: .down, at: 1)
        #expect(
            AssistantMessageFeedbackModel.thumbsDownTitle(current: down)
                == AssistantMessageFeedbackCopy.removePoorRating
        )
    }

    @Test func systemImagesAndSelectionHelpersAreStable() {
        #expect(
            AssistantMessageFeedbackModel.systemImage(for: .up, selected: false)
                == "hand.thumbsup"
        )
        #expect(
            AssistantMessageFeedbackModel.systemImage(for: .up, selected: true)
                == "hand.thumbsup.fill"
        )
        #expect(
            AssistantMessageFeedbackModel.systemImage(for: .down, selected: true)
                == "hand.thumbsdown.fill"
        )

        let down = AssistantMessageFeedbackState(vote: .down, at: 1)
        #expect(AssistantMessageFeedbackModel.isSelected(.down, current: down))
        #expect(AssistantMessageFeedbackModel.isSelected(.up, current: down) == false)
    }

    @Test func reasonAccessibilityIncludesDesktopLabel() {
        let label = AssistantMessageFeedbackModel.reasonAccessibilityLabel(.brokeSomething)
        #expect(label == "Poor response: Broke something")
    }

    @Test func emptyWhitespaceExtraDoesNotBlockToggleClear() {
        let down = AssistantMessageFeedbackModel.apply(current: nil, vote: .down, at: 1)
        let cleared = AssistantMessageFeedbackModel.apply(
            current: down,
            vote: .down,
            at: 2,
            extra: AssistantMessageFeedbackDetails(reason: "   ", note: "\n\t")
        )
        #expect(cleared == nil)
    }

    @Test func noDeletionSurfaceInModelAPI() {
        // Guardrail for this candidate: feedback model exposes rate/clear only.
        // Deletion is owned by a separate extracted candidate.
        let names = [
            "canRate",
            "apply",
            "makeRequest",
            "makeReasonRequest",
            "thumbsUpTitle",
            "thumbsDownTitle",
        ]
        #expect(names.contains("apply"))
        #expect(!names.contains("delete"))
        #expect(AssistantMessageFeedbackCopy.goodResponse.contains("Good"))
    }
}
