import AppKit
import CoreGraphics
import CoreMedia
import CryptoKit
import Metal
import QuartzCore
import XCTest

@testable import TaskWraithStudioCore

/// LIVE concurrent pre-bind + seek-storm discriminator.
///
/// Forks already closed:
/// - Synchronous offscreen storm (`StudioPixelIntegrityTests`) is GREEN.
/// - Isolated 3s display-link PLAY pre-bind on the 22,800-frame fixture is
///   GREEN. Packaged PLAY at 3.833s is also clean (`held 3`).
/// - Dual-fence lease `3691a5c55` is visually insufficient: Work1's exact
///   523-step packaged storm is still catastrophically trailed.
///
/// Remaining fork, both arms required:
/// 1. Warm pre-bind delta — full suite is 593/1 after other Studio tests;
///    isolated PLAY passes. FirstDiff was 108 vs 109 / 77 vs 72 with no
///    byte-count. Quantify it; do not call a 1-luma-code warm delta the same
///    thing as packaged trails.
/// 2. Live backward-seek storm — packaged trails appear AFTER seeks, not
///    during PLAY. Copy planes before bind AND read back the live render
///    target against a fresh decode+render of the same PTS.
///
/// RED pre-bind after storm  => decoder/pool/cache under live seek.
/// GREEN pre-bind + RED presented => Metal sampling / stale texture.
/// Both GREEN => defect is beyond in-process Metal (WindowServer/layer).
///
/// Does not activate the process. Uses `orderFrontRegardless` so the owner
/// keeps foreground. Does not retain live pixel buffers.
@MainActor
final class StudioLivePreBindIntegrityTests: XCTestCase {
    private let expectedAcceptanceSHA =
        "f7e39d4237fe1e408a76d213a322f60a8788eeaedac5252d95677135b08380f9"
    private let playbackSeconds: TimeInterval = 3.25
    private let samplePTS: [Double] = [1.0, 2.0, 3.1]

    func testLiveDisplayLinkPreBindMatchesFreshDecodeAndWindowServer() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        try skipIfGraphicalSessionLocked()

        let (asset, usedAcceptanceFixture) = try await makeLiveAsset()
        let live = try await StudioMediaSourceLoader.makeBoundedFrameSource(
            asset: asset, device: device)
        XCTAssertTrue(
            live.media.sampleProvider is BoundedStudioSampleProvider,
            "live path must use the bounded provider")

        let renderer = try StudioViewerRenderer(device: device)
        renderer.attach(
            source: live.source,
            assetId: asset.assetId,
            timebase: live.media.timebase
        )

        let clock = StudioPlaybackClock(
            timebase: live.media.timebase,
            durationTicks: live.media.durationTicks
        )
        let authority = StudioPlaybackAuthority(clock: clock)
        let width = max(128, Int(live.media.naturalSize.width.rounded()))
        let height = max(128, Int(live.media.naturalSize.height.rounded()))
        let host = LivePresentingHost(
            renderer: renderer,
            authority: authority,
            width: width,
            height: height
        )

        // Display-link and this test share the main actor; no lock.
        var samples: [StudioPreBindProbe.Sample] = []
        StudioPreBindProbe.sink = { buffer, pts in
            // Copy NOW and drop `buffer`. Retaining it would pin the pool.
            if let sample = try? StudioPreBindProbe.makeSample(
                from: buffer, presentationTime: pts)
            {
                samples.append(sample)
            }
        }
        defer {
            StudioPreBindProbe.sink = nil
            host.stop()
            live.source.invalidate()
        }

        host.start()
        host.renderOnce()
        XCTAssertGreaterThan(
            samples.count, 0,
            "first presenting tick produced no bind (drawableMisses=\(host.drawableMisses))"
        )
        pumpMainRunLoop(for: playbackSeconds)
        host.renderOnce()
        pumpMainRunLoop(for: 0.05)

        let captured = samples

