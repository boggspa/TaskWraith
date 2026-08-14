import AVFoundation
import CoreMedia
import CoreVideo
import VideoToolbox
import XCTest

@testable import TaskWraithStudioCore

/// Shared media fixtures for the Studio video tests.
///
/// Frames are ENCODED with a real VTCompressionSession rather than loaded from a
/// checked-in binary, so every decode test exercises a genuine compressed sample
/// carrying a real CMVideoFormatDescription (real SPS/PPS).
///
/// The CPU writes below are fixture construction — synthesising a source frame —
/// which is the opposite of the banked AVCDAW do-not-repeat note about
/// CPU-visible access on the PRESENTATION path. No production Studio code locks
/// a pixel-buffer base address.
enum StudioTestMedia {
    static let defaultWidth = 128
    static let defaultHeight = 128

    /// A flat full-range bi-planar frame: constant luma, neutral chroma.
    static func flatPixelBuffer(
        luma: UInt8,
        width: Int = defaultWidth,
        height: Int = defaultHeight
    ) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            [
                kCVPixelBufferMetalCompatibilityKey: true,
                kCVPixelBufferIOSurfacePropertiesKey: [CFString: Any]() as CFDictionary,
            ] as CFDictionary,
            &buffer
        )
        let pixelBuffer = try XCTUnwrap(buffer, "CVPixelBufferCreate failed: \(status)")

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        if let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) {
            let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
            let pointer = base.assumingMemoryBound(to: UInt8.self)
            for y in 0..<CVPixelBufferGetHeightOfPlane(pixelBuffer, 0) {
                for x in 0..<CVPixelBufferGetWidthOfPlane(pixelBuffer, 0) {
                    pointer[y * stride + x] = luma
                }
            }
        }
        // NV12: plane 1 interleaves Cb and Cr at half resolution.
        if let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) {
            let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)
            let pointer = base.assumingMemoryBound(to: UInt8.self)
            for y in 0..<CVPixelBufferGetHeightOfPlane(pixelBuffer, 1) {
                for x in 0..<CVPixelBufferGetWidthOfPlane(pixelBuffer, 1) {
                    pointer[y * stride + x * 2] = 128
                    pointer[y * stride + x * 2 + 1] = 128
                }
            }
        }
        return pixelBuffer
    }

    /// A moving-content frame: a bright bar sweeping right, a dark block
    /// sweeping down, and a checker patch that flips phase every frame, over a
    /// mid-gray field. The flat fixtures cannot see temporal corruption — a
    /// stale reference frame leaves the same flat luma — while a stale
    /// reference here leaves visible trails of these shapes.
    static func movingPixelBuffer(
        frameIndex: Int,
        width: Int = defaultWidth,
        height: Int = defaultHeight
    ) throws -> CVPixelBuffer {
        let pixelBuffer = try flatPixelBuffer(luma: 100, width: width, height: height)
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else {
            return pixelBuffer
        }
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let planeWidth = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let planeHeight = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let pointer = base.assumingMemoryBound(to: UInt8.self)
        let barX = (frameIndex * 5) % max(1, planeWidth)
        let barWidth = max(4, planeWidth / 16)
        let blockY = (frameIndex * 3) % max(1, planeHeight)
        let blockHeight = max(8, planeHeight / 8)
        let patch = min(32, planeWidth, planeHeight)
        for y in 0..<planeHeight {
            for x in 0..<planeWidth {
                var value: UInt8 = 100
                if x >= barX && x < barX + barWidth { value = 235 }
                if y >= blockY && y < blockY + blockHeight,
                    x >= planeWidth / 4 && x < planeWidth * 3 / 4
                {
                    value = 16
                }
                if x < patch && y >= planeHeight - patch {
                    let on = ((x / 8) + (y / 8) + frameIndex) % 2 == 0
                    value = on ? 220 : 40
                }
                pointer[y * stride + x] = value
            }
        }
        return pixelBuffer
    }

    private final class EncodeCollector: @unchecked Sendable {
        var encoded: [(pts: CMTime, sample: CMSampleBuffer)] = []
        var failure: OSStatus = noErr
    }

    /// One flat H.264 frame per level, every frame forced to a keyframe so each
    /// sample is independently decodable. GOP-aware seeking does not exist yet,
    /// and these fixtures deliberately sidestep it rather than pretend.
    static func encodeFlatFrames(
        lumaLevels: [UInt8],
        width: Int = defaultWidth,
        height: Int = defaultHeight
    ) throws -> (formatDescription: CMVideoFormatDescription, samples: [StudioCompressedSample]) {
        var session: VTCompressionSession?
        let createStatus = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &session
        )
        let compression = try XCTUnwrap(
            session,
            "VTCompressionSessionCreate failed: \(createStatus)"
        )
        defer { VTCompressionSessionInvalidate(compression) }

        VTSessionSetProperty(
            compression,
            key: kVTCompressionPropertyKey_RealTime,
            value: kCFBooleanTrue
        )
        // No B-frames, so encoded order matches presentation order.
        VTSessionSetProperty(
            compression,
            key: kVTCompressionPropertyKey_AllowFrameReordering,
            value: kCFBooleanFalse
        )
        VTSessionSetProperty(
            compression,
            key: kVTCompressionPropertyKey_ProfileLevel,
            value: kVTProfileLevel_H264_Baseline_AutoLevel
        )

        let collector = EncodeCollector()
        for (index, level) in lumaLevels.enumerated() {
            let frame = try flatPixelBuffer(luma: level, width: width, height: height)
            let status = VTCompressionSessionEncodeFrame(
                compression,
                imageBuffer: frame,
                presentationTimeStamp: CMTime(value: Int64(index), timescale: 30),
                duration: CMTime(value: 1, timescale: 30),
                frameProperties: [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary,
                infoFlagsOut: nil
            ) { status, _, sampleBuffer in
                if status != noErr {
                    collector.failure = status
                    return
                }
                if let sampleBuffer {
                    collector.encoded.append(
                        (CMSampleBufferGetPresentationTimeStamp(sampleBuffer), sampleBuffer)
                    )
                }
            }
            XCTAssertEqual(status, noErr, "encode submission failed for level \(level)")
        }
        // Barrier: every output handler has run once this returns.
        VTCompressionSessionCompleteFrames(compression, untilPresentationTimeStamp: .invalid)

        XCTAssertEqual(collector.failure, noErr, "encoder reported a failure")
        guard collector.encoded.count == lumaLevels.count else {
            throw XCTSkip(
                "encoder produced \(collector.encoded.count) of \(lumaLevels.count) frames"
            )
        }

        let ordered = collector.encoded.sorted { $0.pts.value < $1.pts.value }
        let formatDescription = try XCTUnwrap(
            CMSampleBufferGetFormatDescription(ordered[0].sample),
            "encoded sample carried no format description"
        )
        let samples = ordered.map {
            StudioCompressedSample(frameIndex: $0.pts.value, sampleBuffer: $0.sample)
        }
        return (formatDescription, samples)
    }

    /// A ready-to-use decoded source over flat frames.
    static func makeFrameSource(
        lumaLevels: [UInt8],
        device: MTLDevice
    ) throws -> StudioVideoFrameSource {
        let encoded = try encodeFlatFrames(lumaLevels: lumaLevels)
        return try StudioVideoFrameSource(
            formatDescription: encoded.formatDescription,
            samples: encoded.samples,
            device: device
        )
    }

    static func makeTemporaryMovieURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("studio-test-\(UUID().uuidString).mov")
    }

    /// Writes a REAL .mov carrying an audio track: a sine tone at `frequency`.
    ///
    /// Hermetic on purpose. Pointing an audio test at a file some earlier
    /// command left in /tmp makes it skip silently wherever that file is absent,
    /// and a skipped test proves nothing — it just looks green.
    static func writeToneMovie(
        to url: URL,
        seconds: Double = 2.0,
        sampleRate: Double = 44_100,
        frequency: Double = 440
    ) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000,
        ]
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        guard writer.canAdd(input) else {
            throw XCTSkip("asset writer rejected the audio input on this machine")
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw XCTSkip("asset writer could not start: \(String(describing: writer.error))")
        }
        writer.startSession(atSourceTime: .zero)

        guard
            let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: sampleRate,
                channels: 1,
                interleaved: false
            )
        else {
            throw XCTSkip("float PCM format unavailable")
        }

        let totalFrames = Int(sampleRate * seconds)
        let chunkFrames = 4_096
        var written = 0
        while written < totalFrames {
            let frames = min(chunkFrames, totalFrames - written)
            guard
                let buffer = AVAudioPCMBuffer(
                    pcmFormat: format,
                    frameCapacity: AVAudioFrameCount(frames)
                ),
                let channel = buffer.floatChannelData?[0]
            else {
                throw XCTSkip("PCM buffer allocation failed")
            }
            buffer.frameLength = AVAudioFrameCount(frames)
            for index in 0..<frames {
                let phase = 2.0 * Double.pi * frequency * Double(written + index) / sampleRate
                channel[index] = Float(sin(phase)) * 0.25
            }
            guard let sample = Self.sampleBuffer(from: buffer, startFrame: Int64(written)) else {
                throw XCTSkip("could not build a CMSampleBuffer for the tone")
            }
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            input.append(sample)
            written += frames
        }

        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed {
            throw XCTSkip("tone writer failed: \(String(describing: writer.error))")
        }
    }

    private static func sampleBuffer(
        from buffer: AVAudioPCMBuffer,
        startFrame: Int64
    ) -> CMSampleBuffer? {
        var format: CMFormatDescription?
        guard
            CMAudioFormatDescriptionCreate(
                allocator: kCFAllocatorDefault,
                asbd: buffer.format.streamDescription,
                layoutSize: 0,
                layout: nil,
                magicCookieSize: 0,
                magicCookie: nil,
                extensions: nil,
                formatDescriptionOut: &format
            ) == noErr,
            let format
        else {
            return nil
        }

        var sample: CMSampleBuffer?
        let timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(buffer.format.sampleRate)),
            presentationTimeStamp: CMTime(
                value: startFrame,
                timescale: CMTimeScale(buffer.format.sampleRate)
            ),
            decodeTimeStamp: .invalid
        )
        guard
            CMSampleBufferCreate(
                allocator: kCFAllocatorDefault,
                dataBuffer: nil,
                dataReady: false,
                makeDataReadyCallback: nil,
                refcon: nil,
                formatDescription: format,
                sampleCount: CMItemCount(buffer.frameLength),
                sampleTimingEntryCount: 1,
                sampleTimingArray: [timing],
                sampleSizeEntryCount: 0,
                sampleSizeArray: nil,
                sampleBufferOut: &sample
            ) == noErr,
            let sample,
            CMSampleBufferSetDataBufferFromAudioBufferList(
                sample,
                blockBufferAllocator: kCFAllocatorDefault,
                blockBufferMemoryAllocator: kCFAllocatorDefault,
                flags: 0,
                bufferList: buffer.audioBufferList
            ) == noErr
        else {
            return nil
        }
        return sample
    }

    /// Writes a REAL .mov container with an H.264 video track.
    ///
    /// Ingest tests must exercise actual demux, not a second synthesized-sample
    /// path — the whole point of the loader is that samples come from a file.
    /// - Parameter forceKeyFrames: when true every frame is an IDR, which is
    ///   what makes isolated per-sample decoding valid. Left false, the encoder
    ///   emits a normal GOP and the loader is expected to REFUSE the asset —
    ///   measured behaviour, see StudioMediaSourceLoader's header.
    static func writeFlatMovie(
        lumaLevels: [UInt8],
        to url: URL,
        width: Int = defaultWidth,
        height: Int = defaultHeight,
        frameRate: Int32 = 30,
        forceKeyFrames: Bool = true
    ) async throws {
        try await writeMovie(
            frameCount: lumaLevels.count,
            to: url,
            width: width,
            height: height,
            frameRate: frameRate,
            forceKeyFrames: forceKeyFrames
        ) { index in
            try flatPixelBuffer(luma: lumaLevels[index], width: width, height: height)
        }
    }

    /// Writes a REAL inter-coded .mov whose frames MOVE, so temporal reference
    /// corruption becomes visible as trails instead of hiding inside a flat
    /// luma field.
    static func writeMovingMovie(
        frameCount: Int,
        to url: URL,
        width: Int = defaultWidth,
        height: Int = defaultHeight,
        frameRate: Int32 = 30,
        forceKeyFrames: Bool = false
    ) async throws {
        try await writeMovie(
            frameCount: frameCount,
            to: url,
            width: width,
            height: height,
            frameRate: frameRate,
            forceKeyFrames: forceKeyFrames
        ) { index in
            try movingPixelBuffer(frameIndex: index, width: width, height: height)
        }
    }

    private static func writeMovie(
        frameCount: Int,
        to url: URL,
        width: Int,
        height: Int,
        frameRate: Int32,
        forceKeyFrames: Bool,
        makeFrame: (Int) throws -> CVPixelBuffer
    ) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        var outputSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
        ]
        if forceKeyFrames {
            outputSettings[AVVideoCompressionPropertiesKey] = [
                AVVideoMaxKeyFrameIntervalKey: 1,
                AVVideoAllowFrameReorderingKey: false,
            ]
        }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: outputSettings)
        input.expectsMediaDataInRealTime = false

        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: Int(
                    kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
                ),
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [CFString: Any]() as CFDictionary,
            ]
        )

        guard writer.canAdd(input) else {
            throw XCTSkip("asset writer rejected the video input on this machine")
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw XCTSkip("asset writer could not start: \(String(describing: writer.error))")
        }
        writer.startSession(atSourceTime: .zero)

        for index in 0..<frameCount {
            let buffer = try makeFrame(index)
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            let appended = adaptor.append(
                buffer,
                withPresentationTime: CMTime(value: Int64(index), timescale: frameRate)
            )
            XCTAssertTrue(
                appended,
                "append failed for frame \(index): \(String(describing: writer.error))"
            )
        }

        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else {
            throw XCTSkip(
                "asset writer finished \(writer.status): \(String(describing: writer.error))"
            )
        }
    }
}
