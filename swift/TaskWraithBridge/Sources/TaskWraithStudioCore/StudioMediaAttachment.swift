import Foundation
import Metal

/// What happened when the companion tried to open an asset the host committed.
///
/// Carries the asset's own timebase and duration because the viewer's clock
/// MUST adopt them: frame indices are meaningless against a clock built for a
/// different rate, and the container's stored rate is the muxer's choice rather
/// than anything the companion can assume.
public enum StudioMediaAttachmentOutcome: Equatable, Sendable {
    case attached(
        assetId: String,
        frameCount: Int,
        timebase: StudioTimebase,
        durationTicks: Int64
    )
    case failed(assetId: String, message: String)

    public var didAttach: Bool {
        if case .attached = self { return true }
        return false
    }
}

/// Closes the last gap between the host protocol and rendered pixels: given an
/// asset the host reported opening, load it and hand the viewer a live source.
///
/// Non-throwing by design. An unopenable asset must leave the viewer running —
/// a bad path from the host is not a reason to take the companion down — and the
/// failure has to be reportable rather than silent, which is why the outcome
/// carries the message instead of being discarded.
///
/// Attaching REPLACES any previous source, and StudioViewerRenderer.attach
/// invalidates the old one and flushes the in-flight ring, so repeated opens
/// cannot strand decompression sessions or IOSurfaces. That property is the one
/// outcome 11's twenty-source-switch case depends on.
/// MAIN-ACTOR ISOLATED ON PURPOSE. This coordinates VIEWER state: it mutates the
/// renderer's attached source, which the display link reads every refresh.
/// Marking it @unchecked Sendable to dodge the compiler would be exactly the
/// kind of unverified claim this round keeps catching — the isolation is real,
/// so it is declared.
@MainActor
public final class StudioMediaAttachment {
    private let renderer: StudioViewerRenderer

    public private(set) var attachedAssetId: String?
    public private(set) var attachedCount = 0
    public private(set) var failedCount = 0
    /// Decoded audio for the attached asset, or nil when it has none.
    public private(set) var attachedAudio: StudioAudioTrack?

    public init(renderer: StudioViewerRenderer) {
        self.renderer = renderer
    }

    /// Loads `asset` and attaches it to the viewer. Bounded by the loader's own
    /// sample cap; nothing here reads the whole file into an unbounded buffer.
    @discardableResult
    public func attach(
        asset: StudioMediaAsset,
        maxSampleCount: Int = StudioMediaSourceLoader.defaultMaxSampleCount
    ) async -> StudioMediaAttachmentOutcome {
        do {
            let loaded = try await StudioMediaSourceLoader.makeFrameSource(
                asset: asset,
                device: renderer.device,
                maxSampleCount: maxSampleCount
            )
            renderer.attach(source: loaded.source)
            attachedAssetId = asset.assetId
            attachedCount += 1
            // Audio is OPTIONAL and its absence is not a failure: plenty of real
            // media has no audio track, and refusing to show a silent clip
            // because it is silent would be absurd. A video that opens without
            // sound is a working viewer with no audio clock; a video that
            // refuses to open is a broken one.
            attachedAudio = try? await StudioAudioTrack.load(url: URL(fileURLWithPath: asset.path))
            return .attached(
                assetId: asset.assetId,
                frameCount: loaded.media.samples.count,
                timebase: loaded.media.timebase,
                durationTicks: loaded.media.durationTicks
            )
        } catch {
            failedCount += 1
            return .failed(assetId: asset.assetId, message: String(describing: error))
        }
    }

    /// Detaches the proposed source when a ghost is resolved either way.
    public func detachProposed() {
        renderer.detachProposedSource()
    }

    /// Loads `asset` as the PROPOSED source for review, leaving the current
    /// source attached. Both must be resident at once — that is what makes an
    /// A/B possible rather than a reload each time the operator toggles.
    public func attachProposed(
        asset: StudioMediaAsset,
        maxSampleCount: Int = StudioMediaSourceLoader.defaultMaxSampleCount
    ) async -> StudioMediaAttachmentOutcome {
        do {
            let loaded = try await StudioMediaSourceLoader.makeFrameSource(
                asset: asset,
                device: renderer.device,
                maxSampleCount: maxSampleCount
            )
            renderer.attachProposed(
                source: loaded.source,
                assetId: asset.assetId,
                timebase: loaded.media.timebase
            )
            return .attached(
                assetId: asset.assetId,
                frameCount: loaded.media.samples.count,
                timebase: loaded.media.timebase,
                durationTicks: loaded.media.durationTicks
            )
        } catch {
            failedCount += 1
            return .failed(assetId: asset.assetId, message: String(describing: error))
        }
    }

    /// Applies every asset a session step reported, in order. The last one wins,
    /// which matches the host's document semantics: opening a second asset
    /// replaces what the viewer is showing.
    @discardableResult
    public func attach(
        openedAssets: [StudioMediaAsset],
        maxSampleCount: Int = StudioMediaSourceLoader.defaultMaxSampleCount
    ) async -> [StudioMediaAttachmentOutcome] {
        var outcomes: [StudioMediaAttachmentOutcome] = []
        for asset in openedAssets {
            outcomes.append(await attach(asset: asset, maxSampleCount: maxSampleCount))
        }
        return outcomes
    }

    /// Detaches and invalidates whatever is attached. Idempotent.
    public func detach() {
        renderer.detachSource()
        attachedAssetId = nil
    }
}
