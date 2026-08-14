import Foundation

/// The viewer's on-screen transport surface, computed as data (mission outcome 2,
/// with room reserved for outcome 9's diagnostics).
///
/// WHY THIS IS A MODEL AND NOT A VIEW. StudioViewerWindow lives in the Companion
/// target, which has no test target, so anything that can be *wrong* has to live
/// here instead. Everything the overlay decides — where the playhead sits, which
/// span the marks describe, what the readout says, where a click lands — is pure
/// arithmetic over a snapshot, asserted directly. The Metal renderer downstream
/// only turns these primitives into triangles, and AppKit only forwards events.
///
/// COORDINATE SPACE: pixels of the drawable, origin TOP-LEFT, y increasing
/// downward. That is the space a HUD is naturally described in and the space
/// mouse events arrive in after flipping; StudioOverlayRenderer converts to
/// Metal's centre-origin NDC exactly once, at the vertex.
///
/// NOT CLAIMED HERE: audio, A/V sync, Review A/B, proposals, grading, RSS.

// MARK: - Geometry and colour

public struct StudioOverlayFrame: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var maxX: Double { x + width }
    public var maxY: Double { y + height }

    public func contains(x pointX: Double, y pointY: Double) -> Bool {
        pointX >= x && pointX <= maxX && pointY >= y && pointY <= maxY
    }
}

public struct StudioOverlayColor: Equatable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double
    public let alpha: Double

    public init(red: Double, green: Double, blue: Double, alpha: Double) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    /// Scrim behind the HUD. Translucent rather than opaque so the bottom of the
    /// picture stays readable underneath it.
    public static let scrim = StudioOverlayColor(red: 0.04, green: 0.04, blue: 0.05, alpha: 0.72)
    public static let track = StudioOverlayColor(red: 1, green: 1, blue: 1, alpha: 0.22)
    public static let markedSpan = StudioOverlayColor(red: 0.35, green: 0.72, blue: 1.0, alpha: 0.45)
    public static let mark = StudioOverlayColor(red: 0.45, green: 0.82, blue: 1.0, alpha: 0.95)
    /// Ghost proposals read as PENDING rather than committed, so they are amber
    /// and translucent: a ghost drawn like a mark would claim the sequence
    /// already contains material the host has not accepted.
    public static let ghost = StudioOverlayColor(red: 1.0, green: 0.72, blue: 0.25, alpha: 0.38)
    public static let ghostEdge = StudioOverlayColor(red: 1.0, green: 0.78, blue: 0.35, alpha: 0.95)
    public static let playhead = StudioOverlayColor(red: 1, green: 1, blue: 1, alpha: 0.98)
    public static let text = StudioOverlayColor(red: 0.94, green: 0.95, blue: 0.97, alpha: 1)
    public static let dimText = StudioOverlayColor(red: 0.62, green: 0.65, blue: 0.70, alpha: 1)
    public static let activeText = StudioOverlayColor(red: 1.0, green: 0.85, blue: 0.35, alpha: 1)
    public static let errorText = StudioOverlayColor(red: 1.0, green: 0.45, blue: 0.42, alpha: 1)
}

public struct StudioOverlayRect: Equatable, Sendable {
    public let frame: StudioOverlayFrame
    public let color: StudioOverlayColor

    public init(frame: StudioOverlayFrame, color: StudioOverlayColor) {
        self.frame = frame
        self.color = color
    }
}

public struct StudioOverlayText: Equatable, Sendable {
    public let string: String
    /// Top-left of the text's cell box.
    public let x: Double
    public let y: Double
    /// Cell height in pixels; the atlas is monospaced so advance derives from it.
    public let pointSize: Double
    public let color: StudioOverlayColor

    public init(
        string: String,
        x: Double,
        y: Double,
        pointSize: Double,
        color: StudioOverlayColor
    ) {
        self.string = string
        self.x = x
        self.y = y
        self.pointSize = pointSize
        self.color = color
    }
}

// MARK: - Accessibility

/// A control the overlay draws, described for assistive technology.
///
/// Metal-drawn controls carry NO accessibility for free — an NSButton announces
/// itself, a triangle does not. Declaring these as the overlay is built is
/// materially cheaper than retrofitting, and it means the Companion's AppKit
/// layer can publish accessibility children without re-deriving any layout.
/// This is outcome-10 groundwork and is deliberately NOT a claim that outcome 10
/// is met: nothing here has been exercised with VoiceOver.
public struct StudioAccessibilityDescriptor: Equatable, Sendable {
    public enum Role: String, Equatable, Sendable {
        case slider
        case staticText
        /// A transcript segment: activating it selects that segment.
        case button
    }

