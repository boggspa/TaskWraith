import Foundation
import Metal

/// Metal render path for the TaskWraith Studio viewer (mission outcomes 4/5
/// groundwork).
///
/// This slice renders a synthetic test pattern rather than decoded video. What
/// it establishes is the PRESENTATION PATH the decoder will later feed: a
/// render-pass writing straight into a Metal texture, which is either an
/// offscreen target (tests) or a `CAMetalDrawable`'s texture (on screen). No
/// frame ever becomes a `CGImage`, and nothing is assigned to `layer.contents`.
/// That is deliberate — see the banked AVCDAW do-not-repeat note: the reference
/// app's `PreviewViewport.swift` round-trips every frame through
/// `CIContext.createCGImage`, which is a per-frame CPU-visible copy and cannot
/// satisfy the zero-copy requirement.
///
/// Two properties matter for what comes next:
/// * The colour attachment is the SAME `MTLTexture` abstraction that
///   `CVMetalTextureCache` hands back for a decoded `CVPixelBuffer`, so swapping
///   the test pattern for a sampled video texture does not change this
///   structure.
/// * The shader is compiled from source at runtime via `makeLibrary(source:)`
///   instead of a build-time `.metallib`. That keeps SwiftPM out of the Metal
///   toolchain entirely and means the eventual `.app` needs no metallib
///   resource — one fewer packaging dependency for outcome 10.
///
/// NOT established here: VideoToolbox decode, `CVMetalTextureCache` binding,
/// audio, or any measured A/V sync. Those are the next slice.
public enum StudioRendererError: Error, Equatable {
    case metalUnavailable
    case shaderCompilationFailed(String)
    case pipelineCreationFailed(String)
    case commandQueueUnavailable
    case textureAllocationFailed
    case encodingFailed
    case unsupportedPixelFormat(String)
    case readbackOutOfBounds
    case readbackUnsupportedStorageMode
}

/// One RGBA sample. Diagnostics/tests only.
public struct StudioPixel: Equatable, Sendable {
    public let red: UInt8
    public let green: UInt8
    public let blue: UInt8
    public let alpha: UInt8

    public init(red: UInt8, green: UInt8, blue: UInt8, alpha: UInt8) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    public static let white = StudioPixel(red: 255, green: 255, blue: 255, alpha: 255)
    public static let black = StudioPixel(red: 0, green: 0, blue: 0, alpha: 255)
    public static let yellow = StudioPixel(red: 255, green: 255, blue: 0, alpha: 255)
    public static let cyan = StudioPixel(red: 0, green: 255, blue: 255, alpha: 255)
    public static let green = StudioPixel(red: 0, green: 255, blue: 0, alpha: 255)
    public static let magenta = StudioPixel(red: 255, green: 0, blue: 255, alpha: 255)
    public static let red = StudioPixel(red: 255, green: 0, blue: 0, alpha: 255)
    public static let blue = StudioPixel(red: 0, green: 0, blue: 255, alpha: 255)
}

public final class StudioTestPatternRenderer {
    /// Matches `CAMetalLayer`'s default so the offscreen and on-screen paths
    /// share one pipeline state.
    public static let pixelFormat: MTLPixelFormat = .bgra8Unorm

    /// Frames for the sweep bar to traverse the full width once.
    public static let sweepPeriodFrames: Int64 = 120

    /// Bars occupy the top half; the sweep band the bottom half. Keeping them
    /// disjoint is what lets a test assert bar colours and sweep position
    /// independently.
    public static let barBandBottomV: Float = 0.5

    /// Half-width of the sweep bar in normalised width.
    public static let sweepHalfWidth: Float = 0.02

    /// Must mirror `StudioPatternUniforms` in the shader below.
    private struct Uniforms {
        var sweepU: Float
        var sweepHalfWidth: Float
        var barBandBottomV: Float
        var padding: Float
    }

    public let device: MTLDevice
    /// Internal so tests can assert the viewer shares ONE queue across passes.
    let commandQueue: MTLCommandQueue
    private let pipelineState: MTLRenderPipelineState

