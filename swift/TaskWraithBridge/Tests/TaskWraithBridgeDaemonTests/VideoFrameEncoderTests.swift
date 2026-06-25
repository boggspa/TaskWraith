import XCTest
import AVFoundation
import CoreMedia
import CoreVideo
import CoreGraphics
@testable import TaskWraithBridgeDaemon

/// Tests for the native VideoToolbox encode-to-MP4 path
/// (`VideoFrameEncoder.encodeClip`, Approach B / AVAssetWriter).
///
/// The headline test synthesizes a tiny H.264 `.mp4` with `AVAssetWriter`
/// (NO ffmpeg), runs it through the FULL
/// `AVAssetReader → CoreImage downscale → AVAssetWriterInput → .mp4 mux`
/// pipeline, and proves the OUTPUT is a real, playable MP4 by re-opening it via
/// `AVURLAsset` (dimensions / track / frame count) and decoding frame 0 through
/// the sibling `VideoFrameDecoder`. The remaining tests pin the error / param
/// contract the TS side relies on.
final class VideoFrameEncoderTests: XCTestCase {

    // MARK: - Error paths

    func testNonexistentSourceThrowsBadInput() async throws {
        let missing = "/tmp/taskwraith-encode-missing-\(UUID().uuidString).mp4"
        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }
        do {
            _ = try await VideoFrameEncoder.encodeClip(
                sourcePath: missing,
                outputPath: out.path,
                scaleWidth: nil,
                targetBitrateKbps: nil,
                startSeconds: nil,
                durationSeconds: nil
            )
            XCTFail("Expected a throw for a nonexistent source")
        } catch let err as VideoEncodeError {
            guard case .badInput = err else {
                return XCTFail("Expected .badInput, got \(err)")
            }
        }
    }

    func testNonVideoFileThrows() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskwraith-encode-not-a-video-\(UUID().uuidString).txt")
        try Data("this is definitely not a video".utf8).write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        do {
            _ = try await VideoFrameEncoder.encodeClip(
                sourcePath: tmp.path,
                outputPath: out.path,
                scaleWidth: nil,
                targetBitrateKbps: nil,
                startSeconds: nil,
                durationSeconds: nil
            )
            XCTFail("Expected a throw for a non-video file")
        } catch is VideoEncodeError {
            // expected (badInput — no video track / unreadable container)
        }
    }

    /// A trim window entirely past the end of the clip must yield zero frames
    /// → `.encodeFailed` (internalError at the RPC boundary). Guards the
    /// "no frames encoded" branch + cancelWriting cleanup.
    func testTrimPastEndThrowsEncodeFailed() async throws {
        let dim = 64
        // 6 frames @ 10fps => ~0.6s of video.
        let url = try await makeTinyH264(width: dim, height: dim, frames: 6)
        defer { try? FileManager.default.removeItem(at: url) }
        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        do {
            _ = try await VideoFrameEncoder.encodeClip(
                sourcePath: url.path,
                outputPath: out.path,
                scaleWidth: nil,
                targetBitrateKbps: nil,
                startSeconds: 100.0, // far past the ~0.6s end
                durationSeconds: 1.0
            )
            XCTFail("Expected a throw for a trim entirely past the end")
        } catch let err as VideoEncodeError {
            guard case .encodeFailed = err else {
                return XCTFail("Expected .encodeFailed for zero frames, got \(err)")
            }
        }
    }

    // MARK: - Param contract (the shape the RPC layer decodes)

    func testParamDefaultsDecode() throws {
        let json: [String: Any] = [
            "sourcePath": "/tmp/in.mp4",
            "outputPath": "/tmp/out.mp4"
        ]
        let data = try JSONSerialization.data(withJSONObject: json)
        let parsed = try JSONDecoder().decode(VideoEncodeClipParams.self, from: data)
        XCTAssertEqual(parsed.sourcePath, "/tmp/in.mp4")
        XCTAssertEqual(parsed.outputPath, "/tmp/out.mp4")
        XCTAssertNil(parsed.scaleWidth)
        XCTAssertNil(parsed.targetBitrateKbps)
        XCTAssertNil(parsed.startSeconds)
        XCTAssertNil(parsed.durationSeconds)
    }

    func testParamsFullyPopulatedDecode() throws {
        let json: [String: Any] = [
            "sourcePath": "/tmp/in.mov",
            "outputPath": "/tmp/out.mp4",
            "scaleWidth": 640,
            "targetBitrateKbps": 2500,
            "startSeconds": 0.5,
            "durationSeconds": 3.0
        ]
        let data = try JSONSerialization.data(withJSONObject: json)
        let parsed = try JSONDecoder().decode(VideoEncodeClipParams.self, from: data)
        XCTAssertEqual(parsed.sourcePath, "/tmp/in.mov")
        XCTAssertEqual(parsed.outputPath, "/tmp/out.mp4")
        XCTAssertEqual(parsed.scaleWidth, 640)
        XCTAssertEqual(parsed.targetBitrateKbps, 2500)
        XCTAssertEqual(parsed.startSeconds, 0.5)
        XCTAssertEqual(parsed.durationSeconds, 3.0)
    }

    // MARK: - Real round-trip (decode → scale → encode → mux), no ffmpeg

    /// Synthesize a 128×128 / 10-frame source, transcode it down to width 64,
    /// and prove the OUTPUT is a valid, playable MP4.
    func testEncodesScaledClipProducesPlayableMP4() async throws {
        let srcDim = 128
        let frames = 10
        let url = try await makeTinyH264(width: srcDim, height: srcDim, frames: frames)
        defer { try? FileManager.default.removeItem(at: url) }

        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        let clip = try await VideoFrameEncoder.encodeClip(
            sourcePath: url.path,
            outputPath: out.path,
            scaleWidth: 64,
            targetBitrateKbps: nil,
            startSeconds: nil,
            durationSeconds: nil
        )

        // --- Result dict shape (the TS side consumes these exact keys) -------
        XCTAssertEqual(clip.width, 64)
        XCTAssertEqual(clip.height, 64) // square source → square output
        XCTAssertEqual(clip.codec, "h264")
        XCTAssertGreaterThan(clip.durationMs, 0)
        let dict = clip.toJSONObject()
        XCTAssertEqual(dict["ok"] as? Bool, true)
        XCTAssertEqual(dict["width"] as? Int, 64)
        XCTAssertEqual(dict["height"] as? Int, 64)
        XCTAssertEqual(dict["codec"] as? String, "h264")
        XCTAssertNotNil(dict["durationMs"] as? Int)
        XCTAssertNotNil(dict["usedHardware"] as? Bool)

        // --- The file actually exists + is non-empty -------------------------
        XCTAssertTrue(FileManager.default.fileExists(atPath: out.path), "Output MP4 must exist")
        let size = (try FileManager.default.attributesOfItem(atPath: out.path)[.size] as? Int) ?? 0
        XCTAssertGreaterThan(size, 0, "Output MP4 must be non-empty")

        // --- Re-open as a valid MP4: a video track at the right (even) dims ---
        let outAsset = AVURLAsset(url: out)
        let outTracks = try await outAsset.loadTracks(withMediaType: .video)
        XCTAssertEqual(outTracks.count, 1, "Output must have exactly one video track")
        guard let outTrack = outTracks.first else {
            return XCTFail("No video track in encoded output")
        }
        let naturalSize = try await outTrack.load(.naturalSize)
        XCTAssertEqual(Int(naturalSize.width.rounded()), 64)
        XCTAssertEqual(Int(naturalSize.height.rounded()), 64)
        XCTAssertEqual(Int(naturalSize.width.rounded()) % 2, 0, "width must be even")
        XCTAssertEqual(Int(naturalSize.height.rounded()) % 2, 0, "height must be even")

        // Output duration is sane (~1s for 10 frames @10fps, generous bounds).
        let outDuration = try await outAsset.load(.duration)
        let outSeconds = CMTimeGetSeconds(outDuration)
        XCTAssertGreaterThan(outSeconds, 0)
        XCTAssertLessThan(outSeconds, 5)

        // --- Prove it's PLAYABLE: decode frame 0 via the sibling decoder ------
        let frame0 = try await VideoFrameDecoder.decodeFrame(
            inputPath: out.path,
            timestampSeconds: 0,
            preferHardware: true
        )
        XCTAssertEqual(frame0.width, 64)
        XCTAssertEqual(frame0.height, 64)
        XCTAssertEqual(frame0.codec, "h264")
        XCTAssertFalse(frame0.pngData.isEmpty)
    }

    /// No-scale pass-through (scaleWidth nil) keeps natural dims and still muxes
    /// a valid MP4 — exercises the verbatim-append branch (no CoreImage).
    func testEncodesUnscaledClip() async throws {
        let dim = 96 // already even
        let url = try await makeTinyH264(width: dim, height: dim, frames: 6)
        defer { try? FileManager.default.removeItem(at: url) }
        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        let clip = try await VideoFrameEncoder.encodeClip(
            sourcePath: url.path,
            outputPath: out.path,
            scaleWidth: nil,
            targetBitrateKbps: 1500,
            startSeconds: nil,
            durationSeconds: nil
        )
        XCTAssertEqual(clip.width, dim)
        XCTAssertEqual(clip.height, dim)

        let outAsset = AVURLAsset(url: out)
        let outTracks = try await outAsset.loadTracks(withMediaType: .video)
        XCTAssertEqual(outTracks.count, 1)
    }

    /// FIX 1 (HIGH): in the NO-SCALE path the writer must be declared at the
    /// source's CODED dimensions (what the AVAssetReader actually yields), NOT
    /// the even-rounded PRESENTATION dimensions. For a source with non-square
    /// pixels (a PAR), presentation width can be ODD while coded width is even;
    /// the old code declared the writer at even-rounded presentation dims and
    /// appended coded-size buffers verbatim → a silently corrupt / content-
    /// shifted MP4 that LIED about its size. This synthesizes exactly that
    /// (coded 64, PAR 65:64 → presentation width 65, ODD) and asserts the output
    /// is declared + decoded at the CODED size, with a frame that re-decodes.
    func testNoScaleOddPresentationUsesCodedDimensions() async throws {
        let codedW = 64
        let codedH = 64
        // PAR 65:64 stretches display width to 64 * 65/64 = 65 (ODD presentation
        // width over an even coded width) — the exact corruption trigger.
        let url = try await makeTinyH264(
            width: codedW,
            height: codedH,
            frames: 8,
            pixelAspectRatio: (horizontal: 65, vertical: 64)
        )
        defer { try? FileManager.default.removeItem(at: url) }
        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        let clip = try await VideoFrameEncoder.encodeClip(
            sourcePath: url.path,
            outputPath: out.path,
            scaleWidth: nil, // NO scale → must declare at coded dims
            targetBitrateKbps: nil,
            startSeconds: nil,
            durationSeconds: nil
        )
        // The reported (declared) dims MUST be the CODED size, not the even-
        // rounded presentation width (66). Otherwise we shipped a corrupt MP4.
        XCTAssertEqual(clip.width, codedW, "no-scale output width must equal the CODED source width")
        XCTAssertEqual(clip.height, codedH, "no-scale output height must equal the CODED source height")

        // Re-open: the actual track geometry must match the declared dims (no
        // writer-vs-buffer mismatch).
        let outAsset = AVURLAsset(url: out)
        let outTracks = try await outAsset.loadTracks(withMediaType: .video)
        XCTAssertEqual(outTracks.count, 1)
        guard let outTrack = outTracks.first else {
            return XCTFail("No video track in encoded output")
        }
        // Coded dims of the OUTPUT format description == the declared dims; this
        // is the geometry the buffers were actually appended at.
        let outFmts = try await outTrack.load(.formatDescriptions)
        guard let outFmt = outFmts.first else {
            return XCTFail("Output track has no format description")
        }
        let outCoded = CMVideoFormatDescriptionGetDimensions(outFmt)
        XCTAssertEqual(Int(outCoded.width), codedW, "output coded width must equal declared width (buffers append at coded size)")
        XCTAssertEqual(Int(outCoded.height), codedH, "output coded height must equal declared height")

        // And it must genuinely decode (proves the muxed frames are intact, not
        // garbage from a size mismatch).
        let frame0 = try await VideoFrameDecoder.decodeFrame(
            inputPath: out.path,
            timestampSeconds: 0,
            preferHardware: true
        )
        XCTAssertEqual(frame0.width, codedW)
        XCTAssertEqual(frame0.height, codedH)
        XCTAssertEqual(frame0.codec, "h264")
        XCTAssertFalse(frame0.pngData.isEmpty)
    }

    /// Locks the no-scale path to CODED dimensions for a plain square (even)
    /// source: declared output dims == coded source dims. Together with
    /// `testNoScaleOddPresentationUsesCodedDimensions` this pins the invariant
    /// "no-scale writer is ALWAYS declared at coded size" — which is what makes
    /// the odd-PAR case correct by construction.
    func testNoScaleDeclaredDimsEqualCodedSource() async throws {
        let dim = 80 // even, square pixels → coded == presentation
        let url = try await makeTinyH264(width: dim, height: dim, frames: 5)
        defer { try? FileManager.default.removeItem(at: url) }
        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        let clip = try await VideoFrameEncoder.encodeClip(
            sourcePath: url.path,
            outputPath: out.path,
            scaleWidth: nil,
            targetBitrateKbps: nil,
            startSeconds: nil,
            durationSeconds: nil
        )
        XCTAssertEqual(clip.width, dim, "no-scale declared width must equal coded source width")
        XCTAssertEqual(clip.height, dim, "no-scale declared height must equal coded source height")
    }

    /// A trim window (start + duration) yields a SHORTER output than the source
    /// and a still-valid MP4 — exercises the timeRange + PTS-rebase + discard
    /// branch end-to-end.
    func testEncodesTrimmedClip() async throws {
        let dim = 64
        // 20 frames @ 10fps => ~2.0s of source video.
        let url = try await makeTinyH264(width: dim, height: dim, frames: 20)
        defer { try? FileManager.default.removeItem(at: url) }
        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        // Trim ~0.5s..~1.0s => ~0.5s of output.
        let clip = try await VideoFrameEncoder.encodeClip(
            sourcePath: url.path,
            outputPath: out.path,
            scaleWidth: nil,
            targetBitrateKbps: nil,
            startSeconds: 0.5,
            durationSeconds: 0.5
        )
        XCTAssertEqual(clip.width, dim)

        let outAsset = AVURLAsset(url: out)
        let outTracks = try await outAsset.loadTracks(withMediaType: .video)
        XCTAssertEqual(outTracks.count, 1)

        let outSeconds = CMTimeGetSeconds(try await outAsset.load(.duration))
        // Trimmed output must be clearly shorter than the ~2.0s source.
        XCTAssertGreaterThan(outSeconds, 0)
        XCTAssertLessThan(outSeconds, 1.5, "trimmed output should be ~0.5s, well under the 2s source")

        // The trimmed output starts at a rebased zero timeline and decodes.
        let frame0 = try await VideoFrameDecoder.decodeFrame(
            inputPath: out.path,
            timestampSeconds: 0,
            preferHardware: true
        )
        XCTAssertEqual(frame0.width, dim)
        XCTAssertFalse(frame0.pngData.isEmpty)
    }

    /// FIX 2 (MEDIUM): a NO-TRIM encode of a source whose first frame PTS > 0
    /// (edit lists, concatenated MP4s) must REBASE the output to t=0 — the old
    /// code used `outputPTS = sourcePTS` with `startSession(atSourceTime: .zero)`,
    /// leaving an empty leading timeline. This synthesizes a leading-gap source
    /// (first sample PTS ≈ 1.0s) and asserts the encoded output starts at ~0.
    ///
    /// NOTE: AVAssetWriter cannot author a true MP4 edit list, and some readers
    /// normalize the first sample to PTS 0 on read-back — so this test cannot
    /// always *observe* the pre-fix bug. It is therefore tolerant: it asserts
    /// the post-fix invariant (output begins at 0, decodes at 0) which holds on
    /// either platform behavior. The unconditional-rebase code change is
    /// self-evidently correct for the genuine non-zero-start case (anchor =
    /// first observed source PTS, subtracted from every frame).
    func testNoTrimRebasesNonZeroStartToZero() async throws {
        let dim = 64
        // 8 frames @10fps with the first sample offset to ~1.0s (10 frames).
        let url = try await makeTinyH264(
            width: dim,
            height: dim,
            frames: 8,
            startPTSFrames: 10
        )
        defer { try? FileManager.default.removeItem(at: url) }
        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        let clip = try await VideoFrameEncoder.encodeClip(
            sourcePath: url.path,
            outputPath: out.path,
            scaleWidth: nil,
            targetBitrateKbps: nil,
            startSeconds: nil,   // NO trim → exercises the unconditional rebase
            durationSeconds: nil
        )
        XCTAssertEqual(clip.width, dim)
        XCTAssertGreaterThan(clip.durationMs, 0, "honest output duration must remain non-zero")

        let outAsset = AVURLAsset(url: out)
        let outTracks = try await outAsset.loadTracks(withMediaType: .video)
        XCTAssertEqual(outTracks.count, 1)
        guard let outTrack = outTracks.first else {
            return XCTFail("No video track in encoded output")
        }

        // The output timeline must begin at ~0 (no leading gap). Read the first
        // sample's PTS straight off a reader over the output.
        let reader = try AVAssetReader(asset: outAsset)
        let trackOut = AVAssetReaderTrackOutput(
            track: outTrack,
            outputSettings: [
                kCVPixelBufferPixelFormatTypeKey as String:
                    Int(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
            ]
        )
        XCTAssertTrue(reader.canAdd(trackOut))
        reader.add(trackOut)
        XCTAssertTrue(reader.startReading())
        defer { if reader.status == .reading { reader.cancelReading() } }

        guard let firstSample = trackOut.copyNextSampleBuffer() else {
            return XCTFail("Output produced no samples")
        }
        let firstPTS = CMSampleBufferGetPresentationTimeStamp(firstSample)
        XCTAssertTrue(firstPTS.isNumeric)
        let firstSeconds = CMTimeGetSeconds(firstPTS)
        // Rebased to zero — tolerate a sub-frame epsilon (one 10fps frame = 0.1s).
        XCTAssertLessThan(firstSeconds, 0.1, "no-trim output must start rebased at t≈0, got \(firstSeconds)s")

        // And it decodes at t=0 (the content is intact + present at the start).
        let frame0 = try await VideoFrameDecoder.decodeFrame(
            inputPath: out.path,
            timestampSeconds: 0,
            preferHardware: true
        )
        XCTAssertEqual(frame0.width, dim)
        XCTAssertFalse(frame0.pngData.isEmpty)
    }

    // MARK: - Helpers

    private func stagingURL() -> URL {
        // Mimic the TS-owned staging path shape (…/media-staging/tw-<uuid>.mp4).
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("media-staging", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("tw-\(UUID().uuidString).mp4")
    }

    /// Encode a tiny solid-color H.264 `.mp4` source and return its URL. Each
    /// frame is a distinct solid color so the encoder has real deltas. Mirrors
    /// the decoder-test synthesizer.
    ///
    /// `pixelAspectRatio` (optional) bakes a non-square PAR into the output
    /// format description so the source's PRESENTATION width diverges from its
    /// (even) CODED width — used to reproduce the odd-presentation corruption
    /// case in `testNoScaleOddPresentationUsesCodedDimensions`.
    private func makeTinyH264(
        width: Int,
        height: Int,
        frames: Int,
        pixelAspectRatio: (horizontal: Int, vertical: Int)? = nil,
        startPTSFrames: Int = 0
    ) async throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskwraith-encode-synth-\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: url)

        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        var settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height
        ]
        if let par = pixelAspectRatio {
            // Carried into the encoded format description's pixel-aspect-ratio
            // extension → presentation dims = coded * (h/v) while coded stays
            // at width×height (even).
            settings[AVVideoPixelAspectRatioKey] = [
                AVVideoPixelAspectRatioHorizontalSpacingKey: par.horizontal,
                AVVideoPixelAspectRatioVerticalSpacingKey: par.vertical
            ]
        }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false

        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height
        ]
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: attrs
        )

        guard writer.canAdd(input) else {
            throw XCTSkip("AVAssetWriter cannot add an H.264 input in this environment")
        }
        writer.add(input)

        guard writer.startWriting() else {
            throw XCTSkip("AVAssetWriter could not start (status \(writer.status.rawValue), \(String(describing: writer.error)))")
        }
        writer.startSession(atSourceTime: .zero)

        let fps: Int32 = 10
        for i in 0..<frames {
            var spins = 0
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(nanoseconds: 1_000_000)
                spins += 1
                if spins > 5_000 { break }
            }
            guard let pool = adaptor.pixelBufferPool else {
                throw XCTSkip("No pixel buffer pool available")
            }
            var pbOut: CVPixelBuffer?
            let allocStatus = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pbOut)
            guard allocStatus == kCVReturnSuccess, let pb = pbOut else {
                throw XCTSkip("Could not allocate a pixel buffer (status \(allocStatus))")
            }
            fillSolid(pb, frameIndex: i, total: frames)
            // Optional non-zero start: offset every PTS so the FIRST sample
            // lands at startPTSFrames/fps (a leading-gap source, like an edit
            // list / concatenated MP4). Session still starts at .zero.
            let pts = CMTime(value: CMTimeValue(i + startPTSFrames), timescale: fps)
            if !adaptor.append(pb, withPresentationTime: pts) {
                throw XCTSkip("Adaptor refused a frame (status \(writer.status.rawValue), \(String(describing: writer.error)))")
            }
        }

        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else {
            throw XCTSkip("AVAssetWriter did not complete (status \(writer.status.rawValue), \(String(describing: writer.error)))")
        }
        return url
    }

    /// Fill a BGRA pixel buffer with a solid color that varies per frame.
    private func fillSolid(_ pb: CVPixelBuffer, frameIndex: Int, total: Int) {
        CVPixelBufferLockBaseAddress(pb, [])
        defer { CVPixelBufferUnlockBaseAddress(pb, []) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return }
        let width = CVPixelBufferGetWidth(pb)
        let height = CVPixelBufferGetHeight(pb)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pb)

        let t = total > 1 ? Double(frameIndex) / Double(total - 1) : 0
        let r = UInt8(40 + t * 200)
        let g = UInt8(200 - t * 150)
        let b = UInt8(80 + t * 120)
        let a: UInt8 = 255

        let ptr = base.assumingMemoryBound(to: UInt8.self)
        for y in 0..<height {
            let row = ptr + y * bytesPerRow
            for x in 0..<width {
                let px = row + x * 4
                px[0] = b
                px[1] = g
                px[2] = r
                px[3] = a
            }
        }
    }
}