    public let role: Role
    public let label: String
    /// VOLATILE. The playhead and readout descriptors carry the RUNNING
    /// timecode, so this changes every frame during playback while everything
    /// else stays put — see `matchesStructure(of:)`.
    public let value: String
    public let frame: StudioOverlayFrame

    public init(role: Role, label: String, value: String, frame: StudioOverlayFrame) {
        self.role = role
        self.label = label
        self.value = value
        self.frame = frame
    }

    /// True when two descriptors describe the SAME control and differ at most in
    /// their value.
    ///
    /// WHY THIS EXISTS. A viewer republishing accessibility children on plain
    /// inequality rebuilds and reallocates an NSAccessibilityElement every
    /// display-link tick during playback, because `value` carries the running
    /// timecode. That is churn precisely in the state where it costs most, and
    /// it hands assistive technology a moving target. Splitting identity
    /// (role/label/frame) from value lets the caller allocate elements only when
    /// the CONTROLS change and update the spoken value in place otherwise —
    /// which keeps the live timecode readable rather than throttling it away.
    public func matchesStructure(of other: StudioAccessibilityDescriptor) -> Bool {
        role == other.role && label == other.label && frame == other.frame
    }
}

// MARK: - Input state

public struct StudioOverlayViewport: Equatable, Sendable {
    /// Drawable size in PIXELS.
    public let width: Double
    public let height: Double
    /// Backing scale, so layout metrics can be authored in points.
    public let scale: Double

    public init(width: Double, height: Double, scale: Double = 2.0) {
        self.width = width
        self.height = height
        self.scale = max(scale, 0.5)
    }
}

/// Bounded viewer counters, reserved for outcome 9's HUD. Carried by the model
/// now so the diagnostics slice adds a call site rather than a redesign.
public struct StudioOverlayDiagnostics: Equatable, Sendable {
    public let presentedFrameCount: Int
    public let droppedFrameCount: Int
    public let retainedFrameCount: Int
    public let hardwareDecodeLabel: String
    /// Measured A/V sync summary, or "a/v --" before any measurement exists.
    public let syncLabel: String
    /// Process memory. Paired with retainedFrameCount deliberately: measurement
    /// showed phys_footprint is effectively blind to IOSurface-backed video
    /// memory, so RSS alone would under-report the viewer's dominant allocation
    /// class. The two numbers together are the honest picture.
    public let memoryLabel: String
    /// Outcome 9 names seven diagnostics. These three were COMPUTED AND NEVER
    /// DISPLAYED — cacheHitCount in StudioVideoFrameSource, boundFrameCount in
    /// StudioVideoTextureBridge — and players had no counter at all. A number
    /// nothing shows is the same shape as a seam nothing calls.
    public let cacheHitCount: Int
    public let boundTextureCount: Int
    /// Resident media players: decode sources plus the audio engine. Honest
    /// about what it counts rather than implying a pool that does not exist.
    public let playerCount: Int

    public init(
        presentedFrameCount: Int,
        droppedFrameCount: Int,
        retainedFrameCount: Int,
        hardwareDecodeLabel: String,
        syncLabel: String = "a/v --",
        memoryLabel: String = "rss --",
        cacheHitCount: Int = 0,
        boundTextureCount: Int = 0,
        playerCount: Int = 0
    ) {
        self.presentedFrameCount = presentedFrameCount
        self.droppedFrameCount = droppedFrameCount
        self.retainedFrameCount = retainedFrameCount
        self.hardwareDecodeLabel = hardwareDecodeLabel
        self.syncLabel = syncLabel
        self.cacheHitCount = cacheHitCount
        self.boundTextureCount = boundTextureCount
        self.playerCount = playerCount
        self.memoryLabel = memoryLabel
    }
}

/// Everything the overlay needs, flattened out of the transport so the layout is
/// a pure function of a value.
public struct StudioOverlayState: Equatable, Sendable {
    /// Optional transcript band. `nil` means the host has sent no transcript for
    /// the open asset, and the band is not drawn at all — an empty band would
    /// claim "this media has no speech", which is a different statement.
    public var timeline: StudioTimelineState?