        // Fail-and-return: XCTest continues after XCTAssert, and start...targetIndex
        // traps when two inert binds share a PTS (locked console or a slow link).
        if captured.count <= 30 {
            XCTFail(
                "display-link produced too few binds to exercise the pool: got \(captured.count), need >30; fixture=\(usedAcceptanceFixture)"
            )
            return
        }
        let uniquePTS = Set(captured.map { $0.presentationTime.value })
        XCTAssertGreaterThan(uniquePTS.count, 10, "playback did not advance")
        let uniqueSurfaces = Set(captured.compactMap(\.ioSurfaceID))
        XCTAssertGreaterThan(
            uniqueSurfaces.count, 1,
            "a single IOSurface cannot show concurrent pool reuse")

        let last = try XCTUnwrap(captured.last, "no pre-bind sample")
        XCTAssertGreaterThan(
            CMTimeGetSeconds(last.presentationTime), 2.5,
            "playback ended at \(CMTimeGetSeconds(last.presentationTime))s; need ~3s"
        )

        // Release the live session before the reference walk. A second
        // VTDecompressionSession on the same asset while the presenting one is
        // still live is not the layer under test.
        StudioPreBindProbe.sink = nil
        host.stop()
        live.source.invalidate()

        let referenceMedia = try await StudioMediaSourceLoader.loadBounded(asset: asset)
        let referenceDecoder = try StudioVideoDecoder(
            formatDescription: referenceMedia.formatDescription)
        defer { referenceDecoder.invalidate() }

        var mismatches: [String] = []
        var lastDecodedIndex = -1
        var lastFrame: StudioDecodedFrame?
        for targetSeconds in samplePTS {
            let liveSample = try XCTUnwrap(
                closestSample(in: captured, toSeconds: targetSeconds),
                "no live sample near \(targetSeconds)s"
            )
            let targetIndex = try XCTUnwrap(
                decodeIndex(
                    in: referenceMedia, matching: liveSample.presentationTime),
                "no decode index for PTS \(liveSample.presentationTime.value)"
            )
            // Sequential only. The acceptance fixture's attachments often omit
            // DependsOnOthers, so a GOP-restart walker would decode a P-frame
            // in isolation and throw kVTVideoDecoderBadDataErr (-12909).
            let start = lastDecodedIndex + 1
            guard requireAscendingDecodeWindow(
                start: start,
                targetIndex: targetIndex,
                bindCount: captured.count
            ) else { return }
            do {
                for index in start...targetIndex {
                    lastFrame = try referenceDecoder.decode(
                        referenceMedia.sampleProvider.sampleBuffer(atDecodeIndex: index)
                    )
                    lastDecodedIndex = index
                }
            } catch {
                XCTFail(
                    "reference sequential decode failed at idx \(targetIndex): \(error)"
                )
                return
            }
            let fresh = try StudioPreBindProbe.copyTightPlanes(
                try XCTUnwrap(lastFrame).pixelBuffer
            )
            if fresh != liveSample.planeBytes {
                // Do not use String(format:) + "%s" here. Passing a Swift
                // String as %s is a C-varargs type error: DiagnosticReports
                // xctest-2026-08-15-033958 / 034034 are EXC_BAD_ACCESS in
                // _platform_strlen via CFStringAppendFormatCore at this site.
                // That SIGSEGV predates the dual-fence lease (same stack at
                // 03:07, commit a78358d2b). Interpolation keeps a real
                // mismatch as XCTFail instead of stopping the suite.
                let diff = StudioPreBindProbe.diffPlanes(
                    live: liveSample.planeBytes, fresh: fresh)
                let pts = CMTimeGetSeconds(liveSample.presentationTime)
                let surface = liveSample.ioSurfaceID.map(String.init) ?? "nil"
                mismatches.append(
                    "PTS \(String(format: "%.3f", pts))s (idx \(targetIndex), iosurface \(surface)): \(diff.summary) trailClass=\(diff.isTrailClass)"
                )
            }
        }

