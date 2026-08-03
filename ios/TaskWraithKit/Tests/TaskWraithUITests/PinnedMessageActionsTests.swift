import Foundation
import Testing
@testable import TaskWraithUI

@Suite("Pinned message actions (copy / jump / unpin)")
struct PinnedMessageActionsTests {
    @Test func makeItemRequiresStableMessageId() {
        #expect(
            PinnedMessageActionsModel.makeItem(
                messageId: nil,
                preview: "hello"
            ) == nil
        )
        #expect(
            PinnedMessageActionsModel.makeItem(
                messageId: "   ",
                preview: "hello"
            ) == nil
        )
        let item = PinnedMessageActionsModel.makeItem(
            messageId: "msg-42",
            speaker: "Codex",
            role: "assistant",
            preview: "Pinned body",
            truncated: false
        )
        #expect(item?.messageId == "msg-42")
        #expect(item?.id == "msg-42")
        #expect(item?.speaker == "Codex")
        #expect(item?.copyText == "Pinned body")
    }

    @Test func identityMatchesProjectedRowIdContract() throws {
        // Scout5: pinnedRows[i].id === desktop message.id. Jump/unpin/copy
        // must all round-trip that same string — never a synthetic key.
        let rowId = "chatmsg-abc-001"
        let item = try #require(
            PinnedMessageActionsModel.makeItem(
                id: rowId,
                speaker: "You",
                role: "user",
                preview: "Remember this",
                truncated: nil
            )
        )
        let jump = try #require(PinnedMessageActionsModel.jumpRequest(for: item))
        #expect(jump.messageId == rowId)
        #expect(PinnedMessageActionsModel.copyPayload(for: item) == "Remember this")
        #expect(PinnedMessageActionsModel.canPerform(.unpin, on: item))
    }

    @Test func emptyPreviewDisablesCopyButKeepsJumpAndUnpin() {
        let item = try #require(
            PinnedMessageActionsModel.makeItem(
                messageId: "empty-body",
                speaker: "Agent",
                preview: "   ",
                truncated: false
            )
        )
        #expect(PinnedMessageActionsModel.canPerform(.copy, on: item) == false)
        #expect(PinnedMessageActionsModel.copyPayload(for: item) == nil)
        #expect(PinnedMessageActionsModel.canPerform(.jumpToSource, on: item))
        #expect(PinnedMessageActionsModel.canPerform(.unpin, on: item))
        #expect(PinnedMessageActionsModel.jumpRequest(for: item)?.messageId == "empty-body")
    }

    @Test func nilPreviewIsTreatedAsEmptyCopyText() {
        let item = try #require(
            PinnedMessageActionsModel.makeItem(
                messageId: "nil-preview",
                preview: nil
            )
        )
        #expect(item.copyText == "")
        #expect(PinnedMessageActionsModel.canPerform(.copy, on: item) == false)
    }

    @Test func truncatedFlagSurfacesInCopyAccessibility() {
        let item = try #require(
            PinnedMessageActionsModel.makeItem(
                messageId: "trunc-1",
                speaker: "Reviewer",
                preview: "Long peer body that was clipped on the wire",
                truncated: true
            )
        )
        #expect(item.previewTruncated)
        let label = PinnedMessageActionsModel.accessibilityLabel(for: .copy, item: item)
        #expect(label.contains("Copy pinned message"))
        #expect(label.contains("from Reviewer"))
        #expect(label.contains("preview may be truncated"))
    }

    @Test func accessibilityLabelsMatchDesktopVerbs() {
        let item = try #require(
            PinnedMessageActionsModel.makeItem(
                messageId: "a11y-1",
                speaker: "Planner",
                preview: "Short note",
                truncated: false
            )
        )
        #expect(
            PinnedMessageActionsModel.accessibilityLabel(for: .copy, item: item)
                .hasPrefix("Copy pinned message")
        )
        #expect(
            PinnedMessageActionsModel.accessibilityLabel(for: .jumpToSource, item: item)
                .hasPrefix("Jump to message")
        )
        #expect(
            PinnedMessageActionsModel.accessibilityLabel(for: .unpin, item: item)
                .hasPrefix("Unpin message")
        )
    }

    @Test func longPreviewIsSnippetCappedInAccessibility() {
        let long = String(repeating: "x", count: 80)
        let item = try #require(
            PinnedMessageActionsModel.makeItem(
                messageId: "snip-1",
                preview: long
            )
        )
        let label = PinnedMessageActionsModel.accessibilityLabel(for: .jumpToSource, item: item)
        #expect(label.contains("…"))
        #expect(label.contains(String(repeating: "x", count: 48)))
        #expect(!label.contains(String(repeating: "x", count: 49)))
    }

    @Test func roleFallsBackWhenSpeakerMissing() {
        let item = try #require(
            PinnedMessageActionsModel.makeItem(
                messageId: "role-only",
                speaker: "  ",
                role: "tool",
                preview: "path/to/file.swift"
            )
        )
        #expect(item.speaker == nil)
        #expect(item.role == "tool")
        let label = PinnedMessageActionsModel.accessibilityLabel(for: .unpin, item: item)
        #expect(label.contains("(tool)"))
    }

    @Test func systemImagesAndTitlesAreStableForWiring() {
        #expect(PinnedMessageActionsModel.actionSystemImage(.copy) == "doc.on.doc")
        #expect(PinnedMessageActionsModel.actionSystemImage(.jumpToSource) == "arrow.right.to.line")
        #expect(PinnedMessageActionsModel.actionSystemImage(.unpin) == "pin.slash")
        #expect(PinnedMessageActionsModel.actionTitle(.jumpToSource) == "Jump to source")
    }
}
