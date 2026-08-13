import AppKit
import Metal
import QuartzCore
import TaskWraithStudioCore

/// AppKit window + CAMetalLayer shell for the Studio viewer.
///
/// SCOPE HONESTY: this is the presentation shell only. It puts a real
/// Metal-rendered frame on a real NSWindow driven by the one playback clock. It
/// does NOT establish app identity, accessibility, keyboard ACCEPTANCE, or
/// packaging — those need a signed bundle and are outcome 10, deliberately not
/// claimed from this slice. The keyboard handling below is a transport
/// convenience for exercising the clock by hand, not an accessibility
/// implementation.
///
/// The window path is intentionally NOT unit-tested: correctness of the render
/// path is proven headlessly by StudioViewerRendererTests, which asserts
/// actual rendered pixel values. This file is the thin glue that cannot be
/// asserted without a GUI session.

/// Layer-backed view whose backing layer is a CAMetalLayer. Frames are rendered
/// straight into the drawable's texture — nothing is converted to a CGImage and
/// assigned to `layer.contents`.
final class StudioViewerView: NSView {
    /// macOS virtual key codes for the transport keys.
    private enum Key {
        static let space: UInt16 = 49
        static let leftArrow: UInt16 = 123
        static let rightArrow: UInt16 = 124
        static let returnKey: UInt16 = 36
        static let keypadEnter: UInt16 = 76
        static let escape: UInt16 = 53
        static let delete: UInt16 = 51
        static let tab: UInt16 = 48
    }

    let renderer: StudioViewerRenderer
    /// The tested transport lives in Core; this view only forwards gestures to
    /// it and draws whatever the resulting playhead selects.
    /// THE SHARED AUTHORITY, by reference. Not a stored StudioTransportController:
    /// that is a value type, so a per-view copy would make two routes into two
    /// clocks silently and by construction — the outcome the briefing prohibits.
    let authority: StudioPlaybackAuthority

    /// Reads and writes the ONE transport. Every existing mutating call site
    /// works unchanged through this computed setter, which is why the shared
    /// authority could be introduced without rewriting the gesture handlers.
    var transport: StudioTransportController {
        get { authority.transport }
        set { authority.transport = newValue }
    }
    private var frameLink: CADisplayLink?

    /// Timecode entry, also tested in Core. The view supplies keystrokes and
    /// draws the field's own display text.
    /// Internal rather than private so the Companion event tests can assert
    /// that Return belongs to timecode entry. No test-only accessor is added.
    var timecodeField = StudioTimecodeField()
    private var sourceLabel = "No media"
    private var message: String?
    /// The host's transcript for the open asset, or nil. Drives the band.
    private var transcript: StudioTranscript?
    var selectedSegmentId: String?
    private var trim: StudioTrimDrag?
    /// The revision the operator is looking at. Proposals cite it as their base.
    private var hostRevision = 0
    /// The open ghost being reviewed, or nil. Built by the Companion from a
    /// proposal the pump now forwards; before this the renderer's review
    /// machinery existed and NOTHING CALLED IT.
    private var reviewTimeline: StudioProposedTimeline?
    private var reviewVersion: StudioReviewVersion = .current
    /// The operator's own In/Out, parked while the review loop borrows the
    /// transport's one loop authority. Restored on exit — overwriting an
    /// operator's marks to loop a proposal would make one of the two features
    /// unusable, and they are DIFFERENT features.
    var parkedMarks: (inTicks: Int64?, outTicks: Int64?)?
    /// Grading is Core-complete and was unreachable: no Companion code built a
    /// non-default settings value, so the product was pinned to Original.
    var gradeSettings = StudioGradeSettings()
    /// Monotonic within this process, and started above hello/getDocument so a
    /// proposal id can never collide with them.
    private var nextProposalRequestId = StudioProposalRequest.firstProposalRequestId
    /// The overlay layout most recently drawn. Hit testing and accessibility
    /// both read it, so neither re-derives geometry the renderer might disagree
    /// with.
    /// Audio output, and the measured sync between what is seen and heard.
    /// Held here because the display link is the only place that observes a
    /// presented frame, which is one half of the measurement.
    private let audioPlayer = StudioAudioPlayer()
    /// Which asset the attached sound came from. Nil when nothing is attached.
    private var audioAssetId: String?
    private var sequenceAudioMuted = false
    private var syncMeter: StudioAvSyncMeter?
    /// Whether the transport is currently driven by the AUDIO device rather than
    /// host monotonic time.
    private var usingAudioTime = false
    private var lastAudioHostSeconds: Double = 0
    private var lastMemorySampleHost: Double = 0
    private var cachedMemoryLabel = "rss --"

    var overlayModel: StudioOverlayModel?
    private var publishedAccessibility: [StudioAccessibilityDescriptor] = []
    private var accessibilityChildElements: [NSAccessibilityElement] = []

    /// Minimal viewer diagnostics (mission outcome 9 groundwork). Counted here
    /// because the display-link callback is the only place that can observe a
    /// missed drawable. Content-level counters live on StudioViewerRenderer.
    private(set) var presentedFrameCount: Int = 0
    private(set) var missedDrawableCount: Int = 0
    private(set) var droppedFrameCount: Int = 0

    /// The route this view presents. Both routes render from the same
    /// authority; they differ in what they SHOW, never in what time it is.
    let route: StudioViewerRoute

    init(
        renderer: StudioViewerRenderer,
        authority: StudioPlaybackAuthority,
        route: StudioViewerRoute = .source
    ) {
        self.renderer = renderer
        self.authority = authority
        self.route = route
        super.init(frame: NSRect(x: 0, y: 0, width: 960, height: 540))
        wantsLayer = true
        layerContentsRedrawPolicy = .duringViewResize
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("StudioViewerView is created in code only")
    }

    // MARK: - Layer

    override func makeBackingLayer() -> CALayer {
        let metalLayer = CAMetalLayer()
        metalLayer.device = renderer.device
        metalLayer.pixelFormat = StudioTestPatternRenderer.pixelFormat
        // The viewer only ever renders into the drawable, never reads it back,
        // so the driver may pick the cheaper framebuffer-only path.
        metalLayer.framebufferOnly = true
        metalLayer.isOpaque = true
        metalLayer.allowsNextDrawableTimeout = true
        return metalLayer
    }

    private var metalLayer: CAMetalLayer? {
        layer as? CAMetalLayer
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateDrawableSize()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateDrawableSize()
    }

    private func updateDrawableSize() {
        guard let metalLayer else { return }
        let scale = window?.backingScaleFactor ?? 2.0
        metalLayer.contentsScale = scale
        metalLayer.drawableSize = CGSize(
            width: max(1, bounds.width * scale),
            height: max(1, bounds.height * scale)
        )
    }

    // MARK: - Display link

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        frameLink?.invalidate()
        frameLink = nil
        guard window != nil else {
            // Viewer closed: release the decoder and its texture cache now
            // rather than waiting for ARC, so close/reopen cycles cannot
            // accumulate decompression sessions.
            renderer.detachSource()
            return
        }

