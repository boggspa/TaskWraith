import Foundation
import Testing

@testable import TaskWraithUI

/// `.serialized` because the store is process-wide state.
@Suite("Transcript follow state store", .serialized)
@MainActor
struct TranscriptFollowStateStoreTests {
    @Test func aRemountKeepsTheSamePinInstance() {
        let store = TranscriptFollowStateStore()

        let first = store.pin(for: "thread-a")
        first.userLatchedOff = true
        first.lastUserTouchAt = Date(timeIntervalSince1970: 1_000)

        // A remount asks for the pin again. Handing back a fresh instance is
        // precisely what discarded the unfollow — `lastUserTouchAt` reverting
        // to `.distantPast` was how the live log exposed the remount.
        let afterRemount = store.pin(for: "thread-a")

        #expect(afterRemount === first)
        #expect(afterRemount.userLatchedOff)
        #expect(afterRemount.lastUserTouchAt == Date(timeIntervalSince1970: 1_000))
    }

    @Test func threadsDoNotShareFollowState() {
        let store = TranscriptFollowStateStore()

        let a = store.pin(for: "thread-a")
        let b = store.pin(for: "thread-b")
        a.userLatchedOff = true

        #expect(a !== b)
        #expect(!b.userLatchedOff)
    }

    @Test func armingHappensOncePerOpenNotOncePerRemount() {
        let store = TranscriptFollowStateStore()

        // Generation 7 == the user opened this thread.
        #expect(store.shouldArmOnOpen(threadId: "thread-a", selectionGeneration: 7))

        // Same generation == SwiftUI rebuilt the view. Arming here is the bug:
        // it clears userLatchedOff, sets autoFollow and force-pins to the tail.
        #expect(!store.shouldArmOnOpen(threadId: "thread-a", selectionGeneration: 7))
        #expect(!store.shouldArmOnOpen(threadId: "thread-a", selectionGeneration: 7))
    }

    @Test func reopeningAThreadArmsAgain() {
        let store = TranscriptFollowStateStore()

        #expect(store.shouldArmOnOpen(threadId: "thread-a", selectionGeneration: 1))
        store.setAutoFollow(false, for: "thread-a")

        // The user navigated away and came back: a genuine open, so the
        // transcript should snap to the latest message again.
        #expect(store.shouldArmOnOpen(threadId: "thread-a", selectionGeneration: 2))
        #expect(store.autoFollow(for: "thread-a"))
    }

    @Test func unfollowSurvivesARemountButNotAReopen() {
        let store = TranscriptFollowStateStore()
        _ = store.shouldArmOnOpen(threadId: "thread-a", selectionGeneration: 1)

        // User scrolls up: the view records the unfollow.
        store.setAutoFollow(false, for: "thread-a")

        // Reconnect → remount. The view restores rather than arms.
        #expect(!store.shouldArmOnOpen(threadId: "thread-a", selectionGeneration: 1))
        #expect(!store.autoFollow(for: "thread-a"))
    }

    @Test func anUnopenedThreadFollowsTheTail() {
        let store = TranscriptFollowStateStore()

        // Defaulting to false would leave a freshly opened transcript refusing
        // to track a live run.
        #expect(store.autoFollow(for: "never-seen"))
    }
}
