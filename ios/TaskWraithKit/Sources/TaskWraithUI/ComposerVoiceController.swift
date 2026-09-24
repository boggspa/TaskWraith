// ComposerVoiceController.swift
//
// Composer-local dictation controller (item 2 / P0). NOT a voice agent; the
// recognized text is inserted into the composer's `text` binding locally, with
// no host/provider contract change.
//
// Architecture:
//   - ComposerVoiceStateMachine  : pure, testable state machine
//   - ComposerVoiceController    : generic SwiftUI/ObservableObject wrapper
//   - VoiceControllerSession     : protocol abstracting the AV/Speech stack
//   - OnDeviceVoiceControllerSession : iOS-only live implementation
//
// The generic core builds on macOS so `swift build` / `swift test` keep
// compile-checking the TaskWraithUI target. The live session is `#if os(iOS)`
// because it needs AVAudioSession, SFSpeechRecognizer, and a tap on
// AVAudioEngine.inputNode.
//
// Privacy contract (Validator finding 2 + re-audit A): every terminal route —
// automatic final, user stop, user cancel, and failure — MUST stop capture,
// tear down the handle, deactivate AVAudioSession, and leave a non-listening
// state (idle / denied / unavailable). Stop/cancel DURING `.authorizing` must
// also idle the machine and drop a late authorization callback: ignoring stop
// here turns the mic ON after the user tried to stop it, which is worse than
// leaving it on after they finished. The handle protocol exposes
// `deactivateAudioSession()` so tests prove teardown without a mic.
//
// Composer integration lives in ComposerView.swift: a local mic button owns
// this controller, partials stay in its preview, and only a final transcript is
// appended to the draft. Dismiss/send cancel capture and tear down the session.

import Foundation

#if canImport(SwiftUI)
import SwiftUI
#endif

// MARK: - Public vocabulary

/// High-level state of the composer-local microphone. Exposed to SwiftUI.
public enum ComposerVoiceState: Equatable, Sendable {
    /// Ready to start.
    case idle
    /// Waiting for Speech + microphone authorization or for the session to begin.
    case authorizing
    /// Listening to the microphone and receiving partial transcripts.
    case listening
    /// Stopped listening; flushing the final transcript.
    /// Terminal routes do not linger here: the controller tears down and
    /// returns to idle (or denied/unavailable) in the same turn.
    case finalizing
    /// Authorization denied or later revoked.
    case denied(ComposerVoiceDenialReason)
    /// Recognizer unavailable, audio-engine failure, or other runtime failure.
    case unavailable(ComposerVoiceUnavailabilityReason)
}

public enum ComposerVoiceDenialReason: Equatable, Sendable {
    /// Speech recognition permission denied by the user.
    case speechRecognitionDenied
    /// Microphone permission denied by the user.
    case microphoneDenied
    /// Parental controls / MDR restrict speech recognition.
    case restricted
}

public enum ComposerVoiceUnavailabilityReason: Equatable, Sendable {
    /// No on-device recognizer for the current locale or SFSpeechRecognizer
    /// reports itself unavailable.
    case recognizerUnavailable
    /// AVAudioSession / AVAudioEngine failed to start.
    case audioEngineFailure(String)
}

public enum ComposerVoiceError: Equatable, Sendable, Error {
    case recognizerUnavailable
    case notAuthorized
    case audioEngineFailure(String)
    case recognitionFailure(String)
}

public enum ComposerVoiceAuthorizationResult: Equatable, Sendable {
    case granted
    case denied(ComposerVoiceDenialReason)
    case unavailable(ComposerVoiceUnavailabilityReason)
}

// MARK: - Pure state machine

/// Side effects the controller must perform on behalf of the state machine.
public enum ComposerVoiceEffect: Equatable, Sendable {
    case requestAuthorization
    case beginSession
    case stopSession
    case cancelSession
    case emitTranscript(String)
    case none
}

/// Inputs that drive the state machine.
public enum ComposerVoiceEvent: Equatable, Sendable {
    case startRequested
    case authorizationResult(ComposerVoiceAuthorizationResult)
    case recognitionStarted
    case partialTranscript(String)
    case finalTranscript(String)
    case recognitionFailed(ComposerVoiceError)
    case stopRequested
    case cancelRequested
}

/// Pure state machine for composer-local dictation.
///
/// Keeps the concurrency-sensitive speech stack out of the decision logic so
/// the truth table can be unit-tested without a microphone.
public struct ComposerVoiceStateMachine: Equatable, Sendable {
    public private(set) var state: ComposerVoiceState = .idle

