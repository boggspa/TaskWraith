import Foundation
import Testing
@testable import TaskWraithUI

// MARK: - Mocks

@MainActor
final class MockVoiceControllerSession: VoiceControllerSession {
    var authorizationResult: ComposerVoiceAuthorizationResult = .granted
    /// When true, `requestAuthorization` suspends until `completeAuthorization`.
    var holdAuthorization = false

    var beginBehavior:
        (
            @MainActor (String) -> Void,
            @MainActor (String) -> Void,
            @MainActor (ComposerVoiceError) -> Void
        ) async -> Void = { _, _, _ in }

    private(set) var beginInvoked = false
    /// Distinct from the boolean so a delayed-auth test can prove capture
    /// never started, not merely that it has not started *yet*.
    private(set) var beginCount = 0

    private(set) var capturedOnPartial: (@MainActor (String) -> Void)?
    private(set) var capturedOnFinal: (@MainActor (String) -> Void)?
    private(set) var capturedOnError: (@MainActor (ComposerVoiceError) -> Void)?

    private(set) var authorizationWaiters = 0
    private var authorizationContinuation: CheckedContinuation<ComposerVoiceAuthorizationResult, Never>?

    let handle = MockVoiceControllerSessionHandle()

    func requestAuthorization() async -> ComposerVoiceAuthorizationResult {
        if holdAuthorization {
            return await withCheckedContinuation { continuation in
                self.authorizationContinuation = continuation
                self.authorizationWaiters += 1
            }
        }
        return authorizationResult
    }

    func completeAuthorization(_ result: ComposerVoiceAuthorizationResult) {
        authorizationContinuation?.resume(returning: result)
        authorizationContinuation = nil
    }

    func begin(
        onPartial: @escaping @MainActor (String) -> Void,
        onFinal: @escaping @MainActor (String) -> Void,
        onError: @escaping @MainActor (ComposerVoiceError) -> Void
    ) async -> VoiceControllerSessionHandle {
        beginInvoked = true
        beginCount += 1
        capturedOnPartial = onPartial
        capturedOnFinal = onFinal
        capturedOnError = onError
        await beginBehavior(onPartial, onFinal, onError)
        return handle
    }

    func simulatePartial(_ text: String) {
        capturedOnPartial?(text)
    }

    func simulateFinal(_ text: String) {
        capturedOnFinal?(text)
    }

    func simulateError(_ error: ComposerVoiceError) {
        capturedOnError?(error)
    }
}

@MainActor
final class MockVoiceControllerSessionHandle: VoiceControllerSessionHandle {
    private(set) var stopInvoked = false
    private(set) var cancelInvoked = false
    /// Distinct from stop/cancel so tests prove the controller called
    /// deactivate on each terminal path rather than inferring it.
    private(set) var deactivateInvoked = false

    func stop() {
        stopInvoked = true
    }

    func cancel() {
        cancelInvoked = true
    }

    func deactivateAudioSession() {
        deactivateInvoked = true
    }
}

@MainActor
private func waitUntilNotAuthorizing(
    _ controller: ComposerVoiceController<MockVoiceControllerSession>
) async {
    for _ in 0..<50 where controller.state == .authorizing {
        await Task.yield()
    }
}

@MainActor
private func startedController(
    session: MockVoiceControllerSession = MockVoiceControllerSession()
) async -> (ComposerVoiceController<MockVoiceControllerSession>, MockVoiceControllerSession) {
    let controller = ComposerVoiceController(session: session)
    controller.start()
    for _ in 0..<50 where !session.beginInvoked || controller.state == .authorizing {
        await Task.yield()
    }
    return (controller, session)
}

// MARK: - State machine tests

@Suite("Composer voice state machine")
struct ComposerVoiceStateMachineTests {
    @Test("idle start requests authorization")
    func idleStartRequestsAuth() {
        var sm = ComposerVoiceStateMachine()
        let effect = sm.handle(.startRequested)
        #expect(sm.state == .authorizing)
        #expect(effect == .requestAuthorization)
        #expect(sm.partialTranscript == "")
    }

