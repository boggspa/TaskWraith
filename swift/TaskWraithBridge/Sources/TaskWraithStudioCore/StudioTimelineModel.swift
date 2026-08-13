import Foundation

/// The visible timeline band: transcript segments, ghost proposals and trim
/// handles (mission outcome 6's surface).
///
/// THIS TYPE HOLDS NO CLOCK, AND THAT IS THE POINT. Position arrives as an input
/// tick count taken from the one StudioPlaybackClock the transport already
/// reads. A timeline that derived its own position would be a second authority
/// agreeing with the first by luck — the failure this package has now refused
/// three times (the audio clock, the three command queues, the drift metric).
/// StudioTimelineLayout is a caseless enum precisely so there is nowhere for a
/// second clock to live.
///
/// It also draws through the EXISTING overlay primitives rather than a second
/// renderer, for the same reason: two renderers is two things to keep in step.

public enum StudioTrimHandle: String, Equatable, Sendable {
    case start
    case end
}

/// What a completed trim drag WOULD propose.
///
/// PROPOSAL-FIRST, NOT A MUTATION. The host owns durable state and has a
/// versioned studio/proposeEdit with stale-base CAS; a handle drag therefore
/// produces this INTENT and nothing else. If the drag mutated a local document
/// it would bypass the entire ghost/approve flow — and the drag is the only
/// gesture that would ever exercise it, so bypassing it there means the flow is
/// never used at all.
public struct StudioTrimIntent: Equatable, Sendable {
    public let segmentId: String
    public let assetId: String
    public let handle: StudioTrimHandle
    /// Half-open, matching every other range in this package.
    public let sourceInTicks: Int64
    public let sourceOutTicks: Int64
    public let atTicks: Int64
    /// Whether the final position landed on a transcript boundary.
    public let snapped: Bool

    public init(
        segmentId: String,
        assetId: String,
        handle: StudioTrimHandle,
        sourceInTicks: Int64,
        sourceOutTicks: Int64,
        atTicks: Int64,
        snapped: Bool
    ) {
        self.segmentId = segmentId
        self.assetId = assetId
        self.handle = handle
        self.sourceInTicks = sourceInTicks
        self.sourceOutTicks = sourceOutTicks
        self.atTicks = atTicks
        self.snapped = snapped
    }
}

/// A trim gesture in progress.
public struct StudioTrimDrag: Equatable, Sendable {
    public let segmentId: String
    public let assetId: String
    public let handle: StudioTrimHandle
    public let originalStartTicks: Int64
    public let originalEndTicks: Int64
    public private(set) var currentTicks: Int64
    public private(set) var didSnap = false

    public init(
        segmentId: String,
        assetId: String,
        handle: StudioTrimHandle,
        originalStartTicks: Int64,
        originalEndTicks: Int64
    ) {
        self.segmentId = segmentId
        self.assetId = assetId
        self.handle = handle
        self.originalStartTicks = originalStartTicks
        self.originalEndTicks = originalEndTicks
        self.currentTicks = handle == .start ? originalStartTicks : originalEndTicks
    }

    /// Moves the dragged edge, snapping through THE EXISTING SNAPPER.
    ///
    /// StudioTranscriptSnapper, not a second implementation inside the drag
    /// handler. A duplicate would silently diverge, and the drag copy would win
    /// because it is the one an operator actually feels.
    public mutating func update(
        toTicks ticks: Int64,
        boundaries: [Int64],
        toleranceTicks: Int64
    ) {
        let result = StudioTranscriptSnapper.snap(
            ticks: ticks,
            toBoundaries: boundaries,
            toleranceTicks: toleranceTicks
        )
        currentTicks = max(0, result.ticks)
        didSnap = result.didSnap
    }

    /// The resulting range, or nil when the drag has collapsed it.
    ///
    /// A zero-length or inverted range is not an edit; refusing it here is the
    /// same rule the In/Out marks and the proposed timeline already apply.
    public var intent: StudioTrimIntent? {
        let start = handle == .start ? currentTicks : originalStartTicks
        let end = handle == .end ? currentTicks : originalEndTicks
        guard end > start else { return nil }
        return StudioTrimIntent(
            segmentId: segmentId,
            assetId: assetId,
            handle: handle,
            sourceInTicks: start,
            sourceOutTicks: end,
            // Insertion point is the segment's original start: a trim proposes
            // replacing that span, so it lands where the material already sits.
            atTicks: originalStartTicks,
            snapped: didSnap
        )
    }
}

