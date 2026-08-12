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
/// - Open-proposal replay is EXPLICITLY UNIMPLEMENTED in v1: durable proposal
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
    public struct Step {
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

        public init(
            outboundLines: [Data],
            exitCode: Int32?,
            protocolErrors: [String],
            openedAssets: [StudioMediaAsset] = []
        ) {
            self.outboundLines = outboundLines
            self.exitCode = exitCode
            self.protocolErrors = protocolErrors
            self.openedAssets = openedAssets
        }
    }

    public static let protocolVersion = 1
    public static let helloRequestId = 1
    public static let getDocumentRequestId = 2

    public private(set) var phase: Phase = .awaitingHelloResponse
    public private(set) var documentRevision: Int?
    public private(set) var editCommittedCount = 0
    /// open_media operations recognised on studio/editCommitted.
    public private(set) var openedAssetCount = 0
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
                exitCode = outcome.exit
            }
        }
        return Step(
            outboundLines: outbound,
            exitCode: exitCode,
            protocolErrors: errors,
            openedAssets: opened
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