    /// Live preview text; cleared when a final transcript is emitted or the
    /// controller resets. Not mutated by the call site — it is a read-out.
    public private(set) var partialTranscript: String = ""

    /// Tracks whether we have already emitted a final transcript for the
    /// current take. Prevents duplicate emissions if the platform fires an
    /// automatic final followed by a stop-triggered final.
    private var finalEmitted: Bool = false

    public init() {}

    public mutating func handle(_ event: ComposerVoiceEvent) -> ComposerVoiceEffect {
        switch (state, event) {
        case (.idle, .startRequested):
            resetForNewTake()
            state = .authorizing
            return .requestAuthorization

        case (.authorizing, .authorizationResult(.granted)):
            state = .listening
            return .beginSession

        case (.authorizing, .authorizationResult(.denied(let reason))):
            state = .denied(reason)
            return .cancelSession

        case (.authorizing, .authorizationResult(.unavailable(let reason))):
            state = .unavailable(reason)
            return .cancelSession

        case (.authorizing, .cancelRequested), (.authorizing, .stopRequested):
            // Stop during authorizing is cancel, not "finish": capture has
            // not started. Ignoring stop here used to let a late grant begin
            // the mic after the user already tried to stop it.
            state = .idle
            return .cancelSession

        case (.listening, .recognitionStarted):
            return .none

        case (.listening, .partialTranscript(let text)):
            partialTranscript = text
            return .none

        case (.listening, .finalTranscript(let text)):
            // Automatic final is a terminal route: emit, leave listening,
            // and require the controller to tear down the live session.
            partialTranscript = ""
            state = .idle
            if !finalEmitted {
                finalEmitted = true
                return .emitTranscript(text)
            }
            return .stopSession

        case (.listening, .recognitionFailed(let error)):
            partialTranscript = ""
            state = .unavailable(Self.unavailability(from: error))
            return .cancelSession

        case (.listening, .stopRequested):
            // Stop keeps any leftover partial (user meant "done"), then
            // leaves listening. Cancel discards instead.
            let leftover = partialTranscript
            partialTranscript = ""
            state = .idle
            if !finalEmitted && !leftover.isEmpty {
                finalEmitted = true
                return .emitTranscript(leftover)
            }
            return .stopSession

        case (.listening, .cancelRequested):
            partialTranscript = ""
            state = .idle
            return .cancelSession

        case (.finalizing, .finalTranscript(let text)):
            state = .idle
            if !finalEmitted {
                finalEmitted = true
                return .emitTranscript(text)
            }
            return .stopSession

        case (.finalizing, .recognitionFailed):
            partialTranscript = ""
            state = .idle
            return .cancelSession

        case (.finalizing, .stopRequested), (.finalizing, .cancelRequested):
            partialTranscript = ""
            state = .idle
            return .cancelSession

        case (.denied, .startRequested), (.unavailable, .startRequested):
            resetForNewTake()
            state = .authorizing
            return .requestAuthorization

        case (.denied, .cancelRequested), (.unavailable, .cancelRequested):
            state = .idle
            return .cancelSession

        default:
            return .none
        }
    }

    private mutating func resetForNewTake() {
        partialTranscript = ""
        finalEmitted = false
    }

    private static func unavailability(
        from error: ComposerVoiceError
    ) -> ComposerVoiceUnavailabilityReason {
        switch error {
        case .recognizerUnavailable:
            return .recognizerUnavailable
        case .notAuthorized:
            return .audioEngineFailure("not authorized")
        case .audioEngineFailure(let message), .recognitionFailure(let message):
            return .audioEngineFailure(message)
        }
    }
}

// MARK: - Session abstraction

/// Abstracts the platform speech stack so tests can drive the controller
/// without a microphone and the live implementation stays iOS-only.
@MainActor
public protocol VoiceControllerSession: AnyObject, Sendable {
    func requestAuthorization() async -> ComposerVoiceAuthorizationResult
    func begin(
        onPartial: @escaping @MainActor (String) -> Void,
        onFinal: @escaping @MainActor (String) -> Void,
        onError: @escaping @MainActor (ComposerVoiceError) -> Void
    ) async -> VoiceControllerSessionHandle
}

@MainActor
public protocol VoiceControllerSessionHandle: Sendable {
    /// Stop capture and finish recognition. Must deactivate the audio session
    /// (live implementation does this internally; the controller also calls
    /// `deactivateAudioSession()` so tests can observe the privacy contract).
    func stop()
    /// Cancel capture and discard. Must deactivate the audio session.
    func cancel()
    /// Deactivate the audio session. Idempotent. Called on every terminal
    /// route so the microphone cannot stay hot after dictation ends.
    func deactivateAudioSession()
}

