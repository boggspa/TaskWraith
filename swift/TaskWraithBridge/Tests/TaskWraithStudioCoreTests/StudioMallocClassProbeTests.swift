import XCTest

@testable import TaskWraithStudioCore

/// The malloc-class half of an allocation-class-aware memory probe.
///
/// Malloc-zone statistics are measured from the process, but test data for the
/// stability verdict is synthetic on purpose: running allocator churn in a
/// shared XCTest process makes later page-metric controls order-dependent.
final class StudioMallocClassProbeTests: XCTestCase {

    private func allocateTouchedMegabytes(_ count: Int) -> [UnsafeMutableRawPointer] {
        var pointers: [UnsafeMutableRawPointer] = []
        pointers.reserveCapacity(count)
        for _ in 0..<count {
            let bytes = 1_048_576
            let pointer = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: 8)
            memset(pointer, 1, bytes)
            pointers.append(pointer)
        }
        return pointers
    }

    private func deallocate(_ pointers: inout [UnsafeMutableRawPointer]) {
        for pointer in pointers { pointer.deallocate() }
        pointers.removeAll()
    }

    /// The real malloc probe must distinguish retained allocator growth after
    /// warm-pool reuse. No footprint or RSS assertion belongs here: allocator
    /// page reuse is the condition that made those controls non-load-bearing.
    func testLiveMallocProbeDetectsRetainedGrowthAfterAllocatorChurn() throws {
        var churn = allocateTouchedMegabytes(128)
        deallocate(&churn)

        let baseline = try XCTUnwrap(StudioMemoryProbe.read())
        var retained = allocateTouchedMegabytes(128)
        defer { deallocate(&retained) }
        let afterRetention = try XCTUnwrap(StudioMemoryProbe.read())

        let trend = StudioMemoryTrend(
            samples: [baseline, baseline, afterRetention],
            liveIOSurfaceIDSamples: [[], [], []]
        )

        XCTAssertGreaterThan(
            trend.mallocGrowthMegabytes,
            100,
            "the live malloc probe missed 128MB retained after allocator churn: "
                + "\(trend.mallocGrowthMegabytes)MB"
        )
        XCTAssertFalse(
            trend.isStable(withinGrowthBytes: 32 * 1_048_576, surfaceCountLimit: 6),
            "the integrated verdict called live retained malloc stable: \(trend.summaryText)"
        )
    }

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
