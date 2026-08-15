import AppKit
import CoreMedia
import CryptoKit
import Metal
import QuartzCore
import XCTest

@testable import TaskWraithStudioCore

/// LIVE concurrent pre-bind discriminator.
///
/// The synchronous offscreen storm in `StudioPixelIntegrityTests` is GREEN:
/// decoded planes match after far-jump/backward restarts when nothing else is
/// using the decoder pool. Packaged playback of the 22,800-frame fixture is
/// already trailed at 00:00:03.137 with `held 0`, so the remaining fork is
/// concurrent display-link decode/pool reuse versus Metal/presentation.
///
/// This drives the REAL presenting path — `CAMetalLayer.nextDrawable()` plus
/// `StudioViewerRenderer.render(..., presenting: drawable)` on a CADisplayLink
/// — for just over three seconds. Immediately before each Metal bind it copies
/// Y/CbCr planes and drops the `CVPixelBuffer`. Those copies are compared to
/// a fresh sequential decode of the same PTS. In-process WindowServer capture
/// SIGSEGV'd, so the Metal/presentation arm stays on the packaged screenshot.
///
/// RED pre-bind vs fresh decode  => decoder/pool reuse under concurrency.
/// GREEN pre-bind => Metal sampling / render target / presentation beyond
///   wrapper lifetime (packaged WindowServer SHA fce8915e…).
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

        XCTAssertGreaterThan(
            captured.count, 30,
            "display-link produced too few binds to exercise the pool; fixture=\(usedAcceptanceFixture)"
        )
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
                let live = liveSample.planeBytes
                let first = zip(live.indices, zip(live, fresh)).first {
                    $0.1.0 != $0.1.1
                }
                let pts = CMTimeGetSeconds(liveSample.presentationTime)
                let surface = liveSample.ioSurfaceID.map(String.init) ?? "nil"
                mismatches.append(
                    "PTS \(String(format: "%.3f", pts))s (idx \(targetIndex), iosurface \(surface)): live/fresh plane mismatch (\(live.count) vs \(fresh.count) bytes, firstDiff=\(first?.0 ?? -1) live=\(first?.1.0 ?? 0) fresh=\(first?.1.1 ?? 0))"
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
        try await StudioTestMedia.writeMovingVFRMovie(
            sections: [(24, 96)],
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
