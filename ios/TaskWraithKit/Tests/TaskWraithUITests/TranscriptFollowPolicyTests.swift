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

    @Test func forceDoesNotOverrideUnfollowEvenWhenIdle() {
        #expect(
            TranscriptFollowPolicy.shouldScroll(
                autoFollow: false,
                force: true,
                lastUserTouchAt: now.addingTimeInterval(-1),
                now: now
            ) == false
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

    @Test func userTouchQuietPeriodCoversInertiaAfterFingerLift() {
        #expect(TranscriptFollowPolicy.userTouchQuietPeriod == 0.6)
        #expect(
            TranscriptFollowPolicy.shouldScroll(
                autoFollow: true,
                force: false,
                lastUserTouchAt: now.addingTimeInterval(-0.59),
                now: now
            ) == false
        )
        #expect(
            TranscriptFollowPolicy.shouldScroll(
                autoFollow: true,
                force: false,
                lastUserTouchAt: now.addingTimeInterval(-0.6),
                now: now
            )
        )
        // The disappearance edge no longer flips here — it runs to
        // `userScrollSettlePeriod`, because a flick is still moving the
        // transcript long after this window closes. See
        // `decelerationAfterAFlickStillCountsAsUserIntent`.
        #expect(
            TranscriptFollowPolicy.sentinelDisappearanceEndsFollowing(
                lastUserTouchAt: now.addingTimeInterval(-0.59), now: now
            )
        )
        #expect(
            TranscriptFollowPolicy.sentinelDisappearanceEndsFollowing(
                lastUserTouchAt: now.addingTimeInterval(-0.6), now: now
            )
        )
    }

    @Test func programmaticPinGraceBlocksSentinelRearmOnlyWhenLatchedOff() {
        #expect(TranscriptFollowPolicy.programmaticPinRearmGrace == 0.35)
        // Still following: streaming pins rematerializing the sentinel must
        // not get stuck with autoFollow false.
        #expect(
            TranscriptFollowPolicy.sentinelAppearShouldRearmFollowing(
                userLatchedOff: false,
                lastProgrammaticPinAt: now.addingTimeInterval(-0.1),
                now: now
            )
        )
        // Latched off: grace blocks rearm from a settle pin.
        #expect(
            TranscriptFollowPolicy.sentinelAppearShouldRearmFollowing(
                userLatchedOff: true,
                lastProgrammaticPinAt: now.addingTimeInterval(-0.1),
                now: now
            ) == false
        )
        #expect(
            TranscriptFollowPolicy.sentinelAppearShouldRearmFollowing(
                userLatchedOff: true,
                lastProgrammaticPinAt: now.addingTimeInterval(-0.34),
                now: now
            ) == false
        )
        #expect(
            TranscriptFollowPolicy.sentinelAppearShouldRearmFollowing(
                userLatchedOff: true,
                lastProgrammaticPinAt: now.addingTimeInterval(-0.35),
                now: now
            )
        )
    }

    /// Deferred settle after unfollow: force must not scroll, and a settle pin
    /// that briefly shows the sentinel must not re-arm following while latched.
    @Test func deferredUnfollowSettleCannotYankUserBack() {
        #expect(
            TranscriptFollowPolicy.shouldScroll(
                autoFollow: false,
                force: true,
                lastUserTouchAt: now.addingTimeInterval(-1),
                now: now
            ) == false
        )
        let settlePinAt = now.addingTimeInterval(-0.2)
        #expect(
            TranscriptFollowPolicy.sentinelAppearShouldRearmFollowing(
                userLatchedOff: true,
                lastProgrammaticPinAt: settlePinAt,
                now: now
            ) == false
        )
        // Touch-unfollow clears pin grace (distantPast) so scrolling back to
        // the bottom can re-arm immediately.
        #expect(
            TranscriptFollowPolicy.sentinelAppearShouldRearmFollowing(
                userLatchedOff: true,
                lastProgrammaticPinAt: .distantPast,
                now: now
            )
        )
    }

    /// The bottom sentinel disappearing means "the user scrolled away" ONLY while
    /// the transcript may still be moving from their gesture — during the touch
    /// itself or the deceleration that follows it. Long after the transcript came
    /// to rest, a disappearance can only be layout.
    @Test func sentinelDisappearanceIsIntentOnlyWhileTheScrollIsTheUsers() {
        #expect(
            TranscriptFollowPolicy.sentinelDisappearanceEndsFollowing(
                lastUserTouchAt: now.addingTimeInterval(-0.1), now: now
            )
        )
        #expect(
            TranscriptFollowPolicy.sentinelDisappearanceEndsFollowing(
                lastUserTouchAt: now.addingTimeInterval(-1), now: now
            )
        )
        #expect(
            TranscriptFollowPolicy.sentinelDisappearanceEndsFollowing(
                lastUserTouchAt: now.addingTimeInterval(-5), now: now
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

    /// THE YANK. The two edges used to hand off at the SAME instant, which left
    /// no state for "the scroll is still coasting from the user's own flick":
    /// the moment a disappearance stopped counting as intent, a repair pin was
    /// already permitted. A flick that dematerialised the sentinel after the
    /// quiet period therefore latched nothing off AND scrolled straight back to
    /// the tail — the transcript fighting the gesture in the opposite direction.
    ///
    /// The settle period must therefore cover the whole of UIKit's deceleration,
    /// so every instant a repair pin is allowed is an instant the disappearance
    /// is already known NOT to be the user's.
    @Test func noInstantBothDeniesUserIntentAndPermitsARepairPin() {
        for millisecondsSinceTouch in stride(from: 0, through: 4_000, by: 25) {
            let lastUserTouchAt = now.addingTimeInterval(-Double(millisecondsSinceTouch) / 1000)
            let isTheUser = TranscriptFollowPolicy.sentinelDisappearanceEndsFollowing(
                lastUserTouchAt: lastUserTouchAt, now: now)
            let mayRepair = TranscriptFollowPolicy.shouldScroll(
                autoFollow: true, force: true, lastUserTouchAt: lastUserTouchAt, now: now)
            #expect(
                !(mayRepair && !isTheUser && millisecondsSinceTouch < 2_500),
                "a repair pin was permitted \(millisecondsSinceTouch)ms after the last touch, while the scroll may still be decelerating from that gesture"
            )
        }
    }

    /// A flick's deceleration is a continuation of the user's gesture, not a
    /// layout event: the finger is gone but the transcript is still moving
    /// because they threw it. Anywhere inside that window a sentinel
    /// disappearance is intent, so following latches off and the jump-to-latest
    /// pill appears — rather than the transcript snapping back to the tail.
    @Test func decelerationAfterAFlickStillCountsAsUserIntent() {
        #expect(TranscriptFollowPolicy.userScrollSettlePeriod == 2.5)
        // The ordering is the whole invariant: if the settle period were ever
        // SHORTER than the pin-suppression window, the yank comes straight back.
        #expect(
            TranscriptFollowPolicy.userScrollSettlePeriod
                >= TranscriptFollowPolicy.userTouchQuietPeriod
        )
        for secondsSinceFingerLift in stride(from: 0.0, to: 2.5, by: 0.1) {
            #expect(
                TranscriptFollowPolicy.sentinelDisappearanceEndsFollowing(
                    lastUserTouchAt: now.addingTimeInterval(-secondsSinceFingerLift), now: now
                ),
                "a sentinel disappearance \(secondsSinceFingerLift)s after the finger lifted was credited to layout while the flick could still be coasting"
            )
        }
        // Past the settle period the scroll is provably at rest, so a
        // disappearance really is layout and the repair pin is the right answer.
        #expect(
            TranscriptFollowPolicy.sentinelDisappearanceEndsFollowing(
                lastUserTouchAt: now.addingTimeInterval(-2.5), now: now
            ) == false
        )
    }
}
