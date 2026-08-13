import Foundation

/// Deterministic, I/O-free state machine for the TaskWraith Studio companion.
/// main.swift pumps stdin chunks in and writes the returned NDJSON lines out;
/// every protocol decision lives here so tests cover it in-process.
///
/// Protocol v1 (normative: src/main/studio/StudioProtocol.ts):
/// - Hydration is COMPANION-DRIVEN: the companion emits studio/hello with a
///   NUMERIC protocolVersion (the TS dispatcher rejects strings), parses the
///   hello response, emits studio/getDocument, and parses the document
///   response. There is no host-pushed snapshot message in v1 and none is
///   expected here.
/// - After hydration the session stays resident consuming notifications
///   (studio/editCommitted is counted) until stdin EOF, unless hydrateOnce is
///   set, in which case it requests exit 0 immediately after hydration. That
///   mode exists for conformance/E2E harnesses (the host-side
///   StudioCompanionSupervisor interop test); production launch omits it.
/// - Reconnect hydration is studio/hello -> studio/getDocument, and the
///   document response now RESTORES durable state: opened assets, open ghost
///   proposals and transcripts. The "open-proposal replay is explicitly
///   unimplemented" caveat that rode this file since v1 is retired — the host
///   made that state durable, and this parses it.
/// - Legacy note, kept because it explains the shape: durable proposal
///   state is not modelled yet, so there is nothing to replay.
///
/// Exit codes:
///   0 clean (stdin EOF after hydration, or hydrateOnce success)
///   2 host rejected studio/hello with an error response
///   3 hello result malformed or protocol version unsupported
///   4 studio/getDocument rejected or malformed
///   5 stdin EOF before hydration completed
public final class StudioCompanionSession {
    public enum Phase: Equatable {
        case awaitingHelloResponse
        case awaitingDocumentResponse
        case hydrated
    }

    /// Result of feeding one chunk: bytes to write to stdout, an exit request,
    /// and human-readable protocol errors for stderr diagnostics.
    public struct Step: Sendable {
        public let outboundLines: [Data]
        public let exitCode: Int32?
        public let protocolErrors: [String]
        /// Assets the host reported opening in this chunk.
        ///
        /// The session stays I/O-FREE: it recognises the open_media operation
        /// and hands the identity out, but never touches the filesystem. Loading
        /// belongs to StudioMediaAttachment, which is where it can be tested
        /// against a real file without dragging I/O into this state machine.
        public let openedAssets: [StudioMediaAsset]
        /// Ghost proposals the host committed in this chunk.
        ///
        /// Surfaced by the same principle as openedAssets: the session
        /// RECOGNISES propose_edit and hands the decoded proposal out, and does
        /// nothing else with it. Building a proposed timeline and drawing a
        /// ghost belong upstairs where they can be tested against real geometry.
        public let proposals: [StudioEditProposal]
        /// Proposals the host RESOLVED, by id. A resolved ghost must stop being
        /// drawn whichever way it went — an accepted proposal is now part of the
        /// sequence, and a rejected one never will be.
        public let resolvedProposalIds: [String]
        /// Transcripts the host published in this chunk.
        public let transcripts: [StudioTranscript]

        public init(
            outboundLines: [Data],
            exitCode: Int32?,
            protocolErrors: [String],
            openedAssets: [StudioMediaAsset] = [],
            proposals: [StudioEditProposal] = [],
            resolvedProposalIds: [String] = [],
            transcripts: [StudioTranscript] = []
        ) {
            self.outboundLines = outboundLines
            self.exitCode = exitCode
            self.protocolErrors = protocolErrors
            self.openedAssets = openedAssets
            self.proposals = proposals
            self.resolvedProposalIds = resolvedProposalIds
            self.transcripts = transcripts
        }
    }

    public static let protocolVersion = 1
    public static let helloRequestId = 1
    public static let getDocumentRequestId = 2

