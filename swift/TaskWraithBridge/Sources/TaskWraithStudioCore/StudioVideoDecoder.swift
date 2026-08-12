import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// VideoToolbox decode into Metal-bindable pixel buffers (mission outcome 5).
///
/// This is the piece that turns StudioVideoTextureBridge from a proven binding
/// into a real media path: it drives an explicit VTDecompressionSession and asks
/// for output the bridge can wrap with no copy.
///
/// OUTPUT ATTRIBUTES: the bi-planar pixel format request is load-bearing — ask
/// for 32BGRA and there are no Y/CbCr planes to bind. The Metal-compatibility
/// and IOSurface keys are a GUARANTEE rather than a requirement, and this was
/// measured rather than assumed: removing both still produced IOSurface-backed,
/// bindable buffers on this stack (Apple silicon), because VideoToolbox already
/// vends IOSurface-backed buffers here. They stay because the guarantee is free
/// and the default is not contractual across codecs, GPUs or OS versions — but
/// do not repeat the folklore that omitting them fails outright. It does not,
/// at least not here.
///
/// Contrast the existing bridge daemon's VideoFrameDecoder, which deliberately
/// asks for 32BGRA because it wants CPU-readable frames for capture/encode —
/// correct for that job, wrong for a viewer. That file is a read-only reference
/// here; this is separate, new code.
///
/// HARDWARE IS ENABLED, NOT REQUIRED. The daemon learned this already and the
/// comment is worth repeating: `RequireHardwareAcceleratedVideoDecoder` hard
/// fails on Macs with no hardware path for the codec, so this enables hardware
/// and retries once in software rather than refusing to play the file.
///
/// NOT IN SCOPE: GOP-aware seeking. `decode` handles whatever sample it is
/// given; decoding a mid-GOP P-frame in isolation is undefined without its
/// preceding reference frames. Seeking that decodes forward from the nearest
/// keyframe is a later slice, and StudioVideoFrameSource documents the same gap.
/// Whether a decompression session is actually running on hardware.
///
/// Three states on purpose. A two-state Bool forces "we could not tell" to be
/// reported as one of the definite answers, which is how a diagnostic starts
/// lying — the exact defect this type replaced.
public enum StudioHardwareDecodeStatus: Equatable, Sendable {
    case hardware
    case software
    /// VideoToolbox did not report the property; nothing is being claimed.
    case unknown
}

/// One decoded picture and the instant it presents.
///
/// The presentation time is carried out of the decoder deliberately: with GOP
/// decoding the caller submits several samples to reach one target frame, and
/// the only way to know it received the picture it asked for — rather than a
/// reordered neighbour — is to compare timestamps. Assuming would be exactly
/// the class of mistake that produced a silently wrong frame on the first real
/// file this project opened.
public struct StudioDecodedFrame {
    public let pixelBuffer: CVPixelBuffer
    public let presentationTime: CMTime
}

public enum StudioVideoDecoderError: Error, Equatable {
    case sessionCreationFailed(OSStatus)
    case sessionInvalidated
    case decodeSubmissionFailed(OSStatus)
    case decodeFailed(OSStatus)
    case decodeProducedNoFrame
    case unsupportedOutputFormat(UInt32)
}

public final class StudioVideoDecoder {
    /// Full-range bi-planar 4:2:0 — the format StudioVideoTextureBridge binds as
    /// an `.r8Unorm` luma plane plus an `.rg8Unorm` chroma plane.
    public static let outputPixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange

    public let formatDescription: CMVideoFormatDescription
    /// Whether VideoToolbox actually used a hardware decoder for this session.
    ///
    /// This is MEASURED from the session, never inferred from which creation
    /// path succeeded. `EnableHardwareAcceleratedVideoDecoder` is a hint, not a
    /// guarantee: VideoToolbox may hand back a software session anyway when the
    /// hardware block is busy or the format is marginally out of spec, so a
    /// successful hardware-spec create proves nothing about what is running.
    /// `.unknown` means the property could not be read and is reported honestly
    /// rather than guessed.
    public private(set) var hardwareDecodeStatus: StudioHardwareDecodeStatus = .unknown
    public private(set) var decodedFrameCount = 0
    public private(set) var failedDecodeCount = 0

    private var session: VTDecompressionSession?

    /// False once `invalidate()` has run. Resource-lifecycle diagnostics for
    /// outcome 9: a viewer that closes and reopens must show this going false
    /// and back true rather than quietly leaking sessions.
    public var isValid: Bool { session != nil }

    public init(formatDescription: CMVideoFormatDescription) throws {
        self.formatDescription = formatDescription

        let outputAttributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: Int(Self.outputPixelFormat),
            kCVPixelBufferMetalCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [CFString: Any]() as CFDictionary,
        ]

