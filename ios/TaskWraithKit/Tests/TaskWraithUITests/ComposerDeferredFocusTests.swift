import Foundation
import Testing

@testable import TaskWraithUI

/// The "keyboard dismisses briefly, then raises again" race.
///
/// Two focus states flow ONE way: `ComposerView.inputFocused` (@State) drives
/// the text view's binding, and `ThreadDetailView.composerFocused` is fed from
/// it via `onFocusChange`. `dismissKeyboard()` clears the OUTER state and sends
/// a global `resignFirstResponder`; the inner one only follows later, when
/// `textViewDidEndEditing` writes back. A layout pass inside that window sees
/// the stale `focused == true` against a resigned responder and queues a
/// `becomeFirstResponder()`.
@Suite("Composer deferred focus")
struct ComposerDeferredFocusTests {
    @Test("steady state queues nothing")
    func steadyStateIsNoOp() {
        #expect(
            !twShouldApplyDeferredFocus(wantsFocus: true, liveFocus: true, isFirstResponder: true))
        #expect(
            !twShouldApplyDeferredFocus(
                wantsFocus: false, liveFocus: false, isFirstResponder: false))
    }

    @Test("a live focus request still applies")
    func liveRequestsApply() {
        // Tapping the composer: binding says focus, responder has not caught up.
        #expect(
            twShouldApplyDeferredFocus(wantsFocus: true, liveFocus: true, isFirstResponder: false))
        // A deliberate resign that has not landed yet.
        #expect(
            twShouldApplyDeferredFocus(wantsFocus: false, liveFocus: false, isFirstResponder: true))
    }

    @Test("a dismissal that lands mid-dispatch is not undone")
    func staleFocusRequestIsDropped() {
        // THE BUG. `dismissKeyboard()` resigned the responder and the binding
        // has since gone false, but the queued request still carries the
        // `wantsFocus == true` snapshot. Re-checking only the responder cannot
        // tell this apart from a genuine focus request — both read
        // "wants focus, is not first responder" — so the keyboard the user just
        // dismissed came straight back up.
        #expect(
            !twShouldApplyDeferredFocus(wantsFocus: true, liveFocus: false, isFirstResponder: false))
        // Mirror: a focus request arrived while a stale resign was in flight.
        #expect(
            !twShouldApplyDeferredFocus(wantsFocus: false, liveFocus: true, isFirstResponder: true))
    }
}