    public var viewport: StudioOverlayViewport
    public var positionTicks: Int64
    /// 0 means UNBOUNDED — the synthetic pattern before any media is open. The
    /// layout must survive it; see `playheadFraction`.
    public var durationTicks: Int64
    public var isPlaying: Bool
    public var inPointTicks: Int64?
    public var outPointTicks: Int64?
    public var isLoopingRange: Bool
    public var isScrubbing: Bool
    public var timecodeText: String
    public var sourceLabel: String
    public var entry: StudioTimecodeFieldSnapshot?
    public var message: String?
    public var diagnostics: StudioOverlayDiagnostics?
    /// Open ghost proposals, already resolved into the coordinates of whichever
    /// version is displayed. The layout does not know about rational time or the
    /// wire contract — StudioProposedTimeline has already done that.
    public var ghosts: [StudioGhostGeometry] = []
    /// Which version the viewer is addressing, or nil when there is nothing to
    /// review. Nil and `.current` are different: one means no proposal exists,
    /// the other means one exists and you are looking at the sequence without it.
    public var reviewVersion: StudioReviewVersion?

    public init(
        viewport: StudioOverlayViewport,
        positionTicks: Int64 = 0,
        durationTicks: Int64 = 0,
        isPlaying: Bool = false,
        inPointTicks: Int64? = nil,
        outPointTicks: Int64? = nil,
        isLoopingRange: Bool = false,
        isScrubbing: Bool = false,
        timecodeText: String = "00:00:00:00",
        sourceLabel: String = "No media",
        entry: StudioTimecodeFieldSnapshot? = nil,
        message: String? = nil,
        diagnostics: StudioOverlayDiagnostics? = nil
    ) {
        self.viewport = viewport
        self.positionTicks = positionTicks
        self.durationTicks = durationTicks
        self.isPlaying = isPlaying
        self.inPointTicks = inPointTicks
        self.outPointTicks = outPointTicks
        self.isLoopingRange = isLoopingRange
        self.isScrubbing = isScrubbing
        self.timecodeText = timecodeText
        self.sourceLabel = sourceLabel
        self.entry = entry
        self.message = message
        self.diagnostics = diagnostics
    }
}

// MARK: - Layout

/// Layout metrics in POINTS. Scaled by the viewport's backing scale.
///
/// ROW ORDER IS LOAD-BEARING. The scrub track sits at the TOP of the strip and
/// the text rows below it, which is both the conventional player arrangement and
/// the only way the rows fit: an earlier 62pt strip with the track at the bottom
/// put the info row at 230..245 and the track at 235..240, so the source label
/// was drawn straight through the scrub bar. `testNoTextRowOverlapsTheScrubTrack`
/// is what keeps that from coming back.
public enum StudioOverlayMetrics {
    public static let hudHeight: Double = 92
    public static let horizontalMargin: Double = 18
    public static let trackHeight: Double = 5
    /// Distance from the top of the HUD strip to the top of the track.
    public static let trackTopInset: Double = 12
    public static let markWidth: Double = 2
    public static let playheadWidth: Double = 2
    /// Generous vertical grab area — a 5pt track is not a pointer target.
    public static let trackGrabHeight: Double = 22
    public static let timecodeSize: Double = 22
    public static let labelSize: Double = 12
    /// Row origins, measured from the top of the HUD strip.
    public static let readoutRowTop: Double = 24
    /// Nudged down against the taller readout so the two read as one row.
    public static let statusRowTop: Double = 30
    /// Diagnostics get their own row BELOW the source label so a long asset
    /// label and a worst-case counters string cannot be drawn on top of each
    /// other. The HUD strip is taller by exactly that row's height.
    public static let diagnosticsRowTop: Double = 72
    public static let infoRowTop: Double = 56
}

public struct StudioOverlayModel: Equatable, Sendable {
    public let rects: [StudioOverlayRect]
    public let texts: [StudioOverlayText]
    public let accessibilityElements: [StudioAccessibilityDescriptor]
    /// Drawn track. Hit testing uses `grabFrame`, which is taller.
    public let trackFrame: StudioOverlayFrame
    public let grabFrame: StudioOverlayFrame
    public let isVisible: Bool
    /// The transcript band, already laid out. Carried here rather than built by
    /// the view so that hit testing and drawing read the SAME geometry — the
    /// scrub bar's trackFrame/grabFrame split taught this lesson once already.
    public var timeline: StudioTimelineModel = .empty

    public var isEmpty: Bool { rects.isEmpty && texts.isEmpty }
}

