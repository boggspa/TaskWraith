import XCTest

@testable import TaskWraithStudioCore

/// Load-bearing proof for the dual-fence texture lease.
///
/// An offscreen Metal render STRUCTURALLY CANNOT see the present-path visual
/// defect: that path commits and `waitUntilCompleted`s, so the command buffer
/// is done before `render` returns. Do not treat a green offscreen pixel test
/// as evidence. Packaged present-path capture is the visual proof; this file
/// proves the *mechanism* with a fake buffer that does not complete until the
/// test fires it.
///
/// Two retired algorithms stay as red controls:
/// - fixed-depth eviction drops an incomplete wrapper (the original storm
///   hypothesis — still true, not sufficient by itself).
/// - completion-only release drops a floor-resident wrapper (the `be63cb16e`
///   regression — packaged A/B proved it trails during ordinary playback).
final class StudioInFlightTextureLeaseTests: XCTestCase {
    private func makeLease() -> StudioInFlightTextureLease<Int> {
        StudioInFlightTextureLease(maxInFlight: 3)
    }

    func testCompletionDoesNotDropAWrapperStillInsideTheRollingFloor() {
        let lease = makeLease()
        let buffer = StudioFakeCommandBuffer()

        lease.retain(11, until: buffer)
        XCTAssertEqual(lease.count, 1)
        XCTAssertEqual(lease.frames, [11])
        XCTAssertFalse(buffer.completed)

        buffer.complete()
        XCTAssertTrue(buffer.completed)
        XCTAssertEqual(
            lease.frames,
            [11],
            "completion must not shorten the rolling floor"
        )
        XCTAssertEqual(
            StudioInFlightTextureLease<Int>.completionOnlyRetainControlResult(
                submitting: [(11, true)],
                depth: 3
            ),
            [],
            "completion-only (be63cb16e) drops a wrapper still inside the floor"
        )
    }

    func testRollingFloorSurvivesWhenEveryBufferHasCompleted() {
        let lease = makeLease()
        let buffers = (0..<3).map { _ in StudioFakeCommandBuffer() }
        for (index, buffer) in buffers.enumerated() {
            lease.retain(index + 1, until: buffer)
            buffer.complete()
        }
        XCTAssertEqual(
            lease.frames,
            [1, 2, 3],
            "ordinary playback completes every buffer and must still hold the floor"
        )
        XCTAssertEqual(
            StudioInFlightTextureLease<Int>.completionOnlyRetainControlResult(
                submitting: [(1, true), (2, true), (3, true)],
                depth: 3
            ),
            [],
            "completion-only drains to held 0 — the packaged regression"
        )
    }

    func testMiddleCompletionDoesNotDropAFloorResident() {
        let lease = makeLease()
        let first = StudioFakeCommandBuffer()
        let second = StudioFakeCommandBuffer()
        let third = StudioFakeCommandBuffer()

        lease.retain(1, until: first)
        lease.retain(2, until: second)
        lease.retain(3, until: third)
        XCTAssertEqual(lease.frames, [1, 2, 3])

        second.complete()
        XCTAssertEqual(
            lease.frames,
            [1, 2, 3],
            "a completed middle lease is still inside the rolling floor"
        )
        XCTAssertFalse(first.completed)
        XCTAssertFalse(third.completed)
    }

    func testFourthSubmitEvictsCompletedOldestWithoutWaiting() {
        let lease = makeLease()
        let buffers = (0..<4).map { _ in StudioFakeCommandBuffer() }
        for index in 0..<3 {
            lease.retain(index + 1, until: buffers[index])
            buffers[index].complete()
        }
        XCTAssertEqual(lease.frames, [1, 2, 3])

        lease.retain(4, until: buffers[3])
        XCTAssertEqual(buffers[0].waitCount, 0, "already-completed oldest must not stall")
        XCTAssertEqual(lease.frames, [2, 3, 4])
        XCTAssertEqual(lease.count, 3)
    }

    func testFixedDepthEvictionDropsAnInFlightWrapperWithoutCompletion() {
        var ring: [Int] = []
        for frame in 1...4 {
            StudioInFlightTextureLease<Int>.evictingRetainForControl(
                frame,
                into: &ring,
                depth: 3
            )
        }
        XCTAssertEqual(
            ring,
            [2, 3, 4],
            "reverting to fixed-depth eviction drops frame 1 with no completion"
        )
    }

