import CoreVideo
import Foundation
import Metal

/// Zero-copy bridge from a decoder's `CVPixelBuffer` to Metal plane textures
/// (mission outcome 5, the S2 requirement).
///
/// The whole point is what does NOT happen here: no `CVPixelBufferLockBaseAddress`,
/// no `CIContext.createCGImage`, no per-frame CPU copy. `CVMetalTextureCache`
/// wraps the pixel buffer's existing IOSurface planes as `MTLTexture`s that the
/// GPU samples in place, and the YCbCr-to-RGB conversion happens in the shader
/// (see StudioVideoFrameRenderer). That is the banked AVCDAW do-not-repeat note
/// turned into code.
///
/// LIFETIME IS THE DANGEROUS PART. `CVMetalTextureGetTexture` returns an
/// `MTLTexture` whose backing is owned by the `CVMetalTexture` wrapper. Drop the
/// wrapper while the GPU is still reading and you get intermittent black or torn
/// frames — and, because the texture cache then recycles surfaces it should not
/// have, exactly the kind of unbounded growth outcome 11 tests for. So
/// `StudioVideoFrameTextures` retains both wrappers, and callers must keep it
/// alive until the command buffer that samples it has completed *and* the
/// wrapper has rolled out of the present-path floor (CAMetalLayer still
/// displays recently presented IOSurfaces after GPU completion).
///
/// THE OTHER TRAP: a `CVPixelBuffer` created without IOSurface backing cannot be
/// bound at all. `CVMetalTextureCacheCreateTextureFromImage` fails with
/// `kCVReturnInvalidPixelFormat`-class errors rather than silently copying, which
/// is good, but only if the buffer is allocated with
/// `kCVPixelBufferMetalCompatibilityKey` and IOSurface properties set. This is
/// asserted by a test so a future decoder slice cannot regress it quietly.
public enum StudioVideoBridgeError: Error, Equatable {
    case textureCacheCreationFailed(Int32)
    case unsupportedPixelFormat(UInt32)
    case unexpectedPlaneCount(Int)
    /// Almost always a pixel buffer allocated without IOSurface/Metal
    /// compatibility, or a cache that has outlived its device.
    case planeTextureCreationFailed(plane: Int, status: Int32)
    case planeTextureUnavailable(plane: Int)
}

/// How an 8-bit bi-planar buffer's levels map onto normalised sample values.
public enum StudioVideoRange: Equatable, Sendable {
    /// Y and CbCr use the whole 0...255 range.
    case full
    /// Broadcast levels: Y is 16...235, CbCr is 16...240.
    case video

    /// Value subtracted from the sampled luma before scaling.
    public var lumaOffset: Float {
        switch self {
        case .full: return 0
        case .video: return 16.0 / 255.0
        }
    }

    /// Luma gain that maps the coded range onto 0...1.
    public var lumaScale: Float {
        switch self {
        case .full: return 1
        case .video: return 255.0 / 219.0
        }
    }

    /// Chroma gain applied after centring around 0.5.
    public var chromaScale: Float {
        switch self {
        case .full: return 1
        case .video: return 255.0 / 224.0
        }
    }
}

/// One decoded frame as GPU-resident plane textures, plus the wrappers that keep
/// them valid. Deliberately NOT Sendable: it must stay on the thread that
/// submits the command buffer sampling it.
public struct StudioVideoFrameTextures {
    /// Full-resolution Y plane, `.r8Unorm`.
    public let luma: MTLTexture
    /// Half-resolution interleaved CbCr plane, `.rg8Unorm`.
    public let chroma: MTLTexture
    public let displayWidth: Int
    public let displayHeight: Int
    public let range: StudioVideoRange

    /// Retained so the plane textures stay valid. Never read directly; their
    /// existence IS the contract. Removing these fields is the bug.
    private let lumaWrapper: CVMetalTexture
    private let chromaWrapper: CVMetalTexture

