import Foundation
import Metal

/// Draws StudioOverlayModel over the picture, in Metal, in the same queue as the
/// video (mission outcome 2's visible transport).
///
/// WHY NOT AN APPKIT LAYER. A CATextLayer or NSTextField above the CAMetalLayer
/// is a second surface the window server has to composite over every video
/// frame, and per the banked AVCDAW do-not-repeat note the preview must not grow
/// a CPU-composited path. Here the HUD is triangles in the SAME render target,
/// blended by the GPU: the whole overlay is one draw call over a
/// rasterised-once glyph atlas, and there is no readback anywhere on the
/// presentation path.
///
/// The overlay pass LOADS the colour attachment instead of clearing it, so the
/// decoded frame the content pass just wrote survives underneath.
public final class StudioOverlayRenderer {
    /// One vertex: position and uv are pixel-space converted to NDC on the CPU,
    /// colour is straight tint, and `textured` selects atlas sampling. Keeping
    /// solid rects and glyphs in ONE vertex format is what collapses the HUD to
    /// a single draw call.
    struct Vertex {
        var x: Float
        var y: Float
        var u: Float
        var v: Float
        var red: Float
        var green: Float
        var blue: Float
        var alpha: Float
        var textured: Float
    }

    /// Vertex buffers in flight. Matches CAMetalLayer's default drawable count:
    /// overwriting a buffer the GPU may still be reading is a race, and three is
    /// the conventional bound for a triple-buffered presentation path. It is
    /// also the same depth the video renderer's retention ring uses, so the two
    /// resource bounds stay easy to reason about together.
    static let bufferRingDepth = 3

    public let device: MTLDevice
    public let atlas: StudioTextAtlas

    /// Internal so tests can assert the viewer shares ONE queue across passes.
    let commandQueue: MTLCommandQueue
    private let pipelineState: MTLRenderPipelineState
    private let samplerState: MTLSamplerState
    private var bufferRing: [MTLBuffer?]
    private var ringIndex = 0

    /// Vertices emitted by the most recent render. Bounded diagnostic — a HUD
    /// that silently grows its vertex count is a HUD that is leaking strings.
    public private(set) var lastVertexCount = 0

    /// - Parameter commandQueue: inject the OWNING VIEWER'S queue so passes that
    ///   composite into one drawable are ordered. Metal serialises command
    ///   buffers within a queue by commit order; it guarantees NOTHING across
    ///   queues. Defaults to a private queue for standalone use.
    public init(device: MTLDevice, commandQueue: MTLCommandQueue? = nil) throws {
        self.device = device
        self.atlas = try StudioTextAtlas(device: device)

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
            let vertexFunction = library.makeFunction(name: "studio_overlay_vertex"),
            let fragmentFunction = library.makeFunction(name: "studio_overlay_fragment")
        else {
            throw StudioRendererError.pipelineCreationFailed("overlay functions missing")
        }

        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = vertexFunction
        descriptor.fragmentFunction = fragmentFunction
        let attachment = descriptor.colorAttachments[0]
        attachment?.pixelFormat = StudioTestPatternRenderer.pixelFormat
        // Premultiplied source blending: the fragment shader multiplies rgb by
        // alpha, which is what keeps antialiased glyph edges from fringing.
        attachment?.isBlendingEnabled = true
        attachment?.rgbBlendOperation = .add
        attachment?.alphaBlendOperation = .add
        attachment?.sourceRGBBlendFactor = .one
        attachment?.sourceAlphaBlendFactor = .one
        attachment?.destinationRGBBlendFactor = .oneMinusSourceAlpha
        attachment?.destinationAlphaBlendFactor = .oneMinusSourceAlpha
        do {
            pipelineState = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            throw StudioRendererError.pipelineCreationFailed(String(describing: error))
        }

        let sampler = MTLSamplerDescriptor()
        sampler.minFilter = .linear
        sampler.magFilter = .linear
        sampler.sAddressMode = .clampToEdge
        sampler.tAddressMode = .clampToEdge
        guard let samplerState = device.makeSamplerState(descriptor: sampler) else {
            throw StudioRendererError.pipelineCreationFailed("overlay sampler")
        }
        self.samplerState = samplerState
        self.bufferRing = Array(repeating: nil, count: Self.bufferRingDepth)
    }

