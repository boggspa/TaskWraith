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

    /// The bottom sentinel disappearing means "the user scrolled away" ONLY if a
    /// finger was just on the transcript.
    @Test func sentinelDisappearanceIsIntentOnlyAfterATouch() {
        #expect(
            TranscriptFollowPolicy.sentinelDisappearanceEndsFollowing(
                lastUserTouchAt: now.addingTimeInterval(-0.1), now: now
            )
        )
        #expect(
            TranscriptFollowPolicy.sentinelDisappearanceEndsFollowing(
                lastUserTouchAt: now.addingTimeInterval(-1), now: now
            ) == false
        )
    }

    /// The stall this rule exists for (2026-07-28): a send swaps the row set and
    /// a long streamed reply grows the content below the fold, so the sentinel
    /// vanishes with NO user touch in the whole run. Reading that as intent
    /// latched following off — and both re-pin triggers are gated behind
    /// `autoFollow`, so the transcript froze until a manual jump-to-latest tap.
    @Test func aStreamingRunWithNoTouchNeverEndsFollowing() {
        let touchedBeforeTheRun = now.addingTimeInterval(-30)
        for secondsIntoRun in stride(from: 0.0, through: 20.0, by: 0.5) {
            #expect(
                TranscriptFollowPolicy.sentinelDisappearanceEndsFollowing(
                    lastUserTouchAt: touchedBeforeTheRun,
                    now: now.addingTimeInterval(secondsIntoRun)
                ) == false
            )
        }
    }

    /// The quiet period is shared with `shouldScroll` on purpose: the window
    /// that suppresses a follow-pin is the same window that credits a sentinel
    /// disappearance to the user. Drifting them apart would let a gesture stop
    /// following while its own re-pin was still suppressed, or the reverse.
    @Test func bothEdgesShareTheQuietPeriod() {
        let onTheBoundary = now.addingTimeInterval(-TranscriptFollowPolicy.userTouchQuietPeriod)
        #expect(
            TranscriptFollowPolicy.sentinelDisappearanceEndsFollowing(
                lastUserTouchAt: onTheBoundary, now: now
            ) == false
        )
        #expect(
            TranscriptFollowPolicy.shouldScroll(
                autoFollow: true, force: false, lastUserTouchAt: onTheBoundary, now: now
            )
        )
    }
}