public struct StudioTimelineHitBox: Equatable, Sendable {
    public let segmentId: String
    public let handle: StudioTrimHandle?
    public let frame: StudioOverlayFrame

    public init(segmentId: String, handle: StudioTrimHandle?, frame: StudioOverlayFrame) {
        self.segmentId = segmentId
        self.handle = handle
        self.frame = frame
    }
}

public struct StudioTimelineModel: Equatable, Sendable {
    public let rects: [StudioOverlayRect]
    public let texts: [StudioOverlayText]
    public let bandFrame: StudioOverlayFrame
    /// Segment bodies, for selection.
    public let segmentHits: [StudioTimelineHitBox]
    /// Trim handles. Deliberately WIDER than the drawn handle — see the note in
    /// StudioTimelineLayout.
    public let handleHits: [StudioTimelineHitBox]
    public let isVisible: Bool
    /// One descriptor per segment plus one per handle. The band is the only way
    /// to reach a transcript selection with the keyboard, so it cannot be
    /// decorative-only.
    public var accessibilityElements: [StudioAccessibilityDescriptor] = []

    public static let empty = StudioTimelineModel(
        rects: [],
        texts: [],
        bandFrame: StudioOverlayFrame(x: 0, y: 0, width: 0, height: 0),
        segmentHits: [],
        handleHits: [],
        isVisible: false,
        accessibilityElements: []
    )
}

public struct StudioTimelineState: Equatable, Sendable {
    public var viewport: StudioOverlayViewport
    /// From the ONE playback clock. Never derived here.
    public var positionTicks: Int64
    public var durationTicks: Int64
    public var transcript: StudioTranscript?
    public var timebase: StudioTimebase
    public var selectedSegmentId: String?
    public var trim: StudioTrimDrag?
    public var ghosts: [StudioGhostGeometry] = []

    public init(
        viewport: StudioOverlayViewport,
        positionTicks: Int64,
        durationTicks: Int64,
        timebase: StudioTimebase,
        transcript: StudioTranscript? = nil,
        selectedSegmentId: String? = nil,
        trim: StudioTrimDrag? = nil,
        ghosts: [StudioGhostGeometry] = []
    ) {
        self.viewport = viewport
        self.positionTicks = positionTicks
        self.durationTicks = durationTicks
        self.timebase = timebase
        self.transcript = transcript
        self.selectedSegmentId = selectedSegmentId
        self.trim = trim
        self.ghosts = ghosts
    }
}

public enum StudioTimelineMetrics {
    /// The band sits above the HUD strip.
    public static let bandHeight: Double = 34
    public static let bandBottomInset: Double = 84
    public static let horizontalMargin: Double = 18
    public static let segmentHeight: Double = 18
    /// Drawn width of a trim handle.
    public static let handleWidth: Double = 3
    /// GRAB width. Wider than the visual on purpose: a 3pt target is not
    /// clickable, and the pattern is already established by the scrub bar's
    /// 22pt grab area over a 5pt track.
    public static let handleGrabWidth: Double = 18
    public static let labelSize: Double = 11
}

