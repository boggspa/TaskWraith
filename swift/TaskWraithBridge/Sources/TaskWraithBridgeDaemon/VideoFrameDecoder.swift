import Foundation
import AVFoundation
import VideoToolbox
import CoreMedia
import CoreVideo
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// `video.decodeFrame` result. Mirrors the wire shape other modules consume:
/// a base64 PNG plus the actual presentation timestamp of the frame that was
/// returned (NOT the requested timestamp — VT/AVAssetReader can only land on a
/// frame at or after the seek point, so callers need the truth).
struct DecodedVideoFrame: Sendable {
    let pngData: Data
    let width: Int
    let height: Int
    /// The real PTS of the returned frame, in seconds.
    let timestampSeconds: Double
    /// Best-effort codec label — a human fourcc ("h264"/"hevc") when we
    /// recognize it, otherwise the raw fourcc string.
    let codec: String
    /// Whether a hardware-accelerated decoder was REQUESTED and the
    /// hardware-eligible `VTDecompressionSession` was successfully created.
    /// NOTE: this is not a per-frame guarantee. We create the session with
    /// `Enable…HardwareAcceleratedVideoDecoder` (Enable, not Require), so VT may
    /// still silently fall back to a software decoder at decode time for
    /// unsupported profiles while this field stays `true`. `false` means we
    /// created (or were asked for) a software session up front.
    let usedHardware: Bool

    func toJSONObject() -> [String: Any] {
        return [
            "ok": true,
            "pngBase64": pngData.base64EncodedString(),
            "width": width,
            "height": height,
            "timestampSeconds": timestampSeconds,
            "codec": codec,
            "usedHardware": usedHardware
        ]
    }
}

/// Decode failures surfaced by `VideoFrameDecoder`. `.badInput` maps to
/// `invalidParams` at the RPC boundary (the caller gave us something we can't
/// even start on — missing file, no video track); everything else maps to
/// `internalError` (the input looked valid but decode could not complete, or
/// the content is out of scope for this slice, e.g. HDR).
enum VideoFrameDecodeError: Error, CustomStringConvertible {
    /// Caller-correctable: bad/missing path, unreadable asset, or no video track.
    case badInput(String)
    /// Out-of-scope content in this slice (HDR), or a true decode failure.
    case decodeFailed(String)

    var description: String {
        switch self {
        case .badInput(let m): return m
        case .decodeFailed(let m): return m
        }
    }
}