    @Test("granted authorization begins session")
    func grantedBeginsSession() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        let effect = sm.handle(.authorizationResult(.granted))
        #expect(sm.state == .listening)
        #expect(effect == .beginSession)
    }

    @Test("denied authorization cancels session")
    func deniedEndsDenied() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        let effect = sm.handle(.authorizationResult(.denied(.microphoneDenied)))
        #expect(sm.state == .denied(.microphoneDenied))
        #expect(effect == .cancelSession)
    }

    @Test("unavailable authorization cancels session")
    func unavailableEndsUnavailable() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        let effect = sm.handle(.authorizationResult(.unavailable(.recognizerUnavailable)))
        #expect(sm.state == .unavailable(.recognizerUnavailable))
        #expect(effect == .cancelSession)
    }

    @Test("partial transcript updates live preview")
    func partialUpdatesPreview() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        _ = sm.handle(.authorizationResult(.granted))
        _ = sm.handle(.recognitionStarted)
        let effect = sm.handle(.partialTranscript("hello"))
        #expect(sm.state == .listening)
        #expect(sm.partialTranscript == "hello")
        #expect(effect == .none)
    }

    @Test("automatic final emits and returns to idle")
    func finalEmitsAndReturnsIdle() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        _ = sm.handle(.authorizationResult(.granted))
        let effect = sm.handle(.finalTranscript("hello world"))
        #expect(sm.state == .idle)
        #expect(effect == .emitTranscript("hello world"))
        #expect(sm.partialTranscript == "")
    }

    @Test("stop from listening returns to idle")
    func stopFromListening() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        _ = sm.handle(.authorizationResult(.granted))
        _ = sm.handle(.recognitionStarted)
        let effect = sm.handle(.stopRequested)
        #expect(sm.state == .idle)
        #expect(effect == .stopSession)
    }

    @Test("stop with leftover partial emits then returns to idle")
    func stopWithPartialEmits() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        _ = sm.handle(.authorizationResult(.granted))
        _ = sm.handle(.partialTranscript("hello wor"))
        let effect = sm.handle(.stopRequested)
        #expect(sm.state == .idle)
        #expect(effect == .emitTranscript("hello wor"))
        #expect(sm.partialTranscript == "")
    }

    @Test("cancel from listening returns to idle")
    func cancelFromListening() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        _ = sm.handle(.authorizationResult(.granted))
        _ = sm.handle(.recognitionStarted)
        let effect = sm.handle(.cancelRequested)
        #expect(sm.state == .idle)
        #expect(effect == .cancelSession)
    }

    @Test("cancel from authorizing returns to idle")
    func cancelFromAuthorizing() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        let effect = sm.handle(.cancelRequested)
        #expect(sm.state == .idle)
        #expect(effect == .cancelSession)
    }

    @Test("stop from authorizing returns idle and cancels")
    func stopFromAuthorizing() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        let effect = sm.handle(.stopRequested)
        #expect(sm.state == .idle)
        #expect(effect == .cancelSession)
    }

    @Test("granted after stop from authorizing does not begin session")
    func grantedAfterStopDoesNotBegin() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        _ = sm.handle(.stopRequested)
        let effect = sm.handle(.authorizationResult(.granted))
        #expect(sm.state == .idle)
        #expect(effect == .none)
    }

    @Test("duplicate final after idle is ignored")
    func duplicateFinalIgnored() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        _ = sm.handle(.authorizationResult(.granted))
        _ = sm.handle(.finalTranscript("one"))
        let effect = sm.handle(.finalTranscript("two"))
        #expect(effect == .none)
        #expect(sm.state == .idle)
    }

    @Test("failure from listening becomes unavailable and cancels")
    func failureUnavailable() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        _ = sm.handle(.authorizationResult(.granted))
        let effect = sm.handle(.recognitionFailed(.audioEngineFailure("boom")))
        #expect(sm.state == .unavailable(.audioEngineFailure("boom")))
        #expect(effect == .cancelSession)
    }

    @Test("recognizer-unavailable failure maps without losing the case")
    func failureRecognizerUnavailable() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        _ = sm.handle(.authorizationResult(.granted))
        let effect = sm.handle(.recognitionFailed(.recognizerUnavailable))
        #expect(sm.state == .unavailable(.recognizerUnavailable))
        #expect(effect == .cancelSession)
    }

    @Test("restart from denied re-authorizes")
    func restartFromDenied() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        _ = sm.handle(.authorizationResult(.denied(.microphoneDenied)))
        let effect = sm.handle(.startRequested)
        #expect(sm.state == .authorizing)
        #expect(effect == .requestAuthorization)
    }

    @Test("cancel from denied returns to idle and still requests teardown")
    func cancelFromDenied() {
        var sm = ComposerVoiceStateMachine()
        _ = sm.handle(.startRequested)
        _ = sm.handle(.authorizationResult(.denied(.microphoneDenied)))
        let effect = sm.handle(.cancelRequested)
        #expect(sm.state == .idle)
        #expect(effect == .cancelSession)
    }
}

// MARK: - Controller tests

@Suite("Composer voice controller")
@MainActor
struct ComposerVoiceControllerTests {
    @Test("start drives state authorizing then listening")
    func startDrivesStates() async {
        let session = MockVoiceControllerSession()
        let controller = ComposerVoiceController(session: session)
        controller.start()
        #expect(controller.state == .authorizing)

        for _ in 0..<50 where !session.beginInvoked || controller.state == .authorizing {
            await Task.yield()
        }
        #expect(controller.state == .listening)
        #expect(session.beginInvoked)
        #expect(!session.handle.deactivateInvoked)
    }

    @Test("denied authorization surfaces denied state")
    func deniedSurfaces() async {
        let session = MockVoiceControllerSession()
        session.authorizationResult = .denied(.speechRecognitionDenied)
        let controller = ComposerVoiceController(session: session)
        controller.start()
        await waitUntilNotAuthorizing(controller)
        #expect(controller.state == .denied(.speechRecognitionDenied))
    }

