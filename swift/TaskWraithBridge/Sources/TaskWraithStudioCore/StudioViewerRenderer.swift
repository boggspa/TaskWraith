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
    case renderFailed(frameIndex: Int64, message: String)

    /// True when something was actually drawn into the target.
    public var didDraw: Bool {
        switch self {
        case .decodedFrame, .testPattern: return true
        case .decodeFailed, .renderFailed: return false
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

    private let patternRenderer: StudioTestPatternRenderer
    private let videoRenderer: StudioVideoFrameRenderer
    private var source: StudioVideoFrameSource?

    /// Bounded diagnostics for outcome 9.
    public private(set) var decodedFrameCount = 0
    public private(set) var testPatternFrameCount = 0
    public private(set) var failedFrameCount = 0

    /// Frames actually drawn, decoded or synthetic.
    public var presentedFrameCount: Int { decodedFrameCount + testPatternFrameCount }

    public var hasSource: Bool { source != nil }

    public init(device: MTLDevice) throws {
        self.device = device
        self.patternRenderer = try StudioTestPatternRenderer(device: device)
        self.videoRenderer = try StudioVideoFrameRenderer(device: device)
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
        source = newSource
    }

    /// Detaches and invalidates the current source, reverting to the test
    /// pattern. Idempotent.
    public func detachSource() {
        source?.invalidate()
        source = nil
        videoRenderer.releaseRetainedFrames()
    }

    /// Draws the frame the clock says is current.
    ///
    /// - Parameter drawable: supplied on the on-screen path so the command
    ///   buffer presents without waiting; nil offscreen so the target is
    ///   immediately readable.
    @discardableResult
    public func render(
        snapshot: StudioTransportSnapshot,
        to target: MTLTexture,
        presenting drawable: MTLDrawable? = nil
    ) -> StudioViewerFrameOutcome {
        let frameIndex = snapshot.frameIndex

        if let source {
            let textures: StudioVideoFrameTextures
            do {
                textures = try source.textures(at: snapshot)
            } catch {
                // Deliberately NOT falling back to the test pattern — see the
                // fallback policy above.
                failedFrameCount += 1
                return .decodeFailed(frameIndex: frameIndex, message: String(describing: error))
            }
            do {
                try videoRenderer.render(frame: textures, to: target, presenting: drawable)
                decodedFrameCount += 1
                return .decodedFrame(frameIndex: frameIndex)
            } catch {
                failedFrameCount += 1
                return .renderFailed(frameIndex: frameIndex, message: String(describing: error))
            }
        }

        do {
            try patternRenderer.render(to: target, frameIndex: frameIndex, presenting: drawable)
            testPatternFrameCount += 1
            return .testPattern(frameIndex: frameIndex)
        } catch {
            failedFrameCount += 1
            return .renderFailed(frameIndex: frameIndex, message: String(describing: error))
        }
    }

    /// Bounded diagnostics snapshot, including the attached source's counters
    /// when there is one.
    public var diagnostics: Diagnostics {
        Diagnostics(
            hasSource: source != nil,
            decodedFrameCount: decodedFrameCount,
            testPatternFrameCount: testPatternFrameCount,
            failedFrameCount: failedFrameCount,
            sourceDiagnostics: source?.diagnostics
        )
    }

    public struct Diagnostics: Equatable, Sendable {
        public let hasSource: Bool
        public let decodedFrameCount: Int
        public let testPatternFrameCount: Int
        public let failedFrameCount: Int
        public let sourceDiagnostics: StudioVideoFrameSource.Diagnostics?
    }
}
