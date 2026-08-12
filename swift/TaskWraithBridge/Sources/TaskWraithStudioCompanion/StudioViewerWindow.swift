import AppKit
import Metal
import QuartzCore
import TaskWraithStudioCore

/// AppKit window + CAMetalLayer shell for the Studio viewer.
///
/// SCOPE HONESTY: this is the presentation shell only. It puts a real
/// Metal-rendered frame on a real NSWindow driven by the one playback clock. It
/// does NOT establish app identity, accessibility, keyboard ACCEPTANCE, or
/// packaging — those need a signed bundle and are outcome 10, deliberately not
/// claimed from this slice. The keyboard handling below is a transport
/// convenience for exercising the clock by hand, not an accessibility
/// implementation.
///
/// The window path is intentionally NOT unit-tested: correctness of the render
/// path is proven headlessly by StudioViewerRendererTests, which asserts
/// actual rendered pixel values. This file is the thin glue that cannot be
/// asserted without a GUI session.

/// Layer-backed view whose backing layer is a CAMetalLayer. Frames are rendered
/// straight into the drawable's texture — nothing is converted to a CGImage and
/// assigned to `layer.contents`.
final class StudioViewerView: NSView {
    /// macOS virtual key codes for the transport keys.
    private enum Key {
        static let space: UInt16 = 49
        static let leftArrow: UInt16 = 123
        static let rightArrow: UInt16 = 124
    }

    private let renderer: StudioViewerRenderer
    private var clock: StudioPlaybackClock
    private var frameLink: CADisplayLink?

    /// Minimal viewer diagnostics (mission outcome 9 groundwork). Counted here
    /// because the display-link callback is the only place that can observe a
    /// missed drawable. Content-level counters live on StudioViewerRenderer.
    private(set) var presentedFrameCount: Int = 0
    private(set) var missedDrawableCount: Int = 0
    private(set) var droppedFrameCount: Int = 0

    init(renderer: StudioViewerRenderer, clock: StudioPlaybackClock) {
        self.renderer = renderer
        self.clock = clock
        super.init(frame: NSRect(x: 0, y: 0, width: 960, height: 540))
        wantsLayer = true
        layerContentsRedrawPolicy = .duringViewResize
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("StudioViewerView is created in code only")
    }

    // MARK: - Layer

    override func makeBackingLayer() -> CALayer {
        let metalLayer = CAMetalLayer()
        metalLayer.device = renderer.device
        metalLayer.pixelFormat = StudioTestPatternRenderer.pixelFormat
        // The viewer only ever renders into the drawable, never reads it back,
        // so the driver may pick the cheaper framebuffer-only path.
        metalLayer.framebufferOnly = true
        metalLayer.isOpaque = true
        metalLayer.allowsNextDrawableTimeout = true
        return metalLayer
    }

    private var metalLayer: CAMetalLayer? {
        layer as? CAMetalLayer
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateDrawableSize()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateDrawableSize()
    }

    private func updateDrawableSize() {
        guard let metalLayer else { return }
        let scale = window?.backingScaleFactor ?? 2.0
        metalLayer.contentsScale = scale
        metalLayer.drawableSize = CGSize(
            width: max(1, bounds.width * scale),
            height: max(1, bounds.height * scale)
        )
    }

    // MARK: - Display link

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        frameLink?.invalidate()
        frameLink = nil
        guard window != nil else {
            // Viewer closed: release the decoder and its texture cache now
            // rather than waiting for ARC, so close/reopen cycles cannot
            // accumulate decompression sessions.
            renderer.detachSource()
            return
        }

        updateDrawableSize()
        clock.play(atHost: CACurrentMediaTime())

        let link = displayLink(target: self, selector: #selector(handleDisplayLink(_:)))
        link.add(to: .main, forMode: .common)
        frameLink = link
    }

    @objc
    private func handleDisplayLink(_ link: CADisplayLink) {
        renderCurrentFrame()
    }

    /// One display refresh: ask THE clock which frame is current, then draw it.
    /// The view never keeps its own playhead.
    private func renderCurrentFrame() {
        guard let metalLayer else { return }
        let snapshot = clock.snapshot(atHost: CACurrentMediaTime())
        guard let drawable = metalLayer.nextDrawable() else {
            missedDrawableCount += 1
            return
        }
        // All content selection and failure policy lives in StudioViewerRenderer
        // (Core) so it is covered by StudioViewerRendererTests; this stays glue.
        // Non-throwing by design: one bad frame must not take the viewer down.
        let outcome = renderer.render(
            snapshot: snapshot,
            to: drawable.texture,
            presenting: drawable
        )
        if outcome.didDraw {
            presentedFrameCount += 1
        } else {
            // Nothing was encoded, so the drawable is released unpresented —
            // a genuine dropped frame rather than a stale or synthetic one.
            droppedFrameCount += 1
        }
    }