        updateDrawableSize()
        transport.play(atHost: CACurrentMediaTime())

        let link = displayLink(target: self, selector: #selector(handleDisplayLink(_:)))
        link.add(to: .main, forMode: .common)
        frameLink = link
    }

    @objc
    private func handleDisplayLink(_ link: CADisplayLink) {
        renderCurrentFrame()
    }

    /// One display refresh: ask THE clock which frame is current, then draw it.
    /// The view never keeps its own playhead.
    /// The oscillator the transport reads.
    ///
    /// Audio when it is playing, host monotonic otherwise — picture slaved to
    /// sound, because a dropped frame is a flicker and an audio glitch is a
    /// click. There is still ONE authority: StudioPlaybackClock remains the only
    /// thing that answers "what position are we at". All that changes is which
    /// physical oscillator supplies its time.
    private var transportHostSeconds: Double {
        audioPlayer.audioHostSeconds() ?? CACurrentMediaTime()
    }

    /// Re-anchors the clock when the oscillator changes.
    ///
    /// THE TWO TIMELINES HAVE DIFFERENT ORIGINS. Audio seconds are measured from
    /// the audio clock's anchor; host seconds are CACurrentMediaTime's epoch.
    /// Swapping one for the other without re-anchoring teleports the playhead by
    /// the difference between them, which is however long the machine has been
    /// up. So the position is read under the OLD source and re-established under
    /// the NEW one.
    private func reconcileTimeSource() {
        let audioSeconds = audioPlayer.audioHostSeconds()
        let audioActive = audioSeconds != nil
        if audioActive { lastAudioHostSeconds = audioSeconds ?? 0 }
        guard audioActive != usingAudioTime else { return }

        let previousHost = usingAudioTime ? lastAudioHostSeconds : CACurrentMediaTime()
        let position = transport.clock.positionTicks(atHost: previousHost)
        let wasPlaying = transport.clock.snapshot(atHost: previousHost).isPlaying

        usingAudioTime = audioActive
        let nextHost = audioActive ? (audioSeconds ?? 0) : CACurrentMediaTime()
        transport.seek(toTicks: position, atHost: nextHost)
        if wasPlaying { transport.play(atHost: nextHost) }
        // Statistics from before an oscillator change describe a different
        // pipeline, so they are discarded rather than carried forward.
        syncMeter?.reset()
    }

    /// Keeps the sound addressed to the position the picture is at.
    ///
    /// Runs every displayed frame and decides from DIVERGENCE, never from a
    /// gesture, so no transport call site has to remember to drive audio — see
    /// StudioAudioSyncPolicy for why that shape was chosen over eleven forwards.
    /// Whether the attached sound belongs to the picture the timeline is
    /// presenting right now.
    ///
    /// Always true off the sequence path, where there is one asset and the sound
    /// is by definition its own. On a committed timeline the cut decides which
    /// asset is on screen, and the audio player still holds whichever asset was
    /// opened — so past the first cut the sound belongs to a different clip.
    private func soundMatchesPicture(atTicks ticks: Int64) -> Bool {
        guard let sequence = renderer.sequence, !sequence.isEmpty else { return true }
        switch sequence.sample(atTicks: ticks) {
        case .gap:
            // Nothing is drawn in a hole, so nothing should sound in one.
            return false
        case .item(_, let assetId, _):
            return assetId == audioAssetId
        }
    }

    private func reconcileAudio() {
        guard audioPlayer.hasAudio else { return }
        let snapshot = transport.clock.snapshot(atHost: transportHostSeconds)
        let matches = soundMatchesPicture(atTicks: snapshot.positionTicks)
        if matches != !sequenceAudioMuted {
            sequenceAudioMuted = !matches
            if !matches {
                message = "sequence audio muted — sound belongs to \(audioAssetId ?? "no asset")"
            }
        }
        let decision = StudioAudioSyncPolicy.decide(
            transportIsPlaying: snapshot.isPlaying,
            intendedTicks: snapshot.positionTicks,
            audioEndTicks: audioPlayer.endTicks,
            audioIsPlaying: audioPlayer.isPlaying,
            audioPositionTicks: audioPlayer.reading()?.positionTicks,
            toleranceTicks: StudioAudioSyncPolicy.toleranceTicks(
                for: transport.clock.timebase
            ),
            soundMatchesPicture: matches
        )
        switch decision {
        case .leave:
            return
        case .pause:
            // The oscillator stops reporting, and reconcileTimeSource() picks
            // host monotonic time back up on this same frame.
            audioPlayer.pause()
        case .reschedule(let ticks):
            reschedule(audioAt: ticks)
        }
    }

    /// Restarts the sound at `ticks` and IMMEDIATELY re-establishes the clock
    /// against the audio timeline it just created.
    ///
    /// THIS IS THE HAZARD THE WHOLE SLICE TURNS ON. A re-schedule stops the
    /// player node, which resets its sample counter, so `audioHostSeconds()` —
    /// the value StudioPlaybackClock is being driven by — restarts near zero. A
    /// clock still anchored to the previous audio timeline reads that as an
    /// enormous negative elapsed time and teleports the playhead.
    /// reconcileTimeSource() cannot catch it: audio never stopped being present,
    /// and its guard only fires on a presence CHANGE. So the re-anchor has to
    /// happen here, synchronously, at the point the discontinuity is created.
    private func reschedule(audioAt ticks: Int64) {
        do {
            guard try audioPlayer.play(fromTicks: ticks) else { return }
        } catch {
            message = "audio unavailable: \(error)"
            audioPlayer.detach()
            return
        }
        guard let nextHost = audioPlayer.audioHostSeconds() else { return }
        transport.seek(toTicks: ticks, atHost: nextHost)
        transport.play(atHost: nextHost)
        usingAudioTime = true
        lastAudioHostSeconds = nextHost
        // Sync statistics from before the restart were measured against a
        // different anchor, so they describe a pipeline that no longer exists.
        syncMeter?.reset()
    }

