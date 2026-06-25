import XCTest
import AVFoundation
import CoreMedia
import CoreVideo
import CoreGraphics
@testable import TaskWraithBridgeDaemon

/// Tests for the native VideoToolbox single-frame decoder.
///
/// The headline test synthesizes a tiny H.264 `.mp4` with `AVAssetWriter`
/// (NO ffmpeg) and round-trips it through the full
/// `AVAssetReader -> VTDecompressionSession -> CGImage -> PNG` pipeline, proving
/// the real VT machinery in CI. The remaining tests pin the error / param
/// contract that the TS side relies on.
final class VideoFrameDecoderTests: XCTestCase {

    // MARK: - Error paths

    func testNonexistentPathThrowsBadInput() async throws {
        let missing = "/tmp/taskwraith-does-not-exist-\(UUID().uuidString).mp4"
        do {
            _ = try await VideoFrameDecoder.decodeFrame(
                inputPath: missing,
                timestampSeconds: 0,
                preferHardware: true
            )
            XCTFail("Expected a throw for a nonexistent path")
        } catch let err as VideoFrameDecodeError {
            guard case .badInput = err else {
                return XCTFail("Expected .badInput, got \(err)")
            }
        }
    }

    func testNonVideoFileThrows() async throws {
        // A tiny text file has no video track — must throw (badInput in
        // practice, since track loading yields zero video tracks; we accept any
        // VideoFrameDecodeError to stay robust to AVFoundation's read-time
        // failure mode for garbage containers).
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskwraith-not-a-video-\(UUID().uuidString).txt")
        try Data("this is definitely not a video".utf8).write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }

        do {
            _ = try await VideoFrameDecoder.decodeFrame(
                inputPath: tmp.path,
                timestampSeconds: 0,
                preferHardware: true
            )
            XCTFail("Expected a throw for a non-video file")
        } catch is VideoFrameDecodeError {
            // expected
        }
    }

    // MARK: - Param defaults (decode shape the RPC layer uses)

    func testParamDefaultsDecode() throws {
        // Only inputPath supplied — timestampSeconds / preferHardware optional.
        let json: [String: Any] = ["inputPath": "/tmp/x.mp4"]
        let data = try JSONSerialization.data(withJSONObject: json)
        let parsed = try JSONDecoder().decode(VideoDecodeFrameParams.self, from: data)
        XCTAssertEqual(parsed.inputPath, "/tmp/x.mp4")
        XCTAssertNil(parsed.timestampSeconds)
        XCTAssertNil(parsed.preferHardware)
    }

    func testParamsFullyPopulatedDecode() throws {
        let json: [String: Any] = [
            "inputPath": "/tmp/y.mov",
            "timestampSeconds": 1.5,
            "preferHardware": false
        ]
        let data = try JSONSerialization.data(withJSONObject: json)
        let parsed = try JSONDecoder().decode(VideoDecodeFrameParams.self, from: data)
        XCTAssertEqual(parsed.inputPath, "/tmp/y.mov")
        XCTAssertEqual(parsed.timestampSeconds, 1.5)
        XCTAssertEqual(parsed.preferHardware, false)
    }

    // MARK: - Real round-trip

    func testDecodesSynthesizedH264Frame() async throws {
        let dim = 64
        let url = try await makeTinyH264(width: dim, height: dim, frames: 4)
        defer { try? FileManager.default.removeItem(at: url) }

        let frame = try await VideoFrameDecoder.decodeFrame(
            inputPath: url.path,
            timestampSeconds: 0,
            preferHardware: true
        )

        XCTAssertFalse(frame.pngData.isEmpty, "PNG payload should be non-empty")
        XCTAssertEqual(frame.width, dim)
        XCTAssertEqual(frame.height, dim)
        XCTAssertGreaterThanOrEqual(frame.timestampSeconds, 0)
        // usedHardware is a Bool either way; just assert it's reachable.
        XCTAssertTrue(frame.usedHardware == true || frame.usedHardware == false)
        XCTAssertEqual(frame.codec, "h264")

        // Valid PNG header: \x89 P N G
        let header: [UInt8] = Array(frame.pngData.prefix(4))
        XCTAssertEqual(header, [0x89, 0x50, 0x4E, 0x47], "PNG magic bytes mismatch")

        // The decoded PNG should also re-decode to a CGImage of the right size.
        let src = CGImageSourceCreateWithData(frame.pngData as CFData, nil)
        XCTAssertNotNil(src)
        if let src, let img = CGImageSourceCreateImageAtIndex(src, 0, nil) {
            XCTAssertEqual(img.width, dim)
            XCTAssertEqual(img.height, dim)
        } else {
            XCTFail("Decoded PNG did not re-open as a CGImage")
        }

        let dict = frame.toJSONObject()
        XCTAssertEqual(dict["ok"] as? Bool, true)
        XCTAssertNotNil(dict["pngBase64"] as? String)
        XCTAssertEqual(dict["width"] as? Int, dim)
        XCTAssertEqual(dict["height"] as? Int, dim)
        XCTAssertEqual(dict["codec"] as? String, "h264")
        XCTAssertNotNil(dict["usedHardware"] as? Bool)
        XCTAssertNotNil(dict["timestampSeconds"] as? Double)
    }

    func testDecodesFrameAtLaterTimestamp() async throws {
        let dim = 64
        // 10 frames @ 10fps => ~1s of video; ask for ~0.5s in.
        let url = try await makeTinyH264(width: dim, height: dim, frames: 10)
        defer { try? FileManager.default.removeItem(at: url) }

        let frame = try await VideoFrameDecoder.decodeFrame(
            inputPath: url.path,
            timestampSeconds: 0.5,
            preferHardware: true
        )
        XCTAssertFalse(frame.pngData.isEmpty)
        XCTAssertEqual(frame.width, dim)
        // The returned frame's PTS should be at/after the requested seek (within
        // a GOP tolerance — we return the first frame >= target).
        XCTAssertGreaterThanOrEqual(frame.timestampSeconds, 0.4)
    }

    /// Exercises the FULL-DRAIN selection path deterministically: a multi-frame
    /// clip decoded at a mid-stream timestamp must return the EARLIEST frame
    /// whose PTS >= target — not merely *a* frame at/after it. Frames are laid
    /// out at i/fps (fps=10) => PTS 0.0, 0.1, … 0.9. Targeting 0.45s, the only
    /// correct answer is frame 5 at 0.5s.
    ///
    /// With an all-keyframe synthesizer DTS == PTS so delivery order already
    /// matches display order; this test pins that the chosen frame is the
    /// smallest-PTS-≥-target after a complete drain of the window. The B-frame /
    /// reordered-stream guarantee (a later-PTS frame delivered first must NOT be
    /// returned over a not-yet-delivered earlier-PTS frame) now holds BY
    /// CONSTRUCTION — the decoder drains every sample and picks in `best()`
    /// rather than breaking on first delivery — which a tiny synthetic clip
    /// can't force the encoder to emit B-frames for.
    func testFullDrainReturnsEarliestFrameAtOrAfterTarget() async throws {
        let dim = 64
        let fps = 10.0
        // 10 frames @ 10fps => PTS 0.0 … 0.9.
        let url = try await makeTinyH264(width: dim, height: dim, frames: 10)
        defer { try? FileManager.default.removeItem(at: url) }

        // Target lands strictly between frame 4 (0.4s) and frame 5 (0.5s).
        let target = 0.45
        let frame = try await VideoFrameDecoder.decodeFrame(
            inputPath: url.path,
            timestampSeconds: target,
            preferHardware: true
        )

        XCTAssertFalse(frame.pngData.isEmpty)
        XCTAssertEqual(frame.width, dim)

        // Must be at/after the target …
        XCTAssertGreaterThanOrEqual(
            frame.timestampSeconds, target - 1e-6,
            "full drain must return a frame at/after the target"
        )
        // … and must be the EARLIEST such frame — i.e. frame 5 (~0.5s), NOT a
        // later display frame inside the same window. Allow half a frame of
        // slack for timescale rounding.
        let halfFrame = (1.0 / fps) / 2.0
        XCTAssertLessThan(
            frame.timestampSeconds, 0.5 + halfFrame,
            "full drain must return the SMALLEST PTS >= target (frame 5 ~0.5s), not a later frame"
        )
    }

    /// Out-of-range (and absurdly huge finite) timestamps must NOT crash or
    /// throw — they clamp to a finite bound and gracefully return the last
    /// decodable frame (the latest-overall fallback). Guards the FIX-2 clamp:
    /// a raw `1e308` target would otherwise build a non-numeric CMTime and fail
    /// `startReading`.
    func testHugeFiniteTimestampClampsAndReturnsLastFrame() async throws {
        let dim = 64
        let frames = 6
        // PTS 0.0 … 0.5 at 10fps.
        let url = try await makeTinyH264(width: dim, height: dim, frames: frames)
        defer { try? FileManager.default.removeItem(at: url) }

        // 1e308 is finite (so the MCP layer would pass it) but collapses to a
        // non-numeric CMTime if fed straight into CMTime(seconds:).
        let frame = try await VideoFrameDecoder.decodeFrame(
            inputPath: url.path,
            timestampSeconds: 1e308,
            preferHardware: true
        )

        XCTAssertFalse(frame.pngData.isEmpty, "huge timestamp should still yield a frame")
        XCTAssertEqual(frame.width, dim)
        XCTAssertGreaterThanOrEqual(frame.timestampSeconds, 0)
        // It should be a real frame from the clip (PTS <= last frame's ~0.5s),
        // i.e. the graceful last-frame fallback — never a bogus huge PTS.
        XCTAssertLessThan(frame.timestampSeconds, 1.0)
    }

    func testSoftwarePathDecodes() async throws {
        let dim = 64
        let url = try await makeTinyH264(width: dim, height: dim, frames: 4)
        defer { try? FileManager.default.removeItem(at: url) }

        let frame = try await VideoFrameDecoder.decodeFrame(
            inputPath: url.path,
            timestampSeconds: 0,
            preferHardware: false
        )
        XCTAssertFalse(frame.usedHardware, "preferHardware:false must report software")
        XCTAssertFalse(frame.pngData.isEmpty)
        XCTAssertEqual(frame.width, dim)
    }

    // MARK: - Synthesizer (AVAssetWriter, no ffmpeg)

    /// Encode a tiny solid-color H.264 `.mp4` and return its URL. Each frame is
    /// a distinct solid color so the encoder has real (if trivial) content.
    private func makeTinyH264(width: Int, height: Int, frames: Int) async throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskwraith-synth-\(UUID().uuidString).mp4")
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
            // Spin until the input is ready for more data (synthetic content is
            // tiny so this resolves immediately, but the contract requires it).
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

    /// Fill a BGRA pixel buffer with a solid color that varies per frame.
    private func fillSolid(_ pb: CVPixelBuffer, frameIndex: Int, total: Int) {
        CVPixelBufferLockBaseAddress(pb, [])
        defer { CVPixelBufferUnlockBaseAddress(pb, []) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return }
        let width = CVPixelBufferGetWidth(pb)
        let height = CVPixelBufferGetHeight(pb)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pb)

        // Ramp the channels so successive frames differ (encoder gets real deltas).
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
                // 32BGRA byte order in memory: B, G, R, A
                px[0] = b
                px[1] = g
                px[2] = r
                px[3] = a
            }
        }
    }
}