    public private(set) var phase: Phase = .awaitingHelloResponse
    public private(set) var documentRevision: Int?
    public private(set) var editCommittedCount = 0
    /// The revision of the most recent studio/editCommitted. This is the base a
    /// proposal must cite: the host rejects a stale base rather than rebasing
    /// silently, so an operator who proposes against what they were looking at
    /// gets a conflict instead of quietly overwriting a concurrent edit.
    public private(set) var latestRevision: Int?

    /// open_media operations recognised on studio/editCommitted.
    /// Durable state recovered from the getDocument response.
    ///
    /// Separate from the per-chunk Step because hydration is a DIFFERENT event
    /// from a live commit: a caller reconnecting must reapply everything at
    /// once, while a caller handling a notification is reacting to one change.
    /// Collapsing them would make "reopen this asset" indistinguishable from
    /// "the user just opened this asset".
    public struct Hydration: Equatable, Sendable {
        public let assets: [StudioMediaAsset]
        public let proposals: [StudioEditProposal]
        public let transcripts: [StudioTranscript]
        /// The committed timeline, as a PLAYBACK SUBJECT for the Review route.
        /// Decoded in the document's own millisecond rational space; a viewer
        /// re-expresses it when it adopts a timebase.
        public let sequence: StudioTimelineSequence

        public var isEmpty: Bool {
            assets.isEmpty && proposals.isEmpty && transcripts.isEmpty && sequence.isEmpty
        }

        public static let empty = Hydration(
            assets: [], proposals: [], transcripts: [],
            sequence: StudioTimelineSequence(items: []))
    }

    /// Nil until the document response arrives.
    public private(set) var hydrated: Hydration?

    public private(set) var openedAssetCount = 0
    /// Bounded counters for diagnostics; the session holds no proposal state
    /// itself, because durable proposal state is the HOST's and re-deriving it
    /// here would create a second source of truth that can disagree.
    public private(set) var proposalCount = 0
    public private(set) var resolvedProposalCount = 0
    public private(set) var transcriptCount = 0
    /// Most recent asset the host reported opening, for reconnect diagnostics.
    public private(set) var lastOpenedAsset: StudioMediaAsset?
    public private(set) var protocolErrorCount = 0

    private let decoder = StudioNdjsonDecoder()
    private let hydrateOnce: Bool

    public init(hydrateOnce: Bool = false) {
        self.hydrateOnce = hydrateOnce
    }

    /// The first bytes the companion must write: the hello request line.
    public func startLines() -> [Data] {
        [
            Self.encodeLine([
                "jsonrpc": "2.0",
                "id": Self.helloRequestId,
                "method": "studio/hello",
                "params": [
                    "protocolVersion": Self.protocolVersion,
                    "client": "taskwraith-studio-companion"
                ]
            ])
        ]
    }

    /// Feed raw stdin bytes; CRLF and multi-byte UTF-8 splits across chunk
    /// boundaries are handled by StudioNdjsonDecoder.
    public func consume(chunk: Data) -> Step {
        var outbound: [Data] = []
        var errors: [String] = []
        var opened: [StudioMediaAsset] = []
        var proposed: [StudioEditProposal] = []
        var resolved: [String] = []
        var transcripts: [StudioTranscript] = []
        var exitCode: Int32?
        for event in decoder.push(chunk: chunk) {
            if exitCode != nil { break }
            switch event {
            case .decodeError(let code, let message):
                protocolErrorCount += 1
                errors.append("\(code): \(message)")
            case .message(let message):
                let outcome = handle(message)
                outbound.append(contentsOf: outcome.lines)
                if let error = outcome.error {
                    protocolErrorCount += 1
                    errors.append(error)
                }
                if let asset = outcome.openedAsset {
                    opened.append(asset)
                }
                // Proposal traffic rides the SAME editCommitted notification as
                // open_media and insert_range, so the guard is the notification
                // plus the op discriminator — not the presence of a field.
                if message.method == "studio/editCommitted" {
                    if let proposal = Self.proposal(in: message) {
                        proposed.append(proposal)
                        proposalCount += 1
                    }
                    if let resolvedId = Self.resolvedProposalId(in: message) {
                        resolved.append(resolvedId)
                        resolvedProposalCount += 1
                    }
                    switch Self.transcriptOutcome(in: message) {
                    case .decoded(let transcript):
                        transcripts.append(transcript)
                        transcriptCount += 1
                    case .rejected(let reason):
                        // A malformed transcript must SAY SO. Silent rejection
                        // is indistinguishable from silent acceptance, which
                        // leaves the host unable to tell whether its speech
                        // timing ever reached the band.
                        protocolErrorCount += 1
                        errors.append("set_transcript rejected: \(reason)")
                    case .notATranscript:
                        break
                    }
                }
                exitCode = outcome.exit
            }
        }
        return Step(
            outboundLines: outbound,
            exitCode: exitCode,
            protocolErrors: errors,
            openedAssets: opened,
            proposals: proposed,
            resolvedProposalIds: resolved,
            transcripts: transcripts
        )
    }

