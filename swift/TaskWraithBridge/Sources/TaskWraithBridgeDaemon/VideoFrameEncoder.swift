import Foundation
import AVFoundation
import VideoToolbox
import CoreMedia
import CoreVideo
import CoreImage

/// `video.encodeClip` result. The TS side reads the encoded MP4 from
/// `outputPath` itself — we return ONLY metadata, never the bytes. The shape is
/// FIXED (the TS staging-read path consumes these exact keys/types):
///   `ok`(Bool) / `width`(Int) / `height`(Int) / `durationMs`(Int, OUTPUT
///   duration) / `codec`(String, "h264") / `usedHardware`(Bool).
struct EncodedVideoClip: Sendable {
    let width: Int
    let height: Int
    /// Duration of the encoded output, in whole milliseconds.
    let durationMs: Int
    /// Always "h264" this slice (the only codec we emit).
    let codec: String
    /// Whether the encode is expected to have used a hardware encoder.
    /// AVAssetWriter selects HW transparently and exposes no per-session flag,
    /// so this is INFORMATIONAL — reported `true` on arm64 (Apple Silicon
    /// always has a HW H.264 encoder), `false` on Intel. Mirrors the decoder's
    /// "best-effort, not a per-frame guarantee" contract.
    let usedHardware: Bool

    func toJSONObject() -> [String: Any] {
        return [
            "ok": true,
            "width": width,
            "height": height,
            "durationMs": durationMs,
            "codec": codec,
            "usedHardware": usedHardware
        ]
    }
}

/// Encode failures surfaced by `VideoFrameEncoder`. `.badInput` maps to
/// `invalidParams` at the RPC boundary (caller-correctable — missing file, no
/// video track, HDR source which is out-of-scope this slice); `.encodeFailed`
/// maps to `internalError` (the input looked valid but the encode/writer could
/// not complete, or zero frames landed in the output — e.g. a past-end trim).
enum VideoEncodeError: Error, CustomStringConvertible {
    /// Caller-correctable: bad/missing path, no video track, or HDR (out of
    /// scope this slice).
    case badInput(String)
    /// A true encode / muxer failure, or a degenerate request that produced no
    /// frames.
    case encodeFailed(String)

    var description: String {
        switch self {
        case .badInput(let m): return m
        case .encodeFailed(let m): return m
        }
    }
}

