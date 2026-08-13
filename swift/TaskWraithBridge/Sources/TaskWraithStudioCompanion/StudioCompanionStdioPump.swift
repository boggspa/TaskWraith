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
    /// Everything the session learned from one chunk.
    ///
    /// WHY ONE VALUE RATHER THAN A CALLBACK PER PAYLOAD. The pump previously
    /// declared five optional callbacks and dispatched them one by one, so
    /// adding a field to Step required TWO edits here and nothing forced
    /// either. That shape dropped proposals silently once, and was about to
    /// drop the committed sequence the same way — the second time at the same
    /// seam. The defect was never optionality; it was ENUMERATION. Five
    /// hand-written forwards are five chances to forget one, and a `= nil`
    /// default makes forgetting indistinguishable from declining.
    ///
    /// Forwarding the whole update removes the opportunity: the pump no longer
    /// knows what a payload IS, so it cannot fail to mention one. A consumer
    /// can still ignore a field, but that is now visible at a single site
    /// rather than hidden in a transport.
    struct Update: Sendable {
        let step: StudioCompanionSession.Step
        /// Revision of the most recent editCommitted, if any.
        let latestRevision: Int?
        /// The hydrated document, once getDocument has been answered. Carries
        /// the committed timeline, which lives outside Step.
        let hydration: StudioCompanionSession.Hydration?
    }

    static func run(
        hydrateOnce: Bool,
        onUpdate: (@Sendable (Update) -> Void)? = nil
    ) -> Int32 {
        let session = StudioCompanionSession(hydrateOnce: hydrateOnce)
        let standardInput = FileHandle.standardInput
        let standardError = FileHandle.standardError

        // Through the shared writer, so a viewer-originated proposal cannot
        // interleave with a pump response mid-line.
        func writeLines(_ lines: [Data]) {
            StudioOutboundWriter.shared.write(lines)
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
            onUpdate?(
                Update(
                    step: step,
                    latestRevision: session.latestRevision,
                    hydration: session.hydrated
                )
            )
            if let code = step.exitCode {
                return code
            }
        }
        return session.eofExitCode()
    }
}
