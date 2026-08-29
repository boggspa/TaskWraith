// Transcript follow state that outlives the view holding it.

import Foundation

/// Keeps each thread's follow intent alive across SwiftUI view identity
/// changes.
///
/// `ThreadDetailView` held this in `@State`, which SwiftUI destroys whenever a
/// view's *structural* identity changes — not merely when its body
/// re-evaluates. `AppShell` renders the entire shell inside
/// `switch model.phase`, and switch branches are distinct identities, so every
/// transport phase transition tore the transcript down and built a new one.
/// The rebuild re-initialised the pin and re-ran the arming `.task`, which
/// unconditionally cleared `userLatchedOff` and set `autoFollow = true` before
/// force-pinning to the tail. The user's deliberate scroll-up was discarded by
/// a reconnect they never asked for and could not see.
///
/// Measured 2026-08-29 on a paired iPhone against a real thread: after a
/// reconnect, `lastUserTouchAt` reverted from 0.0007s-ago to `.distantPast`
/// (proving a freshly constructed pin, i.e. a remount) and `autoFollow` was
/// true again with no sentinel `onAppear` in between — so this was the
/// remount path, not the sentinel re-arm path.
///
/// State is keyed by thread so two transcripts never share intent.
@MainActor
final class TranscriptFollowStateStore {
    static let shared = TranscriptFollowStateStore()

    private var pins: [String: TranscriptFollowPin] = [:]
    private var autoFollowByThread: [String: Bool] = [:]
    /// The selection generation each thread was last armed for.
    private var armedGenerations: [String: Int] = [:]

    init() {}

    /// The durable coalescer/intent record for `threadId`, created on first
    /// use. Returning the *same* instance is what carries `userLatchedOff` and
    /// `lastUserTouchAt` across a remount.
    func pin(for threadId: String) -> TranscriptFollowPin {
        if let existing = pins[threadId] { return existing }
        let created = TranscriptFollowPin()
        pins[threadId] = created
        return created
    }

    /// Whether the caller should arm following and pin to the tail.
    ///
    /// True exactly once per (thread, selection generation). Opening a thread
    /// is a genuine open and should snap to the latest message; a remount of a
    /// thread already open is not, and must leave the user where they were.
    /// The view cannot tell those apart on its own — both run the same `.task`
    /// — so the discriminator comes from the model's selection generation,
    /// which only advances when the selected thread actually changes.
    func shouldArmOnOpen(threadId: String, selectionGeneration: Int) -> Bool {
        guard armedGenerations[threadId] != selectionGeneration else { return false }
        armedGenerations[threadId] = selectionGeneration
        autoFollowByThread[threadId] = true
        return true
    }

    /// Follow intent to restore into view state on a remount. Defaults to
    /// following: a thread never opened before should track the tail.
    func autoFollow(for threadId: String) -> Bool {
        autoFollowByThread[threadId] ?? true
    }

    func setAutoFollow(_ isFollowing: Bool, for threadId: String) {
        autoFollowByThread[threadId] = isFollowing
    }

    /// Drops everything. Tests only — the store is process-wide, so a test that
    /// did not reset it would inherit whichever threads an earlier test armed.
    func resetForTesting() {
        pins.removeAll()
        autoFollowByThread.removeAll()
        armedGenerations.removeAll()
    }
}
