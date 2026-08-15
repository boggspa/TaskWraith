import XCTest

@testable import TaskWraithStudioCore

/// Load-bearing proof for completion-backed texture leases.
///
/// An offscreen Metal render STRUCTURALLY CANNOT see this defect: that path
/// commits and `waitUntilCompleted`s, so the command buffer is done before
/// `render` returns and the ring never matters. Do not treat a green offscreen
/// pixel test as evidence. The packaged present-path storm is the visual proof;
/// this file proves the lease *mechanism* with a fake buffer that does not
/// complete until the test fires it.
final class StudioInFlightTextureLeaseTests: XCTestCase {
    private func makeLease() -> StudioInFlightTextureLease<Int> {
        StudioInFlightTextureLease(maxInFlight: 3)
    }

    func testWrapperSurvivesUntilItsOwnCommandBufferCompletes() {
        let lease = makeLease()
        let buffer = StudioFakeCommandBuffer()

        lease.retain(11, until: buffer)
        XCTAssertEqual(lease.count, 1)
        XCTAssertEqual(lease.frames, [11])
        XCTAssertFalse(buffer.completed)

        buffer.complete()
        XCTAssertTrue(buffer.completed)
        XCTAssertEqual(lease.count, 0)
        XCTAssertTrue(lease.frames.isEmpty)
    }

    func testCompletionNotDepthReleasesASpecificLease() {
        let lease = makeLease()
        let first = StudioFakeCommandBuffer()
        let second = StudioFakeCommandBuffer()
        let third = StudioFakeCommandBuffer()

        lease.retain(1, until: first)
        lease.retain(2, until: second)
        lease.retain(3, until: third)
        XCTAssertEqual(lease.frames, [1, 2, 3])

        second.complete()
        XCTAssertEqual(lease.frames, [1, 3], "only the completed buffer may drop its wrapper")
        XCTAssertFalse(first.completed)
        XCTAssertFalse(third.completed)

        first.complete()
        third.complete()
        XCTAssertEqual(lease.count, 0)
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

    func testCompletionBackedPathDoesNotEvictAnIncompleteOldest() {
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

    func testAtCapacityWaitsOnOldestRatherThanEvictingIt() {
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