        func create(preferHardware: Bool) -> (status: OSStatus, session: VTDecompressionSession?) {
            var specification: CFDictionary?
            if preferHardware {
                specification =
                    [
                        kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder: true
                    ] as CFDictionary
            }
            var created: VTDecompressionSession?
            let status = VTDecompressionSessionCreate(
                allocator: kCFAllocatorDefault,
                formatDescription: formatDescription,
                decoderSpecification: specification,
                imageBufferAttributes: outputAttributes as CFDictionary,
                outputCallback: nil,
                decompressionSessionOut: &created
            )
            return (status, created)
        }

        let hardware = create(preferHardware: true)
        if hardware.status == noErr, let created = hardware.session {
            session = created
            hardwareDecodeStatus = Self.measureHardwareDecodeStatus(of: created)
            return
        }

        let software = create(preferHardware: false)
        guard software.status == noErr, let created = software.session else {
            throw StudioVideoDecoderError.sessionCreationFailed(software.status)
        }
        session = created
        hardwareDecodeStatus = Self.measureHardwareDecodeStatus(of: created)
    }

    /// Asks the session what it is actually doing.
    ///
    /// Deliberately asked of BOTH creation paths: a session created without the
    /// hardware hint may still get hardware, and one created with it may not.
    /// An unreadable property yields `.unknown` rather than a convenient guess.
    private static func measureHardwareDecodeStatus(
        of session: VTDecompressionSession
    ) -> StudioHardwareDecodeStatus {
        // An explicitly typed out-pointer, not `&someOptional`: passing an
        // Optional<AnyObject> inout to this API selects the raw-pointer
        // overload and warns, and getting ownership wrong on a Copy-semantics
        // call is a leak rather than a compile error.
        let box = UnsafeMutablePointer<CFTypeRef?>.allocate(capacity: 1)
        box.initialize(to: nil)
        defer {
            box.deinitialize(count: 1)
            box.deallocate()
        }

        let status = VTSessionCopyProperty(
            session,
            key: kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,
            allocator: kCFAllocatorDefault,
            valueOut: box
        )
        guard status == noErr, let value = box.pointee else { return .unknown }
        if let number = value as? NSNumber { return number.boolValue ? .hardware : .software }
        return .unknown
    }

    deinit {
        if let session {
            VTDecompressionSessionInvalidate(session)
        }
    }

    /// Decodes one compressed sample into a Metal-bindable pixel buffer.
    ///
    /// Synchronous by construction: asynchronous decompression is not requested
    /// and `VTDecompressionSessionWaitForAsynchronousFrames` acts as the barrier
    /// before the result is read, so a caller never observes a half-written
    /// outcome.
    public func decode(_ sampleBuffer: CMSampleBuffer) throws -> StudioDecodedFrame {
        guard let session else {
            throw StudioVideoDecoderError.sessionInvalidated
        }

        let outcome = DecodeOutcome()
        let submission = VTDecompressionSessionDecodeFrame(
            session,
            sampleBuffer: sampleBuffer,
            flags: [],
            infoFlagsOut: nil
        ) { status, _, imageBuffer, presentationTime, _ in
            outcome.status = status
            outcome.imageBuffer = imageBuffer
            outcome.presentationTime = presentationTime
        }
        guard submission == noErr else {
            failedDecodeCount += 1
            throw StudioVideoDecoderError.decodeSubmissionFailed(submission)
        }

        VTDecompressionSessionWaitForAsynchronousFrames(session)

        guard outcome.status == noErr else {
            failedDecodeCount += 1
            throw StudioVideoDecoderError.decodeFailed(outcome.status)
        }
        guard let pixelBuffer = outcome.imageBuffer else {
            failedDecodeCount += 1
            throw StudioVideoDecoderError.decodeProducedNoFrame
        }

        // The session was asked for a bi-planar format, but a decoder is free to
        // hand back something else; failing loudly here beats an opaque binding
        // error two layers down.
        let formatType = CVPixelBufferGetPixelFormatType(pixelBuffer)
        guard
            formatType == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
                || formatType == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        else {
            failedDecodeCount += 1
            throw StudioVideoDecoderError.unsupportedOutputFormat(formatType)
        }

        decodedFrameCount += 1
        return StudioDecodedFrame(
            pixelBuffer: pixelBuffer,
            presentationTime: outcome.presentationTime
        )
    }

    /// Explicit teardown. Idempotent, and `deinit` calls it too, but viewers
    /// should call it when a source closes rather than waiting for ARC.
    public func invalidate() {
        guard let session else { return }
        VTDecompressionSessionWaitForAsynchronousFrames(session)
        VTDecompressionSessionInvalidate(session)
        self.session = nil
    }

    /// Mutable carrier for the decode callback.
    ///
    /// `@unchecked Sendable` is deliberate and safe here: VideoToolbox may run
    /// the handler on its own queue, but `WaitForAsynchronousFrames` above is a
    /// barrier, so the write happens-before every read.
    private final class DecodeOutcome: @unchecked Sendable {
        var status: OSStatus = noErr
        var imageBuffer: CVImageBuffer?
        var presentationTime: CMTime = .invalid
    }
}
