import Foundation
import Metal

/// Renders decoded YCbCr plane textures to RGB entirely on the GPU.
///
/// Pairs with StudioVideoTextureBridge: the bridge binds a decoder's
/// CVPixelBuffer planes as Metal textures without copying, and this samples them
/// and applies the colour matrix IN THE SHADER. Nothing here reads pixels back,
/// converts through Core Image, or touches `layer.contents`.
///
/// The conversion is BT.709 with explicit range handling. BT.601/BT.2020
/// matrices and the full display transform belong to the grading slice (outcome
/// 8); this deliberately implements one correct matrix rather than a partial
/// colour-management system, and the uniform struct is already shaped to carry a
/// matrix selector when that lands.
public final class StudioVideoFrameRenderer {
    /// Matches CAMetalLayer's default and StudioTestPatternRenderer, so one
    /// drawable can be fed by either renderer.
    public static let pixelFormat: MTLPixelFormat = .bgra8Unorm

    /// How many submitted frames' plane textures stay retained.
    ///
    /// CAMetalLayer vends at most 3 drawables and a single command queue
    /// completes in submission order, so by the time a 4th frame is submitted
    /// the 1st has necessarily finished sampling. Holding 3 is therefore
    /// sufficient to keep CVMetalTexture wrappers alive across the present path
    /// WITHOUT a completion handler — which matters because a Swift 6 @Sendable
    /// completion closure cannot capture the non-Sendable texture wrappers.
    public static let inFlightRetentionDepth = 3

    /// Must mirror `StudioVideoUniforms` in the shader.
    private struct Uniforms {
        var lumaOffset: Float
        var lumaScale: Float
        var chromaScale: Float
        var padding: Float
    }

    public let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let pipelineState: MTLRenderPipelineState
    private let sampler: MTLSamplerState

    /// Frames whose plane textures may still be sampled by an in-flight command
    /// buffer. Bounded to `inFlightRetentionDepth`, so this cannot grow.
    private var retainedFrames: [StudioVideoFrameTextures] = []

    public init(device: MTLDevice) throws {
        self.device = device

        guard let queue = device.makeCommandQueue() else {
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
            let vertexFunction = library.makeFunction(name: "studio_video_vertex"),
            let fragmentFunction = library.makeFunction(name: "studio_video_fragment")
        else {
            throw StudioRendererError.shaderCompilationFailed("missing video entry points")
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

        let samplerDescriptor = MTLSamplerDescriptor()
        samplerDescriptor.minFilter = .linear
        samplerDescriptor.magFilter = .linear
        samplerDescriptor.sAddressMode = .clampToEdge
        samplerDescriptor.tAddressMode = .clampToEdge
        guard let sampler = device.makeSamplerState(descriptor: samplerDescriptor) else {
            throw StudioRendererError.pipelineCreationFailed("sampler state unavailable")
        }
        self.sampler = sampler
    }

    public static func makeDefault() throws -> StudioVideoFrameRenderer {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw StudioRendererError.metalUnavailable
        }
        return try StudioVideoFrameRenderer(device: device)
    }

    /// Draws one decoded frame.
    ///
    /// - Parameter drawable: when supplied the buffer presents and returns
    ///   without waiting (the on-screen path), and `frame` is retained in the
    ///   in-flight ring. When nil the buffer is committed and waited on so the
    ///   target is immediately readable, and no retention is needed because the
    ///   caller's own reference outlives the wait.
    /// - Parameter chaining: when true a LATER pass in this queue owns
    ///   presentation and readback, so this commits without presenting and
    ///   without blocking. Metal executes command buffers in commit order, so
    ///   waiting here would stall the display link for no ordering benefit.
    public func render(
        frame: StudioVideoFrameTextures,
        to target: MTLTexture,
        presenting drawable: MTLDrawable? = nil,
        chaining: Bool = false
    ) throws {
        guard target.pixelFormat == Self.pixelFormat else {
            throw StudioRendererError.unsupportedPixelFormat(String(describing: target.pixelFormat))
        }

        let passDescriptor = MTLRenderPassDescriptor()
        passDescriptor.colorAttachments[0].texture = target
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
            lumaOffset: frame.range.lumaOffset,
            lumaScale: frame.range.lumaScale,
            chromaScale: frame.range.chromaScale,
            padding: 0
        )

        encoder.setRenderPipelineState(pipelineState)
        encoder.setFragmentTexture(frame.luma, index: 0)
        encoder.setFragmentTexture(frame.chroma, index: 1)
        encoder.setFragmentSamplerState(sampler, index: 0)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding()

        if chaining {
            // Retention is REQUIRED here for the same reason the drawable path
            // needs it: the buffer is committed without waiting, so the GPU is
            // still sampling these plane textures after this returns. Omitting
            // it would let the CVMetalTexture wrappers die mid-flight.
            retain(frame)
            commandBuffer.commit()
            return
        }

        if let drawable {
            retain(frame)
            commandBuffer.present(drawable)
            commandBuffer.commit()
            return
        }

        if target.storageMode == .managed {
            guard let blit = commandBuffer.makeBlitCommandEncoder() else {
                throw StudioRendererError.encodingFailed
            }
            blit.synchronize(resource: target)
            blit.endEncoding()
        }
        commandBuffer.commit()
        commandBuffer.waitUntilCompleted()
    }

