import AVFoundation
import CoreVideo
import IOSurface
import Metal
import XCTest

@testable import TaskWraithStudioCore

@MainActor
final class StudioResourceDiagnosticsTests: XCTestCase {
    private func device() throws -> MTLDevice {
        try XCTUnwrap(MTLCreateSystemDefaultDevice(), "native resource proof requires Metal")
    }

    func testFrameCopiesShareOneLifetimeAndDeduplicateDecodedAndTextureSurfaces() throws {
        let baseline = try StudioResourceDiagnostics.snapshot()
        let pixel = try StudioTestMedia.flatPixelBuffer(luma: 90)
        let surface = try XCTUnwrap(CVPixelBufferGetIOSurface(pixel)?.takeUnretainedValue())
        var decoded: StudioDecodedFrame? = StudioDecodedFrame(pixelBuffer: pixel, presentationTime: .zero)
        let bridge = try StudioVideoTextureBridge(device: device())
        var textures: StudioVideoFrameTextures? = try bridge.makeTextures(from: pixel)
        var copy = textures
        var decodedCopy = decoded
        let alive = try StudioResourceDiagnostics.snapshot()
        XCTAssertEqual(alive.video["decodedFrameObjects"], baseline.video["decodedFrameObjects"]! + 1)
        XCTAssertEqual(alive.video["frameObjects"], baseline.video["frameObjects"]! + 1)
        XCTAssertEqual(alive.video["planeTextures"], baseline.video["planeTextures"]! + 2)
        XCTAssertEqual(alive.video["ioSurfaces"], baseline.video["ioSurfaces"]! + 1)
        XCTAssertEqual(alive.video["ioSurfaceBytes"], baseline.video["ioSurfaceBytes"]! + IOSurfaceGetAllocSize(surface))
        XCTAssertTrue(alive.ioSurfaceIds.contains(IOSurfaceGetID(surface)))
        decoded = nil
        textures = nil
        XCTAssertNotNil(copy)
        XCTAssertNotNil(decodedCopy)
        XCTAssertEqual(try StudioResourceDiagnostics.snapshot().video["frameObjects"], alive.video["frameObjects"])
        decodedCopy = nil
        XCTAssertEqual(try StudioResourceDiagnostics.snapshot().video["decodedFrameObjects"], baseline.video["decodedFrameObjects"])
        XCTAssertEqual(try StudioResourceDiagnostics.snapshot().video["ioSurfaces"], alive.video["ioSurfaces"])
        copy = nil
        let released = try StudioResourceDiagnostics.snapshot()
        XCTAssertEqual(released.video["frameObjects"], baseline.video["frameObjects"])
        XCTAssertEqual(released.video["ioSurfaces"], baseline.video["ioSurfaces"])
        withExtendedLifetime(bridge) {}
    }

    func testRealDecodeCacheHitsAndSourceReleasePreserveLifetimeActivity() throws {
        let baseline = try StudioResourceDiagnostics.snapshot()
        var source: StudioVideoFrameSource? = try StudioTestMedia.makeFrameSource(lumaLevels: [32, 192], device: device())
        XCTAssertEqual(try StudioResourceDiagnostics.snapshot().video["decoderSessions"], baseline.video["decoderSessions"]! + 1)
        var held: StudioVideoFrameTextures? = try source!.textures(forFrameIndex: 0)
        let decoded = try StudioResourceDiagnostics.snapshot()
        XCTAssertGreaterThan(decoded.activity["decodeSubmissions"]!, baseline.activity["decodeSubmissions"]!)
        XCTAssertEqual(decoded.video["activeDecodeOperations"], baseline.video["activeDecodeOperations"])
        XCTAssertEqual(decoded.video["reorderCacheEntries"], baseline.video["reorderCacheEntries"]! + 1)
        _ = try source!.textures(forFrameIndex: 0)
        let cached = try StudioResourceDiagnostics.snapshot()
        XCTAssertEqual(cached.activity["decodeSubmissions"], decoded.activity["decodeSubmissions"])
        XCTAssertEqual(cached.activity["frameCacheHits"], decoded.activity["frameCacheHits"]! + 1)
        XCTAssertEqual(cached.video["frameObjects"], decoded.video["frameObjects"])
        source!.invalidate()
        XCTAssertThrowsError(try source!.textures(forFrameIndex: 1))
        source = nil
        let detached = try StudioResourceDiagnostics.snapshot()
        XCTAssertEqual(detached.video["decoderSessions"], baseline.video["decoderSessions"])
        XCTAssertEqual(detached.video["reorderCacheEntries"], baseline.video["reorderCacheEntries"])
        XCTAssertEqual(detached.video["compressedCacheEntries"], baseline.video["compressedCacheEntries"])
        XCTAssertEqual(detached.video["compressedCacheBytes"], baseline.video["compressedCacheBytes"])
        XCTAssertEqual(detached.video["frameObjects"], baseline.video["frameObjects"]! + 1)
        XCTAssertEqual(detached.activity, cached.activity)
        XCTAssertNotNil(held)
        held = nil
        let released = try StudioResourceDiagnostics.snapshot()
        XCTAssertEqual(released.video["frameObjects"], baseline.video["frameObjects"])
        XCTAssertEqual(released.video["ioSurfaces"], baseline.video["ioSurfaces"])
        XCTAssertEqual(released.activity, cached.activity)
    }

