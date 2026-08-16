import AppKit
import Metal
import QuartzCore
import TaskWraithStudioCore

/// Only one visible route may schedule the shared device player. This is
/// separate from StudioPlaybackAuthority: the latter answers content time; this
/// gate prevents two display links from trying to re-anchor that same authority.
@MainActor
final class StudioAudioSchedulingAuthority {
    private(set) var owner: StudioViewerRoute

    init(owner: StudioViewerRoute = .source) {
        self.owner = owner
    }

    func activate(_ route: StudioViewerRoute) {
        owner = route
    }

    func permits(_ route: StudioViewerRoute) -> Bool {
        owner == route
    }
}

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
    /// VoiceOver (and any other AX client) scrubs through this binding. Tests
    /// revert it to prove a value-set does nothing when unbound. Production
    /// leaves it bound so there is still exactly one transport authority.
    var playheadAccessibilityBinding = StudioPlayheadAccessibilityBinding()
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
    var transcriptSegmentCount: Int { transcript?.segments.count ?? 0 }
    private var trim: StudioTrimDrag?
    /// The revision the operator is looking at. Proposals cite it as their base.
    private var hostRevision = 0
    /// The base revision the next proposal/resolve will cite. Internal for
    /// tests; production code sets it through adopt(revision:).
    var nextProposalBaseRevision: Int { hostRevision }
    /// The open ghost being reviewed, or nil. Built by the Companion from a
    /// proposal the pump now forwards; before this the renderer's review
    /// machinery existed and NOTHING CALLED IT.
    private var reviewTimeline: StudioProposedTimeline?
    private var reviewVersion: StudioReviewVersion = .current
    var hasOpenReview: Bool { reviewTimeline != nil }
    /// The exact review request the visible Review controller supplies to its
    /// renderer. Keeping this observable lets the Companion integration test
    /// render the controller-adopted ghost rather than recreating a lookalike
    /// context beside the product path.
    var activeReviewContext: StudioReviewContext? {
        guard route == .review, let reviewTimeline else { return nil }
        return StudioReviewContext(
            version: reviewVersion,
            timeline: reviewTimeline,
            timebase: transport.clock.timebase
        )
    }
    /// The operator's own In/Out, parked while the review loop borrows the
    /// transport's one loop authority. Restored on exit — overwriting an
    /// operator's marks to loop a proposal would make one of the two features
    /// unusable, and they are DIFFERENT features.
    var parkedMarks: (inTicks: Int64?, outTicks: Int64?)?
    /// Grading is Core-complete and was unreachable: no Companion code built a
    /// non-default settings value, so the product was pinned to Original.
    var gradeSettings = StudioGradeSettings()

    /// True only while Effect is on BECAUSE a LUT arrived, rather than because
    /// the operator asked for it. The distinction is the whole point: an
    /// automatic mode may be handed back automatically when the LUT goes away,
    /// but a mode the operator chose is theirs and must survive.
    private(set) var gradeModeAutoEnabledByEffectPreview = false

    /// Previews a newly resident LUT, or returns the picture when it is cleared.
    ///
    /// WHY THIS EXISTS. The host validated the cube, the supervisor delivered
    /// it, and both renderers uploaded it — and the operator saw nothing,
    /// because the viewer stayed in `.original` and the shader bypassed the LUT
    /// entirely. Loading a LUT has to preview it; a Load that changes no pixel
    /// is indistinguishable from a Load that failed.
    ///
    /// Called only after BOTH routes accept the upload, so a partial failure
    /// can never leave one window graded and the other not.
    func applyEffectPreviewGradeMode(active: Bool, isFirstActivation: Bool) {
        if active {
            // Only an inactive -> active transition may take the mode.
            // Replacing an already-resident LUT must not overrule an operator
            // who has since pressed g and gone back to Original.
            guard isFirstActivation, gradeSettings.mode == .original else { return }
            gradeSettings.mode = .effect
            gradeModeAutoEnabledByEffectPreview = true
            renderer.grade = gradeSettings
            return
        }
        // Clearing hands back only what was taken automatically.
        guard gradeModeAutoEnabledByEffectPreview else { return }
        gradeSettings.mode = .original
        gradeModeAutoEnabledByEffectPreview = false
        renderer.grade = gradeSettings
    }
    /// Monotonic within this process, and started above hello/getDocument so a
    /// proposal id can never collide with them.
    private var nextProposalRequestId = StudioProposalRequest.firstProposalRequestId
    /// The overlay layout most recently drawn. Hit testing and accessibility
    /// both read it, so neither re-derives geometry the renderer might disagree
    /// with.
    /// Audio output, and the measured sync between what is seen and heard.
    /// Held here because the display link is the only place that observes a
    /// presented frame, which is one half of the measurement.
    /// One process-wide device player is injected through both route controllers.
    /// Source and Review therefore share an oscillator as well as the playback
    /// authority; a cut changes its resident track, not the number of players.
    private let audioPlayer: StudioAudioPlayer

    var audioPlayerIdentity: ObjectIdentifier {
        ObjectIdentifier(audioPlayer)
    }
    /// The one route allowed to schedule that shared device player.
    let audioSchedulingAuthority: StudioAudioSchedulingAuthority
    /// The app state owns leases; this callback releases this route's pool lease
    /// when AppKit closes its window without invalidating a shared decoder.
    var onPresentationDetached: (() -> Void)?
    var onPresentationStateChanged: (() -> Void)?
    /// Which asset the attached sound came from. Nil when nothing is attached.
    private var audioAssetId: String?
    /// Sequence PCM must already be resident in the Review attachment. A nil
    /// result is silence; it is never a request to reopen the last clip.
    private var sequenceAudioProvider: ((String) -> StudioResidentAudio?)?
    /// Source is audition material while Review owns a committed timeline, so it
    /// must not fight Review for the shared device player.
    private var suspendsLocalAudioForSequence = false
    /// Maps the content ticks used to schedule the current clip back into the
    /// one timeline clock for diagnostics and correction accounting.
    private var audioContentAnchorTicks: Int64?
    private var audioTimelineAnchorTicks: Int64?
    private var syncMeter: StudioAvSyncMeter?
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
        route: StudioViewerRoute = .source,
        audioPlayer: StudioAudioPlayer? = nil,
        audioSchedulingAuthority: StudioAudioSchedulingAuthority? = nil
    ) {
        self.renderer = renderer
        self.authority = authority
        self.route = route
        self.audioPlayer = audioPlayer ?? StudioAudioPlayer()
        self.audioSchedulingAuthority = audioSchedulingAuthority
            ?? StudioAudioSchedulingAuthority(owner: route)
        super.init(frame: NSRect(x: 0, y: 0, width: 960, height: 540))
        wantsLayer = true
        layerContentsRedrawPolicy = .duringViewResize
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("StudioViewerView is created in code only")
    }

    /// Review receives only a lookup over media that is already leased. This
    /// closure is installed by StudioViewerAppState after it has built both
    /// route attachments, so this view cannot create a duplicate decoder.
    func configureSequenceAudio(
        provider: @escaping (String) -> StudioResidentAudio?,
        suspendsLocalAudio: Bool = false
    ) {
        sequenceAudioProvider = provider
        suspendsLocalAudioForSequence = suspendsLocalAudio
    }

    func setLocalAudioSuspendedForSequence(_ suspended: Bool) {
        suspendsLocalAudioForSequence = suspended
        if suspended, audioSchedulingAuthority.permits(route) {
            audioPlayer.silence()
        }
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
            // App state releases this route's lease. Calling renderer.detachSource
            // directly would default-invalidate a decoder the other route may
            // still lease from the shared pool.
            if audioSchedulingAuthority.permits(route) {
                audioPlayer.silence()
            }
            onPresentationDetached?()
            return
        }

        updateDrawableSize()
        mutateTransport(.lifecycleAttach) { controller, host in
            controller.play(atHost: host)
        }

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
    ///
    /// DOMAIN SAFETY: the audio clock and CACurrentMediaTime() have different
    /// origins. Mixing them teleports the playhead by the difference (machine
    /// uptime on a long-running host), which clamps to end-of-media and looks
    /// like a 600 s jump in ~2 s. The anchor is written in the SAME domain this
    /// property returns, so never switch domains while the anchor is live.
    private var transportHostSeconds: Double { transportMutationHostReading.seconds }

    /// THE HOST CLOCK EVERY TRANSPORT MUTATION MUST USE.
    ///
    /// While audio drives playback the live anchor is AUDIO-RELATIVE and starts
    /// near zero, whereas `CACurrentMediaTime()` is machine uptime and is on the
    /// order of 1e5 seconds. Handing the second to a clock anchored in the first
    /// makes `elapsed = hostSeconds - anchorHostSeconds` about the machine's
    /// entire uptime, which the duration clamp turns into an instant jump to
    /// end-of-media — the packaged 4.133s -> 600s teleport.
    ///
    /// It reads the same source the renderer reads, so a mutation can never
    /// disagree with the picture about what time it is. Every mutation in this
    /// view routes through here; none may call `CACurrentMediaTime()` directly.
    private struct TransportMutationSignature: Equatable {
        let clock: StudioPlaybackClock
        let inPointTicks: Int64?
        let outPointTicks: Int64?
        let isLoopingRange: Bool
        let isScrubbing: Bool

        init(_ controller: StudioTransportController) {
            clock = controller.clock
            inPointTicks = controller.inPointTicks
            outPointTicks = controller.outPointTicks
            isLoopingRange = controller.isLoopingRange
            isScrubbing = controller.isScrubbing
        }
    }

    private struct TransportHostReading {
        let source: StudioTransportHostSource
        let seconds: Double
    }

    /// One bounded retained record on the shared authority. Display-link reads
    /// never assign it, and either route sees the same latest mutation.
    var lastTransportMutation: StudioTransportMutationRecord? {
        authority.lastTransportMutation
    }

    private var transportMutationHostReading: TransportHostReading {
        if authority.transportHostSource == .audio {
            return TransportHostReading(
                source: .audio,
                seconds: audioPlayer.audioHostSeconds() ?? authority.lastAudioHostSeconds
            )
        }
        return TransportHostReading(source: .machine, seconds: CACurrentMediaTime())
    }
    var transportMutationHostSeconds: Double { transportMutationHostReading.seconds }

    private func transportMutationRecord(
        kind: StudioTransportMutationKind,
        before: StudioTransportController,
        beforeSource: StudioTransportHostSource,
        beforeHost: Double,
        after: StudioTransportController,
        afterSource: StudioTransportHostSource,
        afterHost: Double,
        previousHost: Double?
    ) -> StudioTransportMutationRecord {
        let beforeClock = before.clock
        let afterClock = after.clock
        return StudioTransportMutationRecord(
            kind: kind,
            route: route,
            beforeSource: beforeSource,
            afterSource: afterSource,
            suppliedHostSeconds: afterHost,
            previousHostSeconds: previousHost,
            beforeAnchorTicks: beforeClock.diagnosticAnchorTicks,
            beforeAnchorHostSeconds: beforeClock.diagnosticAnchorHostSeconds,
            beforePositionTicks: beforeClock.positionTicks(atHost: beforeHost),
            beforeDurationTicks: beforeClock.durationTicks,
            beforeIsPlaying: beforeClock.snapshot(atHost: beforeHost).isPlaying,
            beforeRate: beforeClock.rate,
            afterAnchorTicks: afterClock.diagnosticAnchorTicks,
            afterAnchorHostSeconds: afterClock.diagnosticAnchorHostSeconds,
            afterPositionTicks: afterClock.positionTicks(atHost: afterHost),
            afterDurationTicks: afterClock.durationTicks,
            afterIsPlaying: afterClock.snapshot(atHost: afterHost).isPlaying,
            afterRate: afterClock.rate
        )
    }

    private func retainTransportMutation(
        _ kind: StudioTransportMutationKind,
        before: StudioTransportController,
        beforeReading: TransportHostReading,
        after: StudioTransportController,
        afterReading: TransportHostReading,
        previousHost: Double?,
        recordsDeclaredTransition: Bool = false
    ) {
        let controllerChanged =
            TransportMutationSignature(before) != TransportMutationSignature(after)
        guard controllerChanged || recordsDeclaredTransition else {
            return
        }
        transport = after
        let record = transportMutationRecord(
            kind: kind,
            before: before,
            beforeSource: beforeReading.source,
            beforeHost: beforeReading.seconds,
            after: after,
            afterSource: afterReading.source,
            afterHost: afterReading.seconds,
            previousHost: previousHost
        )
        authority.retainTransportMutation(record)
    }

    private func mutateTransport(
        _ kind: StudioTransportMutationKind,
        _ body: (inout StudioTransportController, Double) -> Void
    ) {
        let reading = transportMutationHostReading
        let before = transport
        var after = before
        body(&after, reading.seconds)
        retainTransportMutation(
            kind,
            before: before,
            beforeReading: reading,
            after: after,
            afterReading: reading,
            previousHost: nil
        )
    }

    @discardableResult
    private func mutateTransportIfAccepted(
        _ kind: StudioTransportMutationKind,
        _ body: (inout StudioTransportController, Double) -> Bool
    ) -> Bool {
        let reading = transportMutationHostReading
        let before = transport
        var after = before
        let accepted = body(&after, reading.seconds)
        guard accepted else { return false }
        retainTransportMutation(
            kind,
            before: before,
            beforeReading: reading,
            after: after,
            afterReading: reading,
            previousHost: nil
        )
        return true
    }

    private func mutateTransportThrowing(
        _ kind: StudioTransportMutationKind,
        _ body: (inout StudioTransportController, Double) throws -> Void
    ) throws {
        let reading = transportMutationHostReading
        let before = transport
        var after = before
        try body(&after, reading.seconds)
        retainTransportMutation(
            kind,
            before: before,
            beforeReading: reading,
            after: after,
            afterReading: reading,
            previousHost: nil
        )
    }

    /// Explicit source transitions cannot use the ordinary same-domain wrapper:
    /// their old and new hosts intentionally come from different oscillators.
    func mutateTransportForSourceTransition(
        _ kind: StudioTransportMutationKind,
        beforeSource: StudioTransportHostSource,
        beforeHost: Double,
        afterSource: StudioTransportHostSource,
        afterHost: Double,
        _ body: (inout StudioTransportController) -> Void
    ) {
        let before = transport
        var after = before
        body(&after)
        retainTransportMutation(
            kind,
            before: before,
            beforeReading: TransportHostReading(source: beforeSource, seconds: beforeHost),
            after: after,
            afterReading: TransportHostReading(source: afterSource, seconds: afterHost),
            previousHost: beforeHost,
            recordsDeclaredTransition: true
        )
        authority.didReanchorTransport(to: afterSource, atHost: afterHost)
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
        guard audioSchedulingAuthority.permits(route) else { return }
        let audioSeconds = audioPlayer.audioHostSeconds()
        let audioActive = audioSeconds != nil
        let wasUsingAudio = authority.transportHostSource == .audio

        guard audioActive != wasUsingAudio else {
            if let audioSeconds {
                authority.didObserveAudioHostSeconds(audioSeconds)
            }
            return
        }

        let beforeSource = authority.transportHostSource
        let previousHost =
            wasUsingAudio ? authority.lastAudioHostSeconds : CACurrentMediaTime()
        let position = transport.clock.positionTicks(atHost: previousHost)
        let wasPlaying = transport.clock.snapshot(atHost: previousHost).isPlaying
        let afterSource: StudioTransportHostSource = audioActive ? .audio : .machine
        let nextHost = audioActive ? (audioSeconds ?? 0) : CACurrentMediaTime()

        mutateTransportForSourceTransition(
            .oscillatorReconciliation,
            beforeSource: beforeSource,
            beforeHost: previousHost,
            afterSource: afterSource,
            afterHost: nextHost
        ) { controller in
            controller.seek(toTicks: position, atHost: nextHost)
            if wasPlaying { controller.play(atHost: nextHost) }
        }
        // Statistics from before an oscillator change describe a different
        // pipeline, so they are discarded rather than carried forward.
        syncMeter?.reset()
    }

    /// Keeps the one device player content-addressed to whatever the active
    /// route renders. Review supplies source ticks for the selected timeline
    /// item; a gap or unresolved asset is affirmative silence, never last-track
    /// fallback. Source deliberately abstains while Review owns a timeline.
    private func reconcileAudio() {
        guard audioSchedulingAuthority.permits(route) else { return }
        if route == .source, suspendsLocalAudioForSequence { return }

        let snapshot = transport.clock.snapshot(atHost: transportHostSeconds)
        var contentTicks = snapshot.positionTicks
        var timelineTicks = snapshot.positionTicks
        var isSequenceAudio = false

        if route == .review, let sequence = renderer.sequence, !sequence.isEmpty {
            switch StudioSequenceAudioPolicy.selection(in: sequence, atTicks: snapshot.positionTicks) {
            case .silence:
                audioContentAnchorTicks = nil
                audioTimelineAnchorTicks = nil
                audioPlayer.silence()
                return
            case .play(let assetId, let sourceTicks):
                guard let resident = sequenceAudioProvider?(assetId),
                    resident.assetId == assetId
                else {
                        message = "sequence audio silent — \(assetId) is unavailable"
                    audioContentAnchorTicks = nil
                    audioTimelineAnchorTicks = nil
                    audioPlayer.silence()
                    return
                }
                if audioAssetId != assetId || !audioPlayer.hasAudio {
                    attachAudio(
                        track: resident.track,
                        timebase: resident.timebase,
                        syncTimebase: transport.clock.timebase,
                        assetId: assetId
                    )
                }
                contentTicks = StudioSequenceAudioPolicy.reexpress(
                    sourceTicks: sourceTicks,
                    from: sequence.timebase ?? transport.clock.timebase,
                    into: resident.timebase
                )
                timelineTicks = snapshot.positionTicks
                isSequenceAudio = true
            }
        }

        guard audioPlayer.hasAudio else { return }
        let decision = StudioAudioSyncPolicy.decide(
            transportIsPlaying: snapshot.isPlaying,
            intendedTicks: contentTicks,
            audioEndTicks: audioPlayer.endTicks,
            audioIsPlaying: audioPlayer.isPlaying,
            audioPositionTicks: audioPlayer.reading()?.positionTicks,
            toleranceTicks: StudioAudioSyncPolicy.toleranceTicks(
                for: transport.clock.timebase
            )
        )
        switch decision {
        case .leave:
            return
        case .pause:
            audioPlayer.pause()
        case .reschedule(let ticks):
            reschedule(
                audioAt: ticks,
                transportAt: isSequenceAudio ? timelineTicks : ticks,
                expectedAssetId: audioAssetId
            )
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
    private func reschedule(
        audioAt contentTicks: Int64,
        transportAt timelineTicks: Int64,
        expectedAssetId: String?
    ) {
        let beforeReading = transportMutationHostReading
        do {
            guard try audioPlayer.play(
                fromTicks: contentTicks,
                expectedAssetId: expectedAssetId
            ) else { return }
        } catch {
            message = "audio unavailable: \(error)"
            audioPlayer.detach()
            return
        }
        guard let nextHost = audioPlayer.audioHostSeconds() else { return }
        // The player reads CONTENT; the authority remains the timeline. They
        // may have different origins at a cut, so never seek the authority to
        // sourceTicks by accident.
        mutateTransportForSourceTransition(
            .audioReschedule,
            beforeSource: beforeReading.source,
            beforeHost: beforeReading.seconds,
            afterSource: .audio,
            afterHost: nextHost
        ) { controller in
            controller.seek(toTicks: timelineTicks, atHost: nextHost)
            controller.play(atHost: nextHost)
        }
        audioContentAnchorTicks = contentTicks
        audioTimelineAnchorTicks = timelineTicks
        // Sync statistics from before the restart were measured against a
        // different anchor, so they describe a pipeline that no longer exists.
        syncMeter?.reset()
    }

    /// Audio reports content ticks. The sync meter compares against the one
    /// timeline authority, so sequence playback maps from the last cut anchor
    /// before recording a measurement. Source playback has identical origins.
    private func audibleTimelinePositionTicks() -> Int64? {
        guard let audible = audioPlayer.audiblePositionTicks() else { return nil }
        guard let content = audioContentAnchorTicks, let timeline = audioTimelineAnchorTicks else {
            return audible
        }
        return timeline &+ (audible &- content)
    }

    func renderCurrentFrame() {
        guard let metalLayer else { return }
        reconcileAudio()
        reconcileTimeSource()
        let snapshot = transport.clock.snapshot(atHost: transportHostSeconds)
        // Wall clock at the instant the frame was CHOSEN. The audio playhead is
        // not read until after nextDrawable(), the overlay build and the inline
        // decode below, so the two operands of the sync measurement are
        // separated by an interval nothing was previously measuring. Two
        // monotonic reads per tick, no allocation, and nothing downstream
        // depends on the value — playback is unchanged whether it is taken or
        // not.
        let snapshotUptimeNanoseconds = DispatchTime.now().uptimeNanoseconds
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
            review: activeReviewContext
        )
        // MEASURED A/V SYNC, against the audio hardware's own playhead.
        //
        // EVERY tick is recorded, drawn or not. The comment that stood here said
        // a dropped frame is not evidence about sync — which is true of the
        // frame that failed to arrive and FALSE of the frame still on screen,
        // and the distinction is the whole instrument. Left uncorrected it
        // would read as a justification for restoring the exclusion.
        if let audible = audibleTimelinePositionTicks() {
            // Closed at the audio read, so the window spans exactly the interval
            // that can inflate this error: drawable wait, overlay build, and the
            // synchronous decode. It explains the number; it never softens it.
            let measurementWindowNanoseconds =
                DispatchTime.now().uptimeNanoseconds &- snapshotUptimeNanoseconds
            if outcome.didDraw {
                syncMeter?.record(
                    presentedFrameTicks: transport.clock.ticks(ofFrame: snapshot.frameIndex),
                    audiblePositionTicks: audible,
                    measurementWindowNanoseconds: measurementWindowNanoseconds
                )
            } else {
                // A dropped frame leaves the PREVIOUS picture on screen while
                // sound carries on. That is the desync, and the old
                // `if outcome.didDraw` gate excluded exactly it — so the meter
                // sampled only healthy ticks and its reading was bounded by
                // frame quantisation whatever the pipeline was doing.
                syncMeter?.recordDroppedFrame(
                    audiblePositionTicks: audible,
                    measurementWindowNanoseconds: measurementWindowNanoseconds
                )
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
            if parkedMarks != nil { toggleReviewLoop() }
        }
        needsDisplay = true
        onPresentationStateChanged?()
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
        onPresentationStateChanged?()
    }

    func performReviewVersionShortcut() {
        guard route == .review else {
            report(message: "Current/Proposed lives in the Review route (w)")
            return
        }
        toggleReviewVersion()
    }

    func adopt(transcript: StudioTranscript?) {
        guard transcript != self.transcript else { return }
        self.transcript = transcript
        selectedSegmentId = nil
        trim = nil
    }

    func overlayState(
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
            timecodeText: timecodeText(for: snapshot),
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
                // Accessibility-only. Nil until a reading exists, so no
                // descriptor is published before there is something to read.
                syncDetail: syncMeter?.peakSample?.diagnosticsExportText,
                syncCurrentDetail: syncMeter?.currentDiagnosticsExportText,
                transportMutationDetail: lastTransportMutation?.diagnosticsExportText,
                memoryLabel: memoryLabel,
                cacheHitCount: renderer.cacheHitCount,
                boundTextureCount: renderer.boundTextureCount,
                // The injected device player is shared by both routes. Source
                // deliberately abstains while Review is running a sequence, so
                // do not double-count that one engine in diagnostics.
                playerCount: renderer.activeSourceCount
                    + ((route == .source && suspendsLocalAudioForSequence)
                        ? 0
                        : (audioPlayer.isAttached ? 1 : 0))
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
    func attachAudio(
        track: StudioAudioTrack?,
        timebase: StudioTimebase,
        syncTimebase: StudioTimebase? = nil,
        assetId: String?
    ) {
        audioAssetId = track == nil ? nil : assetId
        audioContentAnchorTicks = nil
        audioTimelineAnchorTicks = nil
        audioPlayer.detach()
        syncMeter = nil
        guard let track else { return }
        do {
            try audioPlayer.attach(track: track, timebase: timebase, assetId: assetId)
            // Deliberately NOT started here. Opening a file used to begin the
            // sound immediately and from sample zero, so a viewer sitting paused
            // at the head was already audibly playing. reconcileAudio() starts
            // it at whatever position the transport is actually at, when the
            // transport is actually running.
            syncMeter = StudioAvSyncMeter(timebase: syncTimebase ?? timebase)
        } catch {
            message = "audio unavailable: \(error)"
            audioPlayer.detach()
        }
    }

    func adopt(timebase: StudioTimebase, durationTicks: Int64, label: String) {
        mutateTransport(.lifecycleOpen) { controller, host in
            controller = StudioTransportController(
                clock: StudioPlaybackClock(timebase: timebase, durationTicks: durationTicks)
            )
            controller.play(atHost: host)
        }
        // A half-typed timecode belongs to the PREVIOUS asset's timebase, so
        // carrying it across an open would resolve it against the wrong rate.
        timecodeField.cancel()
        sourceLabel = label
        message = nil
    }

    func report(message text: String?) {
        message = text
    }

    /// Timecode text for a snapshot already taken from the one transport clock.
    /// The overlay uses this so its readout agrees with the frame it is drawing,
    /// instead of taking a second sample that can mix absolute host time with
    /// the audio-relative transport epoch.
    private func timecodeText(for snapshot: StudioTransportSnapshot) -> String {
        (try? StudioTimecodeConverter.timecode(
            forFrame: snapshot.frameIndex,
            timebase: transport.clock.timebase
        ).text) ?? "--:--:--:--"
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
        let ticks = StudioOverlayLayout.ticks(
            atX: point.x,
            in: model,
            durationTicks: transport.clock.durationTicks
        )
        mutateTransport(.scrubBegin) { controller, host in
            controller.beginScrub(atHost: host)
            controller.updateScrub(toTicks: ticks, atHost: host)
        }
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
        let ticks = StudioOverlayLayout.ticks(
            atX: overlayPoint(from: event).x,
            in: model,
            durationTicks: transport.clock.durationTicks
        )
        mutateTransport(.scrubMove) { controller, host in
            controller.updateScrub(toTicks: ticks, atHost: host)
        }
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
        mutateTransport(.scrubEnd) { controller, host in
            controller.endScrub(atHost: host)
        }
    }

    /// Loops the AFFECTED RANGE of the open proposal with pre/post-roll.
    ///
    /// Distinct from the transport's In/Out loop, which is the operator's own
    /// mark pair: roll exists so a reviewer sees the CUT rather than the clip,
    /// because looping the inserted span alone shows the new material perfectly
    /// and says nothing about whether it joins. Implemented by BORROWING the
    /// one loop authority rather than adding a second one — and the operator's
    /// marks are parked and restored, not overwritten.
    func toggleReviewLoop() {
        if let parked = parkedMarks {
            mutateTransport(.markOrLoop) { controller, host in
                controller.setLoopingRange(false, atHost: host)
                controller.setInPoint(ticks: parked.inTicks, atHost: host)
                controller.setOutPoint(ticks: parked.outTicks, atHost: host)
            }
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
        let operatorMarks = (transport.inPointTicks, transport.outPointTicks)
        mutateTransport(.markOrLoop) { controller, host in
            controller.setInPoint(ticks: range.startTicks, atHost: host)
            controller.setOutPoint(ticks: range.endTicks, atHost: host)
            controller.setLoopingRange(true, atHost: host)
            controller.seek(toTicks: range.startTicks, atHost: host)
        }
        parkedMarks = operatorMarks
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
    private func selectSegment(forward: Bool) {
        guard
            let next = StudioTimelineLayout.segmentId(
                steppingFrom: selectedSegmentId, forward: forward, in: transcript)
        else { return }
        selectedSegmentId = next
        trim = nil
        if let segment = transcript?.segments.first(where: { $0.segmentId == next }),
            let range = segment.range(in: transport.clock.timebase)
        {
            mutateTransport(.transcriptCueSeek) { controller, host in
                controller.seek(toTicks: range.startTicks, atHost: host)
            }
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

    /// THE ONE TRANSPORT TOGGLE.
    ///
    /// Space and the accessibility Playback control both land here, so the two
    /// cannot drift into different behaviour — a keyboard path and an
    /// assistive path that disagree about what "play" means is a defect that
    /// only shows up for the people relying on the second one.
    ///
    /// Audio follows the transport through the existing per-tick
    /// `reconcileAudio()`; nothing here schedules or re-anchors it.
    @discardableResult
    func performPlaybackToggle(_ kind: StudioTransportMutationKind) -> Bool {
        mutateTransport(kind) { controller, host in
            controller.togglePlayback(atHost: host)
        }
        return true
    }

    override func keyDown(with event: NSEvent) {
        if handleTimecodeEntry(event) { return }

        switch event.keyCode {
        case Key.space:
            performPlaybackToggle(.playbackToggleKey)
            return
        case Key.tab:
            // Tab walks the transcript band. Without this the accessibility
            // descriptors the band publishes are focusable by nothing, which
            // makes them a claim rather than a control.
            selectSegment(forward: !event.modifierFlags.contains(.shift))
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
            mutateTransport(.frameStepKey) { controller, host in
                controller.stepFrames(
                    event.modifierFlags.contains(.shift) ? -shuttleFrames : -1,
                    atHost: host
                )
            }
            return
        case Key.rightArrow:
            mutateTransport(.frameStepKey) { controller, host in
                controller.stepFrames(
                    event.modifierFlags.contains(.shift) ? shuttleFrames : 1,
                    atHost: host
                )
            }
            return
        default:
            break
        }

        switch event.charactersIgnoringModifiers?.lowercased() {
        case "i":
            mutateTransport(.markOrLoop) { $0.markIn(atHost: $1) }
        case "o":
            mutateTransport(.markOrLoop) { $0.markOut(atHost: $1) }
        case "l":
            mutateTransportIfAccepted(.markOrLoop) { controller, host in
                controller.setLoopingRange(!controller.isLoopingRange, atHost: host)
            }
        case "p":
            mutateTransportIfAccepted(.markOrLoop) { $0.playRange(atHost: $1) }
        case "x":
            mutateTransport(.markOrLoop) { $0.clearMarks(atHost: $1) }
        case "w":
            // The route toggle had no input path at all: toggleRoute existed and
            // nothing called it, which is this round's reachable-but-inert shape
            // in the slice that introduced it.
            StudioViewerAppState.shared?.toggleRoute(
                route == .source ? .review : .source)
        case "c":
            toggleReviewLoop()
        case "d":
            // The display transform was implemented, pixel-tested against a CPU
            // oracle, and reachable by nobody: gradeSettings stayed at its
            // default .none forever, so Effect switched program without moving
            // the picture.
            gradeSettings.displayTransform =
                gradeSettings.displayTransform == .none ? .rec709ToSRGB : .none
            // The operator has taken the grade. From here a cleared LUT must
            // leave their choice alone.
            gradeModeAutoEnabledByEffectPreview = false
            renderer.grade = gradeSettings
            report(message: gradeLabel)
        case "g":
            // Original <-> Effect. The mission's guard still binds: a toggle and
            // one supplied LUT, not a grading suite.
            gradeSettings.mode = gradeSettings.mode == .original ? .effect : .original
            gradeModeAutoEnabledByEffectPreview = false
            renderer.grade = gradeSettings
            report(message: gradeLabel)
        case "s":
            gradeSettings.mode = gradeSettings.mode == .split ? .effect : .split
            gradeModeAutoEnabledByEffectPreview = false
            renderer.grade = gradeSettings
            report(message: gradeLabel)
        case "v":
            performReviewVersionShortcut()
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
            try mutateTransportThrowing(.timecodeSeek) { controller, host in
                try controller.seek(toTimecodeText: text, atHost: host)
            }
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
            // The playhead slider publishes ticks in place. Calling
            // setAccessibilityValue here would treat a refresh as a seek.
            let snapshot = transport.clock.snapshot(atHost: transportHostSeconds)
            for (index, descriptor) in incoming.enumerated()
            where descriptor.value != publishedAccessibility[index].value {
                if let playhead = accessibilityChildElements[index]
                    as? StudioPlayheadAccessibilityElement
                {
                    playhead.publish(
                        ticks: snapshot.positionTicks,
                        durationTicks: transport.clock.durationTicks,
                        spoken: descriptor.value
                    )
                } else {
                    accessibilityChildElements[index].setAccessibilityValue(descriptor.value)
                }
            }
            publishedAccessibility = incoming
            return
        }

        publishedAccessibility = incoming
        let scale = window?.backingScaleFactor ?? 2.0
        let snapshot = transport.clock.snapshot(atHost: transportHostSeconds)

        accessibilityChildElements = incoming.map { descriptor in
            if descriptor.role == .slider && descriptor.label == "Playhead" {
                let playhead = StudioPlayheadAccessibilityElement()
                playhead.publish(
                    ticks: snapshot.positionTicks,
                    durationTicks: transport.clock.durationTicks,
                    spoken: descriptor.value
                )
                playhead.applyValue = { [weak self] value in
                    guard let self else { return false }
                    return self.mutateTransportIfAccepted(.playheadAccessibilitySet) {
                        controller, host in
                        self.playheadAccessibilityBinding.apply(
                            value,
                            to: &controller,
                            atHost: host
                        )
                    }
                }
                playhead.applyStep = { [weak self] delta in
                    guard let self else { return false }
                    return self.mutateTransportIfAccepted(.playheadAccessibilityStep) {
                        controller, host in
                        self.playheadAccessibilityBinding.step(
                            frames: delta,
                            to: &controller,
                            atHost: host
                        )
                    }
                }
                playhead.setAccessibilityParent(self)
                applyAccessibilityFrame(descriptor.frame, scale: scale, to: playhead)
                return playhead
            }
            // A descriptor that names an action gets an element that can run
            // it. Without this branch the control would announce a press that
            // reaches nothing, which is worse than not advertising one.
            if let action = descriptor.action {
                let control = StudioActionAccessibilityElement()
                control.publish(label: descriptor.label, value: descriptor.value, action: action)
                control.performAction = { [weak self] in
                    guard let self else { return false }
                    switch action {
                    case .togglePlayback:
                        return self.performPlaybackToggle(.playbackToggleAccessibility)
                    }
                }
                control.setAccessibilityParent(self)
                applyAccessibilityFrame(descriptor.frame, scale: scale, to: control)
                return control
            }
            let element = NSAccessibilityElement()
            element.setAccessibilityRole(Self.accessibilityRole(for: descriptor.role))
            element.setAccessibilityLabel(descriptor.label)
            element.setAccessibilityValue(descriptor.value)
            element.setAccessibilityParent(self)
            applyAccessibilityFrame(descriptor.frame, scale: scale, to: element)
            return element
        }
    }

    /// Descriptor frames are drawable pixels, top-left origin; AppKit wants
    /// points in SCREEN space, bottom-left origin.
    private func applyAccessibilityFrame(
        _ frame: StudioOverlayFrame,
        scale: CGFloat,
        to element: NSAccessibilityElement
    ) {
        let localRect = NSRect(
            x: frame.x / scale,
            y: bounds.height - frame.maxY / scale,
            width: frame.width / scale,
            height: frame.height / scale
        )
        if let window {
            element.setAccessibilityFrame(
                window.convertToScreen(convert(localRect, to: nil))
            )
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
    private let presentationHost: NSView?
    private let presentWindow: () -> Void
    /// This route's OWN renderer, so hiding the route can release its
    /// decoder/player resources without touching the other route's. The
    /// briefing requires exactly that, and one shared renderer could not
    /// deliver it.
    let renderer: StudioViewerRenderer

    convenience init(
        renderer: StudioViewerRenderer,
        authority: StudioPlaybackAuthority,
        route: StudioViewerRoute = .source,
        audioPlayer: StudioAudioPlayer? = nil,
        audioSchedulingAuthority: StudioAudioSchedulingAuthority? = nil
    ) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 540),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = route.windowTitle
        window.center()
        self.init(
            renderer: renderer,
            authority: authority,
            route: route,
            audioPlayer: audioPlayer,
            audioSchedulingAuthority: audioSchedulingAuthority,
            window: window,
            presentationHost: nil,
            presentWindow: {
                window.orderFrontRegardless()
            }
        )
    }

    convenience init(
        renderer: StudioViewerRenderer,
        authority: StudioPlaybackAuthority,
        route: StudioViewerRoute,
        audioPlayer: StudioAudioPlayer?,
        audioSchedulingAuthority: StudioAudioSchedulingAuthority?,
        window: NSWindow,
        presentationHost: NSView,
        presentWindow: @escaping () -> Void
    ) {
        self.init(
            renderer: renderer,
            authority: authority,
            route: route,
            audioPlayer: audioPlayer,
            audioSchedulingAuthority: audioSchedulingAuthority,
            window: window,
            presentationHost: Optional(presentationHost),
            presentWindow: presentWindow
        )
    }

    private init(
        renderer: StudioViewerRenderer,
        authority: StudioPlaybackAuthority,
        route: StudioViewerRoute,
        audioPlayer: StudioAudioPlayer?,
        audioSchedulingAuthority: StudioAudioSchedulingAuthority?,
        window: NSWindow,
        presentationHost: NSView?,
        presentWindow: @escaping () -> Void
    ) {
        self.route = route
        self.renderer = renderer
        self.window = window
        self.presentationHost = presentationHost
        self.presentWindow = presentWindow
        view = StudioViewerView(
            renderer: renderer,
            authority: authority,
            route: route,
            audioPlayer: audioPlayer,
            audioSchedulingAuthority: audioSchedulingAuthority
        )
        view.onPresentationDetached = { [weak self] in
            self?.presentationDidDetach()
        }
        view.onPresentationStateChanged = { [weak self] in
            self?.onPresentationStateChanged?()
        }
    }

    var isPresentationAttached: Bool {
        if let presentationHost {
            return view.superview === presentationHost && view.window === window
        }
        return window.contentView === view && view.window === window
    }

    var audioPlayerIdentity: ObjectIdentifier {
        view.audioPlayerIdentity
    }

    var audioSchedulingOwner: StudioViewerRoute {
        view.audioSchedulingAuthority.owner
    }

    var onPresentationDetached: (() -> Void)?
    var onPresentationStateChanged: (() -> Void)?

    /// Called by the AppKit view when its content view is detached. Keeping the
    /// ownership callback here makes close/reopen testable without asking an
    /// unrelated route to invalidate its shared decoder.
    func presentationDidDetach() {
        onPresentationDetached?()
    }

    func activateAudioScheduling(for route: StudioViewerRoute) {
        view.audioSchedulingAuthority.activate(route)
    }

    /// Observable view state for controller-level lifecycle diagnostics. These
    /// are adopted before presentation on reconnect, so callers can distinguish
    /// a successfully restored background projection from an empty viewer.
    var transcriptSegmentCount: Int { view.transcriptSegmentCount }

    var hasOpenReview: Bool { view.hasOpenReview }

    var activeReviewContext: StudioReviewContext? { view.activeReviewContext }

    var playbackAuthority: StudioPlaybackAuthority { view.authority }

    func attachPresentation() {
        // Attaching the Metal view starts its display link. Keep it detached
        // until an explicit presentation so hidden startup does no rendering.
        guard !isPresentationAttached else { return }
        if let presentationHost {
            view.translatesAutoresizingMaskIntoConstraints = false
            presentationHost.addSubview(view)
            NSLayoutConstraint.activate([
                view.leadingAnchor.constraint(equalTo: presentationHost.leadingAnchor),
                view.trailingAnchor.constraint(equalTo: presentationHost.trailingAnchor),
                view.topAnchor.constraint(equalTo: presentationHost.topAnchor),
                view.bottomAnchor.constraint(equalTo: presentationHost.bottomAnchor),
            ])
        } else {
            window.contentView = view
        }
    }

    func detachPresentation() {
        guard isPresentationAttached else { return }
        if presentationHost != nil {
            view.removeFromSuperview()
        } else {
            window.contentView = nil
        }
    }

    func show() {
        attachPresentation()
        // Visible and capturable, but not the operator's key/frontmost app.
        // makeKeyAndOrderFront + activate() stole focus from the owner on
        // every Source open; Work1 already proved WindowServer capture works
        // on an inactive companion. VoiceOver operates the settable playhead
        // without this process becoming key.
        presentWindow()
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

    func toggleReviewVersion() {
        view.toggleReviewVersion()
    }

    func performReviewVersionShortcut() {
        view.performReviewVersionShortcut()
    }

    func adopt(revision: Int) {
        view.adopt(revision: revision)
    }

    /// Forwards a LUT arriving or leaving to this route's view. The grade lives
    /// on the view alongside the keyboard that also moves it, so the app state
    /// cannot reach it directly — which is precisely why the delivered LUT was
    /// never previewed.
    func applyEffectPreviewGradeMode(active: Bool, isFirstActivation: Bool) {
        view.applyEffectPreviewGradeMode(active: active, isFirstActivation: isFirstActivation)
    }

    /// Internal for tests: whether this route's Effect mode is currently owned
    /// by the LUT path rather than the operator.
    var gradeModeAutoEnabledByEffectPreview: Bool {
        view.gradeModeAutoEnabledByEffectPreview
    }

    /// The base revision the next proposal/resolve will cite. Internal for tests.
    var nextProposalBaseRevision: Int { view.nextProposalBaseRevision }

    func report(message text: String?) {
        view.report(message: text)
    }

    func attachAudio(track: StudioAudioTrack?, timebase: StudioTimebase, assetId: String?) {
        view.attachAudio(track: track, timebase: timebase, assetId: assetId)
    }

    func configureSequenceAudio(
        provider: @escaping (String) -> StudioResidentAudio?,
        suspendsLocalAudio: Bool = false
    ) {
        view.configureSequenceAudio(
            provider: provider,
            suspendsLocalAudio: suspendsLocalAudio
        )
    }

    func setLocalAudioSuspendedForSequence(_ suspended: Bool) {
        view.setLocalAudioSuspendedForSequence(suspended)
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
    /// One pool spans both routes. Slots may be released independently, but the
    /// one decoder behind an exact asset stays valid while any visible route
    /// still holds a lease.
    private let sourcePool: StudioMediaSourcePool
    private let reviewAttachment: StudioMediaAttachment?
    /// Presentation is separate from process startup. The supervised companion
    /// hydrates in the background, but only a host open_media request may bring
    /// Studio to the foreground.
    private let presentSource: () -> Void

    /// Route visibility and the resource obligation that rides with it.
    private var routes = StudioRouteVisibility()
    private let reviewController: StudioViewerWindowController?
    private let workspaceController: StudioWorkspaceWindowController?

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
        // HYDRATION FIRST, BECAUSE IT IS THE OLDER STATE. The document
        // describes the world at getDocument time; the step describes a change
        // that happened AFTER it. This list used to apply the step first and
        // the document second, which inverted protocol chronology whenever both
        // arrived in one chunk — and since a document with a null effectPreview
        // is an explicit CLEAR, the recovered document wiped the preview that
        // had just been committed. Recover, then apply what happened next.
        if let hydration = update.hydration {
            await adopt(hydration: hydration)
        }
        if !update.step.openedAssets.isEmpty {
            await open(assets: update.step.openedAssets)
        }
        if !update.step.transcripts.isEmpty {
            adopt(transcripts: update.step.transcripts)
        }
        adopt(effectPreview: update.step.effectPreview)
        if !update.step.proposals.isEmpty {
            await adopt(proposals: update.step.proposals)
        }
        if !update.step.resolvedProposalIds.isEmpty {
            adopt(resolvedProposals: update.step.resolvedProposalIds)
        }
    }

    /// Restores the durable document without turning a supervisor reconnect into
    /// an operator-visible open_media action. Attachment is deliberately shared
    /// with live opens; presentation is not.
    private func adopt(hydration: StudioCompanionSession.Hydration) async {
        if !hydration.assets.isEmpty {
            await attach(assets: hydration.assets)
        }
        if !hydration.transcripts.isEmpty {
            adopt(transcripts: hydration.transcripts)
        }
        adopt(effectPreview: hydration.effectPreview)
        await adopt(sequence: hydration.sequence, knownAssets: hydration.assets)
        if !hydration.proposals.isEmpty {
            await adopt(proposals: hydration.proposals)
        }
    }

    init(
        controller: StudioViewerWindowController,
        renderer: StudioViewerRenderer,
        reviewController: StudioViewerWindowController? = nil,
        workspaceController: StudioWorkspaceWindowController? = nil,
        presentSource: (() -> Void)? = nil
    ) {
        self.controller = controller
        let sourcePool = StudioMediaSourcePool(device: renderer.device)
        self.sourcePool = sourcePool
        self.attachment = StudioMediaAttachment(renderer: renderer, sourcePool: sourcePool)
        self.reviewController = reviewController
        self.workspaceController = workspaceController
        self.reviewAttachment = reviewController.map {
            StudioMediaAttachment(renderer: $0.renderer, sourcePool: sourcePool)
        }
        self.presentSource = presentSource ?? {
            // Stay .accessory. Promoting to .regular and calling activate()
            // made open_media steal the operator's foreground app before any
            // driver ran. Observation-only capture already works while this
            // process stays inactive.
            if let workspaceController {
                workspaceController.show()
            } else {
                controller.show()
            }
        }
        reviewController?.configureSequenceAudio { [weak self] assetId in
            guard let self else { return nil }
            return self.reviewAttachment?.residentAudio(for: assetId)
                ?? self.attachment.residentAudio(for: assetId)
        }
        controller.onPresentationDetached = { [weak self] in
            self?.attachment.detach()
        }
        reviewController?.onPresentationDetached = { [weak self] in
            self?.reviewAttachment?.detach()
            self?.reviewAttachment?.detachSequence()
        }
        workspaceController?.configureChromeActions(
            onToggleRoute: { [weak self] route in
                guard let self else { return }
                _ = self.toggleRoute(route)
                self.refreshWorkspacePresentation()
            },
            onSelectReviewVersion: { [weak self] version in
                self?.selectReviewVersion(version)
            }
        )
        refreshWorkspacePresentation()
    }

    /// Shows or hides a route. Hiding releases that route's slots through the
    /// attachment, not by invalidating a decoder another visible route leases.
    @discardableResult
    func toggleRoute(_ route: StudioViewerRoute) -> StudioRouteTransition {
        let transition = routes.toggle(route)
        switch transition {
        case .shown(let shown):
            controller.activateAudioScheduling(for: shown)
            if let workspaceController {
                workspaceController.setActiveRoute(shown)
                refreshWorkspacePresentation()
                workspaceController.show()
            } else {
                windowController(for: shown)?.show()
            }
            if shown == .review, let activeSequence {
                controller.setLocalAudioSuspendedForSequence(!activeSequence.isEmpty)
            }
            Task { @MainActor [weak self] in
                if shown == .review {
                    await self?.restoreReviewRoute()
                } else {
                    await self?.restoreSourceRoute()
                }
            }
            Self.report("route \(shown.rawValue) shown")
        case .hidden(let hidden):
            guard let controller = windowController(for: hidden) else { break }
            if let workspaceController {
                workspaceController.setActiveRoute(hidden == .source ? .review : .source)
                refreshWorkspacePresentation()
            } else {
                controller.window.orderOut(nil)
            }
            if hidden == .source {
                attachment.detach()
                controller.activateAudioScheduling(for: .review)
            } else {
                reviewAttachment?.detach()
                reviewAttachment?.detachSequence()
                controller.activateAudioScheduling(for: .source)
                controller.setLocalAudioSuspendedForSequence(false)
                if let audio = attachment.attachedAudio,
                    let assetId = attachment.attachedAssetId,
                    let timebase = viewerTimebase
                {
                    controller.attachAudio(track: audio, timebase: timebase, assetId: assetId)
                }
            }
            Self.report(
                "route \(hidden.rawValue) hidden — route leases released")
        case .refused(let reason):
            Self.report("route toggle refused: \(reason.rawValue)")
        }
        return transition
    }

    private func refreshWorkspacePresentation() {
        workspaceController?.update(
            visibleRoutes: routes.visible,
            sequence: activeSequence,
            activeProposalId: openProposalId
        )
    }

    private func selectReviewVersion(_ version: StudioReviewVersion) {
        guard let reviewController,
            let context = reviewController.activeReviewContext
        else { return }
        if context.version != version {
            reviewController.toggleReviewVersion()
        }
        refreshWorkspacePresentation()
    }

    private func windowController(
        for route: StudioViewerRoute
    ) -> StudioViewerWindowController? {
        route == .source ? controller : reviewController
    }

    private var reviewTarget: StudioViewerWindowController { reviewController ?? controller }

    /// Transcripts the host has sent, keyed by asset. Held across source
    /// switches so that returning to an asset does not need a re-send.
    private var known: [String: StudioTranscript] = [:]
    private var openAssetId: String?
    private var openProposalId: String?
    private var viewerTimebase: StudioTimebase?
    /// Assets the host has opened, keyed by id, so a proposal inserting from a
    /// previously-opened asset can find its media.
    private var proposalAssets: [String: StudioMediaAsset] = [:]
    private var activeSequence: StudioTimelineSequence?
    private var activeReviewTimeline: StudioProposedTimeline?
    /// The last preview accepted by both route renderers. A malformed inbound
    /// payload is reported and leaves this exact preview resident.
    private var installedEffectPreview: StudioEffectPreview?

    /// Testable system-wide count: Source, Review, proposal, and sequence slots
    /// all draw from the same pool, so this cannot hide a second route-local
    /// decoder behind an individual renderer's count.
    var sharedDecoderCreationCount: Int { sourcePool.decoderCreationCount }
    var sharedResidentDecoderCount: Int { sourcePool.residentDecoderCount }

    /// Applies the host-authorized inline LUT to both real route renderers.
    /// Invalid content holds the last valid preview; it is never silently
    /// substituted with a parser fallback or applied to just one route.
    private func adopt(effectPreview change: StudioEffectPreviewChange) {
        switch change {
        case .unchanged:
            return
        case .rejected(let reason):
            Self.report("effect preview rejected — " + reason)
        case .clear:
            do {
                let previous = try installedEffectPreview?.parsedLut()
                do {
                    try setLutOnBothRoutes(nil)
                    installedEffectPreview = nil
                    // Only after the uploads succeed, so a rollback never
                    // leaves the two windows grading different pictures.
                    applyEffectPreviewGradeModeOnBothRoutes(
                        active: false, isFirstActivation: false)
                    Self.report("effect preview cleared")
                } catch {
                    try? setLutOnBothRoutes(previous)
                    throw error
                }
            } catch {
                Self.report("effect preview clear held — " + String(describing: error))
            }
        case .set(let preview):
            do {
                let lut = try preview.parsedLut()
                let previous = try installedEffectPreview?.parsedLut()
                // Captured BEFORE the swap: only an inactive -> active
                // transition may claim the grade mode. A replacement must not
                // overrule an operator who has since chosen Original.
                let isFirstActivation = installedEffectPreview == nil
                do {
                    try setLutOnBothRoutes(lut)
                    installedEffectPreview = preview
                    applyEffectPreviewGradeModeOnBothRoutes(
                        active: true, isFirstActivation: isFirstActivation)
                    Self.report("effect preview " + preview.effectId + " adopted")
                } catch {
                    // A route-local upload failure must not leave the Source and
                    // Review windows grading different pictures.
                    try? setLutOnBothRoutes(previous)
                    throw error
                }
            } catch {
                Self.report("effect preview held — " + String(describing: error))
            }
        }
    }

    private func setLutOnBothRoutes(_ lut: StudioColorLut?) throws {
        try controller.renderer.setLut(lut)
        try reviewController?.renderer.setLut(lut)
    }

    /// Source and Review stay in step for the host preview: a LUT the operator
    /// loaded once should not grade one window and bypass the other.
    private func applyEffectPreviewGradeModeOnBothRoutes(
        active: Bool,
        isFirstActivation: Bool
    ) {
        controller.applyEffectPreviewGradeMode(
            active: active, isFirstActivation: isFirstActivation)
        reviewController?.applyEffectPreviewGradeMode(
            active: active, isFirstActivation: isFirstActivation)
    }

    /// Adopts the host's transcripts. Only the one matching the open asset is
    /// shown: a transcript for a different asset is kept, not drawn, because a
    /// band of somebody else's words over this picture is worse than no band.
    func adopt(revision: Int) {
        controller.adopt(revision: revision)
        reviewController?.adopt(revision: revision)
    }

    /// Restores Source after it was hidden while Review remained visible. This
    /// reclaims the existing Review-held lease instead of reopening the file.
    private func restoreSourceRoute() async {
        guard let openAssetId, let asset = proposalAssets[openAssetId] else { return }
        guard attachment.attachedAssetId != openAssetId else { return }
        switch await attachment.attach(asset: asset) {
        case .attached(_, let frameCount, let timebase, let durationTicks):
            controller.adopt(
                timebase: timebase,
                durationTicks: durationTicks,
                label: "\(openAssetId) · \(frameCount) frames"
            )
            controller.attachAudio(
                track: attachment.attachedAudio,
                timebase: timebase,
                assetId: openAssetId
            )
        case .failed:
            Self.report("source \(openAssetId) unavailable while restoring route")
        }
    }

    /// Restores the Review renderer after a hide without reopening media. A
    /// fresh attachment lease resolves through the Source-held pool entry, so a
    /// route transition cannot manufacture another decoder or retain a stale id.
    func restoreReviewRoute() async {
        guard let reviewAttachment else { return }
        guard await ensureReviewPrimary(reviewAttachment) else { return }
        if let sequence = activeSequence {
            await restore(sequence: sequence, into: reviewAttachment)
        }
        guard let timeline = activeReviewTimeline else { return }
        if timeline.assetId != reviewAttachment.attachedAssetId {
            guard let asset = proposalAssets[timeline.assetId] else {
                Self.report("review proposal held — asset \(timeline.assetId) not open")
                return
            }
            guard (await reviewAttachment.attachProposed(asset: asset)).didAttach else {
                Self.report("review proposal held — proposed source failed")
                return
            }
        }
        reviewTarget.adopt(reviewTimeline: timeline)
    }

    private func ensureReviewPrimary(_ reviewAttachment: StudioMediaAttachment) async -> Bool {
        guard let openAssetId, let asset = proposalAssets[openAssetId] else { return false }
        guard reviewAttachment.attachedAssetId != openAssetId else { return true }
        guard (await reviewAttachment.attach(asset: asset)).didAttach else {
            Self.report("review primary \(openAssetId) unavailable — proposal comparison held")
            return false
        }
        return true
    }

    private func restore(
        sequence: StudioTimelineSequence,
        into reviewAttachment: StudioMediaAttachment
    ) async {
        var attached = 0
        var held: [String] = []
        for assetId in sequence.referencedAssetIds.sorted() {
            guard let asset = proposalAssets[assetId] else {
                held.append(assetId)
                continue
            }
            let outcome = await reviewAttachment.attachSequence(asset: asset)
            if outcome.didAttach { attached += 1 } else { held.append(assetId) }
        }
        reviewController?.renderer.sequence = sequence
        Self.report(
            "sequence restored — \(sequence.items.count) items, \(attached) assets resident"
                + (held.isEmpty ? "" : ", held: \(held.joined(separator: ","))"))
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
        // The two renderers have independent presentation slots, but every
        // slot leases from one pool. A same-asset proposal therefore uses the
        // Source decoder; only a distinct asset creates a second decoder.
        let reviewAttachment = reviewAttachment ?? attachment
        if let dedicatedReviewAttachment = self.reviewAttachment,
            !(await ensureReviewPrimary(dedicatedReviewAttachment))
        {
            Self.report("proposal \(proposal.proposalId) held — review primary source unavailable")
            return
        }
        if timeline.assetId != reviewAttachment.attachedAssetId {
            guard let asset = proposalAssets[timeline.assetId] else {
                Self.report(
                    "proposal \(proposal.proposalId) held — asset \(timeline.assetId) not open")
                return
            }
            let outcome = await reviewAttachment.attachProposed(asset: asset)
            guard outcome.didAttach else {
                Self.report("proposal \(proposal.proposalId) held — proposed source failed")
                return
            }
        }
        openProposalId = proposal.proposalId
        activeReviewTimeline = timeline
        refreshWorkspacePresentation()
        reviewTarget.adopt(reviewTimeline: timeline)
        Self.report(
            "proposal \(proposal.proposalId) shown — v to compare, a accept, r reject")
    }

    /// A resolved ghost stops being reviewable, whichever way it went.
    func adopt(resolvedProposals ids: [String]) {
        guard let openProposalId, ids.contains(openProposalId) else { return }
        self.openProposalId = nil
        activeReviewTimeline = nil
        refreshWorkspacePresentation()
        (reviewAttachment ?? attachment).detachProposed()
        reviewTarget.adopt(reviewTimeline: nil)
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
        activeSequence = sequence
        refreshWorkspacePresentation()
        controller.setLocalAudioSuspendedForSequence(
            routes.isVisible(.review) && !sequence.isEmpty
        )
        guard let reviewController else { return }
        guard !sequence.isEmpty else {
            reviewAttachment?.detachSequence()
            reviewController.renderer.sequence = nil
            if let audio = attachment.attachedAudio,
                let assetId = attachment.attachedAssetId,
                let timebase = viewerTimebase
            {
                controller.attachAudio(track: audio, timebase: timebase, assetId: assetId)
            }
            return
        }
        let reviewAttachment = reviewAttachment ?? StudioMediaAttachment(
            renderer: reviewController.renderer, sourcePool: sourcePool)
        await restore(sequence: sequence, into: reviewAttachment)
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
        // open_media is the explicit product action. Process startup and
        // hydration must stay invisible; even a failed user-requested open is
        // presented so its on-screen error is not lost in stderr.
        presentSource()
        await attach(assets: assets)
    }

    /// Makes media resident and updates the Source projection. Hydration calls
    /// this directly so restored state is real but remains background-only.
    private func attach(assets: [StudioMediaAsset]) async {
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
                // Review receives another lease of this exact source. It gets
                // independent presentation ownership without another decoder.
                if let reviewAttachment {
                    _ = await ensureReviewPrimary(reviewAttachment)
                }
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

/// Entry point for `--viewer`. The AppKit process and stdio protocol hydrate in
/// the background; the first host open_media request presents the viewer.
enum StudioViewerApp {
    @MainActor private static var retainedWorkspaceController:
        StudioWorkspaceWindowController?
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

        let application = NSApplication.shared
        // A supervised companion is infrastructure, not a startup window. Keep
        // it out of the Dock and foreground until Open in Studio arrives.
        application.setActivationPolicy(.accessory)
        // ONE AUTHORITY, TWO ROUTES. The briefing is explicit: "two viewers must
        // never become two clocks". The authority is a reference type held by
        // both routes, so that is a fact about the object graph rather than a
        // convention someone has to maintain.
        let authority = StudioPlaybackAuthority(
            clock: StudioPlaybackClock(timebase: .ntsc2997, durationTicks: 0))
        let audioPlayer = StudioAudioPlayer()
        let audioSchedulingAuthority = StudioAudioSchedulingAuthority(owner: .source)
        // One primary AppKit window owns both route presentations. Each route
        // retains its own renderer and media lease, while the authority and
        // device player above remain shared by construction.
        let workspaceController = StudioWorkspaceWindowController(
            sourceRenderer: renderer,
            reviewRenderer: try? StudioViewerRenderer.makeDefault(),
            authority: authority,
            audioPlayer: audioPlayer,
            audioSchedulingAuthority: audioSchedulingAuthority
        )
        retainedWorkspaceController = workspaceController
        let controller = workspaceController.sourceController
        let reviewController = workspaceController.reviewController
        retainedController = controller
        retainedReviewController = reviewController

        let state = StudioViewerAppState(
            controller: controller,
            renderer: renderer,
            reviewController: reviewController,
            workspaceController: workspaceController
        )
        StudioViewerAppState.shared = state

        // DELIVERY IS BUILT BEFORE THE PUMP, AND THE PUMP CANNOT BE BUILT
        // WITHOUT IT. The thread closure captures this value, which holds the
        // state non-optionally, so "start the pump before the viewer exists" is
        // no longer an ordering a future edit can get wrong by accident — it is
        // a fact about the object graph.
        //
        // AppKit must own the main thread, so the protocol pump moves to its own
        // thread. It exits the process on EOF exactly as the headless path does.
        // Opened assets hop to the main actor as plain Sendable identities; the
        // renderer itself never crosses a thread boundary.
        let delivery = StudioUpdateDelivery(state: state)
        let pumpThread = Thread {
            exit(
                StudioCompanionStdioPump.run(hydrateOnce: hydrateOnce) { update in
                    delivery.deliver(update)
                }
            )
        }
        pumpThread.name = "taskwraith-studio-stdio"
        pumpThread.start()

        application.run()
        exit(0)
    }
}

/// Delivers pump updates to the viewer IN ORDER, and cannot drop one.
///
/// TWO DEFECTS AT ONE SEAM, both of which only became reachable once hydration
/// was made genuinely one-shot in 6516f5a0d.
///
/// THE DROP. `run()` started the pump thread BEFORE constructing
/// `StudioViewerAppState`, and the callback read `StudioViewerAppState.shared?`.
/// A fast getDocument response could consume the SOLE hydration envelope while
/// `shared` was still nil, and optional chaining then discarded it silently and
/// permanently — no window, no ghost, no transcript, no error. The previous
/// defective repeated hydration masked this by replaying the document on the
/// next edit; removing that bug removed the mask. Holding the state
/// NON-OPTIONALLY is the repair: this value cannot exist before the state does,
/// so neither can the thread closure that captures it.
///
/// THE INVERSION. Each callback previously spawned an independent
/// `Task { @MainActor in ... }`. Unstructured tasks carry no FIFO guarantee
/// between them, and `adopt(update:)` suspends on media attachment — so a
/// hydration that stops to decode can be overtaken by the live edit that
/// follows it, and the OLDER document then lands last. That is precisely the
/// inversion already fixed inside a single update; across updates it needs an
/// explicit chain, because "they were submitted in order" is not a guarantee
/// that they RUN in order.
///
/// `@unchecked Sendable` is justified narrowly: `state` is a `@MainActor` class
/// and therefore already Sendable, and `tail` is only ever read or written
/// under `lock`.
final class StudioUpdateDelivery: @unchecked Sendable {
    private let state: StudioViewerAppState
    private let lock = NSLock()
    private var tail: Task<Void, Never>?

    init(state: StudioViewerAppState) {
        self.state = state
    }

    /// Called on the PUMP THREAD. Never blocks it: the work is queued behind
    /// whatever is already in flight and the caller returns immediately, so the
    /// pump's stdio and protocol response writes keep their existing timing.
    func deliver(_ update: StudioCompanionStdioPump.Update) {
        lock.lock()
        let previous = tail
        let state = self.state
        let next = Task { @MainActor in
            // Awaiting the predecessor SUSPENDS rather than blocks, so the main
            // actor stays free to draw while an earlier attachment decodes.
            await previous?.value
            await state.adopt(update: update)
        }
        tail = next
        lock.unlock()
    }

    /// Awaits everything submitted so far. Ordering is not observable without a
    /// way to wait for the chain to settle, so this exists for the controls
    /// rather than for production, which never needs to wait.
    func awaitQuiescence() async {
        // The lock is taken in a SYNCHRONOUS accessor on purpose: NSLock is
        // unavailable from async contexts because a suspension while holding it
        // would block an arbitrary cooperative thread.
        await currentTail()?.value
    }

    private func currentTail() -> Task<Void, Never>? {
        lock.lock()
        defer { lock.unlock() }
        return tail
    }
}
