import Foundation
import Speech

/// Native on-device speech-to-text for `audio.transcribe` (the marquee
/// privacy-preserving daemon capability).
///
/// Pipeline: request Speech Recognition authorization → build an
/// `SFSpeechRecognizer` for the requested locale → run an
/// `SFSpeechURLRecognitionRequest` with `requiresOnDeviceRecognition = true`
/// → map the final `bestTranscription` (text + per-segment substrings with
/// ms timings + confidence) into the locked `TranscriptResult` shape.
///
/// PRIVACY INVARIANT (the whole point of this tool): recognition is ON-DEVICE
/// ONLY. We hard-gate on `recognizer.supportsOnDeviceRecognition` and set
/// `requiresOnDeviceRecognition = true`, so the audio NEVER leaves the Mac —
/// there is NO network fallback anywhere in this flow. A locale whose model
/// isn't downloaded fails with an actionable `.badInput`, it does NOT silently
/// fall back to Apple's servers.
///
/// `import Speech` is a free system framework (like `Vision` in
/// AttachedWindowOCR) — no Package.swift target is added. Mirrors
/// AttachedWindowOCR's async-via-withCheckedThrowingContinuation + Encodable
/// result + `toJSONObject()` shape, and AudioMixer's typed-error → JSON-RPC
/// mapping (`.badInput` → invalidParams, `.recognitionFailed` → internalError).
enum AudioTranscriber {

    /// Transcription failures surfaced to the RPC boundary. `.badInput` →
    /// `invalidParams` (caller-correctable: permission not granted, an
    /// unavailable/unsupported locale, on-device recognition unavailable, a
    /// missing/unreadable file); `.recognitionFailed` → `internalError` (the
    /// setup looked valid but the recognizer itself errored). Mirrors
    /// `AudioMixer.AudioMixError`'s mapping.
    enum TranscribeError: Error, CustomStringConvertible {
        case badInput(String)
        case recognitionFailed(String)

        var description: String {
            switch self {
            case .badInput(let m): return m
            case .recognitionFailed(let m): return m
            }
        }
    }

    /// One recognized span — a substring of the transcript with its start/end
    /// in whole milliseconds and the recognizer's confidence (0..1). Timings
    /// come from each `SFTranscriptionSegment`'s `timestamp`/`duration`
    /// (seconds → ms ints).
    struct Segment: Encodable, Sendable {
        let text: String
        let startMs: Int
        let endMs: Int
        let confidence: Double
    }

    /// `audio.transcribe` result. FIXED shape (the TS executor reads these
    /// exact keys/types): `text`(String, the whole formatted transcript) /
    /// `segments`([Segment]) / `localeIdentifier`(String, the locale actually
    /// used) / `onDevice`(Bool, always true — the privacy invariant).
    struct TranscriptResult: Sendable {
        let text: String
        let segments: [Segment]
        let localeIdentifier: String
        let onDevice: Bool

        func toJSONObject() -> [String: Any] {
            return [
                "text": text,
                "segments": segments.map { segment in
                    [
                        "text": segment.text,
                        "startMs": segment.startMs,
                        "endMs": segment.endMs,
                        "confidence": segment.confidence
                    ] as [String: Any]
                },
                "localeIdentifier": localeIdentifier,
                "onDevice": onDevice
            ]
        }
    }

    // MARK: - Public entry

    /// Transcribe the audio at `sourcePath` entirely on-device.
    /// - Parameters:
    ///   - sourcePath: the TS-path-jailed audio file to transcribe (we trust
    ///     the path; the security boundary is the TS realpath jail).
    ///   - localeIdentifier: BCP-47 locale (e.g. "en-US"); defaults to "en-US".
    static func transcribe(sourcePath: String, localeIdentifier: String?) async throws -> TranscriptResult {
        // 1) Authorization. `requestAuthorization` is completion-style; wrap it
        //    in a continuation. A non-`.authorized` status is a caller-
        //    correctable `.badInput` carrying the exact System Settings path.
        let authStatus: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
        guard authStatus == .authorized else {
            throw TranscribeError.badInput(
                "Speech Recognition permission not granted — enable it in System Settings › Privacy & Security › Speech Recognition"
            )
        }

        // 2) Recognizer for the requested locale. `SFSpeechRecognizer(locale:)`
        //    is FAILABLE (returns nil for an unsupported locale) → guard. Then
        //    require it be available AND support on-device recognition; if the
        //    on-device model for this locale isn't present we FAIL rather than
        //    let Speech fall back to the network (the privacy invariant).
        let resolvedLocaleId = localeIdentifier ?? "en-US"
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: resolvedLocaleId)) else {
            throw TranscribeError.badInput("speech recognition is not supported for locale \"\(resolvedLocaleId)\"")
        }
        guard recognizer.isAvailable else {
            throw TranscribeError.badInput("speech recognizer is not available right now for locale \"\(resolvedLocaleId)\"")
        }
        guard recognizer.supportsOnDeviceRecognition else {
            throw TranscribeError.badInput("on-device recognition unavailable for this locale")
        }

        // 3) The file must exist + be readable before we hand it to Speech.
        let fileURL = URL(fileURLWithPath: sourcePath)
        guard FileManager.default.fileExists(atPath: sourcePath) else {
            throw TranscribeError.badInput("audio file does not exist: \(sourcePath)")
        }

        // 4) On-device-only request. `requiresOnDeviceRecognition = true` is the
        //    enforcement that audio never leaves the Mac; partial results off
        //    (we only want the final transcript).
        let request = SFSpeechURLRecognitionRequest(url: fileURL)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false

        // 5) Run the task. `recognitionTask(with:resultHandler:)` is completion-
        //    style and the callback FIRES REPEATEDLY (progressive results); even
        //    with partials off, an error path and a final-result path can both
        //    arrive, so we MUST resume the continuation exactly once. A
        //    `hasResumed` Bool guards against a double-resume (which would be a
        //    fatal `SWIFT_TASK_CONTINUATION_MISUSE` trap killing the daemon). We
        //    resume only on `error` or `result.isFinal == true`; any non-final
        //    result is ignored.
        return try await withCheckedThrowingContinuation { continuation in
            var hasResumed = false
            let resumeOnce: (Result<TranscriptResult, Error>) -> Void = { outcome in
                // Single-resume guard: the FIRST terminal callback wins; all later
                // callbacks (and the never-both case) are dropped.
                if hasResumed { return }
                hasResumed = true
                continuation.resume(with: outcome)
            }

            recognizer.recognitionTask(with: request) { result, error in
                if let error = error {
                    resumeOnce(.failure(TranscribeError.recognitionFailed(
                        "speech recognition failed: \(error.localizedDescription)"
                    )))
                    return
                }
                guard let result = result else { return }
                // Ignore every non-final (progressive) callback; resume only once
                // the recognizer reports the FINAL transcription.
                guard result.isFinal else { return }

                let best = result.bestTranscription
                let segments: [Segment] = best.segments.map { seg in
                    let startMs = Int((seg.timestamp * 1000).rounded())
                    let endMs = Int(((seg.timestamp + seg.duration) * 1000).rounded())
                    return Segment(
                        text: seg.substring,
                        startMs: startMs,
                        endMs: endMs,
                        confidence: Double(seg.confidence)
                    )
                }
                resumeOnce(.success(TranscriptResult(
                    text: best.formattedString,
                    segments: segments,
                    localeIdentifier: resolvedLocaleId,
                    onDevice: true
                )))
            }
        }
    }
}