    /// Called at stdin EOF. Clean only once hydration completed.
    public func eofExitCode() -> Int32 {
        phase == .hydrated ? 0 : 5
    }

    private func handle(
        _ message: StudioMessage
    ) -> (lines: [Data], exit: Int32?, error: String?, openedAsset: StudioMediaAsset?) {
        // Notifications are tolerated in every phase; only editCommitted is
        // tracked. v1 defines no other host-initiated traffic.
        if message.id == nil, message.method != nil {
            if message.method == "studio/editCommitted" {
                editCommittedCount += 1
                if let revision = message.params?["revision"]?.value as? Int {
                    latestRevision = revision
                }
                if let asset = Self.openedAsset(in: message) {
                    lastOpenedAsset = asset
                    openedAssetCount += 1
                    return ([], nil, nil, asset)
                }
            }
            return ([], nil, nil, nil)
        }
        switch phase {
        case .awaitingHelloResponse:
            guard message.id == Self.helloRequestId, message.method == nil else {
                return ([], nil, unexpected(message, while: "awaiting hello response"), nil)
            }
            if message.error != nil {
                return ([], 2, nil, nil)
            }
            guard
                let result = message.result?.value as? [String: Any],
                let version = result["protocolVersion"] as? Int,
                version == Self.protocolVersion
            else {
                return ([], 3, nil, nil)
            }
            phase = .awaitingDocumentResponse
            let request = Self.encodeLine([
                "jsonrpc": "2.0",
                "id": Self.getDocumentRequestId,
                "method": "studio/getDocument"
            ])
            return ([request], nil, nil, nil)
        case .awaitingDocumentResponse:
            guard message.id == Self.getDocumentRequestId, message.method == nil else {
                return ([], nil, unexpected(message, while: "awaiting document response"), nil)
            }
            if message.error != nil {
                return ([], 4, nil, nil)
            }
            guard
                let result = message.result?.value as? [String: Any],
                let revision = result["revision"] as? Int
            else {
                return ([], 4, nil, nil)
            }
            documentRevision = revision
            // RECOVER THE DOCUMENT, not just the revision.
            //
            // This is the reconnect path, and dropping the document here is
            // what made "reconnect recovery" a claim rather than a behaviour: a
            // restarted companion re-hydrated to the right revision number and
            // then showed nothing — no media reopened, no ghosts reappeared, no
            // transcript. The host has held all of it durably since the
            // proposal and transcript slices landed; the companion simply threw
            // it away.
            hydrated = Self.hydration(from: result["document"])
            phase = .hydrated
            return ([], hydrateOnce ? 0 : nil, nil, nil)
        case .hydrated:
            // Responses beyond v1 scope are tolerated; the companion sends no
            // further requests in this slice.
            return ([], nil, nil, nil)
        }
    }

    private func unexpected(_ message: StudioMessage, while context: String) -> String {
        let id = message.id.map { String($0) } ?? "nil"
        let method = message.method ?? "nil"
        return "unexpected message (id: \(id), method: \(method)) while \(context)"
    }

