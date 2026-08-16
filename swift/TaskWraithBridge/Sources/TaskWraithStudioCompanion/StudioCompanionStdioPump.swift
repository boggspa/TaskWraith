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

    /// Forwards startup hydration EXACTLY ONCE.
    ///
    /// WHY THIS EXISTS. `StudioCompanionSession.hydrated` is a RETAINED
    /// snapshot of the getDocument response: it is never consumed and never
    /// reset. The pump attached it to every subsequent Update, so every live
    /// edit arrived paired with the document as it looked at startup. Because a
    /// document whose `effectPreview` is null is an explicit CLEAR rather than
    /// "leave alone", committing a LUT installed it and then immediately wiped
    /// it. Measured in packaged run w2lut0816g: the operator's LUT was
    /// journaled, persisted and acknowledged, and the picture stayed neutral.
    /// The same shape could replay stale assets, proposals, transcripts and the
    /// committed sequence over live state on every later edit.
    ///
    /// Hydration is a ONE-TIME RECOVERY EVENT, not perpetual state; this makes
    /// the transport say so. It is a cursor at the pump boundary rather than a
    /// mutation of the session because `hydrated` is also a durable reconnect
    /// diagnostic — consuming it there would destroy a second reader's evidence
    /// to fix a transport bug.
    struct HydrationCursor {
        private var forwarded = false

        /// Returns the hydration the first time it exists, and nil forever after.
        mutating func take(
            _ hydrated: StudioCompanionSession.Hydration?
        ) -> StudioCompanionSession.Hydration? {
            guard let hydrated, !forwarded else { return nil }
            forwarded = true
            return hydrated
        }
    }

    /// The envelope seam: one chunk in, one Update out.
    ///
    /// Named and extracted so a test can drive the REAL sequencing instead of
    /// reassembling it. That distinction is the whole lesson of this file — the
    /// stale-hydration defect survived because nothing under Tests/ executed
    /// this join, exactly as proposals and the sequence did before it.
    static func consume(
        chunk: Data,
        session: StudioCompanionSession,
        hydration: inout HydrationCursor
    ) -> Update {
        let step = session.consume(chunk: chunk)
        return Update(
            step: step,
            latestRevision: session.latestRevision,
            hydration: hydration.take(session.hydrated)
        )
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

        var hydrationCursor = HydrationCursor()

        while true {
            let chunk = standardInput.availableData
            if chunk.isEmpty {
                break // stdin EOF: the host closed us down.
            }
            let update = consume(
                chunk: chunk,
                session: session,
                hydration: &hydrationCursor
            )
            reportProtocolErrors(update.step.protocolErrors)
            writeLines(update.step.outboundLines)
            onUpdate?(update)
            if let code = update.step.exitCode {
                return code
            }
        }
        return session.eofExitCode()
    }
}