    func renderCurrentFrame() {
        guard let metalLayer else { return }
        reconcileAudio()
        reconcileTimeSource()
        let snapshot = transport.clock.snapshot(atHost: transportHostSeconds)
        guard let drawable = metalLayer.nextDrawable() else {
            missedDrawableCount += 1
            return
        }
        let overlay = StudioOverlayLayout.build(
            overlayState(snapshot: snapshot, drawable: drawable.texture)
        )
        overlayModel = overlay
        publishAccessibility(for: overlay)

        // All content selection and failure policy lives in StudioViewerRenderer
        // (Core) so it is covered by StudioViewerRendererTests; this stays glue.
        // Non-throwing by design: one bad frame must not take the viewer down.
        let outcome = renderer.render(
            snapshot: snapshot,
            to: drawable.texture,
            presenting: drawable,
            overlay: overlay,
            review: (route == .review ? reviewTimeline : nil).map {
                StudioReviewContext(
                    version: reviewVersion,
                    timeline: $0,
                    timebase: transport.clock.timebase
                )
            }
        )
        // MEASURED A/V SYNC, against the audio hardware's own playhead.
        //
        // EVERY tick is recorded, drawn or not. The comment that stood here said
        // a dropped frame is not evidence about sync — which is true of the
        // frame that failed to arrive and FALSE of the frame still on screen,
        // and the distinction is the whole instrument. Left uncorrected it
        // would read as a justification for restoring the exclusion.
        if let audible = audioPlayer.audiblePositionTicks() {
            if outcome.didDraw {
                syncMeter?.record(
                    presentedFrameTicks: transport.clock.ticks(ofFrame: snapshot.frameIndex),
                    audiblePositionTicks: audible
                )
            } else {
                // A dropped frame leaves the PREVIOUS picture on screen while
                // sound carries on. That is the desync, and the old
                // `if outcome.didDraw` gate excluded exactly it — so the meter
                // sampled only healthy ticks and its reading was bounded by
                // frame quantisation whatever the pipeline was doing.
                syncMeter?.recordDroppedFrame(audiblePositionTicks: audible)
            }
            // Both branches are deliberate. If you are here to make the meter
            // quieter, the number is telling you something.
        }

        if outcome.didDraw {
            presentedFrameCount += 1
        } else {
            // Nothing was encoded, so the drawable is released unpresented —
            // a genuine dropped frame rather than a stale or synthetic one.
            droppedFrameCount += 1
        }
    }

    /// Flattens the live transport into the value the overlay layout consumes.
    /// Everything interesting about the result is asserted in
    /// StudioOverlayModelTests; this is the only place the two worlds meet.
    /// Adopts (or clears) the transcript band. Selection is dropped on change
    /// because a segment id from another transcript addresses nothing.
    func adopt(revision: Int) {
        hostRevision = revision
    }

    /// Adopts an open ghost. `nil` clears review entirely — a resolved proposal
    /// must stop being reviewable, in both directions.
    func adopt(reviewTimeline: StudioProposedTimeline?) {
        self.reviewTimeline = reviewTimeline
        if reviewTimeline == nil {
            reviewVersion = .current
            // A resolved ghost must not leave the transport looping a range
            // that no longer refers to anything.
            if parkedMarks != nil { toggleReviewLoop(atHost: CACurrentMediaTime()) }
        }
        needsDisplay = true
    }

    /// Which version the viewer is addressing. Toggling is only meaningful
    /// while a ghost is open.
    func toggleReviewVersion() {
        guard reviewTimeline != nil else {
            report(message: "No proposal to compare")
            return
        }
        reviewVersion = reviewVersion == .current ? .proposed : .current
        report(message: reviewVersion == .current ? "Showing Current" : "Showing Proposed")
        needsDisplay = true
    }

    func adopt(transcript: StudioTranscript?) {
        guard transcript != self.transcript else { return }
        self.transcript = transcript
        selectedSegmentId = nil
        trim = nil
    }

    private func overlayState(
        snapshot: StudioTransportSnapshot,
        drawable: MTLTexture
    ) -> StudioOverlayState {
        var state = StudioOverlayState(
            viewport: StudioOverlayViewport(
                width: Double(drawable.width),
                height: Double(drawable.height),
                scale: Double(window?.backingScaleFactor ?? 2.0)
            ),
            positionTicks: snapshot.positionTicks,
            durationTicks: transport.clock.durationTicks,
            isPlaying: snapshot.isPlaying,
            inPointTicks: transport.inPointTicks,
            outPointTicks: transport.outPointTicks,
            isLoopingRange: transport.isLoopingRange,
            isScrubbing: transport.isScrubbing,
            timecodeText: currentTimecodeText,
            sourceLabel: sourceLabel,
            entry: timecodeField.snapshot,
            message: message,
            diagnostics: StudioOverlayDiagnostics(
                presentedFrameCount: presentedFrameCount,
                droppedFrameCount: droppedFrameCount,
                retainedFrameCount: renderer.retainedFrameCount,
                hardwareDecodeLabel: hardwareDecodeLabel,
                // "a/v --" when there is no audio, never a measured zero.
                syncLabel: syncMeter?.summaryText ?? "a/v --",
                memoryLabel: memoryLabel,
                cacheHitCount: renderer.cacheHitCount,
                boundTextureCount: renderer.boundTextureCount,
                // Decode sources plus the audio engine when one is attached.
                playerCount: renderer.activeSourceCount + (audioPlayer.isAttached ? 1 : 0)
            )
        )
        // ROUTE-SPECIFIC CONTENT. Source/Audition previews the selected asset
        // "independently of the timeline" (briefing) — so ghosts and the
        // Current/Proposed context belong to Review and are withheld here.
        // Showing a proposal's ghost over the audition viewer would make the
        // two routes the same window twice.
        state.reviewVersion =
            (route == .review && reviewTimeline != nil) ? reviewVersion : nil
        if route == .review, let reviewTimeline {
            state.ghosts = [
                StudioGhostGeometry(
                    proposalId: reviewTimeline.proposalId,
                    startTicks: reviewTimeline.insertionTicks,
                    endTicks: reviewTimeline.insertionTicks + reviewTimeline.spanTicks,
                    isInsertionPoint: reviewVersion == .current
                )
            ]
        }
        // The band reads the SAME position and duration the HUD does — it is a
        // view of the one clock, never a second opinion about time.
        if let transcript {
            state.timeline = StudioTimelineState(
                viewport: state.viewport,
                positionTicks: state.positionTicks,
                durationTicks: state.durationTicks,
                timebase: transport.clock.timebase,
                transcript: transcript,
                selectedSegmentId: selectedSegmentId,
                trim: trim
            )
        }
        return state
    }

    /// Process memory, sampled once a second rather than per frame: task_info is
    /// a kernel call and the display link is not the place for one.
    private var memoryLabel: String {
        let now = CACurrentMediaTime()
        if now - lastMemorySampleHost >= 1.0, let reading = StudioMemoryProbe.read() {
            lastMemorySampleHost = now
            cachedMemoryLabel = String(format: "rss %.0fMB", reading.footprintMegabytes)
        }
        return cachedMemoryLabel
    }

    /// Measured, never inferred — the decoder reports what VideoToolbox actually
    /// chose rather than what was requested.
    private var hardwareDecodeLabel: String {
        switch renderer.diagnostics.sourceDiagnostics?.hardwareDecodeStatus {
        case .hardware: return "hw"
        case .software: return "sw"
        case .unknown, .none: return "hw?"
        }
    }

    /// Rebuilds the clock around a newly opened asset.
    ///
    /// The asset's timebase is authoritative: frame indices computed against a
    /// different rate address the wrong pictures, and the container's stored
    /// rate is the muxer's choice rather than anything the viewer can assume.
    /// Starts audio for a newly opened asset, if it has any.
    ///
    /// Failure is REPORTED AND SURVIVED. A machine with no output device, or an
    /// audio format the engine will not take, must still leave a working silent
    /// viewer — losing the picture because the sound failed would be a strictly
    /// worse outcome than losing the sound.
    func attachAudio(track: StudioAudioTrack?, timebase: StudioTimebase, assetId: String?) {
        audioAssetId = track == nil ? nil : assetId
        sequenceAudioMuted = false
        audioPlayer.detach()
        usingAudioTime = false
        syncMeter = nil
        guard let track else { return }
        do {
            try audioPlayer.attach(track: track, timebase: timebase)
            // Deliberately NOT started here. Opening a file used to begin the
            // sound immediately and from sample zero, so a viewer sitting paused
            // at the head was already audibly playing. reconcileAudio() starts
            // it at whatever position the transport is actually at, when the
            // transport is actually running.
            syncMeter = StudioAvSyncMeter(timebase: timebase)
        } catch {
            message = "audio unavailable: \(error)"
            audioPlayer.detach()
        }
    }