public enum StudioTimelineLayout {
    public static func build(_ state: StudioTimelineState) -> StudioTimelineModel {
        let scale = state.viewport.scale
        let metric = { (points: Double) in points * scale }
        let width = state.viewport.width
        let height = state.viewport.height
        let margin = metric(StudioTimelineMetrics.horizontalMargin)
        let trackWidth = width - margin * 2
        let bandHeight = metric(StudioTimelineMetrics.bandHeight)
        let bandY = height - metric(StudioTimelineMetrics.bandBottomInset) - bandHeight

        guard width > 0, height > 0, trackWidth > metric(24), bandY > 0 else {
            return .empty
        }

        let bandFrame = StudioOverlayFrame(
            x: margin,
            y: bandY,
            width: trackWidth,
            height: bandHeight
        )
        var rects: [StudioOverlayRect] = [
            StudioOverlayRect(frame: bandFrame, color: .scrim)
        ]
        var texts: [StudioOverlayText] = []
        var segmentHits: [StudioTimelineHitBox] = []
        var handleHits: [StudioTimelineHitBox] = []
        var accessibility: [StudioAccessibilityDescriptor] = []

        // Position mapping REUSES the overlay's, so the timeline and the scrub
        // bar cannot disagree about where a tick sits.
        let xForTicks = { (ticks: Int64) -> Double in
            bandFrame.x
                + bandFrame.width
                * StudioOverlayLayout.playheadFraction(
                    positionTicks: ticks,
                    durationTicks: state.durationTicks
                )
        }

        let segmentY = bandY + (bandHeight - metric(StudioTimelineMetrics.segmentHeight)) / 2
        let segmentHeight = metric(StudioTimelineMetrics.segmentHeight)

        for segment in state.transcript?.segments ?? [] {
            guard let range = segment.range(in: state.timebase) else { continue }
            let startX = xForTicks(range.startTicks)
            let endX = xForTicks(range.endTicks)
            let frame = StudioOverlayFrame(
                x: startX,
                y: segmentY,
                width: max(endX - startX, metric(2)),
                height: segmentHeight
            )
            let isSelected = segment.segmentId == state.selectedSegmentId
            rects.append(
                StudioOverlayRect(frame: frame, color: isSelected ? .mark : .track)
            )
            segmentHits.append(
                StudioTimelineHitBox(segmentId: segment.segmentId, handle: nil, frame: frame)
            )
            accessibility.append(
                StudioAccessibilityDescriptor(
                    role: .button,
                    // The spoken words ARE the identity of a segment; selection
                    // is the volatile part, so it rides in `value` and does not
                    // reallocate the element when the user arrows through the
                    // band. See matchesStructure(of:).
                    label: segment.text.isEmpty ? segment.segmentId : segment.text,
                    value: isSelected ? "Selected" : "Not selected",
                    frame: frame
                )
            )

            // The words themselves, clipped to what fits rather than overflowing
            // into the neighbouring segment.
            let labelSize = metric(StudioTimelineMetrics.labelSize)
            let advance = StudioOverlayRenderMetrics.advance(forPointSize: labelSize)
            let capacity = advance > 0 ? Int(frame.width / advance) : 0
            if capacity >= 2, !segment.text.isEmpty {
                texts.append(
                    StudioOverlayText(
                        string: String(segment.text.prefix(capacity)),
                        x: frame.x + metric(1),
                        y: segmentY + metric(3),
                        pointSize: labelSize,
                        color: .text
                    )
                )
            }

            // Handles only on the SELECTED segment: drawing a grab target on
            // every segment would make the whole band a minefield of accidental
            // trims.
            guard isSelected else { continue }
            let handleWidth = metric(StudioTimelineMetrics.handleWidth)
            let grabWidth = metric(StudioTimelineMetrics.handleGrabWidth)
            for (handle, edgeX) in [
                (StudioTrimHandle.start, frame.x), (StudioTrimHandle.end, frame.maxX),
            ] {
                rects.append(
                    StudioOverlayRect(
                        frame: StudioOverlayFrame(
                            x: edgeX - handleWidth / 2,
                            y: segmentY,
                            width: handleWidth,
                            height: segmentHeight
                        ),
                        color: .playhead
                    )
                )
                handleHits.append(
                    StudioTimelineHitBox(
                        segmentId: segment.segmentId,
                        handle: handle,
                        frame: StudioOverlayFrame(
                            x: edgeX - grabWidth / 2,
                            y: segmentY - metric(4),
                            width: grabWidth,
                            height: segmentHeight + metric(8)
                        )
                    )
                )
            }
        }

        // Ghosts on the band too, so a proposal is visible where the material
        // it affects is, not only on the scrub bar.
        for ghost in state.ghosts {
            let startX = xForTicks(ghost.startTicks)
            let endX = xForTicks(ghost.endTicks)
            rects.append(
                StudioOverlayRect(
                    frame: StudioOverlayFrame(
                        x: startX,
                        y: bandY,
                        width: ghost.isInsertionPoint
                            ? metric(StudioTimelineMetrics.handleWidth)
                            : max(endX - startX, metric(1)),
                        height: bandHeight
                    ),
                    color: ghost.isInsertionPoint ? .ghostEdge : .ghost
                )
            )
        }

        // A live trim draws its proposed edge, so the operator sees where the
        // release will land — including the snap.
        if let trim = state.trim {
            let trimX = xForTicks(trim.currentTicks)
            rects.append(
                StudioOverlayRect(
                    frame: StudioOverlayFrame(
                        x: trimX - metric(1),
                        y: bandY,
                        width: metric(2),
                        height: bandHeight
                    ),
                    color: trim.didSnap ? .mark : .playhead
                )
            )
        }

        // The playhead, from the ONE clock's position.
        let playheadX = xForTicks(state.positionTicks)
        rects.append(
            StudioOverlayRect(
                frame: StudioOverlayFrame(
                    x: min(max(playheadX, bandFrame.x), bandFrame.maxX - metric(1)),
                    y: bandY,
                    width: metric(1),
                    height: bandHeight
                ),
                color: .playhead
            )
        )

        return StudioTimelineModel(
            rects: rects,
            texts: texts,
            bandFrame: bandFrame,
            segmentHits: segmentHits,
            handleHits: handleHits,
            isVisible: true,
            accessibilityElements: accessibility
        )
    }