    func testFailedAcquisitionRetiresItsPendingWork() async throws {
        let pool = StudioMediaSourcePool(device: try device())
        let baseline = try StudioResourceDiagnostics.snapshot()
        do {
            _ = try await pool.acquire(asset: StudioMediaAsset(assetId: "missing", path: "/no-such-studio-resource-test.mov"))
            XCTFail("missing media must fail")
        } catch {}
        let failed = try StudioResourceDiagnostics.snapshot()
        XCTAssertEqual(failed.video["pendingSourceLoads"], baseline.video["pendingSourceLoads"])
        XCTAssertEqual(failed.video["decoderSessions"], baseline.video["decoderSessions"])
    }

    func testFailedVideoToolboxSubmissionIsCountedOnceAndRetiresActiveWork() throws {
        let encoded = try StudioTestMedia.encodeFlatFrames(lumaLevels: [96])
        let decoder = try StudioVideoDecoder(formatDescription: encoded.formatDescription)
        defer { decoder.invalidate() }
        let sample = try XCTUnwrap(encoded.samples.first?.sampleBuffer)
        let block = try XCTUnwrap(CMSampleBufferGetDataBuffer(sample))
        XCTAssertEqual(CMBlockBufferFillDataBytes(with: 0, blockBuffer: block,
            offsetIntoDestination: 0, dataLength: CMBlockBufferGetDataLength(block)), noErr)
        let before = try StudioResourceDiagnostics.snapshot()
        XCTAssertThrowsError(try decoder.decode(sample))
        let after = try StudioResourceDiagnostics.snapshot()
        XCTAssertEqual(after.activity["decodeSubmissions"], before.activity["decodeSubmissions"]! + 1)
        XCTAssertEqual(after.activity["decodeFailures"], before.activity["decodeFailures"]! + 1)
        XCTAssertEqual(after.activity["decodeCompletions"], before.activity["decodeCompletions"])
        XCTAssertEqual(after.video["activeDecodeOperations"], before.video["activeDecodeOperations"])
        decoder.invalidate()
        XCTAssertThrowsError(try decoder.decode(sample))
        XCTAssertEqual(try StudioResourceDiagnostics.snapshot().activity, after.activity,
            "a refusal before VT submission must not invent another attempted decode")
    }

    func testActualPendingAcquisitionAndTwoLeasesReportOneSharedDecoderAndCache() async throws {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(lumaLevels: [32, 96, 160, 224], to: url)
        let pool = StudioMediaSourcePool(device: try device())
        let asset = StudioMediaAsset(assetId: "shared", path: url.path)
        let before = try StudioResourceDiagnostics.snapshot()
        let load = Task { try await pool.acquire(asset: asset) }
        var sawPending = false
        for _ in 0..<100 {
            await Task.yield()
            if try StudioResourceDiagnostics.snapshot().video["pendingSourceLoads"] == before.video["pendingSourceLoads"]! + 1 {
                sawPending = true
                break
            }
        }
        let first = try await load.value
        XCTAssertTrue(sawPending, "an actual suspended acquisition must remain observable")
        let loaded = try StudioResourceDiagnostics.snapshot()
        let second = try await pool.acquire(asset: asset)
        XCTAssertTrue(first.source === second.source)
        let shared = try StudioResourceDiagnostics.snapshot()
        XCTAssertEqual(shared.video["decoderSessions"], before.video["decoderSessions"]! + 1)
        XCTAssertEqual(shared.video["decoderSessions"], loaded.video["decoderSessions"])
        XCTAssertEqual(shared.video["compressedCacheEntries"], loaded.video["compressedCacheEntries"])
        XCTAssertEqual(shared.video["compressedCacheBytes"], loaded.video["compressedCacheBytes"])
        XCTAssertEqual(shared.video["pendingSourceLoads"], before.video["pendingSourceLoads"])
        withExtendedLifetime((pool, first, second)) {}
    }