    func adopt(timebase: StudioTimebase, durationTicks: Int64, label: String) {
        transport = StudioTransportController(
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: durationTicks)
        )
        // A half-typed timecode belongs to the PREVIOUS asset's timebase, so
        // carrying it across an open would resolve it against the wrong rate.
        timecodeField.cancel()
        sourceLabel = label
        message = nil
        transport.play(atHost: CACurrentMediaTime())
    }

    func report(message text: String?) {
        message = text
    }

    /// Current playhead as timecode, for diagnostics and for the on-screen
    /// readout a later slice will draw.
    var currentTimecodeText: String {
        (try? transport.currentTimecode(atHost: CACurrentMediaTime()).text) ?? "--:--:--:--"
    }

    // MARK: - Pointer scrubbing

    /// View point (points, bottom-left origin) to the overlay's pixel space
    /// (top-left origin). The overlay is laid out in DRAWABLE pixels, so this
    /// has to scale as well as flip.
    /// Window point -> overlay coordinates: BACKING PIXELS, TOP-LEFT ORIGIN.
    ///
    /// Both halves matter and neither is visible to a Core test, which is handed
    /// an already-converted x. NSView is not flipped, so y must be inverted; the
    /// overlay model is built from the drawable, so points must be scaled. A
    /// headless test window reports backingScaleFactor 1.0, which makes the
    /// scale a no-op there — so the scale is exercised separately against a
    /// windowless view, where the 2.0 fallback below applies.
    func overlayPoint(from event: NSEvent) -> CGPoint {
        let local = convert(event.locationInWindow, from: nil)
        let scale = window?.backingScaleFactor ?? 2.0
        return CGPoint(x: local.x * scale, y: (bounds.height - local.y) * scale)
    }

    override func mouseDown(with event: NSEvent) {
        guard let model = overlayModel, model.isVisible else {
            super.mouseDown(with: event)
            return
        }
        let point = overlayPoint(from: event)

        // The band is tested BEFORE the scrub bar. They do not overlap, but
        // ordering it this way means a future layout change cannot silently
        // turn a trim into a playhead yank.
        if let box = StudioTimelineLayout.hit(atX: point.x, y: point.y, in: model.timeline) {
            beginTimelineGesture(box, in: model)
            return
        }

        // Only the track's grab area starts a scrub. A click anywhere else in
        // the picture must not yank the playhead.
        guard model.grabFrame.contains(x: point.x, y: point.y) else {
            super.mouseDown(with: event)
            return
        }
        let host = CACurrentMediaTime()
        transport.beginScrub(atHost: host)
        transport.updateScrub(
            toTicks: StudioOverlayLayout.ticks(
                atX: point.x,
                in: model,
                durationTicks: transport.clock.durationTicks
            ),
            atHost: host
        )
    }

    override func mouseDragged(with event: NSEvent) {
        if trim != nil, let model = overlayModel {
            updateTimelineDrag(toX: overlayPoint(from: event).x, in: model)
            return
        }
        guard transport.isScrubbing, let model = overlayModel else {
            super.mouseDragged(with: event)
            return
        }
        // Deliberately NOT re-checking the grab area: dragging off the bar and
        // back is normal, and the hit test already clamps to both ends.
        transport.updateScrub(
            toTicks: StudioOverlayLayout.ticks(
                atX: overlayPoint(from: event).x,
                in: model,
                durationTicks: transport.clock.durationTicks
            ),
            atHost: CACurrentMediaTime()
        )
    }

    override func mouseUp(with event: NSEvent) {
        if trim != nil {
            endTimelineDrag()
            return
        }
        guard transport.isScrubbing else {
            super.mouseUp(with: event)
            return
        }
        // Restores whatever the transport was doing before the gesture.
        transport.endScrub(atHost: CACurrentMediaTime())
    }

    /// Loops the AFFECTED RANGE of the open proposal with pre/post-roll.
    ///
    /// Distinct from the transport's In/Out loop, which is the operator's own
    /// mark pair: roll exists so a reviewer sees the CUT rather than the clip,
    /// because looping the inserted span alone shows the new material perfectly
    /// and says nothing about whether it joins. Implemented by BORROWING the
    /// one loop authority rather than adding a second one — and the operator's
    /// marks are parked and restored, not overwritten.
    func toggleReviewLoop(atHost host: CFTimeInterval) {
        if let parked = parkedMarks {
            transport.setLoopingRange(false, atHost: host)
            transport.setInPoint(ticks: parked.inTicks, atHost: host)
            transport.setOutPoint(ticks: parked.outTicks, atHost: host)
            parkedMarks = nil
            report(message: "Review loop off — your In/Out restored")
            return
        }
        guard let reviewTimeline else {
            report(message: "No proposal to review-loop")
            return
        }
        let timebase = transport.clock.timebase
        let roll = StudioProposedTimeline.defaultRollTicks(timebase: timebase)
        guard
            let range = reviewTimeline.reviewRange(
                preRollTicks: roll,
                postRollTicks: roll,
                currentDurationTicks: transport.clock.durationTicks
            )
        else {
            report(message: "Review range is not representable")
            return
        }
        parkedMarks = (transport.inPointTicks, transport.outPointTicks)
        transport.setInPoint(ticks: range.startTicks, atHost: host)
        transport.setOutPoint(ticks: range.endTicks, atHost: host)
        transport.setLoopingRange(true, atHost: host)
        transport.seek(toTicks: range.startTicks, atHost: host)
        let rollFrames = roll / max(1, timebase.frameDurationTicks)
        report(message: "Review loop on — affected range +/- \(rollFrames)f roll")
    }

    /// The HUD line for the current grade. Calls isNeutral so a mode claiming
    /// FX while doing nothing SAYS SO — the guard I wrote for exactly this and
    /// then never invoked.
    var gradeLabel: String {
        switch gradeSettings.mode {
        case .original:
            return "Original"
        case .effect:
            return renderer.isGradeNeutral ? "Effect (no-op — d for 709>sRGB)" : "Effect"
        case .split:
            return renderer.isGradeNeutral
                ? "Split (no-op — d for 709>sRGB)" : "Split compare"
        }
    }

    /// Emits studio/resolveProposal through the SAME serialized writer the trim
    /// proposal uses. A ghost a user can see but cannot accept or reject is a
    /// decoration, not proposal-first editing.
    private func resolveOpenProposal(accept: Bool) {
        guard let reviewTimeline else {
            report(message: "No proposal to resolve")
            return
        }
        let requestId = nextProposalRequestId
        nextProposalRequestId += 1
        StudioOutboundWriter.shared.write(
            StudioProposalRequest.resolveProposal(
                proposalId: reviewTimeline.proposalId,
                accept: accept,
                baseRevision: hostRevision,
                requestId: requestId
            )
        )
        // The host owns the document: the ghost clears when the resulting
        // editCommitted arrives, not optimistically here.
        report(message: accept ? "Accept sent — awaiting host" : "Reject sent — awaiting host")
    }

    // MARK: - Timeline band keyboard

    /// Moves the selection and CUES THE PLAYHEAD to the segment's start.
    /// Selection that did not move the picture would leave an operator reading
    /// a highlight with no idea what was said there.
    private func selectSegment(forward: Bool, atHost host: CFTimeInterval) {
        guard
            let next = StudioTimelineLayout.segmentId(
                steppingFrom: selectedSegmentId, forward: forward, in: transcript)
        else { return }
        selectedSegmentId = next
        trim = nil
        if let segment = transcript?.segments.first(where: { $0.segmentId == next }),
            let range = segment.range(in: transport.clock.timebase)
        {
            transport.seek(toTicks: range.startTicks, atHost: host)
            report(message: segment.text.isEmpty ? next : segment.text)
        }
        needsDisplay = true
    }

    /// Keyboard trim. Opens a drag if none is running, so [ and ] work straight
    /// from a Tab selection without a mouse ever touching the band.
    private func nudgeTrim(handle: StudioTrimHandle, frames: Int64) {
        guard
            let selectedSegmentId,
            let transcript,
            let segment = transcript.segments.first(where: { $0.segmentId == selectedSegmentId }),
            let range = segment.range(in: transport.clock.timebase)
        else { return }
        var drag =
            (trim?.handle == handle && trim?.segmentId == selectedSegmentId)
            ? trim!
            : StudioTrimDrag(
                segmentId: selectedSegmentId,
                assetId: transcript.assetId,
                handle: handle,
                originalStartTicks: range.startTicks,
                originalEndTicks: range.endTicks
            )
        let step = frames * transport.clock.timebase.frameDurationTicks
        // Keyboard nudges do NOT snap: the operator is asking for an exact
        // frame, and a snap would silently discard the precision they chose the
        // keyboard for.
        drag.update(toTicks: drag.currentTicks + step, boundaries: [], toleranceTicks: 0)
        trim = drag
        report(message: "Trim pending — Return to propose, Escape to discard")
        needsDisplay = true
    }

    // MARK: - Timeline band gestures

    /// A click on a segment SELECTS it. A click on a handle of the already
    /// selected segment starts a trim. Selection first means the handles a
    /// drag needs are on screen before the drag can begin, rather than
    /// requiring an operator to hit a 3pt target they cannot see yet.
    private func beginTimelineGesture(_ box: StudioTimelineHitBox, in model: StudioOverlayModel) {
        guard let handle = box.handle else {
            selectedSegmentId = box.segmentId
            trim = nil
            needsDisplay = true
            return
        }
        guard
            let transcript,
            let segment = transcript.segments.first(where: { $0.segmentId == box.segmentId }),
            let range = segment.range(in: transport.clock.timebase)
        else { return }
        trim = StudioTrimDrag(
            segmentId: segment.segmentId,
            assetId: transcript.assetId,
            handle: handle,
            originalStartTicks: range.startTicks,
            originalEndTicks: range.endTicks
        )
        needsDisplay = true
    }

    private func updateTimelineDrag(toX x: Double, in model: StudioOverlayModel) {
        guard var drag = trim else { return }
        drag.update(
            toTicks: StudioTimelineLayout.ticks(
                atX: x,
                in: model.timeline,
                durationTicks: transport.clock.durationTicks
            ),
            boundaries: timelineSnapBoundaries,
            toleranceTicks: timelineSnapToleranceTicks
        )
        trim = drag
        needsDisplay = true
    }

    /// Ends the gesture by PROPOSING. The document is not touched here: the
    /// host owns it, and a trim the host has not accepted must not appear to
    /// have happened.
    private func endTimelineDrag() {
        defer {
            trim = nil
            needsDisplay = true
        }
        guard let drag = trim, let intent = drag.intent else {
            // A degenerate drag - one that inverted or collapsed the segment -
            // proposes nothing rather than emitting an unrepresentable range.
            report(message: "Trim discarded: a segment cannot end before it starts")
            return
        }
        let requestId = nextProposalRequestId
        nextProposalRequestId += 1
        let line = StudioProposalRequest.proposeEdit(
            intent: intent,
            baseRevision: hostRevision,
            proposalId: "trim-\(intent.segmentId)-\(requestId)",
            itemId: intent.segmentId,
            requestId: requestId,
            timebase: transport.clock.timebase
        )
        StudioOutboundWriter.shared.write(line)
        report(
            message: intent.snapped
                ? "Trim proposed, snapped to a transcript boundary"
                : "Trim proposed"
        )
    }

    /// Both of these live in Core so they can be tested: the Companion target
    /// has no test target, and "which boundaries does a handle snap to" is a
    /// decision, not glue.
    private var timelineSnapBoundaries: [Int64] {
        guard let drag = trim else { return [] }
        return StudioTimelineLayout.snapBoundaries(
            transcript: transcript,
            excluding: drag.segmentId,
            timebase: transport.clock.timebase
        )
    }

    private var timelineSnapToleranceTicks: Int64 {
        StudioTimelineLayout.snapToleranceTicks(timebase: transport.clock.timebase)
    }

    // MARK: - Transport keys

    override var acceptsFirstResponder: Bool { true }

    override func keyDown(with event: NSEvent) {
        if handleTimecodeEntry(event) { return }

        let host = CACurrentMediaTime()
        switch event.keyCode {
        case Key.space:
            transport.togglePlayback(atHost: host)
            return
        case Key.tab:
            // Tab walks the transcript band. Without this the accessibility
            // descriptors the band publishes are focusable by nothing, which
            // makes them a claim rather than a control.
            selectSegment(forward: !event.modifierFlags.contains(.shift), atHost: host)
            return
        case Key.escape:
            if trim != nil || selectedSegmentId != nil {
                trim = nil
                selectedSegmentId = nil
                needsDisplay = true
                return
            }
        case Key.returnKey, Key.keypadEnter:
            if trim != nil {
                endTimelineDrag()
                return
            }
        case Key.leftArrow:
            // Shift steps a second at a time, matching the shuttle habit every
            // NLE trains.
            transport.stepFrames(
                event.modifierFlags.contains(.shift) ? -shuttleFrames : -1,
                atHost: host
            )
            return
        case Key.rightArrow:
            transport.stepFrames(
                event.modifierFlags.contains(.shift) ? shuttleFrames : 1,
                atHost: host
            )
            return
        default:
            break
        }

        switch event.charactersIgnoringModifiers?.lowercased() {
        case "i":
            transport.markIn(atHost: host)
        case "o":
            transport.markOut(atHost: host)
        case "l":
            transport.setLoopingRange(!transport.isLoopingRange, atHost: host)
        case "p":
            transport.playRange(atHost: host)
        case "x":
            transport.clearMarks(atHost: host)
        case "w":
            // The route toggle had no input path at all: toggleRoute existed and
            // nothing called it, which is this round's reachable-but-inert shape
            // in the slice that introduced it.
            StudioViewerAppState.shared?.toggleRoute(
                route == .source ? .review : .source)
        case "c":
            toggleReviewLoop(atHost: host)
        case "d":
            // The display transform was implemented, pixel-tested against a CPU
            // oracle, and reachable by nobody: gradeSettings stayed at its
            // default .none forever, so Effect switched program without moving
            // the picture.
            gradeSettings.displayTransform =
                gradeSettings.displayTransform == .none ? .rec709ToSRGB : .none
            renderer.grade = gradeSettings
            report(message: gradeLabel)
        case "g":
            // Original <-> Effect. The mission's guard still binds: a toggle and
            // one supplied LUT, not a grading suite.
            gradeSettings.mode = gradeSettings.mode == .original ? .effect : .original
            renderer.grade = gradeSettings
            report(message: gradeLabel)
        case "s":
            gradeSettings.mode = gradeSettings.mode == .split ? .effect : .split
            renderer.grade = gradeSettings
            report(message: gradeLabel)
        case "v":
            guard route == .review else {
                report(message: "Current/Proposed lives in the Review route (w)")
                break
            }
            toggleReviewVersion()
        case "a":
            resolveOpenProposal(accept: true)
        case "r":
            resolveOpenProposal(accept: false)
        case "[":
            nudgeTrim(handle: .start, frames: event.modifierFlags.contains(.shift) ? -1 : 1)
        case "]":
            nudgeTrim(handle: .end, frames: event.modifierFlags.contains(.shift) ? -1 : 1)
        default:
            super.keyDown(with: event)
        }
    }

    /// Frames a shifted arrow moves: one second at the ASSET'S rate, derived
    /// rather than assumed, so a 25fps clip shuttles 25 and a 29.97 clip 30.
    private var shuttleFrames: Int64 {
        Int64(StudioTimecodeConverter.nominalRate(for: transport.clock.timebase))
    }

    // MARK: - Timecode entry

    /// Returns true when the keystroke belonged to timecode entry.
    ///
    /// A digit STARTS entry, which is how every NLE behaves: you type at the
    /// timecode display, you do not first click into it. Non-digits fall
    /// through so the transport keys keep working mid-entry rather than being
    /// swallowed.
    private func handleTimecodeEntry(_ event: NSEvent) -> Bool {
        if timecodeField.isActive {
            switch event.keyCode {
            case Key.returnKey, Key.keypadEnter:
                commitTimecodeEntry()
                return true
            case Key.escape:
                timecodeField.cancel()
                message = nil
                return true
            case Key.delete:
                return timecodeField.backspace()
            default:
                break
            }
        }

        guard let character = event.charactersIgnoringModifiers?.first,
            character.isNumber,
            character.isASCII
        else {
            return false
        }
        if !timecodeField.isActive {
            // Drop-frame notation only where it is defined; a 25fps asset must
            // never be addressed with a semicolon.
            timecodeField = StudioTimecodeField(
                usesDropFrame: StudioTimecodeConverter.supportsDropFrame(transport.clock.timebase)
            )
            timecodeField.begin()
            message = nil
        }
        return timecodeField.input(character)
    }

    private func commitTimecodeEntry() {
        defer { timecodeField.cancel() }
        guard let text = timecodeField.commitText() else {
            message = nil
            return
        }
        do {
            try transport.seek(toTimecodeText: text, atHost: CACurrentMediaTime())
            message = nil
        } catch {
            // Reported, never approximated: seeking somewhere near a typo is a
            // worse failure than refusing it, and the operator needs to see WHY.
            message = "\(text) is not a valid timecode"
        }
    }

    // MARK: - Accessibility (mission outcome 10 groundwork)

    override func isAccessibilityElement() -> Bool { true }

    override func accessibilityRole() -> NSAccessibility.Role? { .group }

    override func accessibilityLabel() -> String? { "Studio viewer" }

    override func accessibilityChildren() -> [Any]? { accessibilityChildElements }

    /// Rebuilds accessibility children only when the CONTROLS change; otherwise
    /// updates spoken values in place.
    ///
    /// The distinction is load-bearing and I got it wrong first time. A plain
    /// `!=` on the descriptors looks like it prevents churn, and does while
    /// paused — but the playhead and readout descriptors carry the RUNNING
    /// timecode, so during playback the comparison fails on every display-link
    /// tick and this allocated a fresh NSAccessibilityElement per child at frame
    /// rate. Playback is the one state where that matters.
    ///
    /// Throttling the value was the other option and it is worse: it would make
    /// the timecode VoiceOver reads lag the picture. Values are cheap to set;
    /// only the elements are expensive to build.
    private func publishAccessibility(for model: StudioOverlayModel) {
        let incoming = model.accessibilityElements
        let sameControls =
            incoming.count == accessibilityChildElements.count
            && incoming.count == publishedAccessibility.count
            && zip(incoming, publishedAccessibility).allSatisfy { $0.matchesStructure(of: $1) }

        if sameControls {
            // No allocation: update only the values that actually moved.
            for (index, descriptor) in incoming.enumerated()
            where descriptor.value != publishedAccessibility[index].value {
                accessibilityChildElements[index].setAccessibilityValue(descriptor.value)
            }
            publishedAccessibility = incoming
            return
        }

        publishedAccessibility = incoming
        let scale = window?.backingScaleFactor ?? 2.0

        accessibilityChildElements = incoming.map { descriptor in
            let element = NSAccessibilityElement()
            element.setAccessibilityRole(Self.accessibilityRole(for: descriptor.role))
            element.setAccessibilityLabel(descriptor.label)
            element.setAccessibilityValue(descriptor.value)
            element.setAccessibilityParent(self)
            // Descriptor frames are drawable pixels, top-left origin; AppKit
            // wants points in SCREEN space, bottom-left origin.
            let localRect = NSRect(
                x: descriptor.frame.x / scale,
                y: bounds.height - descriptor.frame.maxY / scale,
                width: descriptor.frame.width / scale,
                height: descriptor.frame.height / scale
            )
            if let window {
                element.setAccessibilityFrame(
                    window.convertToScreen(convert(localRect, to: nil))
                )
            }
            return element
        }
    }

    private static func accessibilityRole(
        for role: StudioAccessibilityDescriptor.Role
    ) -> NSAccessibility.Role {
        switch role {
        case .slider: return .slider
        case .staticText: return .staticText
        case .button: return .button
        }
    }
}