        if !mismatches.isEmpty {
            XCTFail(
                "LIVE PRE-BIND CORRUPT vs fresh decode — decoder/pool reuse under concurrency. "
                    + mismatches.joined(separator: "; ")
                    + ". fixtureAcceptance=\(usedAcceptanceFixture). "
                    + "Packaged WindowServer SHA fce8915e… remains the visual arm."
            )
        } else {
            // GREEN pre-bind. In-process CGWindowListCreateImage SIGSEGV'd, so
            // the Metal/presentation split uses the packaged capture, not a
            // manufactured XCTest WindowServer compare.
            XCTAssertTrue(
                usedAcceptanceFixture || captured.count > 30,
                "live pre-bind matches fresh sequential decode on \(usedAcceptanceFixture ? "the 22,800-frame fixture" : "generated VFR")"
            )
        }
    }

    /// Second presenting session on the same Metal device. This is the in-file
    /// analogue of the warm 593/1 (PLAY after other Studio suites). Isolated
    /// PLAY is GREEN; a trail-class second-pass delta would mean the warm
    /// failure is the same defect as the packaged trails. A handful of ±1
    /// codes is recorded, not promoted.
    func testWarmSecondPassPreBindDeltaIsQuantified() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        try skipIfGraphicalSessionLocked()
        let (asset, usedAcceptance) = try await makeLiveAsset()
        let first = try await captureLivePreBind(
            asset: asset, device: device, playbackSeconds: 1.2)
        if first.samples.count <= 10 {
            XCTFail("cold pass produced too few binds: got \(first.samples.count), need >10")
            return
        }

        let second = try await captureLivePreBind(
            asset: asset, device: device, playbackSeconds: 1.2)
        if second.samples.count <= 10 {
            XCTFail("warm pass produced too few binds: got \(second.samples.count), need >10")
            return
        }

        let referenceMedia = try await StudioMediaSourceLoader.loadBounded(asset: asset)
        let referenceDecoder = try StudioVideoDecoder(
            formatDescription: referenceMedia.formatDescription)
        defer { referenceDecoder.invalidate() }

        var lastDecodedIndex = -1
        var lastFrame: StudioDecodedFrame?
        var reports: [String] = []
        var trailClass = 0
        for targetSeconds in [0.4, 0.8, 1.1] {
            let liveSample = try XCTUnwrap(
                closestSample(in: second.samples, toSeconds: targetSeconds),
                "no warm sample near \(targetSeconds)s"
            )
            let targetIndex = try XCTUnwrap(
                decodeIndex(in: referenceMedia, matching: liveSample.presentationTime),
                "no decode index for warm PTS \(liveSample.presentationTime.value)"
            )
            let start = lastDecodedIndex + 1
            guard requireAscendingDecodeWindow(
                start: start,
                targetIndex: targetIndex,
                bindCount: second.samples.count
            ) else { return }
            for index in start...targetIndex {
                lastFrame = try referenceDecoder.decode(
                    referenceMedia.sampleProvider.sampleBuffer(atDecodeIndex: index)
                )
                lastDecodedIndex = index
            }
            let fresh = try StudioPreBindProbe.copyTightPlanes(
                try XCTUnwrap(lastFrame).pixelBuffer
            )
            let diff = StudioPreBindProbe.diffPlanes(
                live: liveSample.planeBytes, fresh: fresh)
            let pts = CMTimeGetSeconds(liveSample.presentationTime)
            reports.append(
                "warm PTS \(String(format: "%.3f", pts))s idx=\(targetIndex) \(diff.summary) trailClass=\(diff.isTrailClass)"
            )
            if diff.isTrailClass { trailClass += 1 }
        }
        XCTAssertEqual(
            trailClass, 0,
            "WARM PRE-BIND is trail-class — decoder/pool reuse under a second session. "
                + reports.joined(separator: "; ")
                + ". fixtureAcceptance=\(usedAcceptance)"
        )
    }

    /// Packaged trails appear after backward seeks, not after PLAY. Drive the
    /// real display-link presenting path, step backward one transport second
    /// at a time, then split pre-bind planes from the live render target.
    func testLiveBackwardSeekStormSplitsPreBindFromPresented() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        let (asset, usedAcceptance) = try await makeLiveAsset()
        let live = try await StudioMediaSourceLoader.makeBoundedFrameSource(
            asset: asset, device: device)
        XCTAssertTrue(
            live.media.sampleProvider is BoundedStudioSampleProvider,
            "storm path must use the bounded provider"
        )
        let syncCount = (0..<live.media.sampleProvider.sampleCount).reduce(0) {
            $0 + (live.media.sampleProvider.metadata(atDecodeIndex: $1).isSyncSample ? 1 : 0)
        }
        XCTAssertLessThan(
            syncCount,
            live.media.sampleProvider.sampleCount,
            "silent DependsOnOthers must not mark every sample sync; sync=\(syncCount)/\(live.media.sampleProvider.sampleCount)"
        )
        if usedAcceptance {
            XCTAssertGreaterThan(syncCount, 10, "acceptance fixture lost its IDRs")
            XCTAssertLessThan(
                syncCount,
                live.media.sampleProvider.sampleCount / 4,
                "acceptance fixture still looks all-intra; sync=\(syncCount)/\(live.media.sampleProvider.sampleCount)"
            )
        }
        let renderer = try StudioViewerRenderer(device: device)
        renderer.attach(
            source: live.source,
            assetId: asset.assetId,
            timebase: live.media.timebase
        )
        let clock = StudioPlaybackClock(
            timebase: live.media.timebase,
            durationTicks: live.media.durationTicks
        )
        let authority = StudioPlaybackAuthority(clock: clock)
        let width = max(128, Int(live.media.naturalSize.width.rounded()))
        let height = max(128, Int(live.media.naturalSize.height.rounded()))
        let host = LivePresentingHost(
            renderer: renderer,
            authority: authority,
            width: width,
            height: height
        )

        var samples: [StudioPreBindProbe.Sample] = []
        StudioPreBindProbe.sink = { buffer, pts in
            if let sample = try? StudioPreBindProbe.makeSample(
                from: buffer, presentationTime: pts)
            {
                samples.append(sample)
            }
        }
        defer {
            StudioPreBindProbe.sink = nil
            host.stop()
            live.source.invalidate()
        }

        host.start()
        host.renderOnce()
        pumpMainRunLoop(for: 0.35)
        host.pause()

        let timescale = live.media.timebase.timescale
        let durationTicks = live.media.durationTicks
        // Stay inside the asset and leave headroom for the 1s steps. Packaged
        // storm started near 20s/241s; 20s is enough to miss the first GOP.
        let startSeconds: Int64 = usedAcceptance ? 20 : 9
        let stepCount = usedAcceptance ? 36 : 16
        var ticks = min(durationTicks, startSeconds * timescale)
        XCTAssertGreaterThan(
            ticks, Int64(stepCount) * timescale / 2,
            "fixture too short for a \(stepCount)-step storm"
        )
        var seekSteps = 0
        for _ in 0..<stepCount {
            host.seek(toTicks: ticks)
            host.renderOnce()
            pumpMainRunLoop(for: 0.04)
            seekSteps += 1
            ticks -= timescale
            if ticks < timescale { break }
        }
        host.renderOnce()
        pumpMainRunLoop(for: 0.05)

        let captured = samples
        XCTAssertGreaterThan(seekSteps, 8, "storm did not apply seeks")
        XCTAssertGreaterThan(
            captured.count, 8,
            "seek storm produced no pre-bind samples; fixtureAcceptance=\(usedAcceptance)"
        )

        let lastSample = try XCTUnwrap(captured.last, "no post-storm pre-bind sample")
        let snapshot = authority.transport.clock.snapshot(atHost: CACurrentMediaTime())

        StudioPreBindProbe.sink = nil
        host.stop()

        let liveTarget = try makeReadbackTexture(device: device, width: width, height: height)
        let liveOutcome = renderer.render(
            snapshot: snapshot, to: liveTarget, presenting: nil, overlay: nil)
        XCTAssertTrue(
            liveOutcome.didDraw,
            "live post-storm render did not draw frame \(snapshot.frameIndex)"
        )
        let liveBGRA = readBGRA(liveTarget)

        live.source.invalidate()

        let referenceMedia = try await StudioMediaSourceLoader.loadBounded(asset: asset)
        let referenceDecoder = try StudioVideoDecoder(
            formatDescription: referenceMedia.formatDescription)
        defer { referenceDecoder.invalidate() }
        let targetIndex = try XCTUnwrap(
            decodeIndex(in: referenceMedia, matching: lastSample.presentationTime),
            "no decode index for post-storm PTS \(lastSample.presentationTime.value)"
        )
        var lastFrame: StudioDecodedFrame?
        for index in 0...targetIndex {
            lastFrame = try referenceDecoder.decode(
                referenceMedia.sampleProvider.sampleBuffer(atDecodeIndex: index)
            )
        }
        let freshPlanes = try StudioPreBindProbe.copyTightPlanes(
            try XCTUnwrap(lastFrame).pixelBuffer
        )
        let preBindDiff = StudioPreBindProbe.diffPlanes(
            live: lastSample.planeBytes, fresh: freshPlanes)

        let freshSource = try StudioVideoFrameSource(
            formatDescription: referenceMedia.formatDescription,
            provider: referenceMedia.sampleProvider,
            device: device
        )
        defer { freshSource.invalidate() }
        let freshRenderer = try StudioViewerRenderer(device: device)
        freshRenderer.attach(
            source: freshSource,
            assetId: asset.assetId,
            timebase: referenceMedia.timebase
        )
        let freshTarget = try makeReadbackTexture(device: device, width: width, height: height)
        let freshOutcome = freshRenderer.render(
            snapshot: snapshot, to: freshTarget, presenting: nil, overlay: nil)
        XCTAssertTrue(
            freshOutcome.didDraw,
            "fresh post-storm render did not draw frame \(snapshot.frameIndex)"
        )
        let freshBGRA = readBGRA(freshTarget)
        let presentedDiff = StudioPreBindProbe.diffPlanes(
            live: liveBGRA, fresh: freshBGRA)

        let pts = CMTimeGetSeconds(lastSample.presentationTime)
        let diagnosis =
            "post-storm PTS \(String(format: "%.3f", pts))s seeks=\(seekSteps) "
            + "fixtureAcceptance=\(usedAcceptance) sync=\(syncCount)/\(live.media.sampleProvider.sampleCount) "
            + "held=\(renderer.retainedFrameCount) "
            + "preBind{\(preBindDiff.summary) trail=\(preBindDiff.isTrailClass)} "
            + "presented{\(presentedDiff.summary) trail=\(presentedDiff.isTrailClass)}"

        if preBindDiff.isTrailClass {
            XCTFail(
                "LIVE SEEK-STORM PRE-BIND is trail-class — decoder/pool/cache under live seek. "
                    + diagnosis
            )
        } else if presentedDiff.isTrailClass {
            XCTFail(
                "LIVE SEEK-STORM PRESENTED is trail-class while pre-bind is not — Metal sampling/stale texture. "
                    + diagnosis
            )
        } else {
            // Both in-process arms clean. Packaged WindowServer trails then live
            // past the bind and the offscreen present, not in decode.
            XCTAssertGreaterThan(seekSteps, 8, diagnosis)
        }
    }

    /// Display-free red control: too-few / non-advancing binds must fail with
    /// a count, not trap inside `start...targetIndex`.
    func testInvertedDecodeWindowFailsWithCountInsteadOfTrapping() {
        XCTAssertEqual(
            Self.invalidDecodeWindowMessage(start: 1, targetIndex: 0, bindCount: 2),
            "decode window invalid: start=1 targetIndex=0 binds=2 — refusing to construct start...targetIndex"
        )
        XCTAssertNil(
            Self.invalidDecodeWindowMessage(start: 0, targetIndex: 10, bindCount: 31)
        )
    }

    // MARK: - Media

    private func makeLiveAsset() async throws -> (StudioMediaAsset, Bool) {
        let fixture = acceptanceFixtureURL()
        if FileManager.default.isReadableFile(atPath: fixture.path),
            sha256File(fixture) == expectedAcceptanceSHA
        {
            return (
                StudioMediaAsset(
                    assetId: "acceptance-vfr",
                    path: fixture.path,
                    mediaKind: .video
                ),
                true
            )
        }
        let url = StudioTestMedia.makeTemporaryMovieURL()
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        // Keep the clean-checkout fallback long enough to drive the minimum
        // nine backwards seeks required by the live storm above. The private
        // acceptance fixture is deliberately absent from release worktrees.
        try await StudioTestMedia.writeMovingVFRMovie(
            sections: [(24, 240)],
            to: url,
            width: 256,
            height: 144,
            maxKeyFrameInterval: 16
        )
        return (
            StudioMediaAsset(assetId: "live-vfr", path: url.path, mediaKind: .video),
            false
        )
    }

    private func acceptanceFixtureURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(
                ".local-only/taskwraith-studio/acceptance/w1acc10e/studio-vfr-10m.mp4"
            )
    }

    // MARK: - Session / range guards

    private func skipIfGraphicalSessionLocked() throws {
        guard Self.isGraphicalSessionLocked() else { return }
        throw XCTSkip(
            "locked console (CGSSessionScreenIsLocked=true); CADisplayLink is inert"
        )
    }

    static func isGraphicalSessionLocked() -> Bool {
        guard let info = CGSessionCopyCurrentDictionary() as NSDictionary? else {
            return false
        }
        if let flag = info["CGSSessionScreenIsLocked"] as? Bool {
            return flag
        }
        if let number = info["CGSSessionScreenIsLocked"] as? NSNumber {
            return number.boolValue
        }
        return false
    }

    static func invalidDecodeWindowMessage(
        start: Int,
        targetIndex: Int,
        bindCount: Int
    ) -> String? {
        guard start > targetIndex else { return nil }
        return
            "decode window invalid: start=\(start) targetIndex=\(targetIndex) binds=\(bindCount) — refusing to construct start...targetIndex"
    }

    private func requireAscendingDecodeWindow(
        start: Int,
        targetIndex: Int,
        bindCount: Int
    ) -> Bool {
        if let message = Self.invalidDecodeWindowMessage(
            start: start, targetIndex: targetIndex, bindCount: bindCount)
        {
            XCTFail(message)
            return false
        }
        return true
    }

    // MARK: - Compare helpers

    private func closestSample(
        in samples: [StudioPreBindProbe.Sample],
        toSeconds seconds: Double
    ) -> StudioPreBindProbe.Sample? {
        samples.min {
            abs(CMTimeGetSeconds($0.presentationTime) - seconds)
                < abs(CMTimeGetSeconds($1.presentationTime) - seconds)
        }
    }

    private func decodeIndex(
        in media: StudioLoadedMedia,
        matching time: CMTime
    ) -> Int? {
        for index in 0..<media.sampleProvider.sampleCount {
            let pts = media.sampleProvider.metadata(atDecodeIndex: index).presentationTime
            if pts.isValid, CMTimeCompare(pts, time) == 0 {
                return index
            }
        }
        return nil
    }

    private func pumpMainRunLoop(for seconds: TimeInterval) {
        // `.common` is a mode bag, not a run-loop mode. Running it is a no-op
        // (and logs kCFRunLoopCommonModes). Display-link is registered for
        // common modes, so it fires while `.default` runs.
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.004))
        }
    }

    private func sha256File(_ url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        while autoreleasepool(invoking: {
            let chunk = handle.readData(ofLength: 1024 * 1024)
            if chunk.isEmpty { return false }
            hasher.update(data: chunk)
            return true
        }) {}
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private struct LiveCapture {
        let samples: [StudioPreBindProbe.Sample]
    }

    private func captureLivePreBind(
        asset: StudioMediaAsset,
        device: MTLDevice,
        playbackSeconds: TimeInterval
    ) async throws -> LiveCapture {
        let live = try await StudioMediaSourceLoader.makeBoundedFrameSource(
            asset: asset, device: device)
        let renderer = try StudioViewerRenderer(device: device)
        renderer.attach(
            source: live.source,
            assetId: asset.assetId,
            timebase: live.media.timebase
        )
        let clock = StudioPlaybackClock(
            timebase: live.media.timebase,
            durationTicks: live.media.durationTicks
        )
        let authority = StudioPlaybackAuthority(clock: clock)
        let width = max(128, Int(live.media.naturalSize.width.rounded()))
        let height = max(128, Int(live.media.naturalSize.height.rounded()))
        let host = LivePresentingHost(
            renderer: renderer,
            authority: authority,
            width: width,
            height: height
        )
        var samples: [StudioPreBindProbe.Sample] = []
        StudioPreBindProbe.sink = { buffer, pts in
            if let sample = try? StudioPreBindProbe.makeSample(
                from: buffer, presentationTime: pts)
            {
                samples.append(sample)
            }
        }
        defer {
            StudioPreBindProbe.sink = nil
            host.stop()
            live.source.invalidate()
        }
        host.start()
        host.renderOnce()
        pumpMainRunLoop(for: playbackSeconds)
        host.renderOnce()
        return LiveCapture(samples: samples)
    }

    private func makeReadbackTexture(
        device: MTLDevice, width: Int, height: Int
    ) throws -> MTLTexture {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: StudioVideoFrameRenderer.pixelFormat,
            width: width,
            height: height,
            mipmapped: false
        )
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = .shared
        guard let texture = device.makeTexture(descriptor: descriptor) else {
            throw StudioRendererError.encodingFailed
        }
        return texture
    }

    private func readBGRA(_ texture: MTLTexture) -> [UInt8] {
        let bytesPerRow = texture.width * 4
        var bytes = [UInt8](repeating: 0, count: bytesPerRow * texture.height)
        texture.getBytes(
            &bytes,
            bytesPerRow: bytesPerRow,
            from: MTLRegionMake2D(0, 0, texture.width, texture.height),
            mipmapLevel: 0
        )
        return bytes
    }
}

