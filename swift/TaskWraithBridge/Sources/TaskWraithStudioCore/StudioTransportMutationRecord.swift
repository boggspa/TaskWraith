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
    case scrubBegin
    case scrubMove
    case scrubEnd
    case timecodeSeek
    case markOrLoop
    /// Not an operator action: the oscillator changed and the clock was
    /// re-anchored from the old source into the new one.
    case oscillatorReconciliation
}

/// Which clock supplied the host seconds.
public enum StudioTransportHostSource: String, Equatable, Sendable {
    /// Audio-relative, starting near zero while sound drives playback.
    case audio
    /// CACurrentMediaTime — machine uptime, order 1e5 seconds.
    case machine
}

/// The last thing that moved the transport, kept whole.
///
/// WHY THE ANCHOR OPERANDS ARE HERE. A record carrying only a before/after
/// position cannot distinguish a mutation that CAUSED a clamp from one that
/// merely observed a playhead already sitting at duration. The anchor is what
/// separates them: position is recomputed from `anchorTicks` at
/// `anchorHostSeconds`, so a wrong-domain host shows up as an anchor whose host
/// is ~1e5 seconds away from the one supplied.
///
/// ONE record, overwritten on mutation only — never per display tick. A
/// diagnostic that grows per frame is a worse defect than the one it explains.
public struct StudioTransportMutationRecord: Equatable, Sendable {
    public let kind: StudioTransportMutationKind
    public let source: StudioTransportHostSource
    /// The host handed to the mutation.
    public let suppliedHostSeconds: Double
    /// For an oscillator swap, the host read under the OLD source. Nil
    /// elsewhere — absence means "not a source change", never "zero".
    public let previousHostSeconds: Double?

    public let beforeAnchorTicks: Int64
    public let beforeAnchorHostSeconds: Double
    public let beforePositionTicks: Int64

    public let afterAnchorTicks: Int64
    public let afterAnchorHostSeconds: Double
    public let afterPositionTicks: Int64

    public let durationTicks: Int64
    public let isPlaying: Bool
    public let rate: Double

    public init(
        kind: StudioTransportMutationKind,
        source: StudioTransportHostSource,
        suppliedHostSeconds: Double,
        previousHostSeconds: Double? = nil,
        beforeAnchorTicks: Int64,
        beforeAnchorHostSeconds: Double,
        beforePositionTicks: Int64,
        afterAnchorTicks: Int64,
        afterAnchorHostSeconds: Double,
        afterPositionTicks: Int64,
        durationTicks: Int64,
        isPlaying: Bool,
        rate: Double
    ) {
        self.kind = kind
        self.source = source
        self.suppliedHostSeconds = suppliedHostSeconds
        self.previousHostSeconds = previousHostSeconds
        self.beforeAnchorTicks = beforeAnchorTicks
        self.beforeAnchorHostSeconds = beforeAnchorHostSeconds
        self.beforePositionTicks = beforePositionTicks
        self.afterAnchorTicks = afterAnchorTicks
        self.afterAnchorHostSeconds = afterAnchorHostSeconds
        self.afterPositionTicks = afterPositionTicks
        self.durationTicks = durationTicks
        self.isPlaying = isPlaying
        self.rate = rate
    }

    /// True when the supplied host is implausibly far from the anchor it was
    /// measured against — the signature of a machine-uptime host handed to an
    /// audio-anchored clock.
    public var suppliedHostIsFarFromAnchor: Bool {
        abs(suppliedHostSeconds - beforeAnchorHostSeconds) > 3600
    }

    /// True when this mutation is what put the playhead on the duration bound.
    /// A playhead already parked there is NOT attributed to this mutation.
    public var clampedToDuration: Bool {
        durationTicks > 0 && afterPositionTicks >= durationTicks
            && beforePositionTicks < durationTicks
    }

    /// One machine-parseable line. `tm1` is a schema version so a packaged
    /// parser fails closed rather than mis-keying a later format; absent values
    /// serialise as `-`, never `0`.
    public var diagnosticsExportText: String {
        let previous = previousHostSeconds.map { String(format: "%.6f", $0) } ?? "-"
        return "tm1 kind=\(kind.rawValue) src=\(source.rawValue)"
            + " host=\(String(format: "%.6f", suppliedHostSeconds)) prevHost=\(previous)"
            + " preAnchorT=\(beforeAnchorTicks)"
            + " preAnchorH=\(String(format: "%.6f", beforeAnchorHostSeconds))"
            + " prePos=\(beforePositionTicks)"
            + " postAnchorT=\(afterAnchorTicks)"
            + " postAnchorH=\(String(format: "%.6f", afterAnchorHostSeconds))"
            + " postPos=\(afterPositionTicks)"
            + " dur=\(durationTicks) play=\(isPlaying ? 1 : 0)"
            + " rate=\(String(format: "%.3f", rate))"
            + " farAnchor=\(suppliedHostIsFarFromAnchor ? 1 : 0)"
            + " clamped=\(clampedToDuration ? 1 : 0)"
    }
}
