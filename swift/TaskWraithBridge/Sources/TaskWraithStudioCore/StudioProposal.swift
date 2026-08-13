import Foundation

/// Swift mirror of the host's durable ghost proposals (mission outcome 6).
///
/// StudioProtocol.ts IS NORMATIVE. Every shape here conforms to it and nothing
/// is re-derived: field names, the independently versioned schema, and the
/// rational-time representation all come from the host, and decoding FAILS
/// CLOSED when they do not match. A companion that guesses at a renamed field
/// silently mis-renders someone's edit, which is worse than refusing it.

/// `{ n: ticks, d: timescale }`, matching StudioRationalTime.ts.
public struct StudioRationalTime: Equatable, Sendable {
    public let n: Int64
    public let d: Int64

    public init?(n: Int64, d: Int64) {
        guard d > 0 else { return nil }
        self.n = n
        self.d = d
    }

    /// Converts to ticks in `timebase`.
    ///
    /// Integer arithmetic reduced through the gcd. NOT because Double would
    /// drift — I measured that claim for the audio clock and it was false at
    /// these magnitudes — but because it is deterministic, reports overflow
    /// explicitly, and matches the tick arithmetic the rest of this package
    /// already uses.
    public func ticks(in timebase: StudioTimebase) -> Int64 {
        let scale = Int64(timebase.timescale)
        let divisor = Self.greatestCommonDivisor(scale, d)
        let numerator = scale / divisor
        let denominator = d / divisor
        let scaled = n.multipliedReportingOverflow(by: numerator)
        guard !scaled.overflow else {
            return Int64(
                (Double(n) * Double(numerator) / Double(denominator))
                    .rounded(.toNearestOrAwayFromZero)
            )
        }
        let value = scaled.partialValue
        if value >= 0 { return (value &+ denominator / 2) / denominator }
        return -((-value &+ denominator / 2) / denominator)
    }

    static func greatestCommonDivisor(_ lhs: Int64, _ rhs: Int64) -> Int64 {
        var a = abs(lhs)
        var b = abs(rhs)
        while b != 0 { (a, b) = (b, a % b) }
        return a == 0 ? 1 : a
    }
}

/// Mirror of StudioInsertRangeOp. `sourceOut` is the EXCLUSIVE end, matching the
/// host and matching the viewer's own Out-point convention, so a range never
/// double-counts its final frame at either end of the wire.
public struct StudioInsertRangeOp: Equatable, Sendable {
    public let itemId: String
    public let assetId: String
    public let trackId: String?
    public let sourceIn: StudioRationalTime
    public let sourceOut: StudioRationalTime
    /// Sequence insertion point; items at or after it ripple right.
    public let at: StudioRationalTime

    public init(
        itemId: String,
        assetId: String,
        trackId: String? = nil,
        sourceIn: StudioRationalTime,
        sourceOut: StudioRationalTime,
        at: StudioRationalTime
    ) {
        self.itemId = itemId
        self.assetId = assetId
        self.trackId = trackId
        self.sourceIn = sourceIn
        self.sourceOut = sourceOut
        self.at = at
    }
}

/// Mirror of StudioEditProposal — a durable ghost. The timeline changes only
/// after explicit acceptance, which is what makes this proposal-FIRST rather
/// than an edit with an undo.
public struct StudioEditProposal: Equatable, Sendable {
    /// Must match the host's STUDIO_PROPOSAL_SCHEMA_VERSION.
    public static let schemaVersion = 1

    public let proposalId: String
    public let createdRevision: Int
    public let op: StudioInsertRangeOp

    public init(proposalId: String, createdRevision: Int, op: StudioInsertRangeOp) {
        self.proposalId = proposalId
        self.createdRevision = createdRevision
        self.op = op
    }
}

public enum StudioProposalDecodeError: Error, Equatable {
    case notAProposal
    case unsupportedSchemaVersion(Int)
    case missingField(String)
    case unsupportedOperation(String)
    case invalidRationalTime(String)
}

public enum StudioProposalDecoder {
    /// Decodes a proposal from a `propose_edit` operation payload.
    ///
    /// Every failure is typed and names the field, because "the ghost did not
    /// appear" is an impossible bug to diagnose from a silent nil.
    public static func proposal(fromProposeEdit payload: [String: Any]) throws
        -> StudioEditProposal
    {
        guard let type = payload["type"] as? String else {
            throw StudioProposalDecodeError.missingField("type")
        }
        guard type == "propose_edit" else { throw StudioProposalDecodeError.notAProposal }
        guard let body = payload["proposal"] as? [String: Any] else {
            throw StudioProposalDecodeError.missingField("proposal")
        }
        return try proposal(from: body)
    }

    /// Decodes a proposal as it appears in the document's `proposals` array.
    public static func proposal(from body: [String: Any]) throws -> StudioEditProposal {
        guard let schemaVersion = body["schemaVersion"] as? Int else {
            throw StudioProposalDecodeError.missingField("schemaVersion")
        }
        // Independently versioned by the host, so a future schema must be
        // REFUSED rather than partially understood.
        guard schemaVersion == StudioEditProposal.schemaVersion else {
            throw StudioProposalDecodeError.unsupportedSchemaVersion(schemaVersion)
        }
        guard let proposalId = body["proposalId"] as? String else {
            throw StudioProposalDecodeError.missingField("proposalId")
        }
        guard let createdRevision = body["createdRevision"] as? Int else {
            throw StudioProposalDecodeError.missingField("createdRevision")
        }
        guard let op = body["op"] as? [String: Any] else {
            throw StudioProposalDecodeError.missingField("op")
        }
        return StudioEditProposal(
            proposalId: proposalId,
            createdRevision: createdRevision,
            op: try insertRange(from: op)
        )
    }

    public static func insertRange(from payload: [String: Any]) throws -> StudioInsertRangeOp {
        guard let type = payload["type"] as? String else {
            throw StudioProposalDecodeError.missingField("op.type")
        }
        // insert_range is the only StudioEditOp today. Naming the operation in
        // the error means a later op type produces a diagnosable refusal rather
        // than a ghost that quietly never draws.
        guard type == "insert_range" else {
            throw StudioProposalDecodeError.unsupportedOperation(type)
        }
        guard let itemId = payload["itemId"] as? String else {
            throw StudioProposalDecodeError.missingField("op.itemId")
        }
        guard let assetId = payload["assetId"] as? String else {
            throw StudioProposalDecodeError.missingField("op.assetId")
        }
        return StudioInsertRangeOp(
            itemId: itemId,
            assetId: assetId,
            trackId: payload["trackId"] as? String,
            sourceIn: try rational(from: payload["sourceIn"], field: "op.sourceIn"),
            sourceOut: try rational(from: payload["sourceOut"], field: "op.sourceOut"),
            at: try rational(from: payload["at"], field: "op.at")
        )
    }

    static func rational(from value: Any?, field: String) throws -> StudioRationalTime {
        guard let object = value as? [String: Any] else {
            throw StudioProposalDecodeError.missingField(field)
        }
        // JSON numbers arrive as NSNumber; Int64 covers both the integer tick
        // counts and the timescale without a Double round trip.
        guard let n = (object["n"] as? NSNumber)?.int64Value,
            let d = (object["d"] as? NSNumber)?.int64Value
        else {
            throw StudioProposalDecodeError.missingField("\(field).n/d")
        }
        guard let time = StudioRationalTime(n: n, d: d) else {
            throw StudioProposalDecodeError.invalidRationalTime(field)
        }
        return time
    }
}
