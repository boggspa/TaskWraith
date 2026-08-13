import Foundation

/// Where a picture actually comes from at a given proposed position.
///
/// This is the whole substance of Current/Proposed A/B. An insert_range does not
/// overlay or replace — it RIPPLES: everything at or after the insertion point
/// moves right by the inserted span. So the same review position addresses
/// genuinely different media in the two versions, and saying which is the
/// difference between a real comparison and two labels on the same frame.
public enum StudioProposedSample: Equatable, Sendable {
    /// Comes from the existing timeline at these ticks.
    case existing(ticks: Int64)
    /// Comes from the proposal's source asset at these ticks.
    case inserted(assetId: String, ticks: Int64)

    public var ticks: Int64 {
        switch self {
        case .existing(let ticks): return ticks
        case .inserted(_, let ticks): return ticks
        }
    }
}

/// Which version of the sequence the review viewer is addressing.
public enum StudioReviewVersion: String, Equatable, Sendable, CaseIterable {
    case current
    case proposed

    public var toggled: StudioReviewVersion { self == .current ? .proposed : .current }
    public var label: String { self == .current ? "CURRENT" : "PROPOSED" }
}

/// The sequence as a single open proposal would leave it (mission outcome 3's
/// Current/Proposed, and the navigable half of outcome 6's ghosts).
///
/// SCOPE, STATED PLAINLY. This models ONE insert_range proposal against the
/// current sequence. Composing several open proposals is a different problem —
/// they interact, and their order matters — and inventing a composition rule
/// the host has not specified would be exactly the kind of guess this package
/// keeps refusing. Multiple ghosts still DRAW; only navigation is single.
public struct StudioProposedTimeline: Equatable, Sendable {
    public let proposalId: String
    public let assetId: String
    /// Insertion point in CURRENT-timeline ticks.
    public let insertionTicks: Int64
    /// Length of the inserted range.
    public let spanTicks: Int64
    /// Start of the range within the source asset.
    public let sourceInTicks: Int64

    public init?(proposal: StudioEditProposal, timebase: StudioTimebase) {
        let op = proposal.op
        let sourceIn = op.sourceIn.ticks(in: timebase)
        let sourceOut = op.sourceOut.ticks(in: timebase)
        let at = op.at.ticks(in: timebase)
        // sourceOut is EXCLUSIVE and must be strictly after sourceIn, matching
        // the host's own contract. A zero-length or inverted range is not a
        // proposal to render; it is a malformed one, and drawing a zero-width
        // ghost would hide that.
        guard sourceOut > sourceIn, at >= 0, sourceIn >= 0 else { return nil }
        self.proposalId = proposal.proposalId
        self.assetId = op.assetId
        self.insertionTicks = at
        self.spanTicks = sourceOut - sourceIn
        self.sourceInTicks = sourceIn
    }

    // MARK: - Mapping

    /// Where the picture at a PROPOSED position comes from.
    public func sample(atProposedTicks ticks: Int64) -> StudioProposedSample {
        if ticks < insertionTicks { return .existing(ticks: ticks) }
        let offset = ticks - insertionTicks
        if offset < spanTicks {
            return .inserted(assetId: assetId, ticks: sourceInTicks &+ offset)
        }
        // Past the insert: the existing timeline, shifted back by the span.
        return .existing(ticks: ticks - spanTicks)
    }

    /// CURRENT position to the PROPOSED position showing the same material.
    ///
    /// Material at the insertion point ripples right, so the boundary belongs to
    /// the material AFTER the insert — the same half-open convention the marks,
    /// the loop range and the host's insert_range all use.
    public func proposedTicks(forCurrentTicks ticks: Int64) -> Int64 {
        ticks < insertionTicks ? ticks : ticks &+ spanTicks
    }

    /// PROPOSED position to the CURRENT position showing the same material, or
    /// nil INSIDE the inserted span — that material does not exist in the
    /// current sequence at all, and returning a nearby frame would be a quiet
    /// lie about what the comparison shows.
    public func currentTicks(forProposedTicks ticks: Int64) -> Int64? {
        if ticks < insertionTicks { return ticks }
        let offset = ticks - insertionTicks
        if offset < spanTicks { return nil }
        return ticks - spanTicks
    }

    public func durationTicks(currentDuration: Int64) -> Int64 {
        max(0, currentDuration) &+ spanTicks
    }

    // MARK: - Review ranges

    /// The affected range in PROPOSED time: exactly the inserted material.
    public var affectedRange: StudioLoopRange? {
        StudioLoopRange(startTicks: insertionTicks, endTicks: insertionTicks &+ spanTicks)
    }

    /// Default roll: ONE SECOND of the sequence, derived from the timebase
    /// rather than assumed, so a 25fps sequence rolls 25 frames and a 30000/1001
    /// sequence rolls 30. A fixed tick count would roll a different duration on
    /// every asset.
    public static func defaultRollTicks(timebase: StudioTimebase) -> Int64 {
        max(timebase.frameDurationTicks, Int64(timebase.timescale))
    }

    /// The affected range with pre- and post-roll (mission outcome 3).
    ///
    /// Roll exists so a reviewer hears and sees the CUT rather than the clip:
    /// looping the inserted span alone shows the new material perfectly and
    /// tells you nothing about whether it joins. Pre-roll is clamped at zero
    /// rather than going negative, and the clamp is what keeps an insert near
    /// the head of the sequence from producing an invalid range.
    public func reviewRange(
        preRollTicks: Int64,
        postRollTicks: Int64,
        currentDurationTicks: Int64? = nil
    ) -> StudioLoopRange? {
        let start = max(0, insertionTicks - max(0, preRollTicks))
        var end = insertionTicks &+ spanTicks &+ max(0, postRollTicks)
        if let currentDurationTicks, currentDurationTicks > 0 {
            end = min(end, durationTicks(currentDuration: currentDurationTicks))
        }
        return StudioLoopRange(startTicks: start, endTicks: end)
    }

    /// Ghost geometry for the overlay, expressed in the coordinates of whichever
    /// version is being displayed.
    ///
    /// In CURRENT the insert has no width — it is a point where material will
    /// arrive — so it draws as a caret. In PROPOSED it occupies real time and
    /// draws as a band. Drawing a band in current view would claim the sequence
    /// already contains material it does not.
    public func ghost(in version: StudioReviewVersion) -> StudioGhostGeometry {
        switch version {
        case .current:
            return StudioGhostGeometry(
                proposalId: proposalId,
                startTicks: insertionTicks,
                endTicks: insertionTicks,
                isInsertionPoint: true
            )
        case .proposed:
            return StudioGhostGeometry(
                proposalId: proposalId,
                startTicks: insertionTicks,
                endTicks: insertionTicks &+ spanTicks,
                isInsertionPoint: false
            )
        }
    }
}

public struct StudioGhostGeometry: Equatable, Sendable {
    public let proposalId: String
    public let startTicks: Int64
    public let endTicks: Int64
    /// True when the ghost has no duration in this version and must draw as a
    /// caret rather than a band.
    public let isInsertionPoint: Bool

    public init(proposalId: String, startTicks: Int64, endTicks: Int64, isInsertionPoint: Bool) {
        self.proposalId = proposalId
        self.startTicks = startTicks
        self.endTicks = endTicks
        self.isInsertionPoint = isInsertionPoint
    }
}
