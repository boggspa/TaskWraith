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

    // MARK: - The inspector's mini transcript (MiniThreadView)

    @Test func theMiniTranscriptDoesNotShareAPinWithTheMainPane() {
        let store = TranscriptFollowStateStore()

        // Expand puts the same thread in both surfaces at once. A shared pin
        // is a shared `scheduled` coalescing flag, so one view's pending pin
        // would swallow the other's.
        let mainPane = store.pin(for: "thread-a")
        let mini = store.pin(for: TranscriptFollowStateStore.miniThreadKey("thread-a"))

        #expect(mainPane !== mini)
    }

    @Test func aMiniRemountKeepsTheUsersScrollPosition() {
        let store = TranscriptFollowStateStore()
        let key = TranscriptFollowStateStore.miniThreadKey("thread-a")

        store.noteMiniThreadOpened("thread-a")
        #expect(
            store.shouldArmOnOpen(
                threadId: key,
                selectionGeneration: store.miniThreadOpenGeneration("thread-a")))

        // The user scrolls up in the side-chat panel.
        store.setAutoFollow(false, for: key)

        // Reconnect → remount. Arming here is the reported bug: it clears the
        // latch, sets autoFollow and force-pins the panel back to the tail.
        #expect(
            !store.shouldArmOnOpen(
                threadId: key,
                selectionGeneration: store.miniThreadOpenGeneration("thread-a")))
        #expect(!store.autoFollow(for: key))
    }

    @Test func reopeningAMiniTranscriptArmsAgain() {
        let store = TranscriptFollowStateStore()
        let key = TranscriptFollowStateStore.miniThreadKey("thread-a")

        store.noteMiniThreadOpened("thread-a")
        _ = store.shouldArmOnOpen(
            threadId: key,
            selectionGeneration: store.miniThreadOpenGeneration("thread-a"))
        store.setAutoFollow(false, for: key)

        // Back to the list and in again: a deliberate open, so the panel
        // should snap to the latest message.
        store.noteMiniThreadOpened("thread-a")
        #expect(
            store.shouldArmOnOpen(
                threadId: key,
                selectionGeneration: store.miniThreadOpenGeneration("thread-a")))
        #expect(store.autoFollow(for: key))
    }

    @Test func openingAnotherMiniTranscriptDoesNotRearmThisOne() {
        let store = TranscriptFollowStateStore()
        let key = TranscriptFollowStateStore.miniThreadKey("thread-a")

        store.noteMiniThreadOpened("thread-a")
        _ = store.shouldArmOnOpen(
            threadId: key,
            selectionGeneration: store.miniThreadOpenGeneration("thread-a"))
        store.setAutoFollow(false, for: key)

        // A different side chat is opened. With ONE global counter this would
        // advance thread-a's generation too, and its next remount would read
        // as an open — which is why the count is per thread.
        store.noteMiniThreadOpened("thread-b")

        #expect(
            !store.shouldArmOnOpen(
                threadId: key,
                selectionGeneration: store.miniThreadOpenGeneration("thread-a")))
        #expect(!store.autoFollow(for: key))
    }

    @Test func aMiniTranscriptWithNoRecordedOpenStillArmsOnFirstMount() {
        let store = TranscriptFollowStateStore()
        let key = TranscriptFollowStateStore.miniThreadKey("thread-a")

        // Guards a panel nobody instrumented: it should fail towards following
        // the tail, never towards a transcript that silently refuses to track
        // a live run.
        #expect(
            store.shouldArmOnOpen(
                threadId: key,
                selectionGeneration: store.miniThreadOpenGeneration("thread-a")))
    }
}
