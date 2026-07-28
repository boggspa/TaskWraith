import Testing

@testable import TaskWraithUI

/// Pins the composer's Return-key contract: Return submits (send-button
/// parity), hardware Shift+Return inserts a newline via its latch, an IME
/// composition's Return commits marked text untouched, and pasted/dictated
/// text keeps its newlines. The UIKit delegate is a thin adapter over this
/// decision, so these pins hold on the macOS test build too.
@Suite("Composer Return key")
struct ComposerReturnKeyTests {
    @Test func plainReturnSubmits() {
        #expect(
            twComposerReturnSubmits(
                replacement: "\n", hasSubmitAction: true,
                isCommittingMarkedText: false, newlineLatched: false))
    }

    @Test func shiftReturnLatchInsertsTheNewlineInstead() {
        #expect(
            !twComposerReturnSubmits(
                replacement: "\n", hasSubmitAction: true,
                isCommittingMarkedText: false, newlineLatched: true))
    }

    /// A CJK keyboard's Return commits the in-flight composition — swallowing
    /// it would make the composer unusable for IME entry.
    @Test func imeCommitReturnIsNeverIntercepted() {
        #expect(
            !twComposerReturnSubmits(
                replacement: "\n", hasSubmitAction: true,
                isCommittingMarkedText: true, newlineLatched: false))
    }

    /// Paste and dictation insert multi-character strings; their embedded
    /// newlines are content, not a submit gesture.
    @Test func pastedTextWithNewlinesIsNotASubmit() {
        #expect(
            !twComposerReturnSubmits(
                replacement: "line one\nline two", hasSubmitAction: true,
                isCommittingMarkedText: false, newlineLatched: false))
        #expect(
            !twComposerReturnSubmits(
                replacement: "\n\n", hasSubmitAction: true,
                isCommittingMarkedText: false, newlineLatched: false))
    }

    /// Without a submit action the field keeps the legacy newline-on-return
    /// behaviour (returnKeyType stays .default in step with this).
    @Test func noSubmitActionMeansNewlinePassesThrough() {
        #expect(
            !twComposerReturnSubmits(
                replacement: "\n", hasSubmitAction: false,
                isCommittingMarkedText: false, newlineLatched: false))
    }
}
