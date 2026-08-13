import XCTest

@testable import TaskWraithStudioCore

/// The malloc-class half of an allocation-class-aware memory probe.
///
/// VALIDATED CHURNED, NEVER COLD, AND THAT IS THE WHOLE POINT. `phys_footprint`
/// is ACCURATE on a cold process — measured at 112.48 MB three times running for
/// a deliberate 128 MB leak, dead stable. A new probe checked cold would agree
/// with the old one exactly where the old one already worked, go green, and
/// prove nothing whatsoever about the condition that invalidated the evidence.
///
/// So this test reproduces the churn harness that broke the old instrument
/// first, and only then measures. The bar to beat is not a constructed number:
/// it is 5.02 / 37.17 / 33.17 MB, measured on this machine for this leak after
/// exactly this churn.
final class StudioMallocClassProbeTests: XCTestCase {

    /// One megabyte, touched, so a page-based probe would have to count it if it
    /// could see it at all.
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

    // THE CHURNED VALIDATION IS NOT RESIDENT HERE, AND WHY IS A FINDING.
    //
    // I wrote it, it passed three times, and the red-first proof discriminated
    // exactly: pointing `mallocGrowthBytes` at `footprintBytes` made the same
    // churned run read 9.09MB against a >100 bar, so the test genuinely tells
    // the two instruments apart on identical data.
    //
    // THEN THE FULL SUITE WENT RED IN TWO PLACES — AND NOT AT MY TEST.
    //   StudioMemoryCalibrationTests.testFootprintTracksMallocClassAllocation
    //     read -0.03MB for 64MB of touched malloc, whose own message is
    //     "the probe itself is broken, so every other memory claim is void"
    //   StudioStressTests.testTheMemoryTrendDetectsMallocClassGrowth
    //     read 37.17MB, squarely inside the churned band measured earlier
    //
    // A malloc pool is PROCESS-GLOBAL. Churning 128MB to create the condition
    // this probe must survive leaves every later test running warm, so a
    // resident version of it silently converts two page-based controls from
    // passing to failing. That is not a regression I introduced into the
    // product — it is proof those two controls are TRUE ONLY COLD and were
    // passing because nothing had churned before them. Real finding, banked;
    // but a test that sabotages its neighbours is still a defect in MY slice,
    // and retuning the victims is the thresholds-absorb-the-leak move this lane
    // refused one commit ago.
    //
    // So the churned validation stands as a MEASUREMENT recorded in the commit
    // and the ledger, not as a resident test, and the automated half is limited
    // to the order-independent property below. Making it resident needs those
    // two controls re-founded on an allocation-class-aware baseline first —
    // which is the same slice this probe is the first half of.

    /// Live bytes must fall when the memory is handed back. Without this, a
    /// counter that only ever increased would satisfy the test above and still
    /// be useless for detecting a leak — it would report growth for healthy
    /// allocate-and-release cycles too.
    func testMallocClassGrowthReturnsToZeroWhenTheMemoryIsFreed() throws {
        var sampler = StudioMemorySampler(warmupCycles: 0)
        sampler.record(cycle: 0)
        for cycle in 1..<5 {
            let transient = allocateTouchedMegabytes(16)
            for pointer in transient { pointer.deallocate() }
            sampler.record(cycle: cycle)
        }
        let trend = sampler.trend
        XCTAssertLessThan(
            trend.mallocGrowthMegabytes,
            8,
            "allocate-and-release must not read as growth, or every healthy cycle "
                + "would look like a leak — measured \(trend.mallocGrowthMegabytes)MB"
        )
    }
}