/// Owns the viewer window. Held strongly by StudioViewerApp because
/// `NSApplication.delegate` and `NSWindow` do not retain it for us.
@MainActor
final class StudioViewerWindowController {
    let window: NSWindow
    private let view: StudioViewerView
    let route: StudioViewerRoute
    /// This route's OWN renderer, so hiding the route can release its
    /// decoder/player resources without touching the other route's. The
    /// briefing requires exactly that, and one shared renderer could not
    /// deliver it.
    let renderer: StudioViewerRenderer

    init(
        renderer: StudioViewerRenderer,
        authority: StudioPlaybackAuthority,
        route: StudioViewerRoute = .source
    ) {
        self.route = route
        self.renderer = renderer
        view = StudioViewerView(renderer: renderer, authority: authority, route: route)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 540),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = route.windowTitle
        window.contentView = view
        window.center()
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(view)
    }

    func adopt(timebase: StudioTimebase, durationTicks: Int64, label: String) {
        view.adopt(timebase: timebase, durationTicks: durationTicks, label: label)
    }

    func adopt(transcript: StudioTranscript?) {
        view.adopt(transcript: transcript)
    }

    func adopt(reviewTimeline: StudioProposedTimeline?) {
        view.adopt(reviewTimeline: reviewTimeline)
    }

    func adopt(revision: Int) {
        view.adopt(revision: revision)
    }

    func report(message text: String?) {
        view.report(message: text)
    }

    func attachAudio(track: StudioAudioTrack?, timebase: StudioTimebase, assetId: String?) {
        view.attachAudio(track: track, timebase: timebase, assetId: assetId)
    }
}

