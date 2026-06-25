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

/// `video.concatClips` result. Like `EncodedVideoClip` the TS side reads the
/// muxed MP4 from `outputPath` itself — we return ONLY metadata. The shape is
/// FIXED (the TS staging-read path consumes these exact keys/types):
///   `ok`(Bool) / `width`(Int) / `height`(Int) / `durationMs`(Int, TOTAL output
///   duration) / `codec`(String, "h264") / `usedHardware`(Bool) /
///   `segmentCount`(Int, how many segments were concatenated).
struct EncodedConcatClip: Sendable {
    let width: Int
    let height: Int
    /// TOTAL duration of the concatenated output, in whole milliseconds.
    let durationMs: Int
    /// Always "h264" this slice (the only codec we emit).
    let codec: String
    /// Best-effort HW flag (see `EncodedVideoClip.usedHardware`).
    let usedHardware: Bool
    /// Number of input segments folded into the output (== `segments.count`).
    let segmentCount: Int

    func toJSONObject() -> [String: Any] {
        return [
            "ok": true,
            "width": width,
            "height": height,
            "durationMs": durationMs,
            "codec": codec,
            "usedHardware": usedHardware,
            "segmentCount": segmentCount
        ]
    }
}

/// One input segment for `concatClips` — a source path plus an optional trim
/// window over THAT source. Shapes mirror the per-segment fields the TS side
/// sends (sourcePaths are TS-jailed realPaths).
struct VideoConcatSegment: Sendable {
    let sourcePath: String
    let startSeconds: Double?
    let durationSeconds: Double?
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

    // MARK: - Concat (N segments → one MP4)