// MARK: - Generic controller

#if canImport(SwiftUI)

    /// Observable controller bound to a `VoiceControllerSession`.
    ///
    /// The controller is `@MainActor` because its `@Published` state feeds SwiftUI
    /// and all session callbacks are main-actor isolated. The underlying state
    /// machine is pure and does not know about actors.
    @MainActor
    public final class ComposerVoiceController<Session: VoiceControllerSession>: ObservableObject {
        @Published public private(set) var state: ComposerVoiceState = .idle
        @Published public private(set) var partialTranscript: String = ""

        /// Fires on the main actor with the finalized transcript. Pass-2
        /// integration appends this string to the composer's text binding.
        public var onTranscriptReady: (@MainActor (String) -> Void)?

        private let session: Session
        private var stateMachine = ComposerVoiceStateMachine()
        private var currentHandle: VoiceControllerSessionHandle?
        /// Bumped on every authorization request and on stop/cancel so a
        /// late-returning permission dialog cannot resurrect a take the user
        /// already cancelled. The state machine also ignores grant-on-idle;
        /// this generation is the controller-side belt for overlapping Tasks.
        private var authorizationGeneration: UInt64 = 0

        public init(session: Session) {
            self.session = session
        }

        public func start() {
            apply(stateMachine.handle(.startRequested))
        }

        public func stop() {
            authorizationGeneration &+= 1
            apply(stateMachine.handle(.stopRequested))
        }

        public func cancel() {
            authorizationGeneration &+= 1
            apply(stateMachine.handle(.cancelRequested))
        }

        private func apply(_ effect: ComposerVoiceEffect) {
            switch effect {
            case .requestAuthorization:
                authorizationGeneration &+= 1
                let generation = authorizationGeneration
                Task { @MainActor in
                    let result = await session.requestAuthorization()
                    guard self.authorizationGeneration == generation else {
                        // User stopped/cancelled (or started a newer take)
                        // while the permission dialog was still up.
                        return
                    }
                    self.apply(self.stateMachine.handle(.authorizationResult(result)))
                }

            case .beginSession:
                Task { @MainActor in
                    let handle = await session.begin(
                        onPartial: { [weak self] text in
                            guard let self else { return }
                            self.apply(self.stateMachine.handle(.partialTranscript(text)))
                        },
                        onFinal: { [weak self] text in
                            guard let self else { return }
                            self.apply(self.stateMachine.handle(.finalTranscript(text)))
                        },
                        onError: { [weak self] error in
                            guard let self else { return }
                            self.apply(self.stateMachine.handle(.recognitionFailed(error)))
                        }
                    )
                    self.currentHandle = handle
                    if self.stateMachine.state == .listening {
                        self.apply(self.stateMachine.handle(.recognitionStarted))
                    } else {
                        // begin() reported a terminal error via callback before
                        // returning the handle. The cancelSession effect ran
                        // with currentHandle still nil; tear down now.
                        self.teardownHandle(cancel: true)
                    }
                }

            case .stopSession:
                teardownHandle(cancel: false)

            case .cancelSession:
                teardownHandle(cancel: true)

            case .emitTranscript(let text):
                onTranscriptReady?(text)
                // Automatic final / leftover-on-stop is terminal: emitting
                // without teardown is what left the mic hot.
                teardownHandle(cancel: false)

            case .none:
                break
            }

            state = stateMachine.state
            partialTranscript = stateMachine.partialTranscript
        }

        /// Stop or cancel capture, deactivate the audio session, and drop the
        /// handle. Safe to call when `currentHandle` is nil or already torn down.
        private func teardownHandle(cancel: Bool) {
            if cancel {
                currentHandle?.cancel()
            } else {
                currentHandle?.stop()
            }
            currentHandle?.deactivateAudioSession()
            currentHandle = nil
        }
    }

#endif

// MARK: - iOS live session