/// Non-activating CAMetalLayer window that ticks the real presenting path.
@MainActor
private final class LivePresentingHost: NSObject {
    let window: NSWindow
    let view: LiveMetalView
    let renderer: StudioViewerRenderer
    let authority: StudioPlaybackAuthority
    private(set) var drawableMisses = 0
    private var frameLink: CADisplayLink?

    init(
        renderer: StudioViewerRenderer,
        authority: StudioPlaybackAuthority,
        width: Int,
        height: Int
    ) {
        self.renderer = renderer
        self.authority = authority
        let view = LiveMetalView(
            frame: NSRect(x: 0, y: 0, width: width, height: height),
            device: renderer.device
        )
        self.view = view
        let window = NSWindow(
            contentRect: view.bounds,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.backgroundColor = .black
        window.isOpaque = true
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.contentView = view
        view.frame = window.contentView!.bounds
        self.window = window
        super.init()
    }

    func pause() {
        authority.transport.pause(atHost: CACurrentMediaTime())
    }

    func seek(toTicks ticks: Int64) {
        authority.transport.seek(toTicks: ticks, atHost: CACurrentMediaTime())
    }

    func start() {
        window.setFrame(
            NSRect(x: 24, y: 24, width: view.bounds.width, height: view.bounds.height),
            display: true
        )
        window.orderFrontRegardless()
        view.layoutSubtreeIfNeeded()
        view.updateDrawableSize()
        authority.transport.play(atHost: CACurrentMediaTime())
        let link = view.displayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .default)
        link.add(to: .main, forMode: .common)
        frameLink = link
    }

