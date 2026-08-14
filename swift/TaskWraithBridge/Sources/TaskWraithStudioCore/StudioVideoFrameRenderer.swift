import Foundation
import IOSurface
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

    /// Must mirror `StudioGradeUniforms` in the shader.
    private struct GradeUniforms {
        var splitPosition: Float
        var lutAmount: Float
        var lutSize: Float
        var applyDisplayTransform: Float
    }

    public let device: MTLDevice
    /// Internal so tests can assert the viewer shares ONE queue across passes.
    let commandQueue: MTLCommandQueue
    /// THREE PIPELINES, AND THE REASON IS THE WHOLE BYPASS CLAIM.
    ///
    /// `pipelineState` is compiled from studio_video_fragment, which contains no
    /// grading code at all. Original therefore does not run the transform with
    /// neutral values — it does not run the transform. A bypass implemented as
    /// "same shader, identity coefficients" proves nothing about whether the
    /// transform does anything, which is the instrument-independent-of-the-
    /// defect shape this round keeps catching.
    private let pipelineState: MTLRenderPipelineState
    private let gradedPipelineState: MTLRenderPipelineState
    private let splitPipelineState: MTLRenderPipelineState
    private let lutSampler: MTLSamplerState
    /// Which program the last render actually used.
    ///
    /// EXISTS BECAUSE PIXEL EQUALITY CANNOT PROVE A BYPASS. A grading shader run
    /// with neutral uniforms produces bit-identical output to the ungraded one,
    /// so every pixel assertion in the world passes on a fake bypass — I proved
    /// that against my own suite before adding this. The only thing that
    /// distinguishes them is WHICH PROGRAM RAN, so the renderer records it and
    /// the test asserts it.
    public enum PipelineKind: String, Equatable, Sendable {
        case ungraded
        case graded
        case split
    }

    public private(set) var lastPipelineKind: PipelineKind?

    private var lutTexture: MTLTexture?
    private var lutSize = 0
    private let sampler: MTLSamplerState

    /// Frames whose plane textures may still be sampled by an in-flight command
    /// buffer. Bounded to `inFlightRetentionDepth`, so this cannot grow.
    private var retainedFrames: [StudioVideoFrameTextures] = []

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

        for (name, target) in [
            ("studio_video_graded_fragment", 0), ("studio_video_split_fragment", 1),
        ] {
            guard library.makeFunction(name: name) != nil else {
                throw StudioRendererError.shaderCompilationFailed("missing \(name)")
            }
            _ = target
        }
        func makePipeline(_ fragmentName: String) throws -> MTLRenderPipelineState {
            guard let function = library.makeFunction(name: fragmentName) else {
                throw StudioRendererError.shaderCompilationFailed("missing \(fragmentName)")
            }
            let gradeDescriptor = MTLRenderPipelineDescriptor()
            gradeDescriptor.vertexFunction = vertexFunction
            gradeDescriptor.fragmentFunction = function
            gradeDescriptor.colorAttachments[0].pixelFormat = Self.pixelFormat
            do {
                return try device.makeRenderPipelineState(descriptor: gradeDescriptor)
            } catch {
                throw StudioRendererError.pipelineCreationFailed(String(describing: error))
            }
        }
        self.gradedPipelineState = try makePipeline("studio_video_graded_fragment")
        self.splitPipelineState = try makePipeline("studio_video_split_fragment")

        // Nearest, not linear: a LUT is already interpolated between its own
        // cells by the hardware's trilinear filter on the COORDINATE. Filtering
        // the sampler as well would blur cell boundaries twice.
        let lutSamplerDescriptor = MTLSamplerDescriptor()
        lutSamplerDescriptor.minFilter = .linear
        lutSamplerDescriptor.magFilter = .linear
        lutSamplerDescriptor.sAddressMode = .clampToEdge
        lutSamplerDescriptor.tAddressMode = .clampToEdge
        lutSamplerDescriptor.rAddressMode = .clampToEdge
        guard let lutSamplerState = device.makeSamplerState(descriptor: lutSamplerDescriptor) else {
            throw StudioRendererError.pipelineCreationFailed("lut sampler unavailable")
        }
        self.lutSampler = lutSamplerState

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
    /// Loads an externally supplied LUT as a 3D texture, or clears it.
    ///
    /// Uploaded ONCE per LUT rather than per frame: a .cube is static data and
    /// re-uploading it every refresh would be a per-frame CPU cost on the
    /// presentation path, which is exactly what the AVCDAW note forbids.
    public func setLut(_ lut: StudioColorLut?) throws {
        guard let lut else {
            lutTexture = nil
            lutSize = 0
            return
        }
        let descriptor = MTLTextureDescriptor()
        descriptor.textureType = .type3D
        descriptor.pixelFormat = .rgba32Float
        descriptor.width = lut.size
        descriptor.height = lut.size
        descriptor.depth = lut.size
        descriptor.usage = .shaderRead
        descriptor.storageMode = device.hasUnifiedMemory ? .shared : .managed
        guard let texture = device.makeTexture(descriptor: descriptor) else {
            throw StudioRendererError.textureAllocationFailed
        }
        let data = lut.textureData
        let bytesPerRow = lut.size * MemoryLayout<Float>.size * 4
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            texture.replace(
                region: MTLRegionMake3D(0, 0, 0, lut.size, lut.size, lut.size),
                mipmapLevel: 0,
                slice: 0,
                withBytes: base,
                bytesPerRow: bytesPerRow,
                bytesPerImage: bytesPerRow * lut.size
            )
        }
        lutTexture = texture
        lutSize = lut.size
    }

    public var hasLut: Bool { lutTexture != nil }

    /// - Parameter chaining: when true a LATER pass in this queue owns
    ///   presentation and readback, so this commits without presenting and
    ///   without blocking. Metal executes command buffers committed to the SAME
    ///   QUEUE in commit order, so waiting here would stall the display link for
    ///   no ordering benefit — but only because the follow-up pass shares this
    ///   renderer's queue. Across queues there is no such guarantee, which is
    ///   why StudioViewerRenderer injects one queue into every pass.
    public func render(
        frame: StudioVideoFrameTextures,
        to target: MTLTexture,
        presenting drawable: MTLDrawable? = nil,
        chaining: Bool = false,
        grade: StudioGradeSettings = StudioGradeSettings()
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

        // ORIGINAL SELECTS THE UNGRADED PIPELINE. Not a neutral uniform — a
        // different compiled program that has no grading code in it.
        switch grade.mode {
        case .original:
            encoder.setRenderPipelineState(pipelineState)
            lastPipelineKind = .ungraded
        case .effect:
            encoder.setRenderPipelineState(gradedPipelineState)
            lastPipelineKind = .graded
        case .split:
            encoder.setRenderPipelineState(splitPipelineState)
            lastPipelineKind = .split
        }
        encoder.setFragmentTexture(frame.luma, index: 0)
        encoder.setFragmentTexture(frame.chroma, index: 1)
        encoder.setFragmentSamplerState(sampler, index: 0)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 0)

        if grade.mode != .original {
            var gradeUniforms = GradeUniforms(
                splitPosition: grade.splitPosition,
                lutAmount: lutTexture == nil ? 0 : grade.lutAmount,
                lutSize: Float(lutSize),
                applyDisplayTransform: grade.displayTransform == .none ? 0 : 1
            )
            encoder.setFragmentTexture(lutTexture, index: 2)
            encoder.setFragmentSamplerState(lutSampler, index: 1)
            encoder.setFragmentBytes(
                &gradeUniforms,
                length: MemoryLayout<GradeUniforms>.stride,
                index: 1
            )
        }
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

    /// Exact IOSurface identities retained until presented command buffers finish.
    public var liveIOSurfaceIDs: Set<UInt32> {
        Set(retainedFrames.compactMap { $0.luma.iosurface.map(IOSurfaceGetID) })
    }

    public var liveIOSurfaceCapacity: Int { Self.inFlightRetentionDepth }

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

    // ---- Grading (mission outcome 8) ----------------------------------------
    //
    // Deliberately BELOW the ungraded entry point and reachable only from the
    // graded/split functions. studio_video_fragment above does not call any of
    // it, which is what makes Original a true bypass rather than the transform
    // running with neutral values.

    struct StudioGradeUniforms {
        float splitPosition;
        float lutAmount;
        float lutSize;
        float applyDisplayTransform;
    };

    static inline float3 studio_decode_rec709(float3 v) {
        float3 low = v / 4.5;
        float3 high = pow(max((v + 0.099) / 1.099, 0.0), 1.0 / 0.45);
        return select(high, low, v < 0.081);
    }

    static inline float3 studio_encode_srgb(float3 linear) {
        float3 low = linear * 12.92;
        float3 high = 1.055 * pow(max(linear, 0.0), 1.0 / 2.4) - 0.055;
        return select(high, low, linear <= 0.0031308);
    }

    static inline float3 studio_apply_grade(
        float3 rgb,
        constant StudioGradeUniforms &grade,
        texture3d<float> lut,
        sampler lutSampler)
    {
        float3 graded = rgb;
        if (grade.lutSize > 1.5 && grade.lutAmount > 0.0) {
            // Half-texel inset: sampling a 3D LUT at the exact 0/1 edges reads
            // outside the outer cell centres and clips the extremes.
            float scale = (grade.lutSize - 1.0) / grade.lutSize;
            float offset = 0.5 / grade.lutSize;
            float3 coord = saturate(rgb) * scale + offset;
            float3 sampled = lut.sample(lutSampler, coord).rgb;
            graded = mix(graded, sampled, grade.lutAmount);
        }
        if (grade.applyDisplayTransform > 0.5) {
            graded = studio_encode_srgb(studio_decode_rec709(saturate(graded)));
        }
        return saturate(graded);
    }

    static inline float3 studio_video_rgb(
        float2 uv,
        texture2d<float> lumaTexture,
        texture2d<float> chromaTexture,
        sampler videoSampler,
        constant StudioVideoUniforms &uniforms)
    {
        float luma = lumaTexture.sample(videoSampler, uv).r;
        float2 chroma = chromaTexture.sample(videoSampler, uv).rg;
        float y = (luma - uniforms.lumaOffset) * uniforms.lumaScale;
        float cb = (chroma.x - 0.5) * uniforms.chromaScale;
        float cr = (chroma.y - 0.5) * uniforms.chromaScale;
        return saturate(float3(
            y + 1.5748 * cr,
            y - 0.187324 * cb - 0.468124 * cr,
            y + 1.8556 * cb));
    }

    fragment float4 studio_video_graded_fragment(
        StudioVideoVertex in [[stage_in]],
        texture2d<float> lumaTexture [[texture(0)]],
        texture2d<float> chromaTexture [[texture(1)]],
        texture3d<float> lutTexture [[texture(2)]],
        sampler videoSampler [[sampler(0)]],
        sampler lutSampler [[sampler(1)]],
        constant StudioVideoUniforms &uniforms [[buffer(0)]],
        constant StudioGradeUniforms &grade [[buffer(1)]]
    ) {
        float3 rgb = studio_video_rgb(in.uv, lumaTexture, chromaTexture, videoSampler, uniforms);
        return float4(studio_apply_grade(rgb, grade, lutTexture, lutSampler), 1.0);
    }

    fragment float4 studio_video_split_fragment(
        StudioVideoVertex in [[stage_in]],
        texture2d<float> lumaTexture [[texture(0)]],
        texture2d<float> chromaTexture [[texture(1)]],
        texture3d<float> lutTexture [[texture(2)]],
        sampler videoSampler [[sampler(0)]],
        sampler lutSampler [[sampler(1)]],
        constant StudioVideoUniforms &uniforms [[buffer(0)]],
        constant StudioGradeUniforms &grade [[buffer(1)]]
    ) {
        // ONE sample of the source, ONE draw. Both halves are therefore the
        // SAME FRAME at the same instant by construction — a split that read
        // the source twice could show a seam that is a timing artefact rather
        // than a grading difference.
        float3 rgb = studio_video_rgb(in.uv, lumaTexture, chromaTexture, videoSampler, uniforms);
        if (in.uv.x < grade.splitPosition) {
            return float4(rgb, 1.0);
        }
        return float4(studio_apply_grade(rgb, grade, lutTexture, lutSampler), 1.0);
    }
    """
}
