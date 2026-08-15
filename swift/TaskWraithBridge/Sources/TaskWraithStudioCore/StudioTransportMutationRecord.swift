import Foundation

/// What moved the transport. A finite set on purpose: a caller-supplied string
/// (`#function`, a description) is unbounded, drifts silently with refactors,
/// and cannot be matched exactly by a packaged parser.
public enum StudioTransportMutationKind: String, Equatable, Sendable {
    /// The view was attached to a window and started the transport.
    case lifecycleAttach
    /// Media was opened/adopted.
    case lifecycleOpen
    case playbackToggleKey
    case playbackToggleAccessibility
    case playheadAccessibilitySet
    case playheadAccessibilityStep
    case frameStepKey
    case transcriptCueSeek
    case scrubBegin
    case scrubMove
    case scrubEnd
    case timecodeSeek
    case markOrLoop
    /// The oscillator CHANGED and the clock was re-anchored from the old source
    /// into the new one.
    case oscillatorReconciliation
    /// The audio timeline was reset and the transport re-seeked to follow it.
    /// Distinct from `oscillatorReconciliation` because no source PRESENCE
    /// changed, and distinct from `lifecycleOpen` because no media changed —
    /// conflating them would hide which of the three actually moved a playhead.
    case audioReschedule
}

/// Which clock supplied the host seconds.
public enum StudioTransportHostSource: String, Equatable, Sendable {
    /// Audio-relative, measured from the audio clock's own anchor.
    case audio
    /// CACurrentMediaTime — machine uptime.
    case machine
}

/// The last thing that moved the transport, kept whole.
///
/// WHY THE ANCHOR OPERANDS ARE HERE, AND WHY POSITIONS ARE NOT ENOUGH. Position
/// is recomputed as `anchorTicks + (host - anchorHostSeconds) * rate`, so a
/// position READ at a wrong-domain host already resolves to duration before the
/// mutation runs. A predicate comparing pre/post positions therefore reports
/// "not caused here" for the exact case it exists to catch. The anchor is what
/// the mutation PERSISTS, so the causal transition is an anchor transition.
///
/// ONE record, overwritten on mutation only — never per display tick. A
/// diagnostic that grows per frame is a worse defect than the one it explains.
public struct StudioTransportMutationRecord: Equatable, Sendable {
    public let kind: StudioTransportMutationKind
    /// The view that initiated the mutation. The controller is shared, so this
    /// must be explicit rather than inferred from whichever AX tree reads it.
    public let route: StudioViewerRoute
    /// Source identity before and after. This — not a magnitude threshold — is
    /// what identifies a domain change: a machine host is machine-domain on a
    /// freshly booted machine too, where its value is small.
    public let beforeSource: StudioTransportHostSource
    public let afterSource: StudioTransportHostSource
    /// The host handed to the mutation.
    public let suppliedHostSeconds: Double
    /// The host read under the OLD source when the source changed. Nil
    /// otherwise — absence means "no source change", never "zero".
    public let previousHostSeconds: Double?

    public let beforeAnchorTicks: Int64
    public let beforeAnchorHostSeconds: Double
    public let beforePositionTicks: Int64
    public let beforeDurationTicks: Int64
    public let beforeIsPlaying: Bool
    public let beforeRate: Double

    public let afterAnchorTicks: Int64
    public let afterAnchorHostSeconds: Double
    public let afterPositionTicks: Int64
    public let afterDurationTicks: Int64
    public let afterIsPlaying: Bool
    public let afterRate: Double

    public init(
        kind: StudioTransportMutationKind,
        route: StudioViewerRoute,
        beforeSource: StudioTransportHostSource,
        afterSource: StudioTransportHostSource,
        suppliedHostSeconds: Double,
        previousHostSeconds: Double? = nil,
        beforeAnchorTicks: Int64,
        beforeAnchorHostSeconds: Double,
        beforePositionTicks: Int64,
        beforeDurationTicks: Int64,
        beforeIsPlaying: Bool,
        beforeRate: Double,
        afterAnchorTicks: Int64,
        afterAnchorHostSeconds: Double,
        afterPositionTicks: Int64,
        afterDurationTicks: Int64,
        afterIsPlaying: Bool,
        afterRate: Double
    ) {
        self.kind = kind
        self.route = route
        self.beforeSource = beforeSource
        self.afterSource = afterSource
        self.suppliedHostSeconds = suppliedHostSeconds
        self.previousHostSeconds = previousHostSeconds
        self.beforeAnchorTicks = beforeAnchorTicks
        self.beforeAnchorHostSeconds = beforeAnchorHostSeconds
        self.beforePositionTicks = beforePositionTicks
        self.beforeDurationTicks = beforeDurationTicks
        self.beforeIsPlaying = beforeIsPlaying
        self.beforeRate = beforeRate
        self.afterAnchorTicks = afterAnchorTicks
        self.afterAnchorHostSeconds = afterAnchorHostSeconds
        self.afterPositionTicks = afterPositionTicks
        self.afterDurationTicks = afterDurationTicks
        self.afterIsPlaying = afterIsPlaying
        self.afterRate = afterRate
    }

    /// True when THIS mutation persisted the playhead onto the duration bound.
    ///
    /// Reads the ANCHOR, not the resolved position. A wrong-domain host makes
    /// the pre-mutation position read already equal duration, so a position
    /// comparison would answer "no" precisely when the answer is "yes".
    public var clampedToDuration: Bool {
        afterDurationTicks > 0
            && beforeAnchorTicks < afterDurationTicks
            && afterAnchorTicks >= afterDurationTicks
    }

    /// True when the host domain changed across this mutation. Source identity,
    /// not a magnitude heuristic.
    public var crossedHostDomain: Bool { beforeSource != afterSource }

    /// One machine-parseable line. `tm1` is a schema version so a packaged
    /// parser fails closed rather than mis-keying a later format; absent values
    /// serialise as `-`, never `0`.
    public var diagnosticsExportText: String {
        let previous = previousHostSeconds.map { String(format: "%.6f", $0) } ?? "-"
        return "tm1 kind=\(kind.rawValue)"
            + " route=\(route.rawValue)"
            + " preSrc=\(beforeSource.rawValue) postSrc=\(afterSource.rawValue)"
            + " host=\(String(format: "%.6f", suppliedHostSeconds)) prevHost=\(previous)"
            + " preAnchorT=\(beforeAnchorTicks)"
            + " preAnchorH=\(String(format: "%.6f", beforeAnchorHostSeconds))"
            + " prePos=\(beforePositionTicks) preDur=\(beforeDurationTicks)"
            + " prePlay=\(beforeIsPlaying ? 1 : 0)"
            + " preRate=\(String(format: "%.3f", beforeRate))"
            + " postAnchorT=\(afterAnchorTicks)"
            + " postAnchorH=\(String(format: "%.6f", afterAnchorHostSeconds))"
            + " postPos=\(afterPositionTicks) postDur=\(afterDurationTicks)"
            + " postPlay=\(afterIsPlaying ? 1 : 0)"
            + " postRate=\(String(format: "%.3f", afterRate))"
            + " crossedDomain=\(crossedHostDomain ? 1 : 0)"
            + " clamped=\(clampedToDuration ? 1 : 0)"
    }
}
