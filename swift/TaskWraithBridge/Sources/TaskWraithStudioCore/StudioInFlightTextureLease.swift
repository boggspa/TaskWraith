import Foundation
import Metal

/// Lifetime surface for one submitted command buffer.
///
/// Extracted so tests can inject a buffer that does **not** complete until
/// asked. `MTLCommandBuffer` already has these methods; the protocol exists so
/// a fake can prove each fence independently.
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

/// Holds frames (and therefore their `CVMetalTexture` wrappers) until **both**
/// fences have cleared:
///
/// 1. Rolling floor — the last `maxInFlight` submitted frames stay strong,
///    whether or not their command buffers have completed. CAMetalLayer still
///    displays recently presented IOSurfaces after GPU completion; the old
///    three-frame ring was load-bearing for that display lifetime.
/// 2. Command completion — a frame may not leave the box until *its* command
///    buffer's `addCompletedHandler` has fired. At capacity the next retain
///    waits on the oldest incomplete buffer instead of evicting it.
///
/// Packaged A/B on 2026-08-15 proved completion-only (`be63cb16e`) is a visual
/// regression: ordinary 3s playback trailed with `held 0`, while restoring
/// only the renderer hunk to the pre-lease ring (`held 3`) was clean. Do not
/// drop a floor-resident wrapper just because its buffer completed.
///
/// BOUNDED: live count cannot exceed `maxInFlight`. The completion fence can
/// only *delay* an eviction, never grow the box.
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
        var completed: Bool
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

    /// Present / chaining path: hold `frame` until both fences clear.
    func retain(_ frame: Frame, until buffer: any StudioCommandBufferLifetime) {
        lock.lock()
        while leases.count >= maxInFlight {
            if leases[0].completed {
                leases.removeFirst()
                continue
            }
            let oldest = leases[0]
            lock.unlock()
            oldest.buffer.waitUntilCompleted()
            lock.lock()
        }
        let id = nextID
        nextID += 1
        leases.append(Lease(id: id, frame: frame, buffer: buffer, completed: false))
        lock.unlock()

        buffer.addCompletedHandler { [weak self] in
            self?.markCompleted(id: id)
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

    private func markCompleted(id: UInt64) {
        lock.lock()
        if let index = leases.firstIndex(where: { $0.id == id }) {
            leases[index].completed = true
        }
        // Completion alone must not drop a wrapper still inside the floor.
        // Eviction happens on the next retain that pushes it past maxInFlight.
        lock.unlock()
    }

    /// The retired fixed-depth algorithm, kept so a test can prove that
    /// reverting to it drops a wrapper before its buffer completes.
    static func evictingRetainForControl(_ frame: Frame, into ring: inout [Frame], depth: Int) {
        ring.append(frame)
        if ring.count > depth {
            ring.removeFirst(ring.count - depth)
        }
    }

    /// The retired completion-only algorithm (`be63cb16e`): drop a wrapper the
    /// moment its buffer completes, even when it is still inside the last
    /// `depth` submitted frames. Packaged A/B proved this shortens a load-bearing
    /// display lifetime.
    static func completionOnlyRetainControlResult(
        submitting frames: [(frame: Frame, completed: Bool)],
        depth: Int
    ) -> [Frame] {
        var live: [(frame: Frame, completed: Bool)] = []
        for item in frames {
            live.append(item)
            live.removeAll { $0.completed }
            if live.count > depth {
                live.removeFirst(live.count - depth)
            }
        }
        return live.map(\.frame)
    }
}