    // MARK: - Vertex assembly

    /// Turns the model into triangles. Pure and internal so a test can assert
    /// the geometry without a GPU, which is how the NDC conversion stays honest.
    func vertices(for model: StudioOverlayModel, width: Double, height: Double) -> [Vertex] {
        guard model.isVisible, width > 0, height > 0 else { return [] }
        var output: [Vertex] = []
        output.reserveCapacity(model.rects.count * 6 + 96)

        for rect in model.rects {
            appendQuad(
                into: &output,
                frame: rect.frame,
                color: rect.color,
                uv: nil,
                width: width,
                height: height
            )
        }

        for text in model.texts {
            let advance = StudioOverlayRenderMetrics.advance(forPointSize: text.pointSize)
            let cellHeight = StudioOverlayRenderMetrics.cellHeight(forPointSize: text.pointSize)
            var penX = text.x
            for character in text.string {
                defer { penX += advance }
                // Space has no coverage; skipping it is free and keeps the
                // vertex count proportional to visible glyphs.
                guard character != " ", let uv = atlas.uvRect(for: character) else { continue }
                appendQuad(
                    into: &output,
                    frame: StudioOverlayFrame(
                        x: penX,
                        y: text.y,
                        width: advance,
                        height: cellHeight
                    ),
                    color: text.color,
                    uv: uv,
                    width: width,
                    height: height
                )
            }
        }
        return output
    }

    private func appendQuad(
        into output: inout [Vertex],
        frame: StudioOverlayFrame,
        color: StudioOverlayColor,
        uv: (u0: Double, v0: Double, u1: Double, v1: Double)?,
        width: Double,
        height: Double
    ) {
        // Pixel space (top-left origin, y down) to Metal NDC (centre origin,
        // y up). Done here, once, rather than in the shader, so the layout model
        // never has to think in NDC.
        let x0 = Float(frame.x / width * 2 - 1)
        let x1 = Float(frame.maxX / width * 2 - 1)
        let y0 = Float(1 - frame.y / height * 2)
        let y1 = Float(1 - frame.maxY / height * 2)
        let textured: Float = uv == nil ? 0 : 1
        let u0 = Float(uv?.u0 ?? 0)
        let v0 = Float(uv?.v0 ?? 0)
        let u1 = Float(uv?.u1 ?? 0)
        let v1 = Float(uv?.v1 ?? 0)
        let red = Float(color.red)
        let green = Float(color.green)
        let blue = Float(color.blue)
        let alpha = Float(color.alpha)

        func vertex(_ x: Float, _ y: Float, _ u: Float, _ v: Float) -> Vertex {
            Vertex(
                x: x,
                y: y,
                u: u,
                v: v,
                red: red,
                green: green,
                blue: blue,
                alpha: alpha,
                textured: textured
            )
        }

        output.append(vertex(x0, y0, u0, v0))
        output.append(vertex(x1, y0, u1, v0))
        output.append(vertex(x0, y1, u0, v1))
        output.append(vertex(x1, y0, u1, v0))
        output.append(vertex(x1, y1, u1, v1))
        output.append(vertex(x0, y1, u0, v1))
    }

    // MARK: - Render

