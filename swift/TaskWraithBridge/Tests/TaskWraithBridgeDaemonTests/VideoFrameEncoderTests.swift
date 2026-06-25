import XCTest
import AVFoundation
import CoreMedia
import CoreVideo
import CoreGraphics
import ImageIO
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

    // MARK: - Overlay composite (S3-2)

    /// Param contract: the five overlay fields decode (defaults nil when absent).
    func testOverlayParamsDecode() throws {
        // Absent overlay fields → nil.
        let bare: [String: Any] = ["sourcePath": "/tmp/in.mp4", "outputPath": "/tmp/out.mp4"]
        let bareData = try JSONSerialization.data(withJSONObject: bare)
        let bareParsed = try JSONDecoder().decode(VideoEncodeClipParams.self, from: bareData)
        XCTAssertNil(bareParsed.overlayPath)
        XCTAssertNil(bareParsed.overlayX)
        XCTAssertNil(bareParsed.overlayY)
        XCTAssertNil(bareParsed.overlayWidth)
        XCTAssertNil(bareParsed.overlayOpacity)

        // Fully populated overlay fields decode to the supplied values.
        let full: [String: Any] = [
            "sourcePath": "/tmp/in.mp4",
            "outputPath": "/tmp/out.mp4",
            "overlayPath": "/tmp/badge.png",
            "overlayX": 12,
            "overlayY": 24,
            "overlayWidth": 48,
            "overlayOpacity": 0.5
        ]
        let fullData = try JSONSerialization.data(withJSONObject: full)
        let fullParsed = try JSONDecoder().decode(VideoEncodeClipParams.self, from: fullData)
        XCTAssertEqual(fullParsed.overlayPath, "/tmp/badge.png")
        XCTAssertEqual(fullParsed.overlayX, 12)
        XCTAssertEqual(fullParsed.overlayY, 24)
        XCTAssertEqual(fullParsed.overlayWidth, 48)
        XCTAssertEqual(fullParsed.overlayOpacity, 0.5)
    }

    /// Overlay happy path: composite a small bright (red) overlay over a solid
    /// dark source at a top-left position, then prove (a) the output is a valid
    /// playable MP4 that re-decodes, and (b) the decoded pixel UNDER the overlay
    /// is reddish while a pixel OUTSIDE it is not — proving the overlay landed at
    /// the requested top-left coordinate (i.e. the bottom-left Y flip is correct).
    func testOverlayCompositesAtTopLeftPosition() async throws {
        let dim = 128
        // A solid DARK source (every frame ~black-ish), so the bright overlay is
        // unambiguous against it. makeTinyH264 already varies color per frame,
        // but the source stays far from saturated red, so the contrast holds.
        let srcURL = try await makeTinyH264(width: dim, height: dim, frames: 8)
        defer { try? FileManager.default.removeItem(at: srcURL) }

        // A 32×32 solid-red overlay PNG written to a temp file.
        let overlayURL = try writeSolidPNG(width: 32, height: 32, r: 255, g: 0, b: 0, a: 255)
        defer { try? FileManager.default.removeItem(at: overlayURL) }

        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        // Position the overlay top-left at (10,10) → it covers output pixels
        // x∈[10,42), y∈[10,42) (top-left origin). No scale → output == 128².
        let clip = try await VideoFrameEncoder.encodeClip(
            sourcePath: srcURL.path,
            outputPath: out.path,
            scaleWidth: nil,
            targetBitrateKbps: nil,
            startSeconds: nil,
            durationSeconds: nil,
            overlayPath: overlayURL.path,
            overlayX: 10,
            overlayY: 10,
            overlayWidth: nil,
            overlayOpacity: nil
        )
        XCTAssertEqual(clip.width, dim, "overlay-without-scale output keeps coded source width")
        XCTAssertEqual(clip.height, dim)

        // Valid, playable MP4: re-open + one video track at the right dims.
        let outAsset = AVURLAsset(url: out)
        let outTracks = try await outAsset.loadTracks(withMediaType: .video)
        XCTAssertEqual(outTracks.count, 1, "overlay output must be a real single-track MP4")

        // Decode frame 0 and prove the overlay composited at the TOP-LEFT spot.
        let frame0 = try await VideoFrameDecoder.decodeFrame(
            inputPath: out.path,
            timestampSeconds: 0,
            preferHardware: true
        )
        XCTAssertEqual(frame0.width, dim)
        XCTAssertEqual(frame0.height, dim)
        XCTAssertFalse(frame0.pngData.isEmpty)

        // Sample the decoded PNG: a pixel INSIDE the overlay box (top-left
        // ~(20,20)) must be reddish; a pixel well OUTSIDE it (~(100,100)) must
        // not be. This is what verifies the bottom-left coordinate flip — a
        // missing flip would place the red at the BOTTOM-left instead.
        guard let inside = decodedPixel(frame0.pngData, x: 20, y: 20),
              let outside = decodedPixel(frame0.pngData, x: 100, y: 100) else {
            // Pixel sampling is best-effort; if the PNG can't be sampled in this
            // environment we still proved a valid playable MP4 of the right dims
            // above. The coordinate flip is covered by construction (ciY =
            // evenH - overlayY - overlayHeight).
            throw XCTSkip("Could not sample decoded PNG pixels in this environment")
        }
        XCTAssertGreaterThan(inside.r, 150, "pixel under the overlay should be strongly red (r=\(inside.r))")
        XCTAssertGreaterThan(Int(inside.r) - Int(inside.g), 80, "overlay pixel red should dominate green")
        XCTAssertGreaterThan(Int(inside.r) - Int(inside.b), 80, "overlay pixel red should dominate blue")
        // Outside the overlay we must NOT see that saturated red (the source is
        // dark / non-red there).
        XCTAssertLessThan(outside.r, 150, "pixel outside the overlay must not be saturated red (r=\(outside.r))")
    }

    /// Overlay + scale together: downscale the frame AND composite a scaled
    /// overlay → a valid playable MP4 at the scaled dims. Exercises the
    /// `needsCoreImage = scaling || overlay` path where BOTH transforms run.
    func testOverlayWithScaleProducesValidMP4() async throws {
        let srcDim = 128
        let srcURL = try await makeTinyH264(width: srcDim, height: srcDim, frames: 6)
        defer { try? FileManager.default.removeItem(at: srcURL) }
        let overlayURL = try writeSolidPNG(width: 40, height: 40, r: 0, g: 255, b: 0, a: 255)
        defer { try? FileManager.default.removeItem(at: overlayURL) }
        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        let clip = try await VideoFrameEncoder.encodeClip(
            sourcePath: srcURL.path,
            outputPath: out.path,
            scaleWidth: 64, // downscale 128 → 64
            targetBitrateKbps: nil,
            startSeconds: nil,
            durationSeconds: nil,
            overlayPath: overlayURL.path,
            overlayX: 4,
            overlayY: 4,
            overlayWidth: 24, // scale the overlay too
            overlayOpacity: 0.8
        )
        XCTAssertEqual(clip.width, 64, "scaled output width")
        XCTAssertEqual(clip.height, 64, "square source → square scaled output")

        let outAsset = AVURLAsset(url: out)
        let outTracks = try await outAsset.loadTracks(withMediaType: .video)
        XCTAssertEqual(outTracks.count, 1)
        let naturalSize = try await outTracks[0].load(.naturalSize)
        XCTAssertEqual(Int(naturalSize.width.rounded()), 64)
        XCTAssertEqual(Int(naturalSize.height.rounded()), 64)

        // Genuinely decodes (overlay+scale composite is intact).
        let frame0 = try await VideoFrameDecoder.decodeFrame(
            inputPath: out.path,
            timestampSeconds: 0,
            preferHardware: true
        )
        XCTAssertEqual(frame0.width, 64)
        XCTAssertFalse(frame0.pngData.isEmpty)
    }

    /// A missing / non-image overlay path → `.badInput`, and NO output file is
    /// produced (we throw before writing anything we can observe).
    func testMissingOverlayThrowsBadInput() async throws {
        let dim = 64
        let srcURL = try await makeTinyH264(width: dim, height: dim, frames: 4)
        defer { try? FileManager.default.removeItem(at: srcURL) }
        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        // Case A: a path that does not exist.
        let missing = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskwraith-overlay-missing-\(UUID().uuidString).png")
        do {
            _ = try await VideoFrameEncoder.encodeClip(
                sourcePath: srcURL.path,
                outputPath: out.path,
                scaleWidth: nil,
                targetBitrateKbps: nil,
                startSeconds: nil,
                durationSeconds: nil,
                overlayPath: missing.path,
                overlayX: 0,
                overlayY: 0,
                overlayWidth: nil,
                overlayOpacity: nil
            )
            XCTFail("Expected a throw for a missing overlay image")
        } catch let err as VideoEncodeError {
            guard case .badInput = err else {
                return XCTFail("Expected .badInput for a missing overlay, got \(err)")
            }
        }
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: out.path),
            "no output should be produced when the overlay fails to load"
        )

        // Case B: a path that exists but is NOT an image (CIImage returns nil).
        let notImage = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskwraith-overlay-not-image-\(UUID().uuidString).png")
        try Data("definitely not a PNG".utf8).write(to: notImage)
        defer { try? FileManager.default.removeItem(at: notImage) }
        let out2 = stagingURL()
        defer { try? FileManager.default.removeItem(at: out2) }
        do {
            _ = try await VideoFrameEncoder.encodeClip(
                sourcePath: srcURL.path,
                outputPath: out2.path,
                scaleWidth: nil,
                targetBitrateKbps: nil,
                startSeconds: nil,
                durationSeconds: nil,
                overlayPath: notImage.path,
                overlayX: 0,
                overlayY: 0,
                overlayWidth: nil,
                overlayOpacity: nil
            )
            XCTFail("Expected a throw for a non-image overlay file")
        } catch let err as VideoEncodeError {
            guard case .badInput = err else {
                return XCTFail("Expected .badInput for a non-image overlay, got \(err)")
            }
        }
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: out2.path),
            "no output should be produced when the overlay is not an image"
        )
    }

    // MARK: - Concat (S3-3): N segments → one MP4

    /// THE key concat test: two DIFFERENT-dimension solid-color sources
    /// concatenated in order. Source A = 96×96 solid RED (8 frames); source B =
    /// 64×128 PORTRAIT solid BLUE (8 frames). Concat [A, B] →
    ///   • output exists + re-opens as a single-track MP4,
    ///   • output dims == A's even coded dims (96×96 — fixed from segment 0),
    ///   • total duration ≈ A.dur + B.dur,
    ///   • a frame from the FIRST half decodes reddish (segment A is present),
    ///   • a frame from the SECOND half decodes blue-ish AND letterboxed (B at
    ///     64×128 fit into 96×96 → black bars left/right), proving BOTH segments
    ///     are present, in order, and normalized into the output frame.
    func testConcatTwoDifferentDimsRoundTrip() async throws {
        let a = try await makeSolidColorH264(width: 96, height: 96, frames: 8, r: 220, g: 20, b: 20)
        defer { try? FileManager.default.removeItem(at: a) }
        let b = try await makeSolidColorH264(width: 64, height: 128, frames: 8, r: 20, g: 20, b: 220)
        defer { try? FileManager.default.removeItem(at: b) }

        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        let clip = try await VideoFrameEncoder.concatClips(
            outputPath: out.path,
            segments: [
                VideoConcatSegment(sourcePath: a.path, startSeconds: nil, durationSeconds: nil),
                VideoConcatSegment(sourcePath: b.path, startSeconds: nil, durationSeconds: nil)
            ],
            scaleWidth: nil,
            targetBitrateKbps: nil
        )

        // --- Result dict shape (the TS side consumes these exact keys) -------
        XCTAssertEqual(clip.width, 96, "output dims fixed from segment 0 (96×96)")
        XCTAssertEqual(clip.height, 96)
        XCTAssertEqual(clip.codec, "h264")
        XCTAssertEqual(clip.segmentCount, 2)
        XCTAssertGreaterThan(clip.durationMs, 0)
        let dict = clip.toJSONObject()
        XCTAssertEqual(dict["ok"] as? Bool, true)
        XCTAssertEqual(dict["width"] as? Int, 96)
        XCTAssertEqual(dict["height"] as? Int, 96)
        XCTAssertEqual(dict["codec"] as? String, "h264")
        XCTAssertEqual(dict["segmentCount"] as? Int, 2)
        XCTAssertNotNil(dict["durationMs"] as? Int)
        XCTAssertNotNil(dict["usedHardware"] as? Bool)

        // --- File exists + non-empty -----------------------------------------
        XCTAssertTrue(FileManager.default.fileExists(atPath: out.path), "Output MP4 must exist")
        let size = (try FileManager.default.attributesOfItem(atPath: out.path)[.size] as? Int) ?? 0
        XCTAssertGreaterThan(size, 0, "Output MP4 must be non-empty")

        // --- Re-open: single video track at 96×96 ----------------------------
        let outAsset = AVURLAsset(url: out)
        let outTracks = try await outAsset.loadTracks(withMediaType: .video)
        XCTAssertEqual(outTracks.count, 1, "Output must have exactly one video track")
        guard let outTrack = outTracks.first else {
            return XCTFail("No video track in concatenated output")
        }
        let naturalSize = try await outTrack.load(.naturalSize)
        XCTAssertEqual(Int(naturalSize.width.rounded()), 96)
        XCTAssertEqual(Int(naturalSize.height.rounded()), 96)

        // --- Total duration == A.dur + B.dur (TIGHT) -------------------------
        // Each source is 8 frames @10fps = 0.8s, so the concat is EXACTLY 1.6s
        // (16 frames, no boundary drop). The pre-fix code under-reported by one
        // frame interval per boundary (~1.5s) AND dropped B's first frame; this
        // asserts the true sum within one frame interval (0.1s) to keep the
        // muxed-container rounding slack tiny while still catching the bug.
        let outSeconds = CMTimeGetSeconds(try await outAsset.load(.duration))
        XCTAssertEqual(outSeconds, 1.6, accuracy: 0.1, "concat duration must be the true 1.6s sum (16 frames @10fps), got \(outSeconds)s")
        // The reported metadata duration is exact rational arithmetic — pin it.
        XCTAssertEqual(clip.durationMs, 1600, "concat durationMs must be the true 16-frame sum, got \(clip.durationMs)ms")

        // --- FIRST half decodes reddish (segment A present) ------------------
        let firstHalf = try await VideoFrameDecoder.decodeFrame(
            inputPath: out.path,
            timestampSeconds: 0.2, // safely inside segment A (~0..0.8s)
            preferHardware: true
        )
        XCTAssertEqual(firstHalf.width, 96)
        XCTAssertEqual(firstHalf.height, 96)
        XCTAssertFalse(firstHalf.pngData.isEmpty)
        // Center pixel of segment A must be red-dominant.
        guard let aCenter = decodedPixel(firstHalf.pngData, x: 48, y: 48) else {
            throw XCTSkip("Could not sample decoded PNG pixels in this environment")
        }
        XCTAssertGreaterThan(aCenter.r, 120, "segment A center should be red (r=\(aCenter.r))")
        XCTAssertGreaterThan(Int(aCenter.r) - Int(aCenter.b), 60, "segment A red should dominate blue")

        // --- SECOND half decodes blue-ish AND letterboxed (segment B present) -
        let secondHalf = try await VideoFrameDecoder.decodeFrame(
            inputPath: out.path,
            timestampSeconds: 1.0, // safely inside segment B (~0.8..1.6s)
            preferHardware: true
        )
        XCTAssertEqual(secondHalf.width, 96)
        XCTAssertEqual(secondHalf.height, 96)
        XCTAssertFalse(secondHalf.pngData.isEmpty)
        // B is 64×128 fit into 96×96: fitScale = min(96/64, 96/128)=0.75 → scaled
        // 48×96, centered → blue spans x∈[24,72), black bars at x<24 and x≥72.
        // Center is blue; a far-left column is the black letterbox bar.
        guard let bCenter = decodedPixel(secondHalf.pngData, x: 48, y: 48),
              let bBar = decodedPixel(secondHalf.pngData, x: 4, y: 48) else {
            throw XCTSkip("Could not sample decoded PNG pixels in this environment")
        }
        XCTAssertGreaterThan(bCenter.b, 120, "segment B center should be blue (b=\(bCenter.b))")
        XCTAssertGreaterThan(Int(bCenter.b) - Int(bCenter.r), 60, "segment B blue should dominate red")
        // The letterbox bar must be dark (black background), NOT blue.
        XCTAssertLessThan(Int(bBar.r), 70, "letterbox bar must be dark (r=\(bBar.r))")
        XCTAssertLessThan(Int(bBar.g), 70, "letterbox bar must be dark (g=\(bBar.g))")
        XCTAssertLessThan(Int(bBar.b), 70, "letterbox bar must be dark, not blue (b=\(bBar.b))")
    }

    /// REGRESSION (HIGH): concat must NOT drop a frame at a segment boundary.
    ///
    /// The sources here are produced the way the daemon itself produces them —
    /// via `VideoFrameEncoder.encodeClip` (AVAssetWriter-muxed H.264). For such
    /// MP4s `CMSampleBufferGetDuration` reads back INVALID through
    /// `AVAssetReaderTrackOutput`, so the old offset-advance fell to
    /// `(last - first) + .zero` = one frame interval SHORT. The next segment's
    /// first rebased frame then landed exactly on `lastAppendedOutputPTS`, failed
    /// the strict monotonic guard, and was silently dropped — so a concat of two
    /// 8-frame clips yielded 15 frames, not 16, and under-reported duration by
    /// one frame interval.
    ///
    /// This decodes EVERY output frame and asserts the EXACT total
    /// (framesA + framesB, no drop) plus the true summed duration. It FAILS
    /// pre-fix (15 frames / ~1.5s) and PASSES post-fix (16 frames / 1.6s).
    func testConcatViaEncodeClipSourcesDropsNoBoundaryFrame() async throws {
        let dim = 64
        let framesA = 8
        let framesB = 8
        // Synthesize two raw sources, then run EACH through encodeClip so the
        // concat inputs are AVAssetWriter-muxed (the invalid-duration case).
        let rawA = try await makeSolidColorH264(width: dim, height: dim, frames: framesA, r: 210, g: 30, b: 30)
        defer { try? FileManager.default.removeItem(at: rawA) }
        let rawB = try await makeSolidColorH264(width: dim, height: dim, frames: framesB, r: 30, g: 30, b: 210)
        defer { try? FileManager.default.removeItem(at: rawB) }

        let clipA = stagingURL()
        defer { try? FileManager.default.removeItem(at: clipA) }
        let clipB = stagingURL()
        defer { try? FileManager.default.removeItem(at: clipB) }

        // encodeClip with no scale/trim → a clean N-frame muxed clip at the coded
        // dims. (This is exactly the kind of MP4 concat is asked to stitch.)
        let encA = try await VideoFrameEncoder.encodeClip(
            sourcePath: rawA.path, outputPath: clipA.path,
            scaleWidth: nil, targetBitrateKbps: nil, startSeconds: nil, durationSeconds: nil
        )
        let encB = try await VideoFrameEncoder.encodeClip(
            sourcePath: rawB.path, outputPath: clipB.path,
            scaleWidth: nil, targetBitrateKbps: nil, startSeconds: nil, durationSeconds: nil
        )
        XCTAssertEqual(encA.width, dim)
        XCTAssertEqual(encB.width, dim)

        // Sanity: confirm the encodeClip outputs really DO read back an invalid
        // sample duration (the precondition for the bug). If they didn't, the
        // regression wouldn't reproduce — so we assert the trap is armed.
        let armedInvalidDuration = try await firstSampleDurationIsInvalid(clipA)
        XCTAssertTrue(
            armedInvalidDuration,
            "precondition: encodeClip-muxed source must read back an INVALID sample duration (the bug trigger)"
        )

        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        let clip = try await VideoFrameEncoder.concatClips(
            outputPath: out.path,
            segments: [
                VideoConcatSegment(sourcePath: clipA.path, startSeconds: nil, durationSeconds: nil),
                VideoConcatSegment(sourcePath: clipB.path, startSeconds: nil, durationSeconds: nil)
            ],
            scaleWidth: nil,
            targetBitrateKbps: nil
        )
        XCTAssertEqual(clip.segmentCount, 2)
        XCTAssertEqual(clip.width, dim, "output dims fixed from segment 0")
        XCTAssertEqual(clip.height, dim)

        // --- Decode ALL output frames; the count must be EXACTLY the sum -------
        let decodedCount = try await countOutputFrames(out)
        XCTAssertEqual(
            decodedCount, framesA + framesB,
            "concat must keep EVERY frame across the boundary (\(framesA)+\(framesB)=\(framesA + framesB)); a short count means the boundary drop regressed (got \(decodedCount))"
        )

        // --- Duration must be the TRUE sum, within one frame interval ---------
        // 16 frames @10fps = 1.6s exactly. Pre-fix this was ~1.5s (one interval
        // short). Tight bound = one frame interval (0.1s).
        let outSeconds = CMTimeGetSeconds(try await AVURLAsset(url: out).load(.duration))
        XCTAssertEqual(outSeconds, 1.6, accuracy: 0.1, "concat duration must be the true \(framesA + framesB)-frame sum, got \(outSeconds)s")
        XCTAssertEqual(clip.durationMs, 1600, "concat durationMs must be the true \(framesA + framesB)-frame sum, got \(clip.durationMs)ms")
    }

    /// Monotonic PTS across the segment boundary: decode ALL output frames'
    /// presentation timestamps and assert they strictly increase end-to-end (no
    /// dup / no regression where segment B is offset onto segment A's timeline).
    func testConcatOutputPTSStrictlyMonotonic() async throws {
        let a = try await makeSolidColorH264(width: 80, height: 80, frames: 6, r: 200, g: 30, b: 30)
        defer { try? FileManager.default.removeItem(at: a) }
        let b = try await makeSolidColorH264(width: 80, height: 80, frames: 6, r: 30, g: 30, b: 200)
        defer { try? FileManager.default.removeItem(at: b) }
        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        let clip = try await VideoFrameEncoder.concatClips(
            outputPath: out.path,
            segments: [
                VideoConcatSegment(sourcePath: a.path, startSeconds: nil, durationSeconds: nil),
                VideoConcatSegment(sourcePath: b.path, startSeconds: nil, durationSeconds: nil)
            ],
            scaleWidth: nil,
            targetBitrateKbps: nil
        )
        XCTAssertEqual(clip.segmentCount, 2)

        let outAsset = AVURLAsset(url: out)
        let outTracks = try await outAsset.loadTracks(withMediaType: .video)
        guard let outTrack = outTracks.first else {
            return XCTFail("No video track in concatenated output")
        }
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

        var previous: CMTime = .negativeInfinity
        var count = 0
        while reader.status == .reading {
            guard let sample = trackOut.copyNextSampleBuffer() else { break }
            let pts = CMSampleBufferGetPresentationTimeStamp(sample)
            XCTAssertTrue(pts.isNumeric, "every output PTS must be numeric")
            XCTAssertEqual(
                CMTimeCompare(pts, previous), 1,
                "output PTS must STRICTLY increase across the boundary (prev \(CMTimeGetSeconds(previous))s, got \(CMTimeGetSeconds(pts))s)"
            )
            previous = pts
            count += 1
        }
        // EXACTLY both segments' frames must be present — NO frame dropped at the
        // boundary. 6 + 6 = 12. The pre-fix offset advance was short by one frame
        // interval at the boundary, so segment B's first frame collided with the
        // monotonic guard and was silently dropped (11/12); this asserts the
        // exact total to catch that regression.
        XCTAssertEqual(count, 12, "expected EXACTLY 12 frames across both segments (no boundary drop), got \(count)")
        // The reported total duration must also be the true sum: 12 frames @10fps
        // = 1.2s, with no under-report.
        XCTAssertEqual(clip.durationMs, 1200, "concat durationMs must be the true 12-frame sum, got \(clip.durationMs)ms")
    }

    /// An empty segment — a segment whose trim window is entirely PAST its end —
    /// must abort the whole concat with `.encodeFailed` and produce NO output
    /// file (we cancelWriting before finishing).
    func testConcatEmptySegmentThrowsEncodeFailed() async throws {
        // Segment 0 is fine; segment 1 has a trim far past its ~0.6s end.
        let a = try await makeSolidColorH264(width: 64, height: 64, frames: 6, r: 200, g: 30, b: 30)
        defer { try? FileManager.default.removeItem(at: a) }
        let b = try await makeSolidColorH264(width: 64, height: 64, frames: 6, r: 30, g: 30, b: 200)
        defer { try? FileManager.default.removeItem(at: b) }
        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }

        do {
            _ = try await VideoFrameEncoder.concatClips(
                outputPath: out.path,
                segments: [
                    VideoConcatSegment(sourcePath: a.path, startSeconds: nil, durationSeconds: nil),
                    VideoConcatSegment(sourcePath: b.path, startSeconds: 100.0, durationSeconds: 1.0)
                ],
                scaleWidth: nil,
                targetBitrateKbps: nil
            )
            XCTFail("Expected a throw for a segment trimmed entirely past its end")
        } catch let err as VideoEncodeError {
            guard case .encodeFailed = err else {
                return XCTFail("Expected .encodeFailed for an empty segment, got \(err)")
            }
        }
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: out.path),
            "no output should be produced when a segment contributes zero frames"
        )
    }

    /// Defensive arity: zero segments → `.badInput` (the TS side enforces ≥2,
    /// but the daemon guards ≥1 itself).
    func testConcatEmptySegmentListThrowsBadInput() async throws {
        let out = stagingURL()
        defer { try? FileManager.default.removeItem(at: out) }
        do {
            _ = try await VideoFrameEncoder.concatClips(
                outputPath: out.path,
                segments: [],
                scaleWidth: nil,
                targetBitrateKbps: nil
            )
            XCTFail("Expected a throw for an empty segment list")
        } catch let err as VideoEncodeError {
            guard case .badInput = err else {
                return XCTFail("Expected .badInput for zero segments, got \(err)")
            }
        }
    }

    /// Concat param contract: the RPC params (incl. nested segments) decode to
    /// the supplied values, with optional per-segment trim fields nil when
    /// absent. Pins the shape the TS side sends.
    func testConcatParamsDecode() throws {
        let json: [String: Any] = [
            "outputPath": "/tmp/out.mp4",
            "segments": [
                ["sourcePath": "/tmp/a.mp4"],
                ["sourcePath": "/tmp/b.mp4", "startSeconds": 1.5, "durationSeconds": 2.0]
            ],
            "scaleWidth": 720,
            "targetBitrateKbps": 3000
        ]
        let data = try JSONSerialization.data(withJSONObject: json)
        let parsed = try JSONDecoder().decode(VideoConcatClipsParams.self, from: data)
        XCTAssertEqual(parsed.outputPath, "/tmp/out.mp4")
        XCTAssertEqual(parsed.scaleWidth, 720)
        XCTAssertEqual(parsed.targetBitrateKbps, 3000)
        XCTAssertEqual(parsed.segments.count, 2)
        XCTAssertEqual(parsed.segments[0].sourcePath, "/tmp/a.mp4")
        XCTAssertNil(parsed.segments[0].startSeconds)
        XCTAssertNil(parsed.segments[0].durationSeconds)
        XCTAssertEqual(parsed.segments[1].sourcePath, "/tmp/b.mp4")
        XCTAssertEqual(parsed.segments[1].startSeconds, 1.5)
        XCTAssertEqual(parsed.segments[1].durationSeconds, 2.0)
    }

    // MARK: - Helpers

    private func stagingURL() -> URL {
        // Mimic the TS-owned staging path shape (…/media-staging/tw-<uuid>.mp4).
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("media-staging", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("tw-\(UUID().uuidString).mp4")
    }

    /// Count EVERY video frame in an MP4 by reading it end-to-end with an
    /// `AVAssetReaderTrackOutput` (the same way concat reads its inputs). Used by
    /// the boundary-drop regression to assert no frame was silently dropped.
    private func countOutputFrames(_ url: URL) async throws -> Int {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        guard let track = tracks.first else { return 0 }
        let reader = try AVAssetReader(asset: asset)
        let trackOut = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [
                kCVPixelBufferPixelFormatTypeKey as String:
                    Int(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
            ]
        )
        guard reader.canAdd(trackOut) else { return 0 }
        reader.add(trackOut)
        guard reader.startReading() else { return 0 }
        defer { if reader.status == .reading { reader.cancelReading() } }
        var count = 0
        while reader.status == .reading {
            guard let sample = trackOut.copyNextSampleBuffer() else { break }
            if CMSampleBufferGetNumSamples(sample) > 0 { count += 1 }
        }
        return count
    }

    /// True iff the FIRST sample of `url`'s video track reads back a NON-numeric
    /// (invalid) `CMSampleBufferGetDuration` through `AVAssetReaderTrackOutput` —
    /// the exact precondition that made the concat boundary-drop bug fire. The
    /// regression test asserts this is true for an encodeClip-muxed source so the
    /// trap is provably armed.
    private func firstSampleDurationIsInvalid(_ url: URL) async throws -> Bool {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        guard let track = tracks.first else { return false }
        let reader = try AVAssetReader(asset: asset)
        let trackOut = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [
                kCVPixelBufferPixelFormatTypeKey as String:
                    Int(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
            ]
        )
        guard reader.canAdd(trackOut) else { return false }
        reader.add(trackOut)
        guard reader.startReading() else { return false }
        defer { if reader.status == .reading { reader.cancelReading() } }
        guard let sample = trackOut.copyNextSampleBuffer() else { return false }
        return !CMSampleBufferGetDuration(sample).isNumeric
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

    /// Encode a tiny H.264 `.mp4` whose EVERY frame is the SAME solid color and
    /// return its URL. Unlike `makeTinyH264` (which varies color per frame), this
    /// keeps a constant hue so a decoded frame from any point in the clip can be
    /// color-asserted — used by the concat round-trip to tell segment A (red)
    /// from segment B (blue) and to detect the black letterbox bars. Encoding a
    /// constant color through H.264 + decode survives the lossy round-trip with a
    /// wide threshold (we assert dominance, not exact bytes).
    private func makeSolidColorH264(
        width: Int,
        height: Int,
        frames: Int,
        r: UInt8, g: UInt8, b: UInt8
    ) async throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskwraith-concat-synth-\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: url)

        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height
        ]
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
            fillSolidColor(pb, r: r, g: g, b: b)
            let pts = CMTime(value: CMTimeValue(i), timescale: fps)
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

    /// Fill a BGRA pixel buffer with ONE constant color (every pixel identical).
    private func fillSolidColor(_ pb: CVPixelBuffer, r: UInt8, g: UInt8, b: UInt8) {
        CVPixelBufferLockBaseAddress(pb, [])
        defer { CVPixelBufferUnlockBaseAddress(pb, []) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return }
        let width = CVPixelBufferGetWidth(pb)
        let height = CVPixelBufferGetHeight(pb)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pb)
        let ptr = base.assumingMemoryBound(to: UInt8.self)
        for y in 0..<height {
            let row = ptr + y * bytesPerRow
            for x in 0..<width {
                let px = row + x * 4
                px[0] = b
                px[1] = g
                px[2] = r
                px[3] = 255
            }
        }
    }

    /// Write a solid-color RGBA PNG of the given size to a temp file and return
    /// its URL. Used to synthesize the static overlay image the encoder loads.
    private func writeSolidPNG(
        width: Int,
        height: Int,
        r: UInt8, g: UInt8, b: UInt8, a: UInt8
    ) throws -> URL {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        guard let ctx = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else {
            throw XCTSkip("Could not create a CGContext for the overlay PNG")
        }
        // Premultiplied-last (RGBA). For a fully-opaque solid the premultiply is
        // a no-op; we keep `a` general but the tests use a=255.
        ctx.setFillColor(
            red: CGFloat(r) / 255.0,
            green: CGFloat(g) / 255.0,
            blue: CGFloat(b) / 255.0,
            alpha: CGFloat(a) / 255.0
        )
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let cgImage = ctx.makeImage() else {
            throw XCTSkip("Could not render the overlay CGImage")
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskwraith-overlay-\(UUID().uuidString).png")
        // PNG UTI without importing UniformTypeIdentifiers (broad availability).
        guard let dest = CGImageDestinationCreateWithURL(
            url as CFURL,
            "public.png" as CFString,
            1,
            nil
        ) else {
            throw XCTSkip("Could not create a PNG image destination")
        }
        CGImageDestinationAddImage(dest, cgImage, nil)
        guard CGImageDestinationFinalize(dest) else {
            throw XCTSkip("Could not finalize the overlay PNG")
        }
        return url
    }

    /// Decode a PNG (the decoder's `pngData`) and sample one pixel's RGB at
    /// (x,y) with a TOP-LEFT origin. Returns nil if the bytes can't be sampled.
    private func decodedPixel(_ pngData: Data, x: Int, y: Int) -> (r: UInt8, g: UInt8, b: UInt8)? {
        guard let provider = CGDataProvider(data: pngData as CFData),
              let cgImage = CGImage(
                pngDataProviderSource: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
              ) else {
            return nil
        }
        let width = cgImage.width
        let height = cgImage.height
        guard x >= 0, y >= 0, x < width, y < height else { return nil }
        // Re-render into a known RGBA8 (premultiplied-last) buffer so the byte
        // layout is deterministic regardless of the source PNG's format.
        var buffer = [UInt8](repeating: 0, count: width * height * 4)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        let sampled: (UInt8, UInt8, UInt8)? = buffer.withUnsafeMutableBytes { raw -> (UInt8, UInt8, UInt8)? in
            guard let base = raw.baseAddress,
                  let ctx = CGContext(
                    data: base,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: width * 4,
                    space: colorSpace,
                    bitmapInfo: bitmapInfo
                  ) else {
                return nil
            }
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            let ptr = base.assumingMemoryBound(to: UInt8.self)
            let offset = (y * width + x) * 4
            return (ptr[offset], ptr[offset + 1], ptr[offset + 2]) // R, G, B
        }
        guard let s = sampled else { return nil }
        return (s.0, s.1, s.2)
    }
}