    @Test("unavailable authorization surfaces unavailable state")
    func unavailableSurfaces() async {
        let session = MockVoiceControllerSession()
        session.authorizationResult = .unavailable(.recognizerUnavailable)
        let controller = ComposerVoiceController(session: session)
        controller.start()
        await waitUntilNotAuthorizing(controller)
        #expect(controller.state == .unavailable(.recognizerUnavailable))
    }

    @Test("partial transcript updates published preview")
    func partialUpdatesPreview() async {
        let (controller, session) = await startedController()
        session.simulatePartial("hello")
        #expect(controller.partialTranscript == "hello")
        #expect(controller.state == .listening)
        #expect(!session.handle.deactivateInvoked)
    }

    @Test("stop after final keeps emitted transcript and stays idle")
    func stopAfterFinalKeepsTranscript() async {
        let (controller, session) = await startedController()
        var captured = ""
        controller.onTranscriptReady = { text in captured = text }

        session.simulateFinal("hello")
        controller.stop()
        #expect(controller.state == .idle)
        #expect(captured == "hello")
        #expect(session.handle.deactivateInvoked)
    }
}

@Suite("Composer voice terminal teardown privacy")
@MainActor
struct ComposerVoiceTerminalTeardownTests {
    @Test("automatic final stops capture, deactivates session, returns idle")
    func finalDeactivatesAndIdles() async {
        let (controller, session) = await startedController()
        var captured = ""
        controller.onTranscriptReady = { text in captured = text }

        session.simulateFinal("hello world")

        #expect(captured == "hello world")
        #expect(controller.state == .idle)
        #expect(controller.partialTranscript == "")
        #expect(session.handle.stopInvoked)
        #expect(!session.handle.cancelInvoked)
        #expect(session.handle.deactivateInvoked)
    }

    @Test("stop deactivates session and returns idle")
    func stopDeactivatesAndIdles() async {
        let (controller, session) = await startedController()

        controller.stop()

        #expect(controller.state == .idle)
        #expect(session.handle.stopInvoked)
        #expect(!session.handle.cancelInvoked)
        #expect(session.handle.deactivateInvoked)
    }

    @Test("stop with leftover partial emits, deactivates, returns idle")
    func stopWithPartialEmitsAndDeactivates() async {
        let (controller, session) = await startedController()
        var captured = ""
        controller.onTranscriptReady = { text in captured = text }

        session.simulatePartial("hello wor")
        controller.stop()

        #expect(captured == "hello wor")
        #expect(controller.state == .idle)
        #expect(session.handle.stopInvoked)
        #expect(session.handle.deactivateInvoked)
    }

    @Test("cancel deactivates session and returns idle")
    func cancelDeactivatesAndIdles() async {
        let (controller, session) = await startedController()

        controller.cancel()

        #expect(controller.state == .idle)
        #expect(session.handle.cancelInvoked)
        #expect(!session.handle.stopInvoked)
        #expect(session.handle.deactivateInvoked)
    }

    @Test("failure deactivates session and becomes unavailable")
    func failureDeactivatesAndUnavailables() async {
        let (controller, session) = await startedController()

        session.simulateError(.recognitionFailure("nope"))

        #expect(controller.state == .unavailable(.audioEngineFailure("nope")))
        #expect(session.handle.cancelInvoked)
        #expect(!session.handle.stopInvoked)
        #expect(session.handle.deactivateInvoked)
    }

    @Test("stop during authorizing then delayed grant never starts capture")
    func stopDuringAuthorizingThenDelayedGrantNeverStartsCapture() async {
        let session = MockVoiceControllerSession()
        session.holdAuthorization = true
        let controller = ComposerVoiceController(session: session)

        controller.start()
        #expect(controller.state == .authorizing)
        for _ in 0..<50 where session.authorizationWaiters == 0 {
            await Task.yield()
        }
        #expect(session.authorizationWaiters == 1)
        #expect(controller.state == .authorizing)

        controller.stop()
        #expect(controller.state == .idle)
        #expect(session.beginCount == 0)

        session.completeAuthorization(.granted)
        // Give a late grant time to start capture if the stop was ignored.
        // Breaking on beginCount > 0 is the red; draining the yields is the green.
        for _ in 0..<50 {
            if session.beginCount > 0 { break }
            await Task.yield()
        }

        #expect(session.beginCount == 0)
        #expect(!session.beginInvoked)
        #expect(controller.state == .idle)
        #expect(!session.handle.stopInvoked)
        #expect(!session.handle.cancelInvoked)
        #expect(!session.handle.deactivateInvoked)
    }

    @Test("begin-time failure deactivates after the handle is returned")
    func beginFailureDeactivates() async {
        let session = MockVoiceControllerSession()
        session.beginBehavior = { _, _, onError in
            onError(.audioEngineFailure("engine"))
        }
        let controller = ComposerVoiceController(session: session)
        controller.start()
        for _ in 0..<50 where controller.state == .authorizing || controller.state == .listening {
            await Task.yield()
        }

        #expect(controller.state == .unavailable(.audioEngineFailure("engine")))
        #expect(session.handle.cancelInvoked)
        #expect(session.handle.deactivateInvoked)
    }
}