/// Native single-frame video decode via an EXPLICIT `VTDecompressionSession`.
///
/// We deliberately do NOT use `AVAssetReaderTrackOutput`'s auto-decompression
/// (`outputSettings:` with a pixel-format dict). Instead we pull the ORIGINAL
/// compressed `CMSampleBuffer`s (`outputSettings: nil`) and feed them through a
/// hand-built VT session. The whole point of this slice is to exercise the real
/// VideoToolbox machinery end-to-end so the streaming slice (S3) inherits a
/// proven decode path.
enum VideoFrameDecoder {
    /// Decode a single frame at (or after) `timestampSeconds`.
    ///
    /// - Parameters:
    ///   - inputPath: filesystem path to a video container.
    ///   - timestampSeconds: target PTS; clamped to >= 0. We return the first
    ///     decoded frame whose PTS >= target. If the target is past the end we
    ///     gracefully return the last frame we could decode.
    ///   - preferHardware: request HW-accelerated decode (never *require* it —
    ///     we retry in software if the HW session won't create).
    static func decodeFrame(
        inputPath: String,
        timestampSeconds: Double,
        preferHardware: Bool
    ) async throws -> DecodedVideoFrame {
        // --- 1. Open the asset + resolve the first video track ----------------
        let url = URL(fileURLWithPath: inputPath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw VideoFrameDecodeError.badInput("Input file does not exist: \(inputPath)")
        }

        let asset = AVURLAsset(url: url)

        let videoTracks = try await loadVideoTracks(asset)
        guard let track = videoTracks.first else {
            throw VideoFrameDecodeError.badInput("No video track in input: \(inputPath)")
        }

        let formatDescriptions = try await loadFormatDescriptions(track)
        guard let formatDescAny = formatDescriptions.first else {
            throw VideoFrameDecodeError.badInput("Video track has no format description: \(inputPath)")
        }
        // CMFormatDescription / CMVideoFormatDescription are the same CFType;
        // the cast is just a typed view.
        let formatDesc = formatDescAny as CMVideoFormatDescription

        // --- 2. HDR gate (SDR-first) -----------------------------------------
        // Detect HDR via the format-desc color extensions and bail clearly
        // rather than mis-rendering BT.2020 / PQ / HLG content as SDR. A later
        // slice adds tone-mapping.
        if isHDR(formatDesc: formatDesc) {
            throw VideoFrameDecodeError.decodeFailed("HDR video not yet supported")
        }

        let codecLabel = fourCCString(CMFormatDescriptionGetMediaSubType(formatDesc))

        // --- 3. AVAssetReader over a tight time window -----------------------
        // Clamp the target to a finite, sane bound BEFORE we ever build a CMTime
        // from it — independent of whether the duration loaded. The MCP layer
        // rejects non-finite input, but NOT a huge finite magnitude: `1e308`
        // makes `CMTime(seconds:)` non-numeric (timescale 0) and `1e18`
        // collapses 600-tick precision, either of which makes `startReading()`
        // fail or yield zero frames -> a confusing `.decodeFailed`. A 24h cap is
        // far beyond any real seek and keeps the CMTime numeric.
        let target = timestampSeconds.isFinite ? min(max(timestampSeconds, 0), 86_400) : 0

        let durationCM = try await loadDuration(asset)
        let durationSeconds = durationCM.isNumeric ? CMTimeGetSeconds(durationCM) : 0
        // When the duration IS known, clamp the requested start to just inside
        // the asset so a far-future seek still reads (and yields the last frame)
        // instead of an empty window. When it's unknown we fall back to the
        // already finite-capped target above.
        let clampedStart = durationSeconds > 0 ? min(target, max(0, durationSeconds - 0.001)) : target

        let reader: AVAssetReader
        do {
            reader = try AVAssetReader(asset: asset)
        } catch {
            throw VideoFrameDecodeError.badInput("Unable to read asset: \(error.localizedDescription)")
        }
        // outputSettings: nil => original compressed sample buffers (with the
        // format description attached), which is exactly what we hand to VT.
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            throw VideoFrameDecodeError.decodeFailed("Reader rejected track output")
        }
        reader.add(output)

        // Tight window: start at the (clamped) seek point, run ~2s or to the
        // end — whichever is shorter — so we don't decode the whole file. The
        // window is widened to a GOP-safe boundary by AVAssetReader internally
        // (it starts at the preceding sync sample), so a mid-GOP target still
        // produces correctly-decoded frames.
        // Defensive: clampedStart is finite-capped above so this is numeric, but
        // guard anyway — a non-numeric start would silently break `startReading`.
        let rawStart = CMTime(seconds: clampedStart, preferredTimescale: 600)
        let startTime = rawStart.isNumeric ? rawStart : .zero
        let windowDuration = CMTime(seconds: 2.0, preferredTimescale: 600)
        if durationCM.isNumeric {
            let remaining = CMTimeSubtract(durationCM, startTime)
            let windowLen = CMTimeMinimum(windowDuration, CMTimeMaximum(remaining, CMTime(value: 1, timescale: 600)))
            reader.timeRange = CMTimeRange(start: startTime, duration: windowLen)
        } else {
            reader.timeRange = CMTimeRange(start: startTime, duration: windowDuration)
        }

        guard reader.startReading() else {
            let msg = reader.error?.localizedDescription ?? "unknown reader error"
            throw VideoFrameDecodeError.decodeFailed("AVAssetReader failed to start: \(msg)")
        }
        // Make sure a thrown error below still cancels the reader.
        defer {
            if reader.status == .reading { reader.cancelReading() }
        }

        // --- 4. Build the explicit VTDecompressionSession --------------------
        let session = try makeDecompressionSession(
            formatDesc: formatDesc,
            preferHardware: preferHardware
        )
        defer { VTDecompressionSessionInvalidate(session.session) }