/// Main-thread home for the live viewer, so the stdio pump can hand over an
/// opened asset without any non-Sendable state crossing a thread boundary: only
/// StudioMediaAsset values travel, and everything else is looked up here.
@MainActor
final class StudioViewerAppState {
    static var shared: StudioViewerAppState?

    let controller: StudioViewerWindowController
    let attachment: StudioMediaAttachment

    /// Route visibility and the resource obligation that rides with it.
    private var routes = StudioRouteVisibility()
    private let reviewController: StudioViewerWindowController?

    /// Everything one pump update means, applied.
    ///
    /// A CORRECTION TO MY OWN CLAIM AT c062d109b. I wrote there that the pump
    /// "no longer knows what a payload is, so it cannot fail to mention one".
    /// That is true OF THE PUMP and it was not the whole story: the enumeration
    /// did not disappear, it MOVED HERE. Adding a field to Step or Hydration
    /// still needs a branch below, and nothing in the compiler asks for it. The
    /// compiler forced this site to be rewritten ONCE; it does not force it to
    /// stay complete.
    ///
    /// So this lives as a named method rather than a closure buried in a Thread
    /// inside run(): the hop that has silently dropped a payload TWICE —
    /// proposals before 5ca5a06e2, the sequence before c062d109b — is now
    /// reachable by a test, and StudioPumpAdoptionTests pins the field counts
    /// so a seventh payload cannot be added without this list being revisited.
    func adopt(update: StudioCompanionStdioPump.Update) async {
        if let revision = update.latestRevision {
            adopt(revision: revision)
        }
        if !update.step.openedAssets.isEmpty {
            await open(assets: update.step.openedAssets)
        }
        if !update.step.transcripts.isEmpty {
            adopt(transcripts: update.step.transcripts)
        }
        if let hydration = update.hydration {
            await adopt(sequence: hydration.sequence, knownAssets: hydration.assets)
        }
        if !update.step.proposals.isEmpty {
            await adopt(proposals: update.step.proposals)
        }
        if !update.step.resolvedProposalIds.isEmpty {
            adopt(resolvedProposals: update.step.resolvedProposalIds)
        }
    }