    /// Handle hits are tested BEFORE segment bodies: the grab areas overlap the
    /// segment they belong to, and a drag is the more specific intent.
    public static func hit(
        atX x: Double,
        y: Double,
        in model: StudioTimelineModel
    ) -> StudioTimelineHitBox? {
        if let handle = model.handleHits.first(where: { $0.frame.contains(x: x, y: y) }) {
            return handle
        }
        return model.segmentHits.first { $0.frame.contains(x: x, y: y) }
    }

    /// The segment a Tab reaches from `current`, in timeline order.
    ///
    /// Nil `current` selects the FIRST segment forward and the LAST backward,
    /// so Tab and Shift-Tab both enter the band from the end an operator
    /// expects. Selection deliberately does NOT wrap: arriving back at the
    /// first segment after the last hides the fact that you reached the end,
    /// and there is no scrollbar here to show position.
    public static func segmentId(
        steppingFrom current: String?,
        forward: Bool,
        in transcript: StudioTranscript?
    ) -> String? {
        guard let transcript, !transcript.segments.isEmpty else { return nil }
        let ids = transcript.segments.map(\.segmentId)
        guard let current, let index = ids.firstIndex(of: current) else {
            return forward ? ids.first : ids.last
        }
        let next = forward ? index + 1 : index - 1
        guard ids.indices.contains(next) else { return current }
        return ids[next]
    }

    /// Snap targets for a trim on `segmentId`: every OTHER segment's edges.
    ///
    /// A handle must not snap to its own segment's boundaries — it already sits
    /// on one of them, so including them would pin the handle in place and read
    /// as a dead control. Excluding them is the difference between "snapping"
    /// and "refusing to move".
    public static func snapBoundaries(
        transcript: StudioTranscript?,
        excluding segmentId: String,
        timebase: StudioTimebase
    ) -> [Int64] {
        guard let transcript else { return [] }
        return transcript.segments
            .filter { $0.segmentId != segmentId }
            .compactMap { $0.range(in: timebase) }
            .flatMap { [$0.startTicks, $0.endTicks] }
    }

    /// Half a frame. Tight enough that an operator aiming between two words is
    /// not dragged onto one of them.
    public static func snapToleranceTicks(timebase: StudioTimebase) -> Int64 {
        max(1, timebase.frameDurationTicks / 2)
    }

    /// Tick position for a pointer x within the band.
    public static func ticks(
        atX x: Double,
        in model: StudioTimelineModel,
        durationTicks: Int64
    ) -> Int64 {
        guard model.isVisible, model.bandFrame.width > 0, durationTicks > 0, x.isFinite else {
            return 0
        }
        let fraction = min(max((x - model.bandFrame.x) / model.bandFrame.width, 0), 1)
        return Int64((fraction * Double(durationTicks)).rounded())
    }
}
