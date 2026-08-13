import Foundation
import TaskWraithStudioCore

/// The stdio side of the companion, extracted verbatim from main.swift so the
/// viewer can run it on a background thread while AppKit owns the main run loop.
///
/// Behaviour is deliberately unchanged: emit the hello line immediately, pump
/// stdin chunks through StudioCompanionSession, write outbound lines to stdout,
/// mirror protocol errors to stderr, and exit on the session's request or at
/// stdin EOF. The host-side StudioCompanionSupervisor interop test depends on
/// exactly this sequence.
enum StudioCompanionStdioPump {
    /// Runs until the session asks to exit or stdin reaches EOF, and returns the
    /// process exit code the caller should use.
    ///
    /// - Parameter onOpenedAssets: called on the PUMP THREAD whenever the host
    ///   commits an open_media. Only Sendable identities cross; loading and
    ///   attaching happen on whichever isolation the handler chooses, because
    ///   the viewer's renderer is main-thread state.
    /// - Parameter onTranscripts: called on the PUMP THREAD when the host sends
    ///   or replaces a transcript. Without this the session parses transcripts
    ///   that reach no renderer, which is what the band is for.
    static func run(
        hydrateOnce: Bool,
        onOpenedAssets: (@Sendable ([StudioMediaAsset]) -> Void)? = nil,
        onTranscripts: (@Sendable ([StudioTranscript]) -> Void)? = nil
    ) -> Int32 {
        let session = StudioCompanionSession(hydrateOnce: hydrateOnce)
        let standardInput = FileHandle.standardInput
        let standardOutput = FileHandle.standardOutput
        let standardError = FileHandle.standardError

        func writeLines(_ lines: [Data]) {
            for line in lines {
                standardOutput.write(line)
            }
        }

        func reportProtocolErrors(_ notes: [String]) {
            for note in notes {
                if let data = "taskwraith-studio-companion: \(note)\n".data(using: .utf8) {
                    standardError.write(data)
                }
            }
        }

        writeLines(session.startLines())

        while true {
            let chunk = standardInput.availableData
            if chunk.isEmpty {
                break // stdin EOF: the host closed us down.
            }
            let step = session.consume(chunk: chunk)
            reportProtocolErrors(step.protocolErrors)
            writeLines(step.outboundLines)
            if !step.openedAssets.isEmpty {
                onOpenedAssets?(step.openedAssets)
            }
            if !step.transcripts.isEmpty {
                onTranscripts?(step.transcripts)
            }
            if let code = step.exitCode {
                return code
            }
        }
        return session.eofExitCode()
    }
}
