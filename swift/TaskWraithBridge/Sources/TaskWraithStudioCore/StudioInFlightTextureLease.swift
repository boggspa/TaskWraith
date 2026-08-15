import Foundation
import Metal

/// Lifetime surface for one submitted command buffer.
///
/// Extracted so tests can inject a buffer that does **not** complete until
/// asked. `MTLCommandBuffer` already has these methods; the protocol exists so
/// a fake can prove the lease is driven by completion rather than by depth.
protocol StudioCommandBufferLifetime: AnyObject {
    func addCompletedHandler(_ handler: @escaping @Sendable () -> Void)
    func waitUntilCompleted()
}

/// Adapts a real Metal command buffer onto `StudioCommandBufferLifetime`.
/// The handler ignores the buffer argument so the lease only needs a Sendable
/// id, not the non-Sendable `CVMetalTexture` wrappers.
final class StudioMetalCommandBufferLifetime: StudioCommandBufferLifetime {
    private let buffer: any MTLCommandBuffer

    init(_ buffer: any MTLCommandBuffer) {
        self.buffer = buffer
    }

    func addCompletedHandler(_ handler: @escaping @Sendable () -> Void) {
        buffer.addCompletedHandler { _ in handler() }
    }

    func waitUntilCompleted() {
        buffer.waitUntilCompleted()
    }
}

/// Holds frames (and therefore their `CVMetalTexture` wrappers) until the
/// command buffer that samples them completes.
///
/// THIS REPLACES THE FIXED-DEPTH RING. A three-frame FIFO is a heuristic
/// proxy for GPU completion: under a present-path storm the ring stays
/// saturated and the oldest wrapper is evicted whether or not its command
/// buffer has finished. CoreVideo requires each wrapper to stay strong until
/// that completion. The handler captures only a `Sendable` lease id; the
/// non-Sendable wrappers stay inside this lock-protected box.
///
/// BOUNDED: if `maxInFlight` leases are already live, the next retain waits
/// on the oldest buffer instead of evicting it. That is backpressure, not
/// unbounded retention, and it matches CAMetalLayer's three-drawable stall.
final class StudioInFlightTextureLease<Frame>: @unchecked Sendable {
    let maxInFlight: Int

    private let lock = NSLock()
    private var nextID: UInt64 = 1
    private var leases: [Lease] = []
    private var seeded: [Frame] = []

    private struct Lease {
        let id: UInt64
        let frame: Frame
        let buffer: any StudioCommandBufferLifetime
    }

    init(maxInFlight: Int) {
        precondition(maxInFlight > 0)
        self.maxInFlight = maxInFlight
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return leases.count + seeded.count
    }

    var frames: [Frame] {
        lock.lock()
        defer { lock.unlock() }
        return leases.map(\.frame) + seeded
    }

    /// Present / chaining path: hold `frame` until `buffer` completes.
    func retain(_ frame: Frame, until buffer: any StudioCommandBufferLifetime) {
        lock.lock()
        if leases.count >= maxInFlight {
            let oldest = leases[0]
            lock.unlock()
            oldest.buffer.waitUntilCompleted()
            release(id: oldest.id)
            lock.lock()
        }
        let id = nextID
        nextID += 1
        leases.append(Lease(id: id, frame: frame, buffer: buffer))
        lock.unlock()

        buffer.addCompletedHandler { [weak self] in
            self?.release(id: id)
        }
    }

    /// Test / attach-detach seed: hold without a command buffer.
    /// Still depth-bounded so a forgotten seed cannot grow. This is **not**
    /// the present-path contract.
    func retainSeeding(_ frame: Frame) {
        lock.lock()
        defer { lock.unlock() }
        seeded.append(frame)
        if seeded.count > maxInFlight {
            seeded.removeFirst(seeded.count - maxInFlight)
        }
    }

    func releaseAll() {
        lock.lock()
        leases.removeAll(keepingCapacity: true)
        seeded.removeAll(keepingCapacity: true)
        lock.unlock()
    }

    private func release(id: UInt64) {
        lock.lock()
        leases.removeAll { $0.id == id }
        lock.unlock()
    }

    /// The retired fixed-depth algorithm, kept only so a test can prove that
    /// reverting to it drops a wrapper before its buffer completes.
    static func evictingRetainForControl(_ frame: Frame, into ring: inout [Frame], depth: Int) {
        ring.append(frame)
        if ring.count > depth {
            ring.removeFirst(ring.count - depth)
        }
    }
}
