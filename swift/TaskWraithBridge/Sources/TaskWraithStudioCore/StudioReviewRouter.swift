import Foundation

/// Where the picture for a review position must come from (mission outcome 3).
///
/// This is the last hop that turns Current/Proposed from geometry into two real
/// pictures. StudioProposedTimeline already answers "what material belongs at
/// this proposed position"; this answers the operational half — WHICH SOURCE to
/// decode from — and, critically, admits when there is no answer.
public enum StudioReviewFrameRequest: Equatable, Sendable {
    /// Draw from the primary source at these ticks.
    case current(ticks: Int64)
    /// Draw from the proposal's own source at these SOURCE ticks.
    case proposed(assetId: String, ticks: Int64)
    /// The proposed sequence calls for material we have no source for.
    ///
    /// NOT a failure to paper over. An insert may reference an asset the viewer
    /// has never opened, and the only honest picture for "material you do not
    /// have" is no picture. Substituting the nearest available frame would make
    /// the A/B show a comparison that does not exist — the same lie
    /// currentTicks(forProposedTicks:) already refuses to tell by returning nil
    /// inside the insert.
    case unavailable(assetId: String)
}

/// Everything the renderer needs to answer "which version am I showing".
public struct StudioReviewContext: Equatable, Sendable {
    public let version: StudioReviewVersion
    public let timeline: StudioProposedTimeline?
    /// The VIEWER's timebase — the one `timeline` was built in.
    public let timebase: StudioTimebase

    public init(
        version: StudioReviewVersion,
        timeline: StudioProposedTimeline?,
        timebase: StudioTimebase
    ) {
        self.version = version
        self.timeline = timeline
        self.timebase = timebase
    }
}

public enum StudioReviewRouter {
    /// Converts a tick count between timebases, exactly.
    ///
    /// LOAD-BEARING FOR REVIEW, and easy to miss: the inserted material can come
    /// from an asset running at a DIFFERENT frame rate than the sequence, so
    /// indexing it with sequence ticks lands on the wrong picture. The proposed
    /// timeline speaks the viewer's timebase; the proposed SOURCE speaks its
    /// own.
    public static func convert(
        ticks: Int64,
        from source: StudioTimebase,
        to destination: StudioTimebase
    ) -> Int64 {
        let fromScale = Int64(source.timescale)
        let toScale = Int64(destination.timescale)
        guard fromScale > 0, toScale > 0 else { return ticks }
        if fromScale == toScale { return ticks }
        let divisor = StudioRationalTime.greatestCommonDivisor(fromScale, toScale)
        let numerator = toScale / divisor
        let denominator = fromScale / divisor
        let scaled = ticks.multipliedReportingOverflow(by: numerator)
        guard !scaled.overflow else {
            return Int64(
                (Double(ticks) * Double(numerator) / Double(denominator))
                    .rounded(.toNearestOrAwayFromZero)
            )
        }
        let value = scaled.partialValue
        if value >= 0 { return (value &+ denominator / 2) / denominator }
        return -((-value &+ denominator / 2) / denominator)
    }

    /// Resolves a review position to a source and an offset.
    ///
    /// - Parameter availableProposedAssetId: the asset the viewer currently has
    ///   a second source attached for, if any. Matching is by IDENTITY, not by
    ///   assuming the insert refers to the open clip: a proposal routinely
    ///   inserts material from a DIFFERENT asset, and quietly decoding the wrong
    ///   file would look like working playback.
    public static func request(
        atTicks ticks: Int64,
        version: StudioReviewVersion,
        timeline: StudioProposedTimeline?,
        availableProposedAssetId: String?
    ) -> StudioReviewFrameRequest {
        // No open proposal, or the operator is looking at the sequence as it
        // stands: the current timeline is the whole answer.
        guard version == .proposed, let timeline else { return .current(ticks: ticks) }

        switch timeline.sample(atProposedTicks: ticks) {
        case .existing(let currentTicks):
            return .current(ticks: currentTicks)
        case .inserted(let assetId, let sourceTicks):
            guard assetId == availableProposedAssetId else {
                return .unavailable(assetId: assetId)
            }
            return .proposed(assetId: assetId, ticks: sourceTicks)
        }
    }

    /// True when the two versions would show DIFFERENT material at `ticks`.
    ///
    /// Useful to a reviewer and to a test: outside the affected range an A/B is
    /// a comparison of a frame with itself, and a Review viewer that claims a
    /// difference there is lying. Toggling should be visibly inert until the
    /// playhead reaches material the proposal actually changes.
    public static func versionsDiffer(atTicks ticks: Int64, timeline: StudioProposedTimeline?)
        -> Bool
    {
        guard let timeline else { return false }
        return timeline.currentTicks(forProposedTicks: ticks) == nil
    }
}