#if os(iOS)

    import AVFoundation
    import Speech

    /// On-device Speech + AVAudioEngine session. Runs entirely on the iOS
    /// companion; no audio or transcript leaves the device.
    @MainActor
    public final class OnDeviceVoiceControllerSession: VoiceControllerSession {
        private let speechRecognizer: SFSpeechRecognizer?
        private let audioEngine = AVAudioEngine()
        private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
        private var recognitionTask: SFSpeechRecognitionTask?
        private var audioSessionActive = false
        private var tapInstalled = false

        public init(localeIdentifier: String = Locale.autoupdatingCurrent.identifier) {
            self.speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier))
        }

        public func requestAuthorization() async -> ComposerVoiceAuthorizationResult {
            let speechStatus = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status)
                }
            }

            switch speechStatus {
            case .notDetermined, .denied:
                return .denied(.speechRecognitionDenied)
            case .restricted:
                return .denied(.restricted)
            case .authorized:
                break
            @unknown default:
                return .denied(.speechRecognitionDenied)
            }

            let micGranted = await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }

            guard micGranted else {
                return .denied(.microphoneDenied)
            }

            guard speechRecognizer?.isAvailable == true else {
                return .unavailable(.recognizerUnavailable)
            }

            return .granted
        }

        public func begin(
            onPartial: @escaping @MainActor (String) -> Void,
            onFinal: @escaping @MainActor (String) -> Void,
            onError: @escaping @MainActor (ComposerVoiceError) -> Void
        ) async -> VoiceControllerSessionHandle {
            guard let recognizer = speechRecognizer, recognizer.isAvailable else {
                onError(.recognizerUnavailable)
                return OnDeviceVoiceControllerSessionHandle(session: self)
            }

            do {
                let audioSession = AVAudioSession.sharedInstance()
                try audioSession.setCategory(.record, mode: .default, options: .duckOthers)
                try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
                audioSessionActive = true

                let request = SFSpeechAudioBufferRecognitionRequest()
                request.requiresOnDeviceRecognition = true
                request.shouldReportPartialResults = true

                let task = recognizer.recognitionTask(with: request) { result, error in
                    if let error {
                        Task { @MainActor in
                            onError(.recognitionFailure(error.localizedDescription))
                        }
                        return
                    }
                    guard let result else { return }
                    let text = result.bestTranscription.formattedString
                    if result.isFinal {
                        Task { @MainActor in
                            onFinal(text)
                        }
                    } else {
                        Task { @MainActor in
                            onPartial(text)
                        }
                    }
                }

                recognitionRequest = request
                recognitionTask = task

                let inputNode = audioEngine.inputNode
                let recordingFormat = inputNode.outputFormat(forBus: 0)
                inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
                    self.recognitionRequest?.append(buffer)
                }
                tapInstalled = true

                audioEngine.prepare()
                try audioEngine.start()

                return OnDeviceVoiceControllerSessionHandle(session: self)
            } catch {
                terminalTeardown(cancelTask: true)
                onError(.audioEngineFailure(error.localizedDescription))
                return OnDeviceVoiceControllerSessionHandle(session: self)
            }
        }

        fileprivate func stop() {
            terminalTeardown(cancelTask: false)
        }

        fileprivate func cancel() {
            terminalTeardown(cancelTask: true)
        }

        fileprivate func deactivateAudioSession() {
            guard audioSessionActive else { return }
            try? AVAudioSession.sharedInstance().setActive(
                false,
                options: .notifyOthersOnDeactivation
            )
            audioSessionActive = false
        }

        /// Full capture teardown used by stop, cancel, and a failed `begin`.
        /// Always deactivates the audio session so a terminal path cannot
        /// leave the microphone hot.
        private func terminalTeardown(cancelTask: Bool) {
            if audioEngine.isRunning {
                audioEngine.stop()
            }
            if tapInstalled {
                audioEngine.inputNode.removeTap(onBus: 0)
                tapInstalled = false
            }
            recognitionRequest?.endAudio()
            if cancelTask {
                recognitionTask?.cancel()
            } else {
                recognitionTask?.finish()
            }
            recognitionTask = nil
            recognitionRequest = nil
            deactivateAudioSession()
        }
    }

    @MainActor
    public struct OnDeviceVoiceControllerSessionHandle: VoiceControllerSessionHandle {
        private let session: OnDeviceVoiceControllerSession

        init(session: OnDeviceVoiceControllerSession) {
            self.session = session
        }

        public func stop() {
            session.stop()
        }

        public func cancel() {
            session.cancel()
        }

        public func deactivateAudioSession() {
            session.deactivateAudioSession()
        }
    }

    extension ComposerVoiceController where Session == OnDeviceVoiceControllerSession {
        /// Convenience factory for the pass-2 integration lane.
        public static func onDevice(
            localeIdentifier: String = Locale.autoupdatingCurrent.identifier
        ) -> ComposerVoiceController<OnDeviceVoiceControllerSession> {
            ComposerVoiceController(session: OnDeviceVoiceControllerSession(localeIdentifier: localeIdentifier))
        }
    }

#endif