    init(
        controller: StudioViewerWindowController,
        renderer: StudioViewerRenderer,
        reviewController: StudioViewerWindowController? = nil
    ) {
        self.controller = controller
        self.attachment = StudioMediaAttachment(renderer: renderer)
        self.reviewController = reviewController
    }

    /// Shows or hides a route. HIDING RELEASES THAT ROUTE'S DECODER/PLAYER
    /// RESOURCES, which the briefing requires by name — the transition value
    /// carries the obligation so a caller cannot quietly skip it.
    @discardableResult
    func toggleRoute(_ route: StudioViewerRoute) -> StudioRouteTransition {
        let transition = routes.toggle(route)
        switch transition {
        case .shown(let shown):
            windowController(for: shown)?.show()
            Self.report("route \(shown.rawValue) shown")
        case .hidden(let hidden):
            guard let controller = windowController(for: hidden) else { break }
            controller.window.orderOut(nil)
            // The obligation, discharged where the resources actually live.
            controller.renderer.detachSource()
            controller.renderer.detachProposedSource()
            // Sequence assets are decoder resources too. Adding the keyed
            // collection without extending this release would have made the
            // briefing's obligation quietly incomplete — a hidden route holding
            // N decoders while the code claimed it released everything.
            controller.renderer.detachSequenceSources()
            Self.report(
                "route \(hidden.rawValue) hidden — decoder resources released")
        case .refused(let reason):
            Self.report("route toggle refused: \(reason.rawValue)")
        }
        return transition
    }

    private func windowController(
        for route: StudioViewerRoute
    ) -> StudioViewerWindowController? {
        route == .source ? controller : reviewController
    }

    /// Transcripts the host has sent, keyed by asset. Held across source
    /// switches so that returning to an asset does not need a re-send.
    private var known: [String: StudioTranscript] = [:]
    private var openAssetId: String?
    private var openProposalId: String?
    private var viewerTimebase: StudioTimebase?
    /// Assets the host has opened, keyed by id, so a proposal inserting from a
    /// previously-opened asset can find its media.
    private var proposalAssets: [String: StudioMediaAsset] = [:]

    /// Adopts the host's transcripts. Only the one matching the open asset is
    /// shown: a transcript for a different asset is kept, not drawn, because a
    /// band of somebody else's words over this picture is worse than no band.
    func adopt(revision: Int) {
        controller.adopt(revision: revision)
    }

    /// Adopts open ghosts. The proposal's asset is loaded as a SECOND resident
    /// source so an A/B toggle is instant rather than a reload, and the review
    /// timeline is built in the VIEWER's timebase — the router converts when
    /// indexing the proposed source, which may run at a different rate.
    func adopt(proposals: [StudioEditProposal]) async {
        guard let proposal = proposals.last else { return }
        guard let timebase = viewerTimebase else {
            Self.report("proposal \(proposal.proposalId) held — no media open")
            return
        }
        guard let timeline = StudioProposedTimeline(proposal: proposal, timebase: timebase) else {
            Self.report("proposal \(proposal.proposalId) rejected — unrepresentable range")
            return
        }
        // An insert from the OPEN asset needs no second source; one from another
        // asset does, and if that load fails the ghost is not shown rather than
        // reviewed against the wrong picture.
        if timeline.assetId != openAssetId {
            guard let asset = proposalAssets[timeline.assetId] else {
                Self.report(
                    "proposal \(proposal.proposalId) held — asset \(timeline.assetId) not open")
                return
            }
            let outcome = await attachment.attachProposed(asset: asset)
            guard outcome.didAttach else {
                Self.report("proposal \(proposal.proposalId) held — proposed source failed")
                return
            }
        }
        openProposalId = proposal.proposalId
        controller.adopt(reviewTimeline: timeline)
        Self.report(
            "proposal \(proposal.proposalId) shown — v to compare, a accept, r reject")
    }