    func testIncompleteOldestIsNotEvictedUntilItsBufferCompletes() {
        let lease = makeLease()
        let buffers = (0..<3).map { _ in StudioFakeCommandBuffer() }
        for (index, buffer) in buffers.enumerated() {
            lease.retain(index + 1, until: buffer)
        }
        XCTAssertEqual(lease.frames, [1, 2, 3])
        XCTAssertTrue(buffers.allSatisfy { !$0.completed })

        // No fourth retain: that would backpressure-wait the oldest.
        // The three wrappers must still be held because nothing completed.
        XCTAssertEqual(lease.count, 3)
        XCTAssertEqual(
            StudioInFlightTextureLease<Int>.evictingRetainControlResult(
                submitting: [1, 2, 3, 4],
                depth: 3
            ),
            [2, 3, 4]
        )
    }

    func testAtCapacityWaitsOnIncompleteOldestRatherThanEvictingIt() {
        let lease = makeLease()
        let oldest = StudioFakeCommandBuffer()
        let second = StudioFakeCommandBuffer()
        let third = StudioFakeCommandBuffer()
        let fourth = StudioFakeCommandBuffer()

        lease.retain(1, until: oldest)
        lease.retain(2, until: second)
        lease.retain(3, until: third)
        XCTAssertEqual(lease.frames, [1, 2, 3])

        // waitUntilCompleted on the fake completes that buffer (same contract
        // as Metal: wait returns only after completion handlers have run).
        lease.retain(4, until: fourth)

        XCTAssertEqual(oldest.waitCount, 1, "the fourth retain must wait, not evict")
        XCTAssertTrue(oldest.completed)
        XCTAssertEqual(lease.frames, [2, 3, 4])
        XCTAssertFalse(second.completed)
        XCTAssertFalse(third.completed)
        XCTAssertFalse(fourth.completed)
        XCTAssertEqual(lease.count, 3, "backpressure keeps the bound")
    }

    func testReleaseAllDropsLeasesWithoutWaiting() {
        let lease = makeLease()
        let buffer = StudioFakeCommandBuffer()
        lease.retain(7, until: buffer)
        lease.retainSeeding(8)
        XCTAssertEqual(lease.count, 2)

        lease.releaseAll()
        XCTAssertEqual(lease.count, 0)
        buffer.complete()
        XCTAssertEqual(lease.count, 0, "a late completion must be idempotent")
    }

    func testSeedingRemainsDepthBounded() {
        let lease = makeLease()
        for frame in 1...10 {
            lease.retainSeeding(frame)
        }
        XCTAssertEqual(lease.frames, [8, 9, 10])
    }
}

extension StudioInFlightTextureLease {
    /// Convenience so the eviction red-control reads as one expression.
    static func evictingRetainControlResult(submitting frames: [Frame], depth: Int) -> [Frame] {
        var ring: [Frame] = []
        for frame in frames {
            evictingRetainForControl(frame, into: &ring, depth: depth)
        }
        return ring
    }
}

/// Instrumentable command buffer: does not complete until `complete()` or a
/// `waitUntilCompleted()` that stands in for Metal's blocking wait.
final class StudioFakeCommandBuffer: StudioCommandBufferLifetime, @unchecked Sendable {
    private let lock = NSLock()
    private var handlers: [@Sendable () -> Void] = []
    private(set) var completed = false
    private(set) var waitCount = 0

    func addCompletedHandler(_ handler: @escaping @Sendable () -> Void) {
        lock.lock()
        if completed {
            lock.unlock()
            handler()
            return
        }
        handlers.append(handler)
        lock.unlock()
    }

    func waitUntilCompleted() {
        lock.lock()
        waitCount += 1
        if completed {
            lock.unlock()
            return
        }
        completed = true
        let pending = handlers
        handlers.removeAll()
        lock.unlock()
        for handler in pending {
            handler()
        }
    }

    func complete() {
        lock.lock()
        if completed {
            lock.unlock()
            return
        }
        completed = true
        let pending = handlers
        handlers.removeAll()
        lock.unlock()
        for handler in pending {
            handler()
        }
    }
}