    /// - Parameter commandQueue: inject the OWNING VIEWER'S queue so passes that
    ///   composite into one drawable are ordered. Metal serialises command
    ///   buffers within a queue by commit order; it guarantees NOTHING across
    ///   queues. Defaults to a private queue for standalone use.
    public init(device: MTLDevice, commandQueue: MTLCommandQueue? = nil) throws {
        self.device = device

        guard let queue = commandQueue ?? device.makeCommandQueue() else {
            throw StudioRendererError.commandQueueUnavailable
        }
        self.commandQueue = queue

        let library: MTLLibrary
        do {
            library = try device.makeLibrary(source: Self.shaderSource, options: nil)
        } catch {
            throw StudioRendererError.shaderCompilationFailed(String(describing: error))
        }

        guard
            let vertexFunction = library.makeFunction(name: "studio_pattern_vertex"),
            let fragmentFunction = library.makeFunction(name: "studio_pattern_fragment")
        else {
            throw StudioRendererError.shaderCompilationFailed("missing pattern entry points")
        }

        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = vertexFunction
        descriptor.fragmentFunction = fragmentFunction
        descriptor.colorAttachments[0].pixelFormat = Self.pixelFormat
        do {
            self.pipelineState = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            throw StudioRendererError.pipelineCreationFailed(String(describing: error))
        }
    }

