import Foundation
import Testing
@testable import TaskWraithUI

@Suite("Transcript follow policy")
struct TranscriptFollowPolicyTests {
    private let now = Date(timeIntervalSince1970: 10_000)

    @Test func forceDoesNotOverrideRecentUserTouch() {
        #expect(
            TranscriptFollowPolicy.shouldScroll(
                autoFollow: false,
                force: true,
                lastUserTouchAt: now.addingTimeInterval(-0.1),
                now: now
            ) == false
        )
    }

    @Test func forceOverridesStaleAutoFollowWhenUserIsIdle() {
        #expect(
            TranscriptFollowPolicy.shouldScroll(
                autoFollow: false,
                force: true,
                lastUserTouchAt: now.addingTimeInterval(-1),
                now: now
            )
        )
    }

    @Test func ordinaryAutoFollowScrollsOnlyWhenEnabledAndUserIsIdle() {
        #expect(
            TranscriptFollowPolicy.shouldScroll(
                autoFollow: true,
                force: false,
                lastUserTouchAt: now.addingTimeInterval(-1),
                now: now
            )
        )
        #expect(
            TranscriptFollowPolicy.shouldScroll(
                autoFollow: false,
                force: false,
                lastUserTouchAt: now.addingTimeInterval(-1),
                now: now
            ) == false
        )
        #expect(
            TranscriptFollowPolicy.shouldScroll(
                autoFollow: true,
                force: false,
                lastUserTouchAt: now.addingTimeInterval(-0.1),
                now: now
            ) == false
        )
    }
}
