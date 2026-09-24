import Foundation
import Testing
@testable import TaskWraithUI

// MARK: - Chrome

@Suite("Composer voice button chrome")
struct ComposerVoiceChromeTests {
    @Test func idleIsAStartableMic() {
        let chrome = ComposerVoiceWiring.chrome(for: .idle)
        #expect(chrome.systemImage == "mic")
        #expect(chrome.accessibilityLabel == "Dictate")
        #expect(chrome.accessibilityValue == "Idle")
        #expect(chrome.tap == .start)
        #expect(!chrome.isListening)
        #expect(!chrome.isFinalizing)
        #expect(!chrome.isFailure)
        #expect(chrome.statusCaption == nil)
    }

    @Test func authorizingIsVisibleAndStoppable() {
        let chrome = ComposerVoiceWiring.chrome(for: .authorizing)
        #expect(chrome.isListening)
        #expect(chrome.tap == .stop)
        #expect(chrome.statusCaption == "Waiting for permission…")
        #expect(!chrome.isFailure)
        #expect(chrome.accessibilityValue == "Authorizing")
    }

    @Test func listeningUsesFilledMicAndStop() {
        let chrome = ComposerVoiceWiring.chrome(for: .listening)
        #expect(chrome.systemImage == "mic.fill")
        #expect(chrome.tap == .stop)
        #expect(chrome.isListening)
        #expect(chrome.statusCaption == nil)
        #expect(chrome.accessibilityLabel == "Stop dictation")
    }

    @Test func finalizingDisablesTheButtonAndShowsACaption() {
        let chrome = ComposerVoiceWiring.chrome(for: .finalizing)
        #expect(chrome.tap == .none)
        #expect(chrome.isFinalizing)
        #expect(chrome.statusCaption == "Finishing…")
        #expect(chrome.accessibilityValue == "Finalizing")
    }

    @Test("denied states are visible failures that retry, not silent no-ops")
    func deniedIsAVisibleFailureThatRetries() {
        let reasons: [ComposerVoiceDenialReason] = [
            .speechRecognitionDenied, .microphoneDenied, .restricted,
        ]
        for reason in reasons {
            let chrome = ComposerVoiceWiring.chrome(for: .denied(reason))
            #expect(chrome.systemImage == "mic.slash", "\(reason)")
            #expect(chrome.isFailure, "\(reason)")
            #expect(chrome.tap == .retry, "\(reason)")
            #expect(chrome.statusCaption != nil, "\(reason) must show a caption")
            #expect(chrome.accessibilityLabel == chrome.statusCaption, "\(reason)")
            #expect(chrome.accessibilityValue == "Denied", "\(reason)")
        }
    }

    @Test func deniedReasonsAreDistinct() {
        let speech = ComposerVoiceWiring.chrome(for: .denied(.speechRecognitionDenied))
        let mic = ComposerVoiceWiring.chrome(for: .denied(.microphoneDenied))
        let restricted = ComposerVoiceWiring.chrome(for: .denied(.restricted))
        #expect(speech.statusCaption == "Speech recognition permission denied")
        #expect(mic.statusCaption == "Microphone permission denied")
        #expect(restricted.statusCaption == "Speech recognition is restricted")
        #expect(Set([speech.statusCaption, mic.statusCaption, restricted.statusCaption]).count == 3)
    }

    @Test("unavailable states are visible failures that retry")
    func unavailableIsAVisibleFailureThatRetries() {
        let recognizer = ComposerVoiceWiring.chrome(for: .unavailable(.recognizerUnavailable))
        #expect(recognizer.systemImage == "mic.slash")
        #expect(recognizer.isFailure)
        #expect(recognizer.tap == .retry)
        #expect(recognizer.statusCaption == "On-device dictation unavailable")
        #expect(recognizer.accessibilityValue == "Unavailable")

        let engine = ComposerVoiceWiring.chrome(
            for: .unavailable(.audioEngineFailure("engine down")))
        #expect(engine.isFailure)
        #expect(engine.tap == .retry)
        #expect(engine.statusCaption == "Microphone failed to start")
        #expect(engine.accessibilityValue == "engine down")
    }
}

// MARK: - Insertion (committed paste)

@Suite("Composer voice transcript insertion")
struct ComposerVoiceInsertionTests {
    @Test func emptyDraftTakesTheTranscript() {
        #expect(ComposerVoiceWiring.appendFinalTranscript("hello", to: "") == "hello")
    }

    @Test func joinsWithASpaceWhenTheDraftHasNoTrailingWhitespace() {
        #expect(ComposerVoiceWiring.appendFinalTranscript("world", to: "hello") == "hello world")
    }

    @Test func doesNotInsertAnExtraSpaceAfterExistingWhitespace() {
        #expect(ComposerVoiceWiring.appendFinalTranscript("world", to: "hello ") == "hello world")
        #expect(ComposerVoiceWiring.appendFinalTranscript("world", to: "hello\n") == "hello\nworld")
    }

    @Test func emptyOrWhitespaceTranscriptIsANoOp() {
        #expect(ComposerVoiceWiring.appendFinalTranscript("", to: "hello") == "hello")
        #expect(ComposerVoiceWiring.appendFinalTranscript("   \n", to: "hello") == "hello")
    }

    @Test func keepsInternalNewlinesLikeACommittedPaste() {
        #expect(
            ComposerVoiceWiring.appendFinalTranscript("line one\nline two", to: "intro")
                == "intro line one\nline two")
    }

    @Test func trimsOnlyTheTranscriptEdges() {
        #expect(
            ComposerVoiceWiring.appendFinalTranscript("  hello  ", to: "") == "hello")
    }
}

// MARK: - Tap dispatch