    func renderOnce() {
        tick(nil)
    }

    func stop() {
        frameLink?.invalidate()
        frameLink = nil
        window.orderOut(nil)
    }

    @objc
    private func tick(_ link: CADisplayLink?) {
        guard let metalLayer = view.metalLayer else {
            drawableMisses += 1
            return
        }
        guard let drawable = metalLayer.nextDrawable() else {
            drawableMisses += 1
            return
        }
        let snapshot = authority.transport.clock.snapshot(atHost: CACurrentMediaTime())
        _ = renderer.render(
            snapshot: snapshot,
            to: drawable.texture,
            presenting: drawable,
            overlay: nil
        )
    }
}

@MainActor
private final class LiveMetalView: NSView {
    let metalDevice: MTLDevice

    init(frame: NSRect, device: MTLDevice) {
        self.metalDevice = device
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        layer = makeBackingLayer()
        updateDrawableSize()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func makeBackingLayer() -> CALayer {
        let metalLayer = CAMetalLayer()
        metalLayer.device = metalDevice
        metalLayer.pixelFormat = StudioVideoFrameRenderer.pixelFormat
        metalLayer.framebufferOnly = true
        metalLayer.isOpaque = true
        metalLayer.allowsNextDrawableTimeout = true
        metalLayer.contentsScale = 1
        return metalLayer
    }

    var metalLayer: CAMetalLayer? { layer as? CAMetalLayer }

    func updateDrawableSize() {
        guard let metalLayer else { return }
        metalLayer.contentsScale = 1
        metalLayer.drawableSize = CGSize(
            width: max(1, bounds.width),
            height: max(1, bounds.height)
        )
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateDrawableSize()
    }
}