    /// Concatenate `segments` IN ORDER into one H.264 `.mp4` at `outputPath`
    /// (a TS-owned staging path). One AVAssetWriter, N AVAssetReaders.
    ///
    /// The OUTPUT geometry is fixed from segment 0 (its even CODED dims, or the
    /// even `scaleWidth`-aspect-scaled dims). Every segment is normalized into
    /// that frame: a segment whose coded dims already match is appended VERBATIM
    /// (fast path, no CoreImage); a segment whose dims differ is aspect-FIT
    /// LETTERBOXED (scaled + centered over a black background via CoreImage).
    ///
    /// Each segment is read by its OWN reader, HDR-gated against its OWN format
    /// description, and color-propagated from its OWN format description (the
    /// classic concat bug is propagating segment 0's color onto every segment).
    /// Output PTS are accumulated as rational CMTime — NEVER float-seconds — by
    /// adding a running `cumulativeOffset` to each segment's rebased PTS, so the
    /// boundary between segments is monotonic and gap-free.
    ///
    /// - Parameters:
    ///   - outputPath: where to WRITE the muxed MP4 (TS reads + deletes it).
    ///   - segments: ≥1 input segments, each with an optional trim window.
    ///   - scaleWidth: optional output width (height auto from segment 0's
    ///     aspect, even); nil = segment 0's even coded dims.
    ///   - targetBitrateKbps: average bitrate in kbps; default by output height.
    static func concatClips(
        outputPath: String,
        segments: [VideoConcatSegment],
        scaleWidth: Int?,
        targetBitrateKbps: Int?
    ) async throws -> EncodedConcatClip {
        // --- 0. Defensive arity (TS enforces ≥2, we accept ≥1) ----------------
        guard segments.count >= 1 else {
            throw VideoEncodeError.badInput("concat requires at least one segment")
        }

        // --- 1. Output geometry, fixed from SEGMENT 0 ------------------------
        let seg0URL = URL(fileURLWithPath: segments[0].sourcePath)
        guard FileManager.default.fileExists(atPath: seg0URL.path) else {
            throw VideoEncodeError.badInput("Segment 0 file does not exist: \(segments[0].sourcePath)")
        }
        let seg0Asset = AVURLAsset(url: seg0URL)
        let seg0Tracks = try await loadVideoTracks(seg0Asset)
        guard let seg0Track = seg0Tracks.first else {
            throw VideoEncodeError.badInput("No video track in segment 0: \(segments[0].sourcePath)")
        }
        let seg0Formats = try await loadFormatDescriptions(seg0Track)
        guard let seg0FormatAny = seg0Formats.first else {
            throw VideoEncodeError.badInput("Segment 0 has no format description: \(segments[0].sourcePath)")
        }
        let seg0Format = seg0FormatAny as CMVideoFormatDescription
        if isHDR(formatDesc: seg0Format) {
            throw VideoEncodeError.badInput("HDR not yet supported (segment 0)")
        }

        let seg0Coded = CMVideoFormatDescriptionGetDimensions(seg0Format)
        let seg0CodedW = Int(seg0Coded.width)
        let seg0CodedH = Int(seg0Coded.height)
        guard seg0CodedW > 0, seg0CodedH > 0 else {
            throw VideoEncodeError.badInput("Segment 0 has zero-sized video dimensions")
        }
        // Presentation drives the scaled-height aspect (display geometry after
        // PAR / clean aperture), falling back to coded if degenerate.
        let seg0Pres = CMVideoFormatDescriptionGetPresentationDimensions(
            seg0Format, usePixelAspectRatio: true, useCleanAperture: true
        )
        let presW = Double(seg0Pres.width) > 0 ? Double(seg0Pres.width) : Double(seg0CodedW)
        let presH = Double(seg0Pres.height) > 0 ? Double(seg0Pres.height) : Double(seg0CodedH)

        let outW: Int
        let outH: Int
        if let scaleWidth, scaleWidth > 0, Double(scaleWidth) < presW {
            let targetW = Double(scaleWidth)
            let targetH = (targetW / presW) * presH
            outW = max(2, evenDimension(targetW))
            outH = max(2, evenDimension(targetH))
        } else {
            // No scale (or a declined up-scale) — segment 0's even CODED dims.
            // (Coded dims are even for H.264 4:2:0, but round defensively.)
            outW = max(2, evenDimension(Double(seg0CodedW)))
            outH = max(2, evenDimension(Double(seg0CodedH)))
        }
        let outputRect = CGRect(x: 0, y: 0, width: outW, height: outH)

        // --- 2. Writer created ONCE ------------------------------------------
        let outputURL = URL(fileURLWithPath: outputPath)
        try? FileManager.default.removeItem(at: outputURL) // writer refuses overwrite

        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        } catch {
            throw VideoEncodeError.encodeFailed("Unable to create AVAssetWriter: \(error.localizedDescription)")
        }
        let bitrate = resolveBitrate(targetBitrateKbps: targetBitrateKbps, outputHeight: outH)
        let compression: [String: Any] = [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoMaxKeyFrameIntervalKey: 60,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
        ]
        let writerSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: outW,
            AVVideoHeightKey: outH,
            AVVideoCompressionPropertiesKey: compression
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: writerSettings)
        input.expectsMediaDataInRealTime = false

        let adaptorAttrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
            kCVPixelBufferWidthKey as String: outW,
            kCVPixelBufferHeightKey as String: outH,
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
        // The session starts at .zero EXACTLY ONCE for the whole concatenation;
        // each segment's frames are offset onto this single timeline.
        writer.startSession(atSourceTime: .zero)
        defer {
            if writer.status == .writing { writer.cancelWriting() }
        }

        // --- 3. CIContext created ONCE (any differing-dims segment needs it) --
        // Concat almost always normalizes at least one segment, so build it up
        // front; a pure-verbatim concat just never touches it.
        let ciContext = CIContext(options: [.useSoftwareRenderer: false])

        // --- 4. Per-segment drive on a SINGLE writer timeline ----------------
        var totalFrames = 0
        // Running offset on the output timeline; segment i's frames land at
        // cumulativeOffset + (sourcePTS - segmentInPoint). Rational throughout.
        var cumulativeOffset: CMTime = .zero
        // Strictly-increasing guard across the WHOLE output (spans boundaries),
        // so a non-monotonic / duplicate source PTS can never be appended.
        var lastAppendedOutputPTS: CMTime = .negativeInfinity
        var finalSegmentLastPTS: CMTime = .zero
        var finalSegmentLastDuration: CMTime = .zero

        for (i, segment) in segments.enumerated() {
            let segURL = URL(fileURLWithPath: segment.sourcePath)
            guard FileManager.default.fileExists(atPath: segURL.path) else {
                throw VideoEncodeError.badInput("Segment \(i) file does not exist: \(segment.sourcePath)")
            }
            let segAsset = AVURLAsset(url: segURL)
            let segTracks = try await loadVideoTracks(segAsset)
            guard let segTrack = segTracks.first else {
                throw VideoEncodeError.badInput("No video track in segment \(i): \(segment.sourcePath)")
            }
            let segFormats = try await loadFormatDescriptions(segTrack)
            guard let segFormatAny = segFormats.first else {
                throw VideoEncodeError.badInput("Segment \(i) has no format description: \(segment.sourcePath)")
            }
            // THIS segment's own format description — used for the HDR gate AND
            // color propagation. Propagating segment 0's color here is the
            // classic concat bug (BT.601<->709 shift on a differently-tagged
            // segment), so we always use the segment's own descriptor.
            let segFormat = segFormatAny as CMVideoFormatDescription
            if isHDR(formatDesc: segFormat) {
                throw VideoEncodeError.badInput("HDR not yet supported (segment \(i))")
            }
            let segCoded = CMVideoFormatDescriptionGetDimensions(segFormat)
            let segCodedW = Int(segCoded.width)
            let segCodedH = Int(segCoded.height)
            // Verbatim fast-path only when the segment's coded geometry EXACTLY
            // equals the output; any divergence → letterbox via CoreImage.
            let needsLetterbox = (segCodedW != outW) || (segCodedH != outH)

            // Reader (+ optional trim window, finite-clamped CMTime). Each
            // segment opens its OWN reader.
            let reader: AVAssetReader
            do {
                reader = try AVAssetReader(asset: segAsset)
            } catch {
                throw VideoEncodeError.badInput("Unable to read segment \(i): \(error.localizedDescription)")
            }
            let readerOutputSettings: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
            ]
            let segOutput = AVAssetReaderTrackOutput(track: segTrack, outputSettings: readerOutputSettings)
            segOutput.alwaysCopiesSampleData = false
            guard reader.canAdd(segOutput) else {
                throw VideoEncodeError.encodeFailed("Reader rejected track output (segment \(i))")
            }
            reader.add(segOutput)

            // Trim window (mirrors encodeClip's finite-clamp + safe-start).
            let segDurationCM = try await loadDuration(segAsset)
            let segSourceDurationSeconds = segDurationCM.isNumeric ? CMTimeGetSeconds(segDurationCM) : 0
            let hasStart = (segment.startSeconds != nil)
            let rawStart = segment.startSeconds ?? 0
            let clampedStart = rawStart.isFinite ? min(max(rawStart, 0), 86_400) : 0
            let trimStart = CMTime(seconds: clampedStart, preferredTimescale: 600)
            let trimming = hasStart || (segment.durationSeconds != nil)
            if trimming {
                let safeStart: CMTime
                if segSourceDurationSeconds > 0 {
                    let cappedStart = min(clampedStart, max(0, segSourceDurationSeconds - 0.001))
                    let s = CMTime(seconds: cappedStart, preferredTimescale: 600)
                    safeStart = s.isNumeric ? s : .zero
                } else {
                    safeStart = trimStart.isNumeric ? trimStart : .zero
                }
                let dur: CMTime
                if let durSecs = segment.durationSeconds, durSecs.isFinite, durSecs > 0 {
                    let capped = min(durSecs, 86_400)
                    let d = CMTime(seconds: capped, preferredTimescale: 600)
                    dur = d.isNumeric ? d : .positiveInfinity
                } else {
                    dur = .positiveInfinity
                }
                reader.timeRange = CMTimeRange(start: safeStart, duration: dur)
            }

            guard reader.startReading() else {
                let msg = reader.error?.localizedDescription ?? "unknown reader error"
                throw VideoEncodeError.encodeFailed("AVAssetReader failed to start (segment \(i)): \(msg)")
            }

            // segmentInPoint: the clamped trimStart when a start was given, else
            // captured lazily as the FIRST kept frame's PTS (mirrors the
            // encoder's rebaseAnchor) so a segment with a non-zero first PTS is
            // rebased into its slot with no leading gap.
            var segmentInPoint: CMTime = (trimming && hasStart) ? trimStart : .invalid
            var segFirstOutputPTS: CMTime = .invalid
            var segLastOutputPTS: CMTime = .zero
            var segLastDuration: CMTime = .zero
            // The PTS of the PREVIOUS appended frame, used to MEASURE the genuine
            // inter-frame interval. CMSampleBufferGetDuration reads back INVALID
            // for AVAssetReaderTrackOutput over many MP4s — including this daemon's
            // OWN AVAssetWriter-muxed output — so `segLastDuration` falls to .zero
            // and cannot be trusted to advance the offset. The measured spacing of
            // the last two appended frames is the robust fallback (no extra async
            // load), and is what makes the boundary gap-free.
            var segPrevOutputPTS: CMTime = .invalid
            var segLastFrameInterval: CMTime = .invalid
            var segFrames = 0

            while reader.status == .reading {
                guard let sampleBuffer = segOutput.copyNextSampleBuffer() else { break }
                guard CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { continue }
                guard let sourcePixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { continue }
                let sourcePTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                guard sourcePTS.isNumeric else { continue }

                // Discard back-extended frames before the cut (AVAssetReader
                // back-extends a trim window to the preceding sync sample).
                if trimming && hasStart {
                    if CMTimeCompare(sourcePTS, trimStart) < 0 { continue }
                }
                // Lazily capture the in-point for the no-start path.
                if !segmentInPoint.isNumeric {
                    segmentInPoint = sourcePTS
                }

                // Propagate THIS SEGMENT's color onto its decoded buffer.
                propagateColorAttachments(from: segFormat, to: sourcePixelBuffer)

                // outputPTS = cumulativeOffset + (sourcePTS - segmentInPoint),
                // rational CMTime (never float-seconds accumulation).
                let rebased = CMTimeSubtract(sourcePTS, segmentInPoint)
                let outputPTS = CMTimeAdd(cumulativeOffset, rebased)
                // Strictly-increasing across the WHOLE output → skip a
                // non-monotonic / duplicate source frame.
                guard outputPTS.isNumeric,
                      CMTimeCompare(outputPTS, lastAppendedOutputPTS) > 0 else { continue }

                // Normalize to the output frame.
                let bufferToAppend: CVPixelBuffer
                if needsLetterbox, let pool = adaptor.pixelBufferPool {
                    var renderOut: CVPixelBuffer?
                    let allocStatus = CVPixelBufferPoolCreatePixelBuffer(nil, pool, &renderOut)
                    guard allocStatus == kCVReturnSuccess, let renderTarget = renderOut else {
                        throw VideoEncodeError.encodeFailed("Pixel buffer pool allocation failed (status \(allocStatus))")
                    }
                    let composited = letterbox(
                        source: sourcePixelBuffer,
                        sourceW: segCodedW,
                        sourceH: segCodedH,
                        outputRect: outputRect
                    )
                    // colorSpace: nil preserves source color tags (matches the
                    // propagateColor half).
                    ciContext.render(
                        composited,
                        to: renderTarget,
                        bounds: outputRect,
                        colorSpace: nil
                    )
                    bufferToAppend = renderTarget
                } else {
                    // Coded dims already match the output → append verbatim.
                    bufferToAppend = sourcePixelBuffer
                }

                // Back-pressure: never DROP a frame — wait until input drains.
                while !input.isReadyForMoreMediaData {
                    if writer.status == .failed { break }
                    try await Task.sleep(nanoseconds: 1_000_000)
                }
                if writer.status == .failed {
                    let msg = writer.error?.localizedDescription ?? "unknown writer error"
                    throw VideoEncodeError.encodeFailed("Writer failed during append (segment \(i)): \(msg)")
                }
                if !adaptor.append(bufferToAppend, withPresentationTime: outputPTS) {
                    let msg = writer.error?.localizedDescription ?? "append returned false"
                    throw VideoEncodeError.encodeFailed("Failed to append frame (segment \(i)): \(msg)")
                }

                if !segFirstOutputPTS.isNumeric { segFirstOutputPTS = outputPTS }
                segLastOutputPTS = outputPTS
                let sampleDuration = CMSampleBufferGetDuration(sampleBuffer)
                segLastDuration = sampleDuration.isNumeric ? sampleDuration : .zero
                // Measure the genuine spacing between the last two appended frames
                // (only once we have a prior numeric PTS). This is the real
                // frame-interval fallback for the offset advance when the muxed
                // sample duration reads back invalid.
                if segPrevOutputPTS.isNumeric {
                    let interval = CMTimeSubtract(outputPTS, segPrevOutputPTS)
                    if interval.isNumeric { segLastFrameInterval = interval }
                }
                segPrevOutputPTS = outputPTS
                lastAppendedOutputPTS = outputPTS
                segFrames += 1
                totalFrames += 1
            }

            if reader.status == .failed {
                let msg = reader.error?.localizedDescription ?? "unknown"
                writer.cancelWriting()
                throw VideoEncodeError.encodeFailed("AVAssetReader failed mid-concat (segment \(i)): \(msg)")
            }
            if reader.status == .reading { reader.cancelReading() }

            // A segment that contributed nothing (empty source or a trim past
            // its end) is a hard failure — the concat would silently drop it.
            guard segFrames > 0, segFirstOutputPTS.isNumeric else {
                writer.cancelWriting()
                throw VideoEncodeError.encodeFailed("segment \(i): no frames (empty source or trim past end)")
            }

            // Advance the offset by THIS segment's output duration:
            //   (lastPTS - firstPTS) + lastInterval. `lastInterval` is the
            //   genuine spacing AFTER the last frame so the NEXT segment's first
            //   rebased frame lands at lastAppendedOutputPTS + lastInterval —
            //   strictly GREATER, leaving a real one-frame gap (no collision with
            //   the monotonic guard, no silent drop).
            //
            // Pick the FIRST numeric & positive source:
            //   1. segLastDuration  — CMSampleBufferGetDuration of the last frame,
            //      IF it read back valid;
            //   2. segLastFrameInterval — the MEASURED last inter-frame interval.
            //      This is the fix: CMSampleBufferGetDuration is INVALID for
            //      AVAssetReaderTrackOutput over many MP4s (incl. our own muxed
            //      output) → segLastDuration is .zero, advancing the offset short
            //      by exactly one frame and dropping the next segment's first
            //      frame. The measured spacing recovers the true interval;
            //   3. CMTime(value:1, timescale:600) floor — a single-frame segment
            //      has no measurable interval, so use a small non-zero advance.
            let oneFrame = CMTime(value: 1, timescale: 600)
            let lastInterval: CMTime = {
                if segLastDuration.isNumeric && CMTimeCompare(segLastDuration, .zero) > 0 {
                    return segLastDuration
                }
                if segLastFrameInterval.isNumeric && CMTimeCompare(segLastFrameInterval, .zero) > 0 {
                    return segLastFrameInterval
                }
                return oneFrame
            }()
            let span = CMTimeSubtract(segLastOutputPTS, segFirstOutputPTS)
            var segmentOutDur = CMTimeAdd(span, lastInterval)
            if !segmentOutDur.isNumeric || CMTimeCompare(segmentOutDur, oneFrame) < 0 {
                segmentOutDur = oneFrame
            }
            cumulativeOffset = CMTimeAdd(cumulativeOffset, segmentOutDur)
            finalSegmentLastPTS = segLastOutputPTS
            finalSegmentLastDuration = segLastDuration
        }

        // --- 5. Finish -------------------------------------------------------
        guard totalFrames > 0 else {
            writer.cancelWriting()
            throw VideoEncodeError.encodeFailed("No frames encoded across all segments")
        }
        input.markAsFinished()
        // finishWriting is ASYNC — drain it before returning (same Sendable-safe
        // pattern as encodeClip: read status AFTER the continuation resumes).
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            writer.finishWriting {
                continuation.resume()
            }
        }
        if writer.status == .failed {
            let msg = writer.error?.localizedDescription ?? "writer finished in failed state"
            throw VideoEncodeError.encodeFailed("finishWriting failed: \(msg)")
        }

        // --- 6. Total output duration ----------------------------------------
        // Prefer the running cumulativeOffset (it already sums every segment's
        // output span + a one-frame floor); fall back to lastPTS + lastDuration.
        var durationSecondsOut: Double = 0
        if cumulativeOffset.isNumeric {
            durationSecondsOut = max(0, CMTimeGetSeconds(cumulativeOffset))
        }
        if durationSecondsOut <= 0 {
            let withLast = CMTimeAdd(
                finalSegmentLastPTS.isNumeric ? finalSegmentLastPTS : .zero,
                finalSegmentLastDuration.isNumeric ? finalSegmentLastDuration : .zero
            )
            if withLast.isNumeric { durationSecondsOut = max(0, CMTimeGetSeconds(withLast)) }
        }
        let durationMs = Int((durationSecondsOut * 1000).rounded())

        return EncodedConcatClip(
            width: outW,
            height: outH,
            durationMs: durationMs,
            codec: "h264",
            usedHardware: isAppleSilicon(),
            segmentCount: segments.count
        )
    }

    /// Aspect-FIT letterbox a source pixel buffer into `outputRect`: scale by
    /// `min(outW/srcW, outH/srcH)`, center, and composite over a BLACK
    /// background (source-over). Returns the cropped output-sized CIImage. NEVER
    /// force-unwraps — falls back to the bare source image on any filter miss.
    private static func letterbox(
        source: CVPixelBuffer,
        sourceW: Int,
        sourceH: Int,
        outputRect: CGRect
    ) -> CIImage {
        let src = CIImage(cvPixelBuffer: source)
        guard sourceW > 0, sourceH > 0 else {
            return src.cropped(to: outputRect)
        }
        let outW = Double(outputRect.width)
        let outH = Double(outputRect.height)
        let fitScale = min(outW / Double(sourceW), outH / Double(sourceH))
        let scaledW = Double(sourceW) * fitScale
        let scaledH = Double(sourceH) * fitScale
        let offsetX = (outW - scaledW) / 2.0
        let offsetY = (outH - scaledH) / 2.0
        // Scale then translate to center. The source extent can have a non-zero
        // origin; scaling about the origin then translating by the centered
        // offset lands it correctly for a [0,0]-origin decoded buffer.
        let scaled = src
            .transformed(by: CGAffineTransform(scaleX: CGFloat(fitScale), y: CGFloat(fitScale)))
            .transformed(by: CGAffineTransform(translationX: CGFloat(offsetX), y: CGFloat(offsetY)))
        // Opaque black background spanning the whole output frame.
        let background = CIImage(color: CIColor.black).cropped(to: outputRect)
        guard let compositor = CIFilter(name: "CISourceOverCompositing") else {
            // Filter unavailable — best-effort: the scaled source, cropped.
            return scaled.cropped(to: outputRect)
        }
        compositor.setValue(scaled, forKey: kCIInputImageKey)
        compositor.setValue(background, forKey: kCIInputBackgroundImageKey)
        let composited = (compositor.outputImage ?? scaled).cropped(to: outputRect)
        return composited
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