    /// Extracts the asset from a studio/editCommitted whose op is open_media.
    /// insert_range commits arrive on the SAME notification, so the type
    /// discriminator inside StudioMediaAsset.fromDocumentOperation is what keeps
    /// them apart.
    /// Decodes durable state from the getDocument document payload.
    ///
    /// Individual malformed entries are SKIPPED rather than failing the whole
    /// hydration. One unreadable ghost must not cost the operator their media
    /// and their transcript too — partial recovery beats none, and the
    /// per-entry decoders already fail closed on anything they cannot read.
    static func hydration(from document: Any?) -> Hydration {
        guard let document = document as? [String: Any] else { return .empty }
        let assets = (document["assets"] as? [[String: Any]] ?? [])
            .compactMap(StudioMediaAsset.decode(from:))
        let proposals = (document["proposals"] as? [[String: Any]] ?? [])
            .compactMap { try? StudioProposalDecoder.proposal(from: $0) }
        // TRACKS. Carried by the document since insert_range began
        // materialising items, and dropped here until now — so the committed
        // timeline arrived and reached nothing.
        let trackPayload = document["tracks"] as? [[String: Any]] ?? []
        let transcripts = (document["transcripts"] as? [[String: Any]] ?? [])
            .compactMap { try? StudioTranscriptDecoder.transcript(from: $0) }
        return Hydration(
            assets: assets,
            proposals: proposals,
            transcripts: transcripts,
            // The viewer's timebase is not known at hydration, so the sequence
            // is decoded in the DOCUMENT's own millisecond rational space and
            // re-expressed when a viewer adopts it. Decoding against a guessed
            // timebase would bake a wrong one into the item boundaries.
            sequence: StudioTimelineSequenceDecoder.sequence(
                fromTracks: trackPayload,
                timebase: StudioTimebase(timescale: 1000, frameDurationTicks: 1)!
            )
        )
    }

    /// Extracts a transcript from a studio/editCommitted whose op is
    /// set_transcript.
    static func transcript(in message: StudioMessage) -> StudioTranscript? {
        guard case .decoded(let transcript) = transcriptOutcome(in: message) else { return nil }
        return transcript
    }

    enum TranscriptOutcome {
        case decoded(StudioTranscript)
        /// The op WAS a set_transcript and failed to decode. Distinct from
        /// `notATranscript`, which is every other operation passing through.
        case rejected(String)
        case notATranscript
    }

    static func transcriptOutcome(in message: StudioMessage) -> TranscriptOutcome {
        guard let operation = message.params?["op"]?.value as? [String: Any] else {
            return .notATranscript
        }
        guard operation["type"] as? String == "set_transcript" else { return .notATranscript }
        do {
            return .decoded(
                try StudioTranscriptDecoder.transcript(fromSetTranscript: operation))
        } catch {
            return .rejected(String(describing: error))
        }
    }

    /// Extracts a ghost proposal from a studio/editCommitted whose op is
    /// propose_edit. Returns nil for every other operation, so open_media and
    /// insert_range commits sharing this notification pass through untouched.
    static func proposal(in message: StudioMessage) -> StudioEditProposal? {
        guard let operation = message.params?["op"]?.value as? [String: Any] else { return nil }
        return try? StudioProposalDecoder.proposal(fromProposeEdit: operation)
    }

    /// Extracts the id of a resolved proposal, accepted or rejected.
    static func resolvedProposalId(in message: StudioMessage) -> String? {
        guard let operation = message.params?["op"]?.value as? [String: Any],
            operation["type"] as? String == "resolve_proposal",
            let proposalId = operation["proposalId"] as? String
        else {
            return nil
        }
        return proposalId
    }

    static func openedAsset(in message: StudioMessage) -> StudioMediaAsset? {
        guard let operation = message.params?["op"]?.value as? [String: Any] else { return nil }
        return StudioMediaAsset.fromDocumentOperation(operation)
    }

    private static func encodeLine(_ object: [String: Any]) -> Data {
        var data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        data.append(0x0A)
        return data
    }
}
