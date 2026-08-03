import Foundation
import Testing

@testable import TaskWraithUI

@Suite("Transcript copy menu (Copy Messages vs Copy handoff Markdown)")
struct TranscriptCopyMenuModelTests {
    @Test func desktopActionLabelsAreExact() {
        #expect(
            TranscriptCopyMenuModel.actionLabel(for: .messages, busy: false)
                == "Copy Messages"
        )
        #expect(
            TranscriptCopyMenuModel.actionLabel(for: .handoff, busy: false)
                == "Copy handoff Markdown"
        )
        #expect(TranscriptCopyMenuModel.actionLabel(for: .messages, busy: true) == "Copying...")
        #expect(TranscriptCopyMenuModel.actionLabel(for: .handoff, busy: true) == "Copying...")
    }

    @Test func dialogChromeMatchesDesktopCopyTranscriptButton() {
        #expect(TranscriptCopyMenuCopy.dialogTitle == "Copy transcript")
        #expect(
            TranscriptCopyMenuCopy.dialogDescription
                == "Creates safe handoff Markdown, or copies raw conversation messages only."
        )
        #expect(TranscriptCopyMenuCopy.copyMessagesLabel == "Copy Messages")
        #expect(TranscriptCopyMenuCopy.copyHandoffLabel == "Copy handoff Markdown")
    }

    @Test func failureMessagesMatchDesktopWording() {
        #expect(
            TranscriptCopyMenuModel.failureMessage(for: .notFound)
                == "This chat could not be loaded."
        )
        #expect(
            TranscriptCopyMenuModel.failureMessage(for: .archived)
                == "Archived chats cannot be copied from here."
        )
        #expect(
            TranscriptCopyMenuModel.failureMessage(for: .tooLarge)
                == "This transcript is too large for clipboard copy."
        )
        #expect(
            TranscriptCopyMenuModel.failureMessage(for: .unauthorized)
                == "This window is not allowed to copy transcripts."
        )
        #expect(
            TranscriptCopyMenuModel.failureMessage(for: .empty)
                == "There is no transcript content to copy yet."
        )
    }

    @Test func successStatusJoinsOmissionsLikeDesktop() {
        let plain = TranscriptCopySuccessSummary(messageCount: 1, charCount: 10)
        #expect(TranscriptCopyMenuModel.successStatus(for: plain) == "Copied 1 message.")

        let plural = TranscriptCopySuccessSummary(
            messageCount: 3,
            charCount: 120,
            omissions: ["absolute paths scrubbed", "common secrets scrubbed"]
        )
        #expect(
            TranscriptCopyMenuModel.successStatus(for: plural)
                == "Copied 3 messages. absolute paths scrubbed; common secrets scrubbed."
        )
    }

    @Test func triggerAccessibilityTracksCopiedFormat() {
        #expect(
            TranscriptCopyMenuModel.triggerAccessibilityLabel(copiedFormat: nil)
                == "Copy transcript as Markdown"
        )
        #expect(
            TranscriptCopyMenuModel.triggerAccessibilityLabel(copiedFormat: .handoff)
                == "Copied transcript as Markdown"
        )
        #expect(
            TranscriptCopyMenuModel.triggerAccessibilityLabel(copiedFormat: .messages)
                == "Copied messages"
        )
    }

    @Test func rawMessagesExplanationDocumentsOmissions() {
        let text = TranscriptCopyMenuModel.omissionExplanation(for: .messages)
        #expect(text.contains("user and assistant prose only"))
        #expect(text.localizedCaseInsensitiveContains("speaker labels"))
        #expect(text.localizedCaseInsensitiveContains("tool"))
        #expect(text.localizedCaseInsensitiveContains("orchestration"))
        // Must not claim raw messages are a full transcript export.
        #expect(!text.localizedCaseInsensitiveContains("identical to handoff"))
    }

    @Test func handoffExplanationDocumentsScrubbing() {
        let text = TranscriptCopyMenuModel.omissionExplanation(for: .handoff)
        #expect(text.localizedCaseInsensitiveContains("scrub"))
        #expect(text.localizedCaseInsensitiveContains("paths"))
        #expect(text.localizedCaseInsensitiveContains("secrets"))
    }

    @Test func wireFailureReasonParsingIsStable() {
        #expect(TranscriptCopyMenuModel.failureReason(fromWire: "not-found") == .notFound)
        #expect(TranscriptCopyMenuModel.failureReason(fromWire: "too-large") == .tooLarge)
        #expect(TranscriptCopyMenuModel.failureReason(fromWire: "archived") == .archived)
        #expect(TranscriptCopyMenuModel.failureReason(fromWire: "unauthorized") == .unauthorized)
        #expect(TranscriptCopyMenuModel.failureReason(fromWire: "empty") == .empty)
        #expect(TranscriptCopyMenuModel.failureReason(fromWire: "mystery") == .empty)
        #expect(TranscriptCopyMenuModel.failureReason(fromWire: nil) == .empty)
    }

    @Test func resultFactoriesPreserveCountsAndOmissions() {
        if case let .success(summary) = TranscriptCopyMenuModel.makeSuccess(
            messageCount: 4,
            charCount: 99,
            omissions: ["tool display details omitted"]
        ) {
            #expect(summary.messageCount == 4)
            #expect(summary.charCount == 99)
            #expect(summary.omissions == ["tool display details omitted"])
        } else {
            Issue.record("expected success result")
        }

        if case let .failure(reason) = TranscriptCopyMenuModel.makeFailure(.unauthorized) {
            #expect(reason == .unauthorized)
        } else {
            Issue.record("expected failure result")
        }
    }

    @Test func labelsNeverSayRunOrAutoSend() {
        for format in TranscriptCopyFormat.allCases {
            let label = TranscriptCopyMenuModel.actionLabel(for: format, busy: false)
            #expect(!label.localizedCaseInsensitiveContains("Run"))
            #expect(!label.localizedCaseInsensitiveContains("Send"))
            #expect(!label.localizedCaseInsensitiveContains("Prompt"))
        }
    }
}