    /// Number of frames currently held by the in-flight ring. Bounded
    /// diagnostics for outcome 9; a value above the retention depth is a bug.
    public var retainedFrameCount: Int { retainedFrames.count }

    /// Drops all retained frames. Only safe once no submitted command buffer is
    /// still sampling them — for example after the viewer stops presenting.
    public func releaseRetainedFrames() {
        retainedFrames.removeAll(keepingCapacity: true)
    }

    /// Internal rather than private so the bound on the ring is directly
    /// testable; the present path is the only production caller.
    func retain(_ frame: StudioVideoFrameTextures) {
        retainedFrames.append(frame)
        if retainedFrames.count > Self.inFlightRetentionDepth {
            retainedFrames.removeFirst(retainedFrames.count - Self.inFlightRetentionDepth)
        }
    }

    // MARK: - Shader

    private static let shaderSource = """
    #include <metal_stdlib>
    using namespace metal;

    struct StudioVideoVertex {
        float4 position [[position]];
        float2 uv;
    };

    struct StudioVideoUniforms {
        float lumaOffset;
        float lumaScale;
        float chromaScale;
        float padding;
    };

    constant float2 kStudioVideoPositions[4] = {
        float2(-1.0, -1.0),
        float2( 1.0, -1.0),
        float2(-1.0,  1.0),
        float2( 1.0,  1.0)
    };

    vertex StudioVideoVertex studio_video_vertex(uint vertexID [[vertex_id]]) {
        float2 position = kStudioVideoPositions[vertexID];
        StudioVideoVertex out;
        out.position = float4(position, 0.0, 1.0);
        // v = 0 at the TOP, matching CVPixelBuffer row 0. An inverted mapping
        // here is the classic upside-down viewer.
        out.uv = float2((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5);
        return out;
    }

    fragment float4 studio_video_fragment(
        StudioVideoVertex in [[stage_in]],
        texture2d<float> lumaTexture [[texture(0)]],
        texture2d<float> chromaTexture [[texture(1)]],
        sampler videoSampler [[sampler(0)]],
        constant StudioVideoUniforms &uniforms [[buffer(0)]]
    ) {
        float luma = lumaTexture.sample(videoSampler, in.uv).r;
        float2 chroma = chromaTexture.sample(videoSampler, in.uv).rg;

        float y = (luma - uniforms.lumaOffset) * uniforms.lumaScale;
        float cb = (chroma.x - 0.5) * uniforms.chromaScale;
        float cr = (chroma.y - 0.5) * uniforms.chromaScale;

        // BT.709 full-swing matrix; range normalisation already applied above.
        float r = y + 1.5748 * cr;
        float g = y - 0.187324 * cb - 0.468124 * cr;
        float b = y + 1.8556 * cb;

        return float4(saturate(float3(r, g, b)), 1.0);
    }
    """
}