        // --- 5. Decode loop --------------------------------------------------
        // The output handler runs on VT's queue; funnel results into a small
        // thread-safe collector that keeps the best frame seen so far.
        let collector = FrameCollector(targetSeconds: target)

        // FULL DRAIN. We must submit EVERY sample the (already bounded ~2s)
        // reader window yields — never break early on "a frame at/after target
        // arrived". VT delivers async callbacks in DECODE (DTS) order, and on
        // B-frame / reordered streams DTS != PTS: a later-PTS frame can be
        // delivered BEFORE the true earliest-PTS-≥-target frame has even been
        // submitted. Breaking on first-delivery would then return a frame one or
        // more display-frames too late (still inside the GOP). Draining the whole
        // window and choosing in `best()` makes the result deterministic
        // regardless of reorder; the cost is bounded by the timeRange above.
        while reader.status == .reading {
            guard let sampleBuffer = output.copyNextSampleBuffer() else { break }
            // Skip empty samples (no media). For compressed samples the next
            // num-samples check is the real empty-frame guard.
            guard CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { continue }

            var flagsOut = VTDecodeInfoFlags()
            let decodeFlags: VTDecodeFrameFlags = [._EnableAsynchronousDecompression]
            let status = VTDecompressionSessionDecodeFrame(
                session.session,
                sampleBuffer: sampleBuffer,
                flags: decodeFlags,
                infoFlagsOut: &flagsOut,
                outputHandler: { (decodeStatus, _, imageBuffer, presentationTimeStamp, _) in
                    guard decodeStatus == noErr, let imageBuffer else { return }
                    let pts = CMTimeGetSeconds(presentationTimeStamp)
                    collector.offer(imageBuffer: imageBuffer, ptsSeconds: pts.isFinite ? pts : 0)
                }
            )
            if status != noErr {
                // A single-frame decode error shouldn't abort the whole window
                // (the next sample may decode fine); but if NOTHING decodes
                // we surface it below.
                collector.noteDecodeError(status)
            }
        }

        // Barrier: block until every async frame submitted above has been
        // delivered, THEN pick. `best()` is only meaningful after a full drain.
        VTDecompressionSessionWaitForAsynchronousFrames(session.session)

        if reader.status == .failed {
            let msg = reader.error?.localizedDescription ?? "unknown"
            throw VideoFrameDecodeError.decodeFailed("AVAssetReader failed mid-decode: \(msg)")
        }

        guard let chosen = collector.best() else {
            if let code = collector.lastDecodeStatus {
                throw VideoFrameDecodeError.decodeFailed("VT produced no frames (last status \(code))")
            }
            throw VideoFrameDecodeError.decodeFailed("No decodable frame in the requested window")
        }

        // --- 6. CVPixelBuffer -> CGImage -> PNG ------------------------------
        // Propagate source color so the CGImage isn't BT.601<->709 hue-shifted:
        // attach the format-desc color extensions to the pixel buffer if VT
        // didn't already stamp them.
        propagateColorAttachments(from: formatDesc, to: chosen.imageBuffer)

        let cgImage = try makeCGImage(from: chosen.imageBuffer)
        let png = try encodePNG(cgImage)