    /// Draws the overlay over whatever is already in `target`.
    ///
    /// Presentation is OWNED HERE when a drawable is supplied, because the
    /// overlay is the last pass: the content renderer runs in `chaining` mode
    /// and hands presentation forward. An empty or hidden overlay must still
    /// present, or the viewer freezes on the frame before the HUD was hidden.
    /// - Parameter clearingFirst: set when the content pass did NOT draw, so the
    ///   target still holds a stale picture. Clearing keeps a dropped frame
    ///   visibly dropped instead of showing frozen video under a live HUD.
    public func render(
        model: StudioOverlayModel,
        to target: MTLTexture,
        presenting drawable: MTLDrawable? = nil,
        clearingFirst: Bool = false
    ) throws {
        guard target.pixelFormat == StudioTestPatternRenderer.pixelFormat else {
            throw StudioRendererError.unsupportedPixelFormat(String(describing: target.pixelFormat))
        }
        guard let commandBuffer = commandQueue.makeCommandBuffer() else {
            throw StudioRendererError.encodingFailed
        }

        let vertexList = vertices(
            for: model,
            width: Double(target.width),
            height: Double(target.height)
        )
        lastVertexCount = vertexList.count

        if !vertexList.isEmpty || clearingFirst {
            let passDescriptor = MTLRenderPassDescriptor()
            passDescriptor.colorAttachments[0].texture = target
            // LOAD by default: the decoded frame is already in there and the
            // overlay composites on top of it.
            passDescriptor.colorAttachments[0].loadAction = clearingFirst ? .clear : .load
            passDescriptor.colorAttachments[0].storeAction = .store
            passDescriptor.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1)

            guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: passDescriptor)
            else {
                throw StudioRendererError.encodingFailed
            }
            if !vertexList.isEmpty {
                let byteCount = vertexList.count * MemoryLayout<Vertex>.stride
                guard let buffer = buffer(ofAtLeast: byteCount) else {
                    throw StudioRendererError.textureAllocationFailed
                }
                vertexList.withUnsafeBytes { source in
                    guard let base = source.baseAddress else { return }
                    buffer.contents().copyMemory(from: base, byteCount: byteCount)
                }
                encoder.setRenderPipelineState(pipelineState)
                encoder.setVertexBuffer(buffer, offset: 0, index: 0)
                encoder.setFragmentTexture(atlas.texture, index: 0)
                encoder.setFragmentSamplerState(samplerState, index: 0)
                encoder.drawPrimitives(
                    type: .triangle,
                    vertexStart: 0,
                    vertexCount: vertexList.count
                )
            }
            encoder.endEncoding()
        }

        if let drawable {
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

    private func buffer(ofAtLeast byteCount: Int) -> MTLBuffer? {
        ringIndex = (ringIndex + 1) % Self.bufferRingDepth
        if let existing = bufferRing[ringIndex], existing.length >= byteCount {
            return existing
        }
        // Grow in whole pages so a HUD whose text length wobbles by a character
        // does not reallocate every frame.
        let rounded = ((byteCount + 4095) / 4096) * 4096
        let created = device.makeBuffer(length: rounded, options: .storageModeShared)
        bufferRing[ringIndex] = created
        return created
    }

    // MARK: - Shader

    private static let shaderSource = """
        #include <metal_stdlib>
        using namespace metal;

        struct StudioOverlayVertexIn {
            packed_float2 position;
            packed_float2 uv;
            packed_float4 color;
            float textured;
        };

        struct StudioOverlayVaryings {
            float4 position [[position]];
            float2 uv;
            float4 color;
            float textured;
        };

        vertex StudioOverlayVaryings studio_overlay_vertex(
            uint vertexId [[vertex_id]],
            const device StudioOverlayVertexIn *vertices [[buffer(0)]])
        {
            StudioOverlayVertexIn source = vertices[vertexId];
            StudioOverlayVaryings out;
            out.position = float4(source.position[0], source.position[1], 0.0, 1.0);
            out.uv = float2(source.uv[0], source.uv[1]);
            out.color = float4(source.color[0], source.color[1], source.color[2], source.color[3]);
            out.textured = source.textured;
            return out;
        }

        fragment float4 studio_overlay_fragment(
            StudioOverlayVaryings in [[stage_in]],
            texture2d<float> atlas [[texture(0)]],
            sampler atlasSampler [[sampler(0)]])
        {
            float4 tint = in.color;
            if (in.textured > 0.5) {
                // The atlas is single-channel coverage, so the glyph supplies
                // alpha and the vertex supplies colour.
                tint.a *= atlas.sample(atlasSampler, in.uv).r;
            }
            return float4(tint.rgb * tint.a, tint.a);
        }
        """
}
