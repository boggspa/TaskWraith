import Foundation
import Metal

/// What one display-link tick actually produced.
///
/// Returned rather than thrown because this runs inside a display-link callback:
/// a single bad frame must never take the viewer down, and the caller needs to
/// tell "drew content" apart from "dropped a frame" for outcome 9 diagnostics.
public enum StudioViewerFrameOutcome: Equatable, Sendable {
    case decodedFrame(frameIndex: Int64)
    case testPattern(frameIndex: Int64)
    case decodeFailed(frameIndex: Int64, message: String)
    /// The proposed sequence calls for material no attached source can provide.
    /// Nothing is drawn — see StudioReviewFrameRequest.unavailable.
    case proposedMaterialUnavailable(frameIndex: Int64, assetId: String)
    case renderFailed(frameIndex: Int64, message: String)

    /// True when something was actually drawn into the target.
    public var didDraw: Bool {
        switch self {
        case .decodedFrame, .testPattern: return true
        case .decodeFailed, .renderFailed, .proposedMaterialUnavailable: return false
        }
    }
}

/// The viewer's per-frame decision, extracted from AppKit so it is testable.
///
/// StudioViewerWindow is a thin NSView + CAMetalLayer shell with no test target,
/// so everything that can be wrong — which source is used, what happens when a
/// decode fails, whether teardown really releases the decoder — lives here and
/// is asserted against real rendered pixels.
///
/// FALLBACK POLICY, and it is deliberate:
/// * NO SOURCE CONFIGURED -> render the test pattern. That is intended content,
///   not an error; the companion currently ships in this state.
/// * SOURCE CONFIGURED BUT DECODE FAILED -> report the failure and draw NOTHING.
///   Falling back to colour bars mid-playback would be the worst possible
///   behaviour: the viewer would look like it was working while showing
///   synthetic content, and a broken decoder would never be noticed. A dropped
///   frame is honest and is exactly what the dropped-frame diagnostic counts.
public final class StudioViewerRenderer {
    public let device: MTLDevice

    /// ONE command queue for every pass this viewer runs.
    ///
    /// THIS IS THE ORDERING CONTRACT, not a resource optimisation. The content
    /// pass and the overlay pass composite into the SAME drawable: the content
    /// pass clears and draws, the overlay pass loads that result and presents.
    /// Metal serialises command buffers within a queue by commit order, and
    /// guarantees NOTHING across queues without an MTLEvent or MTLFence. These
    /// three renderers each created their own queue, so "the overlay is last"
    /// was intent rather than contract — it held because the driver happened to
    /// serialise them, which is exactly the kind of works-on-this-machine
    /// reasoning the kCVPixelBufferMetalCompatibilityKey correction already
    /// caught me making once.
    ///
    /// A shared queue cannot be proven by a red-first test: a race does not fail
    /// on demand, and a passing composite proves ordering HAPPENED, not that it
    /// is guaranteed. The honest test is structural — assert the passes share
    /// one queue instance — and that is what StudioViewerRendererTests does.
    let commandQueue: MTLCommandQueue

    /// Internal rather than private so tests can assert all three passes were
    /// built against `commandQueue`.
    let patternRenderer: StudioTestPatternRenderer
    /// Also lets tests seed and inspect the in-flight ring directly; the present
    /// path is the only production writer.
    let videoRenderer: StudioVideoFrameRenderer
    let overlayRenderer: StudioOverlayRenderer
    private var source: StudioVideoFrameSource?

    /// Second source for a proposal's inserted material (mission outcome 3).
    ///
    /// A SECOND DECODER, TEXTURE CACHE AND REORDER BUFFER — deliberately, and
    /// worth naming because it doubles the allocations outcome 11's stress
    /// matrix will measure. It is held only while a proposal is open and is
    /// invalidated the moment it is replaced or detached, exactly like the
    /// primary, so a review session cannot accumulate decompression sessions.
    private var proposedSource: StudioVideoFrameSource?
    private(set) var proposedAssetId: String?
    private var proposedTimebase: StudioTimebase?

    /// Bounded diagnostics for outcome 9.
    public private(set) var decodedFrameCount = 0
    public private(set) var testPatternFrameCount = 0
    public private(set) var failedFrameCount = 0

    /// Frames actually drawn, decoded or synthetic.
    public var presentedFrameCount: Int { decodedFrameCount + testPatternFrameCount }

    public var hasSource: Bool { source != nil }

    /// Frames still held by the video renderer's in-flight ring.
    ///
    /// Outcome 9/11 diagnostic: these are IOSurface-backed buffers, so this
    /// MUST return to zero whenever a source is detached or replaced. A
    /// non-zero count with no live source means stranded surfaces.
    public var retainedFrameCount: Int { videoRenderer.retainedFrameCount }