        return DecodedVideoFrame(
            pngData: png,
            width: cgImage.width,
            height: cgImage.height,
            timestampSeconds: chosen.ptsSeconds,
            codec: codecLabel,
            usedHardware: session.usedHardware
        )
    }

    // MARK: - VT session construction

    /// A constructed session plus which path was REQUESTED at creation.
    /// `usedHardware == true` means the hardware-eligible session was created
    /// (Enable, not Require); VT may still fall back to software per-frame for
    /// unsupported profiles. See `DecodedVideoFrame.usedHardware`.
    private struct VTSession {
        let session: VTDecompressionSession
        let usedHardware: Bool
    }

    private static func makeDecompressionSession(
        formatDesc: CMVideoFormatDescription,
        preferHardware: Bool
    ) throws -> VTSession {
        // Destination pixel buffer attributes: request 32BGRA + IOSurface so
        // VTCreateCGImageFromCVPixelBuffer works directly and the layout
        // matches AttachedWindowStream's BGRA assumption.
        let destinationAttrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()
        ]

        func create(hardware: Bool) -> (status: OSStatus, session: VTDecompressionSession?) {
            var spec: CFDictionary? = nil
            if hardware {
                // ENABLE (not REQUIRE) — Require hard-fails on Macs without a
                // HW decoder for the codec; Enable just prefers it.
                let specDict: [String: Any] = [
                    kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder as String: true
                ]
                spec = specDict as CFDictionary
            }
            var sessionOut: VTDecompressionSession?
            let status = VTDecompressionSessionCreate(
                allocator: kCFAllocatorDefault,
                formatDescription: formatDesc,
                decoderSpecification: spec,
                imageBufferAttributes: destinationAttrs as CFDictionary,
                outputCallback: nil,
                decompressionSessionOut: &sessionOut
            )
            return (status, sessionOut)
        }

        if preferHardware {
            let hw = create(hardware: true)
            if hw.status == noErr, let s = hw.session {
                return VTSession(session: s, usedHardware: true)
            }
            // Retry once in software with a nil spec.
            let sw = create(hardware: false)
            if sw.status == noErr, let s = sw.session {
                return VTSession(session: s, usedHardware: false)
            }
            throw VideoFrameDecodeError.decodeFailed(
                "VTDecompressionSessionCreate failed (hw status \(hw.status), sw status \(sw.status))"
            )
        } else {
            let sw = create(hardware: false)
            if sw.status == noErr, let s = sw.session {
                return VTSession(session: s, usedHardware: false)
            }
            throw VideoFrameDecodeError.decodeFailed(
                "VTDecompressionSessionCreate (software) failed (status \(sw.status))"
            )
        }
    }

    // MARK: - Color / HDR helpers

    /// HDR if the transfer function is PQ (smpte2084) or HLG, OR the primaries
    /// are BT.2020. We read these straight off the format-description color
    /// extensions so we never have to decode a frame to know.
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
    /// description onto the decoded pixel buffer when VT left them unset. Without
    /// this, `VTCreateCGImageFromCVPixelBuffer` assumes a default matrix and the
    /// resulting CGImage can be hue-shifted (the classic BT.601<->709 bug).
    private static func propagateColorAttachments(
        from formatDesc: CMVideoFormatDescription,
        to pixelBuffer: CVPixelBuffer
    ) {
        func copy(extKey: CFString, attachKey: CFString) {
            // CVBufferCopyAttachment is the non-deprecated reader (macOS 12+);
            // it returns an owned ref, so a non-nil result means VT already set
            // the attachment and we leave it alone.
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

    // MARK: - Image encode

    private static func makeCGImage(from pixelBuffer: CVPixelBuffer) throws -> CGImage {
        var cgImage: CGImage?
        let status = VTCreateCGImageFromCVPixelBuffer(pixelBuffer, options: nil, imageOut: &cgImage)
        guard status == noErr, let image = cgImage else {
            throw VideoFrameDecodeError.decodeFailed("VTCreateCGImageFromCVPixelBuffer failed (status \(status))")
        }
        return image
    }

    /// PNG encode via ImageIO `CGImageDestination` — mirrors the ImageIO usage
    /// pattern in `AttachedWindowOCR.swift` (and the test helper).
    private static func encodePNG(_ cgImage: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data as CFMutableData,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            throw VideoFrameDecodeError.decodeFailed("Could not create PNG destination")
        }
        CGImageDestinationAddImage(destination, cgImage, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw VideoFrameDecodeError.decodeFailed("PNG finalize failed")
        }
        return data as Data
    }

    // MARK: - fourcc

    /// Render a CMVideoCodecType (a fourcc) as a friendly label where we know
    /// it, otherwise as the raw 4-char string.
    private static func fourCCString(_ code: FourCharCode) -> String {
        switch code {
        case kCMVideoCodecType_H264: return "h264"
        case kCMVideoCodecType_HEVC: return "hevc"
        case kCMVideoCodecType_AppleProRes422, kCMVideoCodecType_AppleProRes422HQ,
             kCMVideoCodecType_AppleProRes422LT, kCMVideoCodecType_AppleProRes422Proxy,
             kCMVideoCodecType_AppleProRes4444, kCMVideoCodecType_AppleProRes4444XQ:
            return "prores"
        case kCMVideoCodecType_MPEG4Video: return "mpeg4"
        default:
            let bytes: [UInt8] = [
                UInt8((code >> 24) & 0xFF),
                UInt8((code >> 16) & 0xFF),
                UInt8((code >> 8) & 0xFF),
                UInt8(code & 0xFF)
            ]
            let scalars = bytes.map { byte -> Character in
                let isPrintable = byte >= 0x20 && byte < 0x7F
                return isPrintable ? Character(UnicodeScalar(byte)) : "?"
            }
            return String(scalars)
        }
    }

    // MARK: - async property loading
    //
    // AVFoundation's synchronous `.tracks` / `.formatDescriptions` / `.duration`
    // accessors are deprecated under Swift 6 strict concurrency in favor of the
    // async `load(_:)` family. These thin wrappers keep the call sites readable.

    private static func loadVideoTracks(_ asset: AVAsset) async throws -> [AVAssetTrack] {
        do {
            return try await asset.loadTracks(withMediaType: .video)
        } catch {
            throw VideoFrameDecodeError.badInput("Could not read tracks: \(error.localizedDescription)")
        }
    }

    private static func loadFormatDescriptions(_ track: AVAssetTrack) async throws -> [CMFormatDescription] {
        do {
            return try await track.load(.formatDescriptions)
        } catch {
            throw VideoFrameDecodeError.badInput("Could not read format descriptions: \(error.localizedDescription)")
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

/// Thread-safe accumulator for decoded frames. VT delivers frames on its own
/// queue in DECODE (DTS) order, which on B-frame / reordered streams is NOT PTS
/// order — so we cannot trust delivery order and instead keep, across a FULL
/// drain of the reader window:
///   - the EARLIEST-PTS frame whose PTS >= target (the "ideal" answer — the
///     true display frame the caller asked for, even if a later-PTS frame was
///     delivered first), and
///   - the latest frame overall (the graceful fallback when the target is past
///     the end of the window).
/// `best()` is only meaningful once every submitted frame has been offered
/// (i.e. after `VTDecompressionSessionWaitForAsynchronousFrames`).
/// Retains the chosen `CVPixelBuffer` until the caller reads it.
private final class FrameCollector: @unchecked Sendable {
    private let lock = NSLock()
    private let targetSeconds: Double

    private var atOrAfter: (imageBuffer: CVPixelBuffer, ptsSeconds: Double)?
    private var latest: (imageBuffer: CVPixelBuffer, ptsSeconds: Double)?
    private(set) var lastDecodeStatus: OSStatus?

    init(targetSeconds: Double) {
        self.targetSeconds = targetSeconds
    }

    func offer(imageBuffer: CVPixelBuffer, ptsSeconds: Double) {
        lock.lock(); defer { lock.unlock() }
        // Track the latest-overall frame as a fallback.
        if let cur = latest {
            if ptsSeconds >= cur.ptsSeconds {
                latest = (imageBuffer, ptsSeconds)
            }
        } else {
            latest = (imageBuffer, ptsSeconds)
        }
        // Track the EARLIEST frame at/after the target — that's the frame the
        // caller actually asked for.
        if ptsSeconds + 1e-6 >= targetSeconds {
            if let cur = atOrAfter {
                if ptsSeconds < cur.ptsSeconds {
                    atOrAfter = (imageBuffer, ptsSeconds)
                }
            } else {
                atOrAfter = (imageBuffer, ptsSeconds)
            }
        }
    }

    func noteDecodeError(_ status: OSStatus) {
        lock.lock(); defer { lock.unlock() }
        lastDecodeStatus = status
    }

    /// The frame to return: the earliest at/after target, else the latest seen.
    func best() -> (imageBuffer: CVPixelBuffer, ptsSeconds: Double)? {
        lock.lock(); defer { lock.unlock() }
        return atOrAfter ?? latest
    }
}