public enum StudioOverlayLayout {
    /// Position as a 0...1 fraction of the asset.
    ///
    /// ZERO DURATION IS THE CASE THAT BITES. The viewer's default clock is
    /// created with `durationTicks: 0` (the synthetic pattern is unbounded), so
    /// this runs with a zero denominator every launch before media opens. A
    /// plain division yields NaN, which propagates into vertex positions and —
    /// worse — into `Int64(...)` on the way back out of a hit test, where Swift
    /// TRAPS. Returning zero is the only total answer.
    public static func playheadFraction(positionTicks: Int64, durationTicks: Int64) -> Double {
        guard durationTicks > 0 else { return 0 }
        let clamped = min(max(positionTicks, 0), durationTicks)
        return Double(clamped) / Double(durationTicks)
    }

    public static func build(_ state: StudioOverlayState) -> StudioOverlayModel {
        let scale = state.viewport.scale
        let width = state.viewport.width
        let height = state.viewport.height
        let metric = { (points: Double) in points * scale }

        let hudHeight = metric(StudioOverlayMetrics.hudHeight)
        let margin = metric(StudioOverlayMetrics.horizontalMargin)
        let hudTop = max(0, height - hudHeight)

        // A viewport too small for the HUD gets no HUD rather than a mangled
        // one: overlapping an 18pt margin on a 20px window draws nonsense.
        let trackWidth = width - margin * 2
        guard width > 0, height > 0, trackWidth > metric(24), hudHeight < height else {
            return StudioOverlayModel(
                rects: [],
                texts: [],
                accessibilityElements: [],
                trackFrame: StudioOverlayFrame(x: 0, y: 0, width: 0, height: 0),
                grabFrame: StudioOverlayFrame(x: 0, y: 0, width: 0, height: 0),
                isVisible: false
            )
        }

        let trackHeight = metric(StudioOverlayMetrics.trackHeight)
        let trackY = hudTop + metric(StudioOverlayMetrics.trackTopInset)
        let trackFrame = StudioOverlayFrame(
            x: margin,
            y: trackY,
            width: trackWidth,
            height: trackHeight
        )
        let grabHeight = metric(StudioOverlayMetrics.trackGrabHeight)
        let grabFrame = StudioOverlayFrame(
            x: margin,
            y: trackY + trackHeight / 2 - grabHeight / 2,
            width: trackWidth,
            height: grabHeight
        )

        var rects: [StudioOverlayRect] = [
            StudioOverlayRect(
                frame: StudioOverlayFrame(x: 0, y: hudTop, width: width, height: hudHeight),
                color: .scrim
            ),
            StudioOverlayRect(frame: trackFrame, color: .track),
        ]
        var texts: [StudioOverlayText] = []
        var accessibility: [StudioAccessibilityDescriptor] = []

        let xForTicks = { (ticks: Int64) -> Double in
            trackFrame.x
                + trackFrame.width
                * playheadFraction(positionTicks: ticks, durationTicks: state.durationTicks)
        }

        // GHOSTS UNDERNEATH EVERYTHING. A pending proposal must never obscure
        // the playhead or the operator's own In/Out marks: it is a suggestion,
        // and it draws like one.
        for ghost in state.ghosts {
            let startX = xForTicks(ghost.startTicks)
            if ghost.isInsertionPoint {
                // No duration in this version — a caret marking where material
                // would arrive, not a band claiming it already has.
                rects.append(
                    StudioOverlayRect(
                        frame: StudioOverlayFrame(
                            x: startX,
                            y: trackFrame.y - trackFrame.height,
                            width: metric(StudioOverlayMetrics.markWidth),
                            height: trackFrame.height * 3
                        ),
                        color: .ghostEdge
                    )
                )
            } else {
                let endX = xForTicks(ghost.endTicks)
                rects.append(
                    StudioOverlayRect(
                        frame: StudioOverlayFrame(
                            x: startX,
                            y: trackFrame.y,
                            width: max(endX - startX, metric(1)),
                            height: trackFrame.height
                        ),
                        color: .ghost
                    )
                )
            }
            accessibility.append(
                StudioAccessibilityDescriptor(
                    role: .staticText,
                    label: "Proposed edit",
                    value: ghost.proposalId,
                    frame: StudioOverlayFrame(
                        x: startX,
                        y: trackFrame.y - trackFrame.height,
                        width: max(xForTicks(ghost.endTicks) - startX, metric(2)),
                        height: trackFrame.height * 3
                    )
                )
            )
        }

        // Marked span next, so the marks and playhead draw on top of it.
        if let inTicks = state.inPointTicks,
            let outTicks = state.outPointTicks,
            outTicks > inTicks
        {
            let startX = xForTicks(inTicks)
            let endX = xForTicks(outTicks)
            rects.append(
                StudioOverlayRect(
                    frame: StudioOverlayFrame(
                        x: startX,
                        y: trackFrame.y,
                        width: max(endX - startX, metric(1)),
                        height: trackFrame.height
                    ),
                    color: .markedSpan
                )
            )
        }

        let markWidth = metric(StudioOverlayMetrics.markWidth)
        let markHeight = trackFrame.height * 3
        let markY = trackFrame.y - trackFrame.height
        if let inTicks = state.inPointTicks {
            let markX = xForTicks(inTicks)
            rects.append(
                StudioOverlayRect(
                    frame: StudioOverlayFrame(
                        x: markX,
                        y: markY,
                        width: markWidth,
                        height: markHeight
                    ),
                    color: .mark
                )
            )
            accessibility.append(
                StudioAccessibilityDescriptor(
                    role: .staticText,
                    label: "In point",
                    value: "\(inTicks)",
                    frame: StudioOverlayFrame(
                        x: markX - markWidth,
                        y: markY,
                        width: markWidth * 3,
                        height: markHeight
                    )
                )
            )
        }
        if let outTicks = state.outPointTicks {
            // Out is EXCLUSIVE, so its mark sits at the boundary and is nudged
            // left by its own width to stay inside the track at the very end.
            let markX = min(xForTicks(outTicks), trackFrame.maxX - markWidth)
            rects.append(
                StudioOverlayRect(
                    frame: StudioOverlayFrame(
                        x: markX,
                        y: markY,
                        width: markWidth,
                        height: markHeight
                    ),
                    color: .mark
                )
            )
            accessibility.append(
                StudioAccessibilityDescriptor(
                    role: .staticText,
                    label: "Out point",
                    value: "\(outTicks)",
                    frame: StudioOverlayFrame(
                        x: markX - markWidth,
                        y: markY,
                        width: markWidth * 3,
                        height: markHeight
                    )
                )
            )
        }

        let playheadWidth = metric(StudioOverlayMetrics.playheadWidth)
        let playheadX = min(
            max(xForTicks(state.positionTicks) - playheadWidth / 2, trackFrame.x),
            trackFrame.maxX - playheadWidth
        )
        rects.append(
            StudioOverlayRect(
                frame: StudioOverlayFrame(
                    x: playheadX,
                    y: trackFrame.y - trackFrame.height * 1.6,
                    width: playheadWidth,
                    height: trackFrame.height * 4.2
                ),
                color: .playhead
            )
        )

        // Readout. During entry the typed digits REPLACE the clock's timecode,
        // because a field that keeps showing the running position while you type
        // into it is the fastest way to seek somewhere you did not mean to.
        let timecodeSize = metric(StudioOverlayMetrics.timecodeSize)
        let labelSize = metric(StudioOverlayMetrics.labelSize)
        let readoutY = hudTop + metric(StudioOverlayMetrics.readoutRowTop)
        let readout = state.entry?.displayText ?? state.timecodeText
        texts.append(
            StudioOverlayText(
                string: readout,
                x: margin,
                y: readoutY,
                pointSize: timecodeSize,
                color: state.entry == nil ? .text : .activeText
            )
        )
        accessibility.append(
            StudioAccessibilityDescriptor(
                role: .staticText,
                label: state.entry == nil ? "Timecode" : "Timecode entry",
                value: readout,
                frame: StudioOverlayFrame(
                    x: margin,
                    y: readoutY,
                    width: StudioOverlayRenderMetrics.advance(forPointSize: timecodeSize)
                        * Double(readout.count),
                    height: timecodeSize
                )
            )
        )

        // Status line: transport state, then whatever qualifies it.
        var status: [String] = [state.isPlaying ? "PLAY" : "PAUSE"]
        // The version label leads the qualifiers: when a proposal is open, WHICH
        // sequence you are watching is the most consequential thing on screen.
        if let reviewVersion = state.reviewVersion { status.insert(reviewVersion.label, at: 0) }
        if state.isScrubbing { status.append("SCRUB") }
        if state.isLoopingRange { status.append("LOOP") }
        if state.inPointTicks != nil || state.outPointTicks != nil {
            status.append(
                "IN \(state.inPointTicks == nil ? "--" : "SET") / OUT "
                    + (state.outPointTicks == nil ? "--" : "SET")
            )
        }
        let statusText = status.joined(separator: "  ")
        let statusWidth =
            StudioOverlayRenderMetrics.advance(forPointSize: labelSize) * Double(statusText.count)
        let statusY = hudTop + metric(StudioOverlayMetrics.statusRowTop)
        texts.append(
            StudioOverlayText(
                string: statusText,
                x: max(margin, width - margin - statusWidth),
                y: statusY,
                pointSize: labelSize,
                color: .dimText
            )
        )
        // STATIC TEXT, NOT A CHECKBOX. There is no toggleable loop control in
        // the HUD — looping is a status token and an "L" key. Announcing it as
        // a checkbox would offer VoiceOver a control that cannot be operated,
        // which is a worse experience than describing the state plainly.
        accessibility.append(
            StudioAccessibilityDescriptor(
                role: .staticText,
                label: "Loop marked range",
                value: state.isLoopingRange ? "on" : "off",
                frame: StudioOverlayFrame(
                    x: max(margin, width - margin - statusWidth),
                    y: statusY,
                    width: statusWidth,
                    height: labelSize
                )
            )
        )

        // A message (an entry rejection, an open failure) outranks the source
        // label: it is the thing the operator needs and it is transient.
        let secondaryY = hudTop + metric(StudioOverlayMetrics.infoRowTop)
        texts.append(
            StudioOverlayText(
                string: state.message ?? state.sourceLabel,
                x: margin,
                y: secondaryY,
                pointSize: labelSize,
                color: state.message == nil ? .dimText : .errorText
            )
        )

        // Diagnostics sit on their own row. Sharing the source label's row made
        // the right-aligned line clamp to the same left margin as soon as it
        // grew past the viewport, so the two strings overwrote each other.
        let diagnosticsY = hudTop + metric(StudioOverlayMetrics.diagnosticsRowTop)
        if let diagnostics = state.diagnostics {
            let line =
                "\(diagnostics.hardwareDecodeLabel)  \(diagnostics.syncLabel)"
                + "  drop \(diagnostics.droppedFrameCount)"
                + "  held \(diagnostics.retainedFrameCount)"
                + "  shown \(diagnostics.presentedFrameCount)"
                + "  cache \(diagnostics.cacheHitCount)"
                + "  tex \(diagnostics.boundTextureCount)"
                + "  play \(diagnostics.playerCount)"
                + "  \(diagnostics.memoryLabel)"
            let lineWidth =
                StudioOverlayRenderMetrics.advance(forPointSize: labelSize) * Double(line.count)
            texts.append(
                StudioOverlayText(
                    string: line,
                    x: max(margin, width - margin - lineWidth),
                    y: diagnosticsY,
                    pointSize: labelSize,
                    color: .dimText
                )
            )
        }

        accessibility.append(
            StudioAccessibilityDescriptor(
                role: .slider,
                label: "Playhead",
                value: readout,
                frame: grabFrame
            )
        )

        let timeline: StudioTimelineModel =
            state.timeline.map(StudioTimelineLayout.build) ?? .empty
        rects.append(contentsOf: timeline.rects)
        texts.append(contentsOf: timeline.texts)
        accessibility.append(contentsOf: timeline.accessibilityElements)

        return StudioOverlayModel(
            rects: rects,
            texts: texts,
            accessibilityElements: accessibility,
            trackFrame: trackFrame,
            grabFrame: grabFrame,
            isVisible: true,
            timeline: timeline
        )
    }

    /// Inverse of the playhead mapping: where a pointer at `x` lands, in ticks.
    ///
    /// Clamped at BOTH ends rather than returning nil outside the track, because
    /// a drag that runs off the edge should pin to the edge — releasing the
    /// mouse past the end of a scrub bar has always meant "the end".
    public static func ticks(
        atX x: Double,
        in model: StudioOverlayModel,
        durationTicks: Int64
    ) -> Int64 {
        guard model.isVisible, model.trackFrame.width > 0, durationTicks > 0 else { return 0 }
        guard x.isFinite else { return 0 }
        let fraction = (x - model.trackFrame.x) / model.trackFrame.width
        let bounded = min(max(fraction, 0), 1)
        // Rounded rather than truncated so the two halves of a pixel do not both
        // resolve to the earlier frame.
        let ticks = (bounded * Double(durationTicks)).rounded()
        return Int64(min(max(ticks, 0), Double(durationTicks)))
    }
}
