import CoreMedia
import XCTest

@testable import TaskWraithStudioCore

/// Silent-attachment GOP map. The acceptance fixture omits DependsOnOthers;
/// treating that as intra is what made every backward seek decode a P-frame.
final class StudioSyncSampleTests: XCTestCase {
    func testGeneratedInterCodedMovieKeepsExplicitDependentFlags() async throws {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeMovingVFRMovie(
            sections: [(24, 48)],
            to: url,
            width: 128,
            height: 72,
            maxKeyFrameInterval: 16
        )
        let media = try await StudioMediaSourceLoader.loadBounded(
            asset: StudioMediaAsset(assetId: "sync-vfr", path: url.path, mediaKind: .video)
        )
        let count = media.sampleProvider.sampleCount
        let syncCount = (0..<count).reduce(0) {
            $0 + (media.sampleProvider.metadata(atDecodeIndex: $1).isSyncSample ? 1 : 0)
        }
        XCTAssertGreaterThan(count, 16)
        XCTAssertGreaterThan(syncCount, 0)
        XCTAssertLessThan(syncCount, count)
        XCTAssertTrue(
            media.sampleProvider.metadata(atDecodeIndex: 0).isSyncSample,
            "decode must still be able to start"
        )
    }

    func testAcceptanceFixtureIsNotAllIntraOnceSilentAttachmentsAreInspected() async throws {
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(
                ".local-only/taskwraith-studio/acceptance/w1acc10e/studio-vfr-10m.mp4"
            )
        guard FileManager.default.isReadableFile(atPath: fixture.path) else {
            throw XCTSkip("acceptance fixture not present")
        }
        let media = try await StudioMediaSourceLoader.loadBounded(
            asset: StudioMediaAsset(
                assetId: "acceptance-vfr",
                path: fixture.path,
                mediaKind: .video
            )
        )
        let count = media.sampleProvider.sampleCount
        let syncCount = (0..<count).reduce(0) {
            $0 + (media.sampleProvider.metadata(atDecodeIndex: $1).isSyncSample ? 1 : 0)
        }
        XCTAssertEqual(count, 22_800)
        XCTAssertTrue(media.sampleProvider.metadata(atDecodeIndex: 0).isSyncSample)
        XCTAssertLessThan(
            syncCount,
            count / 4,
            "silent attachments still look all-intra; sync=\(syncCount)/\(count)"
        )
        XCTAssertGreaterThan(syncCount, 50, "lost the real IDR map; sync=\(syncCount)")
        XCTAssertFalse(media.allSamplesAreSyncSamples)
    }
}