    func testObservationPreservesOvercapacityAndRejectsUnrepresentableCounts() throws {
        let baseline = try StudioResourceDiagnostics.snapshot()
        let observation = StudioResourceLease(["presentationLeases": 8, "presentationLeaseCapacity": 3])
        let measured = try StudioResourceDiagnostics.snapshot()
        XCTAssertEqual(measured.video["presentationLeases"], baseline.video["presentationLeases"]! + 8)
        XCTAssertEqual(measured.video["presentationLeaseCapacity"], baseline.video["presentationLeaseCapacity"]! + 3)
        observation.update(["frameObjects": Int.max])
        XCTAssertThrowsError(try StudioResourceDiagnostics.snapshot())
        observation.finish()
        XCTAssertNoThrow(try StudioResourceDiagnostics.snapshot())
    }

    private func track() throws -> StudioAudioTrack {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 128))
        buffer.frameLength = 96
        return StudioAudioTrack(format: format, buffer: buffer)
    }

    func testQueuedViewsRetainOnePCMAllocationAndLateCompletionCannotRetireTheReplacement() throws {
        let baseline = try StudioResourceDiagnostics.snapshot()
        var owner: StudioAudioTrack? = try track()
        weak var lifetime = owner
        let bytes = 128 * 2 * MemoryLayout<Float>.size
        let first = StudioAudioOutputHold(track: owner!, buffer: try XCTUnwrap(StudioAudioPlayer.segment(of: owner!.buffer, from: 0)))
        let second = StudioAudioOutputHold(track: owner!, buffer: try XCTUnwrap(StudioAudioPlayer.segment(of: owner!.buffer, from: 32)))
        owner = nil
        let queued = try StudioResourceDiagnostics.snapshot()
        XCTAssertEqual(queued.audio["pcmBuffers"], baseline.audio["pcmBuffers"]! + 1)
        XCTAssertEqual(queued.audio["pcmBytes"], baseline.audio["pcmBytes"]! + bytes)
        XCTAssertEqual(queued.audio["queuedBuffers"], baseline.audio["queuedBuffers"]! + 2)
        XCTAssertEqual(queued.audio["queuedPcmBytes"], baseline.audio["queuedPcmBytes"]! + (96 + 64) * 2 * MemoryLayout<Float>.size)
        first.complete()
        first.complete()
        XCTAssertFalse(first.isActive)
        XCTAssertTrue(second.isActive)
        XCTAssertNotNil(lifetime)
        let replacement = try StudioResourceDiagnostics.snapshot()
        XCTAssertEqual(replacement.audio["queuedBuffers"], baseline.audio["queuedBuffers"]! + 1)
        XCTAssertEqual(replacement.audio["pcmBytes"], baseline.audio["pcmBytes"]! + bytes)
        second.complete()
        XCTAssertNil(lifetime, "retained callback/hold must release its track at completion")
        let finished = try StudioResourceDiagnostics.snapshot()
        XCTAssertEqual(finished.audio["pcmBytes"], baseline.audio["pcmBytes"])
        XCTAssertEqual(finished.audio["queuedBuffers"], baseline.audio["queuedBuffers"])
    }

    func testSilenceRetainsTheAttachedTrackAndReportsNoQueuedOutput() throws {
        let baseline = try StudioResourceDiagnostics.snapshot()
        let player = StudioAudioPlayer()
        try player.attach(track: track(), timebase: .ntsc2997, assetId: "silent-fixture")
        XCTAssertFalse(try player.play(fromTicks: 0, expectedAssetId: "wrong-fixture"))
        player.silence()
        let closed = try StudioResourceDiagnostics.snapshot()
        XCTAssertEqual(closed.audio["playerObjects"], baseline.audio["playerObjects"]! + 1)
        XCTAssertEqual(closed.audio["engineObjects"], baseline.audio["engineObjects"]! + 1)
        XCTAssertEqual(closed.audio["attachedTracks"], baseline.audio["attachedTracks"]! + 1)
        XCTAssertEqual(closed.audio["pcmBuffers"], baseline.audio["pcmBuffers"]! + 1)
        XCTAssertEqual(closed.audio["playersWithQueuedOutput"], baseline.audio["playersWithQueuedOutput"])
        XCTAssertEqual(closed.audio["playingPlayers"], baseline.audio["playingPlayers"])
        player.detach()
        XCTAssertEqual(try StudioResourceDiagnostics.snapshot().audio["pcmBuffers"], baseline.audio["pcmBuffers"])
        withExtendedLifetime(player) {}
    }
}