/// Native VideoToolbox encode-to-MP4 (Approach B — AVAssetWriter).
///
/// Pipeline: `AVAssetReader` (decompresses the source via VT internally) →
/// optional CoreImage downscale → `AVAssetWriterInput` H.264 encode →
/// `.mp4` mux. We deliberately use AVAssetWriter rather than a hand-built
/// `VTCompressionSession`: the writer owns muxing, bitrate control, and HW
/// encoder selection, which is exactly the SDR transcode this slice needs.
///
/// NOTE on helper duplication: `isHDR`, `propagateColorAttachments`, the CMTime
/// finite-clamp, and `fourCCString` are intentionally REPLICATED from
/// `VideoFrameDecoder` (they're `private` there). A future refactor should lift
/// the shared color/format helpers into one `VideoFormatHelpers` file; we don't
/// touch `VideoFrameDecoder` here to keep this slice isolated.
enum VideoFrameEncoder {
    /// Transcode `sourcePath` → H.264 `.mp4` at `outputPath` (a TS-owned
    /// staging path).
    ///
    /// - Parameters:
    ///   - sourcePath: filesystem path to a source video container.
    ///   - outputPath: where to WRITE the MP4 (TS reads + deletes it after).
    ///   - scaleWidth: if set, downscale to this width (height auto, aspect
    ///     preserved); both output dims are rounded to EVEN (H.264 requires it).
    ///   - targetBitrateKbps: average bitrate in kbps; defaults by output height.
    ///   - startSeconds / durationSeconds: optional trim window over the source.
    ///   - overlayPath: optional path to a PNG/JPEG/WebP image to composite over
    ///     EVERY output frame (the TS side jails this realpath; we just load it).
    ///   - overlayX / overlayY: TOP-LEFT origin of the overlay in OUTPUT pixels
    ///     (default 0,0). CoreImage's origin is BOTTOM-left, so we flip Y to honor
    ///     a top-left convention.
    ///   - overlayWidth: scale the overlay to this width (aspect preserved); nil =
    ///     native overlay size.
    ///   - overlayOpacity: overlay alpha multiplier, clamped to 0...1 (default 1).
    static func encodeClip(
        sourcePath: String,
        outputPath: String,
        scaleWidth: Int?,
        targetBitrateKbps: Int?,
        startSeconds: Double?,
        durationSeconds: Double?,
        overlayPath: String? = nil,
        overlayX: Int? = nil,
        overlayY: Int? = nil,
        overlayWidth: Int? = nil,
        overlayOpacity: Double? = nil
    ) async throws -> EncodedVideoClip {
        // --- 1. Open the asset + resolve the first video track ----------------
        let sourceURL = URL(fileURLWithPath: sourcePath)
        guard FileManager.default.fileExists(atPath: sourceURL.path) else {
            throw VideoEncodeError.badInput("Source file does not exist: \(sourcePath)")
        }

        let asset = AVURLAsset(url: sourceURL)

        let videoTracks = try await loadVideoTracks(asset)
        guard let track = videoTracks.first else {
            throw VideoEncodeError.badInput("No video track in source: \(sourcePath)")
        }

        let formatDescriptions = try await loadFormatDescriptions(track)
        guard let formatDescAny = formatDescriptions.first else {
            throw VideoEncodeError.badInput("Video track has no format description: \(sourcePath)")
        }
        let formatDesc = formatDescAny as CMVideoFormatDescription

        // --- 2. HDR gate (SDR-first) -----------------------------------------
        if isHDR(formatDesc: formatDesc) {
            throw VideoEncodeError.badInput("HDR not yet supported")
        }

        // --- 3. Compute output dimensions (EVEN) -----------------------------
        // CODED dims = the pixel-buffer geometry the AVAssetReader actually
        // yields (always even for H.264 4:2:0). PRESENTATION dims = display
        // geometry after PAR / clean-aperture (can be ODD for non-square pixels
        // or an odd clean aperture). We size the no-scale writer at the CODED
        // dims so the declared output size ALWAYS equals the buffers we append
        // verbatim — declaring at even-rounded presentation dims would lie about
        // the geometry and append source buffers at a mismatched size (silent
        // corruption / content shift). We size at presentation only when the
        // caller asks to scale, since CoreImage then RESAMPLES to the target.
        let coded = CMVideoFormatDescriptionGetDimensions(formatDesc)
        let codedW = Int(coded.width)
        let codedH = Int(coded.height)
        guard codedW > 0, codedH > 0 else {
            throw VideoEncodeError.badInput("Source has zero-sized video dimensions")
        }
        // Presentation dims drive the aspect ratio used to derive the scaled
        // height (so a downscale honors the display aspect, not the storage
        // aspect of non-square pixels). Fall back to coded dims if presentation
        // is degenerate.
        let presentation = CMVideoFormatDescriptionGetPresentationDimensions(
            formatDesc,
            usePixelAspectRatio: true,
            useCleanAperture: true
        )
        let presentW = Double(presentation.width) > 0 ? Double(presentation.width) : Double(codedW)
        let presentH = Double(presentation.height) > 0 ? Double(presentation.height) : Double(codedH)

        let evenW: Int
        let evenH: Int
        let scaling: Bool
        if let scaleWidth, scaleWidth > 0, Double(scaleWidth) < presentW {
            // Downscale request: preserve the DISPLAY aspect, derive height from
            // the requested width, and round to even. CoreImage resamples the
            // source buffers into a pool at this even target — so the declared
            // size matches the appended (resampled) buffers.
            let targetW = Double(scaleWidth)
            let targetH = (targetW / presentW) * presentH
            // Floor of 2 (an even non-zero minimum) so a tiny target can't yield
            // a zero dimension the encoder rejects.
            let tW = max(2, evenDimension(targetW))
            let tH = max(2, evenDimension(targetH))
            evenW = tW
            evenH = tH
            // Only actually resample if the even target differs from the coded
            // source geometry; an even target that lands exactly on the coded
            // size is a no-op pass-through (append verbatim, skip CoreImage).
            scaling = (tW != codedW) || (tH != codedH)
        } else {
            // No scale (or an up-scale request we decline) — pass the source
            // buffers through VERBATIM at their CODED size. This is the size the
            // reader yields, so the writer's declared dims match exactly.
            evenW = codedW
            evenH = codedH
            scaling = false
        }

        // --- 4. Trim window (finite-clamped CMTime) --------------------------
        let durationCM = try await loadDuration(asset)
        let sourceDurationSeconds = durationCM.isNumeric ? CMTimeGetSeconds(durationCM) : 0

        // Clamp start to a finite, sane bound BEFORE building a CMTime — a raw
        // 1e308 makes CMTime(seconds:) non-numeric (timescale 0) and breaks
        // startReading. 24h cap is far beyond any real trim. (Mirrors the
        // decoder's FIX-2 clamp.)
        let hasStart = (startSeconds != nil)
        let rawStart = startSeconds ?? 0
        let clampedStart = rawStart.isFinite ? min(max(rawStart, 0), 86_400) : 0
        let trimStart = CMTime(seconds: clampedStart, preferredTimescale: 600)
        // `trimming` distinguishes "apply a timeRange + rebase PTS" from a
        // straight full-asset pass. A start of 0 with no duration is NOT a trim.
        let trimming = hasStart || (durationSeconds != nil)

        // --- 5. Reader (auto-decompress to 420v) -----------------------------
        let reader: AVAssetReader
        do {
            reader = try AVAssetReader(asset: asset)
        } catch {
            throw VideoEncodeError.badInput("Unable to read source asset: \(error.localizedDescription)")
        }
        // 420v (8-bit 4:2:0 video-range bi-planar) is the H.264-preferred layout
        // for both the reader output AND the writer's pixel-buffer pool, so the
        // no-scale path appends frames with zero pixel-format conversion.
        let readerOutputSettings: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: readerOutputSettings)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            throw VideoEncodeError.encodeFailed("Reader rejected track output")
        }
        reader.add(output)

        if trimming {
            // Clamp the start just inside the asset when the duration is known so
            // a far-future start still reads (and yields zero frames → a clean
            // "no frames" error) rather than silently mis-configuring the range.
            let safeStart: CMTime
            if sourceDurationSeconds > 0 {
                let cappedStart = min(clampedStart, max(0, sourceDurationSeconds - 0.001))
                let s = CMTime(seconds: cappedStart, preferredTimescale: 600)
                safeStart = s.isNumeric ? s : .zero
            } else {
                safeStart = trimStart.isNumeric ? trimStart : .zero
            }
            // Duration: an explicit finite durationSeconds, else "to the end"
            // (positiveInfinity makes AVAssetReader run to EOF).
            let dur: CMTime
            if let durationSeconds, durationSeconds.isFinite, durationSeconds > 0 {
                let capped = min(durationSeconds, 86_400)
                let d = CMTime(seconds: capped, preferredTimescale: 600)
                dur = d.isNumeric ? d : .positiveInfinity
            } else {
                dur = .positiveInfinity
            }
            reader.timeRange = CMTimeRange(start: safeStart, duration: dur)
        }

        guard reader.startReading() else {
            let msg = reader.error?.localizedDescription ?? "unknown reader error"
            throw VideoEncodeError.encodeFailed("AVAssetReader failed to start: \(msg)")
        }
        defer {
            if reader.status == .reading { reader.cancelReading() }
        }

        // --- 6. Writer + H.264 input + pixel-buffer adaptor ------------------
        let outputURL = URL(fileURLWithPath: outputPath)
        // AVAssetWriter REFUSES to overwrite — clear any prior staging file.
        try? FileManager.default.removeItem(at: outputURL)

        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        } catch {
            throw VideoEncodeError.encodeFailed("Unable to create AVAssetWriter: \(error.localizedDescription)")
        }

        let bitrate = resolveBitrate(targetBitrateKbps: targetBitrateKbps, outputHeight: evenH)
        let compression: [String: Any] = [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoMaxKeyFrameIntervalKey: 60,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
        ]
        let writerSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: evenW,
            AVVideoHeightKey: evenH,
            AVVideoCompressionPropertiesKey: compression
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: writerSettings)
        input.expectsMediaDataInRealTime = false

        // IOSurface-backed pool (the empty IOSurfaceProperties dict) so a
        // CoreImage render targets a GPU surface instead of CPU-falling-back.
        let adaptorAttrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
            kCVPixelBufferWidthKey as String: evenW,
            kCVPixelBufferHeightKey as String: evenH,
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()
        ]
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: adaptorAttrs
        )

        guard writer.canAdd(input) else {
            throw VideoEncodeError.encodeFailed("Writer rejected the H.264 input")
        }
        writer.add(input)

        guard writer.startWriting() else {
            let msg = writer.error?.localizedDescription ?? "unknown writer error"
            throw VideoEncodeError.encodeFailed("AVAssetWriter failed to start: \(msg)")
        }
        writer.startSession(atSourceTime: .zero)
        defer {
            if writer.status == .writing { writer.cancelWriting() }
        }

        // --- 7. Overlay (loaded + prepared ONCE — it's static) ---------------
        // Load the overlay image a SINGLE time before the drive loop (CIImage
        // construction + decode is per-image expensive; the overlay never
        // changes frame-to-frame). The TS side has already JAILED overlayPath to
        // a realpath inside the allowed media roots — we only load it.
        var preparedOverlay: CIImage? = nil
        if let overlayPath, !overlayPath.isEmpty {
            let overlayURL = URL(fileURLWithPath: overlayPath)
            guard let overlayCI = CIImage(contentsOf: overlayURL) else {
                throw VideoEncodeError.badInput(
                    "overlay image could not be loaded: \(overlayPath)"
                )
            }
            // 7a. Scale the overlay to `overlayWidth` (aspect preserved). The
            // native extent can have a non-zero origin; we operate on its size.
            var overlay = overlayCI
            let nativeExtent = overlay.extent
            if let overlayWidth, overlayWidth > 0,
               nativeExtent.width > 0, nativeExtent.height > 0 {
                let factor = CGFloat(overlayWidth) / nativeExtent.width
                overlay = overlay.transformed(
                    by: CGAffineTransform(scaleX: factor, y: factor)
                )
            }
            // 7b. Opacity — scale ONLY the alpha channel via CIColorMatrix's
            // alpha vector (w = opacity), so we never double-darken the RGB.
            let clampedOpacity = max(0.0, min(1.0, overlayOpacity ?? 1.0))
            if clampedOpacity < 1.0 {
                if let matrix = CIFilter(name: "CIColorMatrix") {
                    matrix.setValue(overlay, forKey: kCIInputImageKey)
                    matrix.setValue(
                        CIVector(x: 0, y: 0, z: 0, w: CGFloat(clampedOpacity)),
                        forKey: "inputAVector"
                    )
                    // Fall back to the un-faded overlay if the filter yields no
                    // image (never force-unwrap — crash-safety contract).
                    overlay = matrix.outputImage ?? overlay
                }
            }
            // 7c. Position with the BOTTOM-LEFT COORDINATE FLIP. CoreImage's
            // y=0 is the BOTTOM of the frame, but overlayY is a TOP-LEFT origin
            // in OUTPUT pixels — so convert: ciY = frameHeight - overlayY -
            // overlayHeight. evenH is the OUTPUT (post-scale) frame height.
            let ox = CGFloat(overlayX ?? 0)
            let oy = CGFloat(overlayY ?? 0)
            let ciY = CGFloat(evenH) - oy - overlay.extent.height
            preparedOverlay = overlay.transformed(
                by: CGAffineTransform(translationX: ox, y: ciY)
            )
        }

        // --- 7d. CoreImage context (when scaling OR compositing an overlay) ---
        // Created ONCE before the loop — CIContext construction is expensive.
        // Widen the condition: an overlay-only encode (no scale) still needs the
        // CoreImage render path to composite.
        let needsCoreImage = scaling || (preparedOverlay != nil)
        let ciContext: CIContext? = needsCoreImage
            ? CIContext(options: [.useSoftwareRenderer: false])
            : nil
        // Resample from the CODED source buffer geometry (what the reader yields,
        // and the basis of the CIImage extent) to the even target. Using coded
        // dims here keeps the affine scale exact against the actual pixels.
        let scaleX = codedW > 0 ? Double(evenW) / Double(codedW) : 1
        let scaleY = codedH > 0 ? Double(evenH) / Double(codedH) : 1

        // --- 8. Drive loop ---------------------------------------------------
        var frameCount = 0
        var firstOutputPTS: CMTime = .invalid
        var lastOutputPTS: CMTime = .zero
        var lastOutputDuration: CMTime = .zero
        // Rebase anchor — subtracted from EVERY frame's PTS so the output
        // timeline always starts at t=0. Two cases, unified:
        //   • hasStart trim: anchor is `trimStart` (frames < trimStart are
        //     discarded below, so the first kept frame ≈ trimStart).
        //   • no-start (full pass OR duration-only): anchor is the FIRST
        //     observed source PTS, captured lazily on the first kept frame.
        //     Sources with a non-zero first PTS (edit lists, concatenated MP4s)
        //     would otherwise emit an empty leading gap.
        var rebaseAnchor: CMTime = (trimming && hasStart) ? trimStart : .invalid

        while reader.status == .reading {
            guard let sampleBuffer = output.copyNextSampleBuffer() else { break }
            guard CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { continue }
            guard let sourcePixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { continue }

            let sourcePTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            guard sourcePTS.isNumeric else { continue }

            // AVAssetReader back-extends a trim window to the preceding sync
            // sample, so frames with PTS < trimStart can arrive. Discard them so
            // the output truly starts at the requested cut.
            if trimming && hasStart {
                if CMTimeCompare(sourcePTS, trimStart) < 0 { continue }
            }
            // Capture the first observed (kept) source PTS as the anchor for the
            // no-start paths, so the output is rebased to zero unconditionally.
            if !rebaseAnchor.isNumeric {
                rebaseAnchor = sourcePTS
            }
            // Rebase the output timeline to zero (subtract the anchor on EVERY
            // path — full pass-through included).
            let outputPTS = CMTimeSubtract(sourcePTS, rebaseAnchor)
            guard outputPTS.isNumeric, CMTimeCompare(outputPTS, .zero) >= 0 else { continue }

            // Propagate source color onto the (decoded) source buffer so a
            // CoreImage render or a verbatim append isn't BT.601<->709 shifted.
            propagateColorAttachments(from: formatDesc, to: sourcePixelBuffer)

            // Choose the buffer we hand to the adaptor.
            let bufferToAppend: CVPixelBuffer
            if needsCoreImage, let ciContext, let pool = adaptor.pixelBufferPool {
                var renderOut: CVPixelBuffer?
                let allocStatus = CVPixelBufferPoolCreatePixelBuffer(nil, pool, &renderOut)
                guard allocStatus == kCVReturnSuccess, let renderTarget = renderOut else {
                    throw VideoEncodeError.encodeFailed("Pixel buffer pool allocation failed (status \(allocStatus))")
                }
                let frameExtent = CGRect(x: 0, y: 0, width: evenW, height: evenH)
                let source = CIImage(cvPixelBuffer: sourcePixelBuffer)
                // The frame background: the SCALED source when scaling, else the
                // raw source verbatim (overlay-without-scale case — evenW/evenH
                // are the CODED dims here, so no resample is wanted).
                let transformed: CIImage = scaling
                    ? source.transformed(
                        by: CGAffineTransform(scaleX: CGFloat(scaleX), y: CGFloat(scaleY))
                      )
                    : source
                // Composite the static overlay over the frame (source-over), if
                // one is set. CISourceOverCompositing handles the sRGB-overlay →
                // YCbCr-frame conversion; cropping to frameExtent discards any
                // overlay pixels that spill past the frame bounds.
                let imageToRender: CIImage
                if let preparedOverlay {
                    if let compositor = CIFilter(name: "CISourceOverCompositing") {
                        compositor.setValue(preparedOverlay, forKey: kCIInputImageKey)
                        compositor.setValue(transformed, forKey: kCIInputBackgroundImageKey)
                        // Never force-unwrap: fall back to the un-composited frame
                        // if the filter yields no image (crash-safety contract).
                        imageToRender = (compositor.outputImage ?? transformed)
                            .cropped(to: frameExtent)
                    } else {
                        imageToRender = transformed
                    }
                } else {
                    imageToRender = transformed
                }
                // colorSpace: nil preserves the source color tags (no conversion
                // to a working space) — the matching half of propagateColor.
                ciContext.render(
                    imageToRender,
                    to: renderTarget,
                    bounds: frameExtent,
                    colorSpace: nil
                )
                bufferToAppend = renderTarget
            } else {
                bufferToAppend = sourcePixelBuffer
            }

            // Back-pressure: never DROP a frame — wait until the input drains.
            // `Thread.sleep` is unavailable in an async context, so yield via
            // Task.sleep (~1ms). Synthetic/small frames drain immediately; the
            // poll-wait is the correctness contract (we must not drop a frame).
            while !input.isReadyForMoreMediaData {
                if writer.status == .failed { break }
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            if writer.status == .failed {
                let msg = writer.error?.localizedDescription ?? "unknown writer error"
                throw VideoEncodeError.encodeFailed("Writer failed during append: \(msg)")
            }

            if !adaptor.append(bufferToAppend, withPresentationTime: outputPTS) {
                let msg = writer.error?.localizedDescription ?? "append returned false"
                throw VideoEncodeError.encodeFailed("Failed to append frame: \(msg)")
            }

            if firstOutputPTS == CMTime.invalid || !firstOutputPTS.isNumeric {
                firstOutputPTS = outputPTS
            }
            lastOutputPTS = outputPTS
            let sampleDuration = CMSampleBufferGetDuration(sampleBuffer)
            lastOutputDuration = sampleDuration.isNumeric ? sampleDuration : .zero
            frameCount += 1
        }

        if reader.status == .failed {
            let msg = reader.error?.localizedDescription ?? "unknown"
            throw VideoEncodeError.encodeFailed("AVAssetReader failed mid-encode: \(msg)")
        }

        // --- 9. Finish -------------------------------------------------------
        guard frameCount > 0 else {
            // A past-end trim (or an empty source) — clean up + clear error.
            writer.cancelWriting()
            throw VideoEncodeError.encodeFailed("No frames encoded (empty source or trim past end)")
        }

        input.markAsFinished()
        // finishWriting is ASYNC — we MUST drain it before returning or TS reads
        // a half-written file. The completion closure only signals completion
        // (it captures nothing non-Sendable); we read `writer.status`/`error`
        // AFTER the continuation resumes, back in this async context where
        // `writer` is just a local — which also dodges the non-Sendable capture
        // warning from referencing `writer` inside an `@Sendable` closure.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            writer.finishWriting {
                continuation.resume()
            }
        }
        if writer.status == .failed {
            let msg = writer.error?.localizedDescription ?? "writer finished in failed state"
            throw VideoEncodeError.encodeFailed("finishWriting failed: \(msg)")
        }

        // --- 10. Output duration --------------------------------------------
        // Span of appended frames + the last frame's own duration (so a single
        // frame still reports a non-zero duration). Fall back to the trimmed
        // source span if frame durations were unavailable.
        var durationSecondsOut: Double = 0
        let spanCM = CMTimeSubtract(lastOutputPTS, firstOutputPTS.isNumeric ? firstOutputPTS : .zero)
        if spanCM.isNumeric {
            let withLast = CMTimeAdd(spanCM, lastOutputDuration.isNumeric ? lastOutputDuration : .zero)
            durationSecondsOut = max(0, CMTimeGetSeconds(withLast))
        }
        if durationSecondsOut <= 0 {
            // Best-effort fallback from the requested window / source duration.
            if let durationSeconds, durationSeconds.isFinite, durationSeconds > 0 {
                durationSecondsOut = durationSeconds
            } else if sourceDurationSeconds > 0 {
                durationSecondsOut = max(0, sourceDurationSeconds - clampedStart)
            }
        }
        let durationMs = Int((durationSecondsOut * 1000).rounded())

        return EncodedVideoClip(
            width: evenW,
            height: evenH,
            durationMs: durationMs,
            codec: "h264",
            usedHardware: isAppleSilicon()
        )
    }

    // MARK: - Dimension / bitrate helpers

    /// Round a (positive) dimension UP to the nearest even integer. H.264
    /// requires even width AND height for 4:2:0 chroma.
    private static func evenDimension(_ value: Double) -> Int {
        let n = Int(value.rounded())
        let nonNeg = max(0, n)
        return (nonNeg + 1) & ~1
    }

    /// Average bitrate in bits/sec: an explicit `targetBitrateKbps*1000`, else a
    /// sane default by output height (~4 Mbps @1080p, ~2 Mbps @720p, scaled down
    /// for smaller frames).
    private static func resolveBitrate(targetBitrateKbps: Int?, outputHeight: Int) -> Int {
        if let kbps = targetBitrateKbps, kbps > 0 {
            return kbps * 1000
        }
        switch outputHeight {
        case 1081...: return 6_000_000
        case 721...1080: return 4_000_000
        case 481...720: return 2_000_000
        case 241...480: return 1_000_000
        default: return 600_000
        }
    }

    /// Informational HW flag — Apple Silicon always has a HW H.264 encoder that
    /// AVAssetWriter uses transparently; Intel may not. Best-effort, like the
    /// decoder's `usedHardware`.
    private static func isAppleSilicon() -> Bool {
        #if arch(arm64)
        return true
        #else
        return false
        #endif
    }

    // MARK: - Color / HDR helpers (replicated from VideoFrameDecoder)

    /// HDR if the transfer function is PQ (smpte2084) or HLG, OR the primaries
    /// are BT.2020. Read straight off the format-description color extensions.
    private static func isHDR(formatDesc: CMVideoFormatDescription) -> Bool {
        let transfer = CMFormatDescriptionGetExtension(
            formatDesc,
            extensionKey: kCMFormatDescriptionExtension_TransferFunction
        ) as? String
        if let transfer {
            if transfer == (kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String)
                || transfer == (kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG as String) {
                return true
            }
        }
        let primaries = CMFormatDescriptionGetExtension(
            formatDesc,
            extensionKey: kCMFormatDescriptionExtension_ColorPrimaries
        ) as? String
        if let primaries, primaries == (kCMFormatDescriptionColorPrimaries_ITU_R_2020 as String) {
            return true
        }
        return false
    }

    /// Copy YCbCrMatrix / ColorPrimaries / TransferFunction from the format
    /// description onto the pixel buffer when they're unset, so a CoreImage
    /// render (or a verbatim append) isn't BT.601<->709 hue-shifted.
    private static func propagateColorAttachments(
        from formatDesc: CMVideoFormatDescription,
        to pixelBuffer: CVPixelBuffer
    ) {
        func copy(extKey: CFString, attachKey: CFString) {
            let existing = CVBufferCopyAttachment(pixelBuffer, attachKey, nil)
            if existing != nil { return }
            if let value = CMFormatDescriptionGetExtension(formatDesc, extensionKey: extKey) {
                CVBufferSetAttachment(pixelBuffer, attachKey, value, .shouldPropagate)
            }
        }
        copy(
            extKey: kCMFormatDescriptionExtension_YCbCrMatrix,
            attachKey: kCVImageBufferYCbCrMatrixKey
        )
        copy(
            extKey: kCMFormatDescriptionExtension_ColorPrimaries,
            attachKey: kCVImageBufferColorPrimariesKey
        )
        copy(
            extKey: kCMFormatDescriptionExtension_TransferFunction,
            attachKey: kCVImageBufferTransferFunctionKey
        )
    }

    // MARK: - async property loading (replicated from VideoFrameDecoder)

    private static func loadVideoTracks(_ asset: AVAsset) async throws -> [AVAssetTrack] {
        do {
            return try await asset.loadTracks(withMediaType: .video)
        } catch {
            throw VideoEncodeError.badInput("Could not read tracks: \(error.localizedDescription)")
        }
    }

    private static func loadFormatDescriptions(_ track: AVAssetTrack) async throws -> [CMFormatDescription] {
        do {
            return try await track.load(.formatDescriptions)
        } catch {
            throw VideoEncodeError.badInput("Could not read format descriptions: \(error.localizedDescription)")
        }
    }

    private static func loadDuration(_ asset: AVAsset) async throws -> CMTime {
        do {
            return try await asset.load(.duration)
        } catch {
            return CMTime.invalid
        }
    }
}