    public init(device: MTLDevice) throws {
        self.device = device
        guard let queue = device.makeCommandQueue() else {
            throw StudioRendererError.commandQueueUnavailable
        }
        self.commandQueue = queue
        // Every pass shares it — see the note on `commandQueue`.
        self.patternRenderer = try StudioTestPatternRenderer(device: device, commandQueue: queue)
        self.videoRenderer = try StudioVideoFrameRenderer(device: device, commandQueue: queue)
        self.overlayRenderer = try StudioOverlayRenderer(device: device, commandQueue: queue)
    }

    public static func makeDefault() throws -> StudioViewerRenderer {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw StudioRendererError.metalUnavailable
        }
        return try StudioViewerRenderer(device: device)
    }

    /// Attaches decoded media. Any previously attached source is invalidated
    /// first, so switching sources cannot leak a decompression session.
    public func attach(source newSource: StudioVideoFrameSource) {
        source?.invalidate()
        // The in-flight ring may still hold frames belonging to the session we
        // just invalidated. Without this flush they survive until the NEW
        // source presents enough frames to evict them — and if it never does
        // (decode failure, or attached while paused) they are held for good.
        // detachSource() has always done this; attach() must match it, or the
        // two paths silently disagree about resource lifetime.
        videoRenderer.releaseRetainedFrames()
        source = newSource
    }

    /// Attaches the second source a proposal's inserted material decodes from.
    ///
    /// Keyed by assetId because a proposal routinely inserts material from a
    /// DIFFERENT asset than the one open; the router matches on identity so a
    /// mismatch draws nothing rather than the wrong file.
    /// Grading state for subsequent frames.
    ///
    /// WHY THIS EXISTS. StudioVideoFrameRenderer has taken a per-render
    /// StudioGradeSettings since the grading slice landed, and nothing above it
    /// ever supplied one — so the running product was permanently pinned to the
    /// default Original path while the bypass, display transform, LUT and split
    /// were all real and pixel-tested underneath. Core-complete and
    /// product-unreachable is not shipped.
    public var grade = StudioGradeSettings()

    /// Whether the current grade would leave the picture untouched, accounting
    /// for whether a LUT is actually resident. The renderer is the only place
    /// that knows both halves.
    public var isGradeNeutral: Bool {
        grade.isNeutral(hasLut: videoRenderer.hasLut)
    }

    /// Loads (or clears) the externally supplied LUT.
    public func setLut(_ lut: StudioColorLut?) throws {
        try videoRenderer.setLut(lut)
    }

    public func attachProposed(
        source newSource: StudioVideoFrameSource,
        assetId: String,
        timebase: StudioTimebase
    ) {
        proposedSource?.invalidate()
        videoRenderer.releaseRetainedFrames()
        proposedSource = newSource
        proposedAssetId = assetId
        proposedTimebase = timebase
    }

    /// Detaches the proposal's source. Called when a ghost is resolved either
    /// way: an accepted proposal becomes part of the sequence and a rejected one
    /// never will be, so neither leaves anything to review.
    public func detachProposedSource() {
        proposedSource?.invalidate()
        proposedSource = nil
        proposedAssetId = nil
        proposedTimebase = nil
        videoRenderer.releaseRetainedFrames()
    }

    /// Detaches and invalidates the current source, reverting to the test
    /// pattern. Idempotent. Also drops the proposal's source: a review of
    /// material that is no longer open is not a review.
    public func detachSource() {
        source?.invalidate()
        source = nil
        detachProposedSource()
        videoRenderer.releaseRetainedFrames()
    }

    /// Draws the frame the clock says is current, then the transport overlay.
    ///
    /// - Parameter drawable: supplied on the on-screen path so the command
    ///   buffer presents without waiting; nil offscreen so the target is
    ///   immediately readable.
    /// - Parameter overlay: when supplied, the content pass runs in `chaining`
    ///   mode and the OVERLAY pass owns presentation, because it must be last.
    ///   Passing nil keeps the original single-pass behaviour byte for byte.
    @discardableResult
    public func render(
        snapshot: StudioTransportSnapshot,
        to target: MTLTexture,
        presenting drawable: MTLDrawable? = nil,
        overlay: StudioOverlayModel? = nil,
        review: StudioReviewContext? = nil
    ) -> StudioViewerFrameOutcome {
        let frameIndex = snapshot.frameIndex
        let chaining = overlay != nil
        // With an overlay the content pass must not present; the overlay does.
        let outcome = renderContent(
            snapshot: snapshot,
            to: target,
            presenting: chaining ? nil : drawable,
            chaining: chaining,
            review: review
        )

        guard let overlay else { return outcome }

        // The content pass encodes with loadAction .clear. When it FAILED it
        // never ran, so the target still holds whatever was in it — a stale
        // picture under a live HUD reads as frozen playback, which is exactly
        // the dishonest green the fallback policy exists to prevent. Clearing
        // in the overlay pass keeps a dropped frame visibly dropped.
        do {
            try overlayRenderer.render(
                model: overlay,
                to: target,
                presenting: drawable,
                clearingFirst: !outcome.didDraw
            )
        } catch {
            failedFrameCount += 1
            return .renderFailed(frameIndex: frameIndex, message: String(describing: error))
        }
        return outcome
    }

    /// The original single-pass content decision, unchanged apart from handing
    /// presentation forward. Split out so the overlay wrapper cannot
    /// accidentally reclassify a decode failure as a render failure: those are
    /// different diagnoses and they stay in separate catch blocks.
    private func renderContent(
        snapshot: StudioTransportSnapshot,
        to target: MTLTexture,
        presenting drawable: MTLDrawable?,
        chaining: Bool,
        review: StudioReviewContext? = nil
    ) -> StudioViewerFrameOutcome {
        let frameIndex = snapshot.frameIndex

        // WITHOUT A REVIEW CONTEXT THIS IS THE ORIGINAL PATH, unchanged: the
        // primary source at the snapshot's own frame. Routing only engages when
        // a proposal is actually being reviewed, so nothing else pays for it.
        var selectedSource = source
        var selectedFrame = frameIndex
        if let review {
            switch StudioReviewRouter.request(
                atTicks: snapshot.positionTicks,
                version: review.version,
                timeline: review.timeline,
                availableProposedAssetId: proposedAssetId
            ) {
            case .current(let ticks):
                selectedFrame = ticks / review.timebase.frameDurationTicks
            case .proposed(_, let ticks):
                guard let proposedSource, let proposedTimebase else {
                    failedFrameCount += 1
                    return .proposedMaterialUnavailable(
                        frameIndex: frameIndex,
                        assetId: proposedAssetId ?? "unknown"
                    )
                }
                // The inserted asset may run at a different rate; convert
                // before indexing or the review shows the wrong picture.
                let converted = StudioReviewRouter.convert(
                    ticks: ticks,
                    from: review.timebase,
                    to: proposedTimebase
                )
                selectedSource = proposedSource
                selectedFrame = converted / proposedTimebase.frameDurationTicks
            case .unavailable(let assetId):
                // Draw NOTHING. A neighbouring frame here would show a
                // comparison that does not exist.
                failedFrameCount += 1
                return .proposedMaterialUnavailable(frameIndex: frameIndex, assetId: assetId)
            }
        }

        if let source = selectedSource {
            let textures: StudioVideoFrameTextures
            do {
                textures = try source.textures(forFrameIndex: selectedFrame)
            } catch {
                // Deliberately NOT falling back to the test pattern — see the
                // fallback policy above.
                failedFrameCount += 1
                return .decodeFailed(frameIndex: frameIndex, message: String(describing: error))
            }
            do {
                try videoRenderer.render(
                    frame: textures,
                    to: target,
                    presenting: drawable,
                    chaining: chaining,
                    grade: grade
                )
                decodedFrameCount += 1
                return .decodedFrame(frameIndex: frameIndex)
            } catch {
                failedFrameCount += 1
                return .renderFailed(frameIndex: frameIndex, message: String(describing: error))
            }
        }

        do {
            try patternRenderer.render(
                to: target,
                frameIndex: frameIndex,
                presenting: drawable,
                chaining: chaining
            )
            testPatternFrameCount += 1
            return .testPattern(frameIndex: frameIndex)
        } catch {
            failedFrameCount += 1
            return .renderFailed(frameIndex: frameIndex, message: String(describing: error))
        }
    }

    /// Vertices the last overlay pass emitted. Bounded outcome-9 diagnostic.
    public var overlayVertexCount: Int { overlayRenderer.lastVertexCount }

    /// Bounded diagnostics snapshot, including the attached source's counters
    /// when there is one.
    public var diagnostics: Diagnostics {
        Diagnostics(
            hasSource: source != nil,
            decodedFrameCount: decodedFrameCount,
            testPatternFrameCount: testPatternFrameCount,
            failedFrameCount: failedFrameCount,
            retainedFrameCount: retainedFrameCount,
            sourceDiagnostics: source?.diagnostics
        )
    }

    public struct Diagnostics: Equatable, Sendable {
        public let hasSource: Bool
        public let decodedFrameCount: Int
        public let testPatternFrameCount: Int
        public let failedFrameCount: Int
        public let retainedFrameCount: Int
        public let sourceDiagnostics: StudioVideoFrameSource.Diagnostics?
    }
}
