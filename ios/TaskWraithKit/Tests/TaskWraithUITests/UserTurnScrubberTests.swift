import Foundation
import Testing
@testable import TaskWraithUI

@Suite("User turn scrubber")
struct UserTurnScrubberTests {
    private func row(
        id: String,
        role: String,
        content: String = "",
        height: CGFloat = 64
    ) -> UserTurnScrubberSourceRow {
        UserTurnScrubberSourceRow(
            id: id,
            role: role,
            content: content,
            estimatedHeight: height
        )
    }

    @Test func hiddenBelowTwoUserTurns() {
        let none = UserTurnScrubber.buildMarkers(from: [
            row(id: "a1", role: "assistant", content: "hi")
        ])
        #expect(none.isEmpty)
        #expect(UserTurnScrubber.isVisible(markers: none) == false)

        let one = UserTurnScrubber.buildMarkers(from: [
            row(id: "u0", role: "user", content: "only one")
        ])
        #expect(one.isEmpty)

        let two = UserTurnScrubber.buildMarkers(from: [
            row(id: "u0", role: "user", content: "first"),
            row(id: "a1", role: "assistant", content: "ans"),
            row(id: "u1", role: "user", content: "second")
        ])
        #expect(two.count == 2)
        #expect(UserTurnScrubber.isVisible(markers: two))
    }

    @Test func markersOnlyFromLoadedUserRowsWithStableRowKeys() {
        let markers = UserTurnScrubber.buildMarkers(from: [
            row(id: "same", role: "user", content: "First prompt"),
            row(id: "assistant-1", role: "assistant", content: "Answer"),
            row(id: "same", role: "user", content: "Second prompt")
        ])

        #expect(markers.count == 2)
        #expect(markers[0].messageId == "same")
        #expect(markers[0].rowKey == "same#0")
        #expect(markers[0].rowIndex == 0)
        #expect(markers[0].ordinal == 1)
        #expect(markers[0].title == "First prompt")

        #expect(markers[1].messageId == "same")
        #expect(markers[1].rowKey == "same#2")
        #expect(markers[1].rowIndex == 2)
        #expect(markers[1].ordinal == 2)
        #expect(markers[1].title == "Second prompt")
        #expect(markers[1].topPercent > markers[0].topPercent)
    }

    @Test func titlesAndPreviewsHandleBlankAndLongPrompts() {
        #expect(UserTurnScrubber.title(for: "") == "User message")
        #expect(UserTurnScrubber.preview(for: "") == "")

        let longPrompt = [
            "Please review the release checklist and focus on the risky edge cases.",
            "One", "Two", "Three", "Four", "Five"
        ].joined(separator: "\n")

        #expect(
            UserTurnScrubber.title(for: longPrompt)
                == "Please review the release checklist and focus on the risky edge cases."
        )
        #expect(UserTurnScrubber.preview(for: longPrompt).split(separator: "\n").count == 4)
    }

    @Test func denseLayoutBoundsMarkerSpanAndPreservesOrder() {
        let rows = (0..<24).map { i in
            row(id: "user-\(i)", role: "user", content: "Prompt \(i)")
        }
        let markers = UserTurnScrubber.buildMarkers(from: rows)
        let layout = UserTurnScrubber.layoutMarkers(markers, frameHeight: 900)
        let tops = layout.map(\.topPx)
        let span = (tops.max() ?? 0) - (tops.min() ?? 0)

        #expect(layout.map(\.key) == markers.map(\.key))
        #expect(span <= 23 * 8 + 0.001)
        for i in 1..<tops.count {
            #expect(tops[i] > tops[i - 1])
        }
    }

    @Test func activeMarkerJoinUsesPositionalRowIndex() {
        let markers = UserTurnScrubber.buildMarkers(from: [
            row(id: "u0", role: "user", content: "First"),
            row(id: "a1", role: "assistant", content: "Ans"),
            row(id: "u2", role: "user", content: "Second")
        ])
        #expect(markers.map(\.rowIndex) == [0, 2])
        #expect(UserTurnScrubber.activeMarkerKey(markers: markers, anchorRowIndex: 0) == markers[0].key)
        #expect(UserTurnScrubber.activeMarkerKey(markers: markers, anchorRowIndex: 1) == markers[0].key)
        #expect(UserTurnScrubber.activeMarkerKey(markers: markers, anchorRowIndex: 2) == markers[1].key)
    }

    @Test func jumpIntentIsExplicitMarkerBeginEnd() {
        let markers = UserTurnScrubber.buildMarkers(from: [
            row(id: "u0", role: "user", content: "First"),
            row(id: "u1", role: "user", content: "Second")
        ])
        #expect(UserTurnScrubber.jumpIntent(for: markers[0]) == .marker(markers[0]))
        #expect(UserTurnScrubberJumpIntent.begin != .end)
    }
}