@Suite("Composer voice tap dispatch")
struct ComposerVoiceTapTests {
    @Test func startAndRetryInvokeStartOnly() {
        var starts = 0
        var stops = 0
        let start = { starts += 1 }
        let stop = { stops += 1 }
        ComposerVoiceWiring.perform(.start, start: start, stop: stop)
        ComposerVoiceWiring.perform(.retry, start: start, stop: stop)
        ComposerVoiceWiring.perform(.none, start: start, stop: stop)
        #expect(starts == 2)
        #expect(stops == 0)
    }

    @Test func stopInvokesStopOnly() {
        var starts = 0
        var stops = 0
        ComposerVoiceWiring.perform(.stop, start: { starts += 1 }, stop: { stops += 1 })
        #expect(starts == 0)
        #expect(stops == 1)
    }
}

// MARK: - Controller wiring (the path Composer actually uses)

@MainActor
private final class ComposerVoiceDraftSink {
    var text: String
    init(_ text: String) { self.text = text }

    /// Same assignment Composer.bindVoiceTranscript makes.
    func attach(_ controller: ComposerVoiceController<MockVoiceControllerSession>) {
        controller.onTranscriptReady = { [weak self] final in
            guard let self else { return }
            self.text = ComposerVoiceWiring.appendFinalTranscript(final, to: self.text)
        }
    }

    func handleTap(
        _ controller: ComposerVoiceController<MockVoiceControllerSession>
    ) {
        let chrome = ComposerVoiceWiring.chrome(for: controller.state)
        ComposerVoiceWiring.perform(
            chrome.tap,
            start: { controller.start() },
            stop: { controller.stop() })
    }

    func cancelOnSend(_ controller: ComposerVoiceController<MockVoiceControllerSession>) {
        controller.cancel()
    }
}

@MainActor
private func startedController() async -> (
    ComposerVoiceController<MockVoiceControllerSession>, MockVoiceControllerSession
) {
    let session = MockVoiceControllerSession()
    let controller = ComposerVoiceController(session: session)
    controller.start()
    for _ in 0..<50 where !session.beginInvoked || controller.state == .authorizing {
        await Task.yield()
    }
    return (controller, session)
}

@Suite("Composer voice wiring")
@MainActor
struct ComposerVoiceWiringTests {
    @Test func partialTranscriptDoesNotMutateTheDraft() async {
        let (controller, session) = await startedController()
        let sink = ComposerVoiceDraftSink("hello")
        sink.attach(controller)
        session.simulatePartial("world")
        #expect(controller.partialTranscript == "world")
        #expect(sink.text == "hello", "partials must not publish into the composer draft")
    }

    @Test func finalTranscriptAppendsLikeACommittedPaste() async {
        let (controller, session) = await startedController()
        let sink = ComposerVoiceDraftSink("hello")
        sink.attach(controller)
        session.simulatePartial("world")
        session.simulateFinal("world")
        #expect(sink.text == "hello world")
        #expect(controller.partialTranscript.isEmpty)
        #expect(controller.state == .idle)
    }

    @Test func listeningTapStopsAndInsertsLeftoverPartial() async {
        let (controller, session) = await startedController()
        let sink = ComposerVoiceDraftSink("note:")
        sink.attach(controller)
        session.simulatePartial("ship it")
        #expect(sink.text == "note:")
        sink.handleTap(controller)
        #expect(sink.text == "note: ship it")
        #expect(controller.state == .idle)
    }

    @Test func sendCancelDropsThePartialInsteadOfInsertingIt() async {
        let (controller, session) = await startedController()
        let sink = ComposerVoiceDraftSink("keep me")
        sink.attach(controller)
        session.simulatePartial("do not insert")
        sink.cancelOnSend(controller)
        #expect(sink.text == "keep me")
        #expect(controller.state == .idle)
        #expect(controller.partialTranscript.isEmpty)
    }

    @Test func deniedTapRetriesRatherThanDoingNothing() async {
        let session = MockVoiceControllerSession()
        session.authorizationResult = .denied(.microphoneDenied)
        let controller = ComposerVoiceController(session: session)
        let sink = ComposerVoiceDraftSink("")
        sink.attach(controller)
        sink.handleTap(controller)
        for _ in 0..<200 where controller.state == .authorizing {
            await Task.yield()
        }
        #expect(controller.state == .denied(.microphoneDenied))
        let chrome = ComposerVoiceWiring.chrome(for: controller.state)
        #expect(chrome.isFailure)
        #expect(chrome.tap == .retry)
        #expect(chrome.statusCaption == "Microphone permission denied")

        session.holdAuthorization = true
        sink.handleTap(controller)
        #expect(controller.state == .authorizing, "retry must re-request authorization")
        #expect(sink.text.isEmpty, "a denied take must not invent a transcript")
        for _ in 0..<200 where session.authorizationWaiters == 0 {
            await Task.yield()
        }
        session.completeAuthorization(.denied(.microphoneDenied))
        for _ in 0..<200 where controller.state == .authorizing {
            await Task.yield()
        }
        #expect(controller.state == .denied(.microphoneDenied))
    }

    @Test func idleTapStartsListening() async {
        let session = MockVoiceControllerSession()
        let controller = ComposerVoiceController(session: session)
        let sink = ComposerVoiceDraftSink("")
        sink.attach(controller)
        #expect(ComposerVoiceWiring.chrome(for: controller.state).tap == .start)
        sink.handleTap(controller)
        for _ in 0..<200 where !session.beginInvoked || controller.state == .authorizing {
            await Task.yield()
        }
        #expect(controller.state == .listening)
        #expect(session.beginInvoked)
        #expect(sink.text.isEmpty)
    }
}