    /// Convenience for the system default device. Returns nil rather than
    /// throwing when the machine has no Metal device, so callers can skip
    /// cleanly instead of failing.
    public static func makeDefault() throws -> StudioTestPatternRenderer {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw StudioRendererError.metalUnavailable
        }
        return try StudioTestPatternRenderer(device: device)
    }

    /// An offscreen colour target that the CPU can sample afterwards.
    /// `.shared` on unified memory, `.managed` otherwise, because textures
    /// cannot be `.shared` on discrete-GPU Macs — and the shipping mac target
    /// is a universal build, so the Intel path is not hypothetical.
    public static func makeOffscreenTarget(
        device: MTLDevice,
        width: Int,
        height: Int
    ) throws -> MTLTexture {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: pixelFormat,
            width: width,
            height: height,
            mipmapped: false
        )
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = device.hasUnifiedMemory ? .shared : .managed
        guard let texture = device.makeTexture(descriptor: descriptor) else {
            throw StudioRendererError.textureAllocationFailed
        }
        return texture
    }

    /// Renders one frame of the pattern.
    ///
    /// - Parameter drawable: when supplied the command buffer presents it and
    ///   returns WITHOUT waiting, which is the on-screen path — blocking the
    ///   display-link callback on GPU completion is how a viewer starts
    ///   dropping frames. When nil the buffer is committed and waited on so the
    ///   texture is immediately readable, which is the offscreen/test path.
    /// - Parameter chaining: when true a LATER pass in this queue owns
    ///   presentation and readback, so this commits without presenting and
    ///   without blocking.
    public func render(
        to texture: MTLTexture,
        frameIndex: Int64,
        presenting drawable: MTLDrawable? = nil,
        chaining: Bool = false
    ) throws {
        guard texture.pixelFormat == Self.pixelFormat else {
            throw StudioRendererError.unsupportedPixelFormat(String(describing: texture.pixelFormat))
        }

        let passDescriptor = MTLRenderPassDescriptor()
        passDescriptor.colorAttachments[0].texture = texture
        passDescriptor.colorAttachments[0].loadAction = .clear
        passDescriptor.colorAttachments[0].storeAction = .store
        passDescriptor.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1)

        guard
            let commandBuffer = commandQueue.makeCommandBuffer(),
            let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: passDescriptor)
        else {
            throw StudioRendererError.encodingFailed
        }

        var uniforms = Uniforms(
            sweepU: Self.sweepPosition(forFrame: frameIndex),
            sweepHalfWidth: Self.sweepHalfWidth,
            barBandBottomV: Self.barBandBottomV,
            padding: 0
        )

        encoder.setRenderPipelineState(pipelineState)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding()

        if chaining {
            commandBuffer.commit()
            return
        }

        if let drawable {
            commandBuffer.present(drawable)
            commandBuffer.commit()
            return
        }

        // Offscreen: a discrete GPU writes into VRAM, so the managed copy must
        // be synchronised before the CPU may read it.
        if texture.storageMode == .managed {
            guard let blit = commandBuffer.makeBlitCommandEncoder() else {
                throw StudioRendererError.encodingFailed
            }
            blit.synchronize(resource: texture)
            blit.endEncoding()
        }
        commandBuffer.commit()
        commandBuffer.waitUntilCompleted()
    }

    /// Normalised sweep position for a frame. Pure and total, so a test can
    /// predict the rendered position from a clock reading alone.
    public static func sweepPosition(forFrame frameIndex: Int64) -> Float {
        let period = sweepPeriodFrames
        let phase = ((frameIndex % period) + period) % period
        return Float(phase) / Float(period)
    }

    /// Which colour bar covers a normalised horizontal coordinate.
    public static func barIndex(atU u: Float) -> Int {
        Int(min(max(u * 8.0, 0.0), 7.999))
    }

    /// Expected colour of a bar, mirroring the shader's table. Tests assert
    /// rendered pixels against this, so a shader edit that changes the pattern
    /// without updating the table fails loudly.
    public static func barColor(index: Int) -> StudioPixel {
        switch index {
        case 0: return .white
        case 1: return .yellow
        case 2: return .cyan
        case 3: return .green
        case 4: return .magenta
        case 5: return .red
        case 6: return .blue
        default: return .black
        }
    }

    /// Reads ONE pixel. This is a diagnostic/verification affordance and is
    /// deliberately bounded to a 1x1 region (4 bytes): per the AVCDAW
    /// do-not-repeat note, readback must never sit on the presentation path.
    /// Nothing in `render(to:frameIndex:presenting:)` calls this.
    public static func readPixel(from texture: MTLTexture, x: Int, y: Int) throws -> StudioPixel {
        guard x >= 0, y >= 0, x < texture.width, y < texture.height else {
            throw StudioRendererError.readbackOutOfBounds
        }
        guard texture.storageMode != .private else {
            throw StudioRendererError.readbackUnsupportedStorageMode
        }
        guard texture.pixelFormat == pixelFormat else {
            throw StudioRendererError.unsupportedPixelFormat(String(describing: texture.pixelFormat))
        }
        var bytes = [UInt8](repeating: 0, count: 4)
        texture.getBytes(
            &bytes,
            bytesPerRow: 4,
            from: MTLRegionMake2D(x, y, 1, 1),
            mipmapLevel: 0
        )
        // .bgra8Unorm memory order is B, G, R, A.
        return StudioPixel(red: bytes[2], green: bytes[1], blue: bytes[0], alpha: bytes[3])
    }

    // MARK: - Shader

    private static let shaderSource = """
    #include <metal_stdlib>
    using namespace metal;

    struct StudioPatternVertex {
        float4 position [[position]];
        float2 uv;
    };

    struct StudioPatternUniforms {
        float sweepU;
        float sweepHalfWidth;
        float barBandBottomV;
        float padding;
    };

    constant float2 kStudioPatternPositions[4] = {
        float2(-1.0, -1.0),
        float2( 1.0, -1.0),
        float2(-1.0,  1.0),
        float2( 1.0,  1.0)
    };

    float3 studio_bar_color(int index);

    float3 studio_bar_color(int index) {
        switch (index) {
            case 0: return float3(1.0, 1.0, 1.0);
            case 1: return float3(1.0, 1.0, 0.0);
            case 2: return float3(0.0, 1.0, 1.0);
            case 3: return float3(0.0, 1.0, 0.0);
            case 4: return float3(1.0, 0.0, 1.0);
            case 5: return float3(1.0, 0.0, 0.0);
            case 6: return float3(0.0, 0.0, 1.0);
            default: return float3(0.0, 0.0, 0.0);
        }
    }

    vertex StudioPatternVertex studio_pattern_vertex(uint vertexID [[vertex_id]]) {
        float2 position = kStudioPatternPositions[vertexID];
        StudioPatternVertex out;
        out.position = float4(position, 0.0, 1.0);
        // v = 0 at the TOP of the target, matching texture row 0.
        out.uv = float2((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5);
        return out;
    }

    fragment float4 studio_pattern_fragment(
        StudioPatternVertex in [[stage_in]],
        constant StudioPatternUniforms &uniforms [[buffer(0)]]
    ) {
        if (in.uv.y <= uniforms.barBandBottomV) {
            int index = int(clamp(in.uv.x * 8.0, 0.0, 7.999));
            return float4(studio_bar_color(index), 1.0);
        }
        float distance = fabs(in.uv.x - uniforms.sweepU);
        float level = distance <= uniforms.sweepHalfWidth ? 1.0 : 0.0;
        return float4(level, level, level, 1.0);
    }
    """
}