    /// Rebuilds the clock around a newly opened asset.
    ///
    /// The asset's timebase is authoritative: frame indices computed against a
    /// different rate address the wrong pictures, and the container's stored
    /// rate is the muxer's choice rather than anything the viewer can assume.
    func adopt(timebase: StudioTimebase, durationTicks: Int64) {
        clock = StudioPlaybackClock(timebase: timebase, durationTicks: durationTicks)
        clock.play(atHost: CACurrentMediaTime())
    }

    // MARK: - Transport keys

    override var acceptsFirstResponder: Bool { true }

    override func keyDown(with event: NSEvent) {
        let host = CACurrentMediaTime()
        switch event.keyCode {
        case Key.space:
            if clock.snapshot(atHost: host).isPlaying {
                clock.pause(atHost: host)
            } else {
                clock.play(atHost: host)
            }
        case Key.leftArrow:
            clock.stepFrames(-1, atHost: host)
        case Key.rightArrow:
            clock.stepFrames(1, atHost: host)
        default:
            super.keyDown(with: event)
        }
    }
}

/// Owns the viewer window. Held strongly by StudioViewerApp because
/// `NSApplication.delegate` and `NSWindow` do not retain it for us.
@MainActor
final class StudioViewerWindowController {
    let window: NSWindow
    private let view: StudioViewerView

    init(renderer: StudioViewerRenderer) {
        // durationTicks 0 means "unbounded": the synthetic pattern has no end.
        // A real source replaces this with the decoded asset's duration.
        let clock = StudioPlaybackClock(timebase: .ntsc2997, durationTicks: 0)
        view = StudioViewerView(renderer: renderer, clock: clock)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 540),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "TaskWraith Studio — Source"
        window.contentView = view
        window.center()
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(view)
    }

    func adopt(timebase: StudioTimebase, durationTicks: Int64) {
        view.adopt(timebase: timebase, durationTicks: durationTicks)
    }
}

/// Main-thread home for the live viewer, so the stdio pump can hand over an
/// opened asset without any non-Sendable state crossing a thread boundary: only
/// StudioMediaAsset values travel, and everything else is looked up here.
@MainActor
final class StudioViewerAppState {
    static var shared: StudioViewerAppState?

    let controller: StudioViewerWindowController
    let attachment: StudioMediaAttachment

    init(controller: StudioViewerWindowController, renderer: StudioViewerRenderer) {
        self.controller = controller
        self.attachment = StudioMediaAttachment(renderer: renderer)
    }

    /// Opens each asset the host committed and points the clock at the last one
    /// that actually loaded. Failures are reported to stderr rather than being
    /// swallowed or crashing the viewer.
    func open(assets: [StudioMediaAsset]) async {
        for outcome in await attachment.attach(openedAssets: assets) {
            switch outcome {
            case .attached(let assetId, let frameCount, let timebase, let durationTicks):
                controller.adopt(timebase: timebase, durationTicks: durationTicks)
                Self.report("opened \(assetId) (\(frameCount) frames)")
            case .failed(let assetId, let message):
                Self.report("could not open \(assetId): \(message)")
            }
        }
    }

    private static func report(_ note: String) {
        if let data = "taskwraith-studio-companion: \(note)\n".data(using: .utf8) {
            FileHandle.standardError.write(data)
        }
    }
}

/// Entry point for `--viewer`. Production launch still uses the headless stdio
/// path; this flag is the seam that gets flipped once the viewer is wired into
/// the host's supervisor lifecycle.
enum StudioViewerApp {
    @MainActor private static var retainedController: StudioViewerWindowController?

    @MainActor
    static func run(hydrateOnce: Bool) -> Never {
        let renderer: StudioViewerRenderer
        do {
            renderer = try StudioViewerRenderer.makeDefault()
        } catch {
            // No Metal device, or the shader/pipeline failed: fall back to the
            // proven headless behaviour rather than dying, and say why.
            let note = "taskwraith-studio-companion: viewer unavailable (\(error)); running headless\n"
            if let data = note.data(using: .utf8) {
                FileHandle.standardError.write(data)
            }
            exit(StudioCompanionStdioPump.run(hydrateOnce: hydrateOnce))
        }

        // AppKit must own the main thread, so the protocol pump moves to its own
        // thread. It exits the process on EOF exactly as the headless path does.
        // Opened assets hop to the main actor as plain Sendable identities; the
        // renderer itself never crosses a thread boundary.
        let pumpThread = Thread {
            exit(
                StudioCompanionStdioPump.run(hydrateOnce: hydrateOnce) { assets in
                    Task { @MainActor in
                        await StudioViewerAppState.shared?.open(assets: assets)
                    }
                }
            )
        }
        pumpThread.name = "taskwraith-studio-stdio"
        pumpThread.start()

        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let controller = StudioViewerWindowController(renderer: renderer)
        retainedController = controller
        StudioViewerAppState.shared = StudioViewerAppState(
            controller: controller,
            renderer: renderer
        )
        controller.show()
        application.activate()
        application.run()
        exit(0)
    }
}