    init(
        luma: MTLTexture,
        chroma: MTLTexture,
        displayWidth: Int,
        displayHeight: Int,
        range: StudioVideoRange,
        lumaWrapper: CVMetalTexture,
        chromaWrapper: CVMetalTexture
    ) {
        self.luma = luma
        self.chroma = chroma
        self.displayWidth = displayWidth
        self.displayHeight = displayHeight
        self.range = range
        self.lumaWrapper = lumaWrapper
        self.chromaWrapper = chromaWrapper
    }
}

public final class StudioVideoTextureBridge {
    public static let lumaPixelFormat: MTLPixelFormat = .r8Unorm
    public static let chromaPixelFormat: MTLPixelFormat = .rg8Unorm

    public let device: MTLDevice
    private let textureCache: CVMetalTextureCache

    /// Bounded diagnostics for outcome 9. Counted here because this is the only
    /// place that can see a binding fail.
    public private(set) var boundFrameCount: Int = 0
    public private(set) var failedBindCount: Int = 0

    public init(device: MTLDevice) throws {
        self.device = device
        var cache: CVMetalTextureCache?
        let status = CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &cache)
        guard status == kCVReturnSuccess, let cache else {
            throw StudioVideoBridgeError.textureCacheCreationFailed(status)
        }
        self.textureCache = cache
    }

    /// Wraps a bi-planar 4:2:0 pixel buffer's planes as Metal textures without
    /// copying pixel data.
    public func makeTextures(from pixelBuffer: CVPixelBuffer) throws -> StudioVideoFrameTextures {
        let formatType = CVPixelBufferGetPixelFormatType(pixelBuffer)
        let range: StudioVideoRange
        switch formatType {
        case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange:
            range = .full
        case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange:
            range = .video
        default:
            failedBindCount += 1
            throw StudioVideoBridgeError.unsupportedPixelFormat(formatType)
        }

        let planeCount = CVPixelBufferGetPlaneCount(pixelBuffer)
        guard planeCount == 2 else {
            failedBindCount += 1
            throw StudioVideoBridgeError.unexpectedPlaneCount(planeCount)
        }

        do {
            let luma = try makePlaneTexture(
                pixelBuffer: pixelBuffer,
                plane: 0,
                pixelFormat: Self.lumaPixelFormat
            )
            let chroma = try makePlaneTexture(
                pixelBuffer: pixelBuffer,
                plane: 1,
                pixelFormat: Self.chromaPixelFormat
            )
            boundFrameCount += 1
            return StudioVideoFrameTextures(
                luma: luma.texture,
                chroma: chroma.texture,
                displayWidth: CVPixelBufferGetWidthOfPlane(pixelBuffer, 0),
                displayHeight: CVPixelBufferGetHeightOfPlane(pixelBuffer, 0),
                range: range,
                lumaWrapper: luma.wrapper,
                chromaWrapper: chroma.wrapper
            )
        } catch {
            failedBindCount += 1
            throw error
        }
    }

    /// Releases texture-cache entries no longer referenced.
    ///
    /// MUST NOT be called while any StudioVideoFrameTextures handed out by this
    /// bridge is still being sampled by an in-flight command buffer. Safe points
    /// are after a `waitUntilCompleted`, or once that buffer's completion
    /// handler has released the renderer's lease.
    public func flushUnusedTextures() {
        CVMetalTextureCacheFlush(textureCache, 0)
    }

    private func makePlaneTexture(
        pixelBuffer: CVPixelBuffer,
        plane: Int,
        pixelFormat: MTLPixelFormat
    ) throws -> (texture: MTLTexture, wrapper: CVMetalTexture) {
        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, plane)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, plane)

        var wrapper: CVMetalTexture?
        let status = CVMetalTextureCacheCreateTextureFromImage(
            kCFAllocatorDefault,
            textureCache,
            pixelBuffer,
            nil,
            pixelFormat,
            width,
            height,
            plane,
            &wrapper
        )
        guard status == kCVReturnSuccess, let wrapper else {
            throw StudioVideoBridgeError.planeTextureCreationFailed(plane: plane, status: status)
        }
        guard let texture = CVMetalTextureGetTexture(wrapper) else {
            throw StudioVideoBridgeError.planeTextureUnavailable(plane: plane)
        }
        return (texture, wrapper)
    }
}