    /// A resolved ghost stops being reviewable, whichever way it went.
    func adopt(resolvedProposals ids: [String]) {
        guard let openProposalId, ids.contains(openProposalId) else { return }
        self.openProposalId = nil
        attachment.detachProposed()
        controller.adopt(reviewTimeline: nil)
        Self.report("proposal \(openProposalId) resolved — review cleared")
    }

    /// Adopts the committed timeline and makes the Review route able to PLAY
    /// it: every referenced asset the companion can resolve becomes a resident
    /// decode source keyed by id.
    ///
    /// An asset it cannot resolve is HELD, not substituted — the same refusal
    /// as a foreign-asset proposal. A timeline that silently played the wrong
    /// file at a cut would be worse than one that shows nothing there.
    func adopt(sequence: StudioTimelineSequence, knownAssets: [StudioMediaAsset] = []) async {
        // Hydration's asset list is the ONLY place a sequence's assets are named
        // on a cold start: open_media populates the map for assets the user
        // opened, and a committed timeline routinely references clips this
        // session never opened. Driving the live binary is what exposed that —
        // the first run reported "0 assets resident" for an asset the document
        // plainly carried.
        for asset in knownAssets { proposalAssets[asset.assetId] = asset }
        guard let reviewController else { return }
        guard !sequence.isEmpty else {
            reviewController.renderer.detachSequenceSources()
            return
        }
        var attached = 0
        var held: [String] = []
        for assetId in sequence.referencedAssetIds.sorted() {
            guard let asset = proposalAssets[assetId] else {
                held.append(assetId)
                continue
            }
            let outcome = await StudioMediaAttachment(renderer: reviewController.renderer)
                .attachSequence(asset: asset)
            if outcome.didAttach { attached += 1 } else { held.append(assetId) }
        }
        reviewController.renderer.sequence = sequence
        Self.report(
            "sequence adopted — \(sequence.items.count) items, \(attached) assets resident"
                + (held.isEmpty ? "" : ", held: \(held.joined(separator: ","))"))
    }

    func adopt(transcripts: [StudioTranscript]) {
        for transcript in transcripts {
            known[transcript.assetId] = transcript
            // Reported for the same reason media opens are: a transcript that
            // silently fails to reach the band is indistinguishable from one
            // that arrived, and that is precisely the bug this wiring fixes.
            let shown = transcript.assetId == openAssetId
            Self.report(
                "transcript \(transcript.transcriptId) for \(transcript.assetId)"
                    + " (\(transcript.segments.count) segments, "
                    + (shown ? "shown" : "held — a different asset is open") + ")"
            )
        }
        if let assetId = openAssetId, let match = known[assetId] {
            controller.adopt(transcript: match)
        }
    }

    /// Opens each asset the host committed and points the clock at the last one
    /// that actually loaded. Failures are reported to stderr rather than being
    /// swallowed or crashing the viewer.
    func open(assets: [StudioMediaAsset]) async {
        for asset in assets { proposalAssets[asset.assetId] = asset }
        for outcome in await attachment.attach(openedAssets: assets) {
            switch outcome {
            case .attached(let assetId, let frameCount, let timebase, let durationTicks):
                controller.adopt(
                    timebase: timebase,
                    durationTicks: durationTicks,
                    label: "\(assetId) · \(frameCount) frames"
                )
                // Audio after the clock, so it anchors against the timebase the
                // viewer just adopted rather than the previous asset's.
                controller.attachAudio(
                    track: attachment.attachedAudio,
                    timebase: timebase,
                    assetId: assetId
                )
                // A source switch must not leave the previous asset's words on
                // screen: adopt this asset's transcript, or clear the band.
                openAssetId = assetId
                viewerTimebase = timebase
                controller.adopt(transcript: known[assetId])
                Self.report("opened \(assetId) (\(frameCount) frames)")
            case .failed(let assetId, let message):
                // Surfaced ON SCREEN as well as on stderr: a viewer that fails
                // to open something and says so only in a log the operator
                // cannot see just looks broken.
                controller.report(message: "could not open \(assetId): \(message)")
                Self.report("could not open \(assetId): \(message)")
            }
        }
    }

    private static func report(_ note: String) {
        if let data = "taskwraith-studio-companion: \(note)\n".data(using: .utf8) {
            FileHandle.standardError.write(data)
        }
    }
}

/// Entry point for `--viewer`. Production launch still uses the headless stdio
/// path; this flag is the seam that gets flipped once the viewer is wired into
/// the host's supervisor lifecycle.
enum StudioViewerApp {
    @MainActor private static var retainedController: StudioViewerWindowController?
    @MainActor private static var retainedReviewController: StudioViewerWindowController?

    @MainActor
    static func run(hydrateOnce: Bool) -> Never {
        let renderer: StudioViewerRenderer
        do {
            renderer = try StudioViewerRenderer.makeDefault()
        } catch {
            // No Metal device, or the shader/pipeline failed: fall back to the
            // proven headless behaviour rather than dying, and say why.
            let note = "taskwraith-studio-companion: viewer unavailable (\(error)); running headless\n"
            if let data = note.data(using: .utf8) {
                FileHandle.standardError.write(data)
            }
            exit(StudioCompanionStdioPump.run(hydrateOnce: hydrateOnce))
        }

        // AppKit must own the main thread, so the protocol pump moves to its own
        // thread. It exits the process on EOF exactly as the headless path does.
        // Opened assets hop to the main actor as plain Sendable identities; the
        // renderer itself never crosses a thread boundary.
        let pumpThread = Thread {
            exit(
                StudioCompanionStdioPump.run(hydrateOnce: hydrateOnce) { update in
                    Task { @MainActor in
                        await StudioViewerAppState.shared?.adopt(update: update)
                    }
                }
            )
        }
        pumpThread.name = "taskwraith-studio-stdio"
        pumpThread.start()

        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        // ONE AUTHORITY, TWO ROUTES. The briefing is explicit: "two viewers must
        // never become two clocks". The authority is a reference type held by
        // both routes, so that is a fact about the object graph rather than a
        // convention someone has to maintain.
        let authority = StudioPlaybackAuthority(
            clock: StudioPlaybackClock(timebase: .ntsc2997, durationTicks: 0))
        let controller = StudioViewerWindowController(
            renderer: renderer, authority: authority, route: .source)
        retainedController = controller

        // Review gets its OWN renderer so hiding it can release that route's
        // decoder/player resources without disturbing Source.
        let reviewController = (try? StudioViewerRenderer.makeDefault()).map {
            StudioViewerWindowController(
                renderer: $0, authority: authority, route: .review)
        }
        retainedReviewController = reviewController

        StudioViewerAppState.shared = StudioViewerAppState(
            controller: controller,
            renderer: renderer,
            reviewController: reviewController
        )
        controller.show()
        application.activate()
        application.run()
        exit(0)
    }
}
