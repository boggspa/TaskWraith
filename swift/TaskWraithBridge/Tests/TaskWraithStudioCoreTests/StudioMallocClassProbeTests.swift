import XCTest

@testable import TaskWraithStudioCore

/// The malloc-class half of an allocation-class-aware memory probe.
///
/// Malloc-zone statistics are measured from the process, but test data for the
/// stability verdict is synthetic on purpose: running allocator churn in a
/// shared XCTest process makes later page-metric controls order-dependent.
final class StudioMallocClassProbeTests: XCTestCase {

    /// This confirms the process probe is live without allocating or warming the
    /// shared malloc pool. Growth behaviour belongs to deterministic trend
    /// controls below, where suite order cannot alter the observation.
    func testProbeReportsLiveMallocBytesWithoutTestSideAllocation() throws {
        let reading = try XCTUnwrap(StudioMemoryProbe.read())
        XCTAssertGreaterThan(
            reading.mallocInUseBytes,
            0,
            "malloc-zone statistics returned no live process allocation"
        )
    }

    /// A healthy allocate-and-release shape returns to the same malloc baseline.
    /// The readings are intentionally synthetic: allocating to manufacture this
    /// shape would perturb every later page-metric test in the shared process.
    func testMallocClassGrowthReturnsToBaselineWithoutPageGrowth() {
        let trend = StudioMemoryTrend(
            samples: [
                StudioMemoryReading(
                    footprintBytes: 200 * 1_048_576,
                    residentBytes: 160 * 1_048_576,
                    mallocInUseBytes: 20 * 1_048_576
                ),
                StudioMemoryReading(
                    footprintBytes: 200 * 1_048_576,
                    residentBytes: 160 * 1_048_576,
                    mallocInUseBytes: 84 * 1_048_576
                ),
                StudioMemoryReading(
                    footprintBytes: 200 * 1_048_576,
                    residentBytes: 160 * 1_048_576,
                    mallocInUseBytes: 20 * 1_048_576
                ),
            ],
            liveIOSurfaceIDSamples: [[], [], []]
        )

        XCTAssertEqual(trend.mallocGrowthBytes, 0)
        XCTAssertTrue(
            trend.isStable(withinGrowthBytes: 24 * 1_048_576, surfaceCountLimit: 6),
            "an allocate-and-release shape must stay stable: \(trend.summaryText)"
        )
    }
}
