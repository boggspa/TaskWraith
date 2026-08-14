import Darwin
import Foundation

/// Process memory, measured (mission outcome 9's RSS, and the instrument
/// outcome 11's stress matrix is judged by).
///
/// TWO NUMBERS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
/// * `footprintBytes` is `phys_footprint` — what Activity Monitor and Xcode call
///   "Memory", and what a macOS jetsam decision is actually made against. It
///   accounts for compressed and purgeable pages, so it does not collapse just
///   because the system compressed something.
/// * `residentBytes` is the classic RSS. Kept because the mission names RSS
///   explicitly and because a divergence between the two is itself informative.
///
/// Both are read from the kernel via task_info; nothing here estimates.
/// * `mallocInUseBytes` is LIVE ALLOCATED BYTES, and it is here because the
///   other two were measured blind. Both figures above count PAGES THE PROCESS
///   OWNS, so once the allocator holds a pool of already-mapped freed pages a
///   new allocation is served from that pool and neither number moves. Measured
///   on a deliberate 128 MB leak: 112.48 MB cold, but 5.02/37.17/33.17 MB after
///   a 128 MB allocate-and-free churn — a 22x swing and up to ~96% blind, worst
///   in exactly the warm, churn-heavy condition S1-S10 exists to probe.
///   `malloc_zone_statistics` reports bytes HANDED OUT rather than pages mapped,
///   so page reuse cannot hide a leak from it.
public struct StudioMemoryReading: Equatable, Sendable {
    public let footprintBytes: UInt64
    public let residentBytes: UInt64
    /// Live bytes currently handed out by every malloc zone.
    public let mallocInUseBytes: UInt64

    public init(footprintBytes: UInt64, residentBytes: UInt64, mallocInUseBytes: UInt64) {
        self.footprintBytes = footprintBytes
        self.residentBytes = residentBytes
        self.mallocInUseBytes = mallocInUseBytes
    }

    public var footprintMegabytes: Double { Double(footprintBytes) / 1_048_576 }
}

public enum StudioMemoryProbe {
    /// Current process memory, or nil when the kernel refuses the query.
    ///
    /// Nil rather than zero: "could not measure" and "measured zero" are
    /// different claims, and a stress report that silently treats a failed
    /// query as 0 bytes would read as a spectacular improvement.
    public static func read() -> StudioMemoryReading? {
        var vmInfo = task_vm_info_data_t()
        var vmCount = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size
        )
        let vmResult = withUnsafeMutablePointer(to: &vmInfo) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(vmCount)) { rebound in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &vmCount)
            }
        }
        guard vmResult == KERN_SUCCESS else { return nil }

        var basicInfo = mach_task_basic_info_data_t()
        var basicCount = mach_msg_type_number_t(
            MemoryLayout<mach_task_basic_info_data_t>.size / MemoryLayout<natural_t>.size
        )
        let basicResult = withUnsafeMutablePointer(to: &basicInfo) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(basicCount)) { rebound in
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), rebound, &basicCount)
            }
        }
        guard basicResult == KERN_SUCCESS else { return nil }

        // Passing a nil zone sums every zone, which is what a process-wide
        // figure has to mean. No failure code to check: this one cannot refuse.
        var mallocStats = malloc_statistics_t()
        malloc_zone_statistics(nil, &mallocStats)

        return StudioMemoryReading(
            footprintBytes: UInt64(vmInfo.phys_footprint),
            residentBytes: basicInfo.resident_size,
            mallocInUseBytes: UInt64(mallocStats.size_in_use)
        )
    }
}

/// A series of memory readings across repetitions of a stress cycle, and the
/// judgement about whether they describe a leak.
///
/// WHY MONOTONICITY IS THE TEST AND A DELTA IS NOT. Process memory is noisy:
/// allocators round up, the system compresses pages, caches warm. A single
/// before/after delta therefore proves nothing in either direction — it can be
/// large without a leak and small with one. What a leak actually looks like is
/// memory that goes up EVERY cycle and never comes back, and that shape is
/// statistically distinctive: for readings that merely wobble, the chance of ten
/// consecutive increases is 1/10! — about three in ten million. Monotonic growth
/// over enough cycles is a real signal; a delta is an anecdote.
public struct StudioMemoryTrend: Equatable, Sendable {
    public let samples: [StudioMemoryReading]
    /// Live IOSurface identities held at the same point as each memory sample.
    ///
    /// These are SETS, not a cumulative "ever seen" counter: a bounded decoder
    /// cache is allowed to recycle one surface for another. A leak is a live set
    /// that grows or exceeds the bound, not ordinary cache turnover.
    public let liveIOSurfaceIDSamples: [Set<UInt32>]
    /// Cycles discarded before measurement began.
    public let warmupCycles: Int

    public init(
        samples: [StudioMemoryReading],
        warmupCycles: Int = 0,
        liveIOSurfaceIDSamples: [Set<UInt32>]
    ) {
        precondition(
            liveIOSurfaceIDSamples.count == samples.count,
            "IOSurface samples must align with memory samples"
        )
        self.samples = samples
        self.liveIOSurfaceIDSamples = liveIOSurfaceIDSamples
        self.warmupCycles = warmupCycles
    }

    /// True when EVERY sample exceeds the one before it.
    ///
    /// This is the leak shape. Two samples cannot establish it — a single
    /// increase is noise — so fewer than three readings answers false rather
    /// than pretending to know.
    public var isMonotonicallyGrowing: Bool {
        guard samples.count >= 3 else { return false }
        for index in 1..<samples.count
        where samples[index].footprintBytes <= samples[index - 1].footprintBytes {
            return false
        }
        return true
    }

    /// Signed growth from first measured sample to last. May be negative.
    public var growthBytes: Int64 {
        guard let first = samples.first, let last = samples.last else { return 0 }
        return Int64(bitPattern: last.footprintBytes) - Int64(bitPattern: first.footprintBytes)
    }

    public var peakFootprintBytes: UInt64 {
        samples.map(\.footprintBytes).max() ?? 0
    }

    public var growthMegabytes: Double { Double(growthBytes) / 1_048_576 }

    /// Signed growth in LIVE ALLOCATED BYTES — the allocation class the two
    /// page-based figures cannot see once the allocator is warm.
    public var mallocGrowthBytes: Int64 {
        guard let first = samples.first, let last = samples.last else { return 0 }
        return Int64(bitPattern: last.mallocInUseBytes) - Int64(bitPattern: first.mallocInUseBytes)
    }

    public var mallocGrowthMegabytes: Double { Double(mallocGrowthBytes) / 1_048_576 }

    /// The largest simultaneous live IOSurface set. Surface identity is the
    /// layer at which decoder-pool reuse is observable; a texture wrapper
    /// identity is too high to prove retention.
    public var peakLiveIOSurfaceCount: Int {
        liveIOSurfaceIDSamples.map(\.count).max() ?? 0
    }

    /// Detects three consecutive samples where the live IOSurface set only
    /// accumulates. A bounded cache may replace one identity with another, but
    /// it must not retain every old identity while adding new ones.
    public var hasGrowingLiveIOSurfaceRetention: Bool {
        guard liveIOSurfaceIDSamples.count >= 3 else { return false }
        for index in 2..<liveIOSurfaceIDSamples.count {
            let first = liveIOSurfaceIDSamples[index - 2]
            let second = liveIOSurfaceIDSamples[index - 1]
            let third = liveIOSurfaceIDSamples[index]
            let firstGrows = first.isSubset(of: second) && first != second
            let secondGrows = second.isSubset(of: third) && second != third
            if firstGrows && secondGrows {
                return true
            }
        }
        return false
    }

    /// Whether every allocation class stayed inside the stated budget and none
    /// reports a leak shape. RSS/phys_footprint remain reported because they are
    /// required operational signals; neither may stand in for malloc zones or
    /// live IOSurface retention after allocator/cache warm-up.
    public func isStable(
        withinGrowthBytes budget: Int64,
        surfaceCountLimit: Int
    ) -> Bool {
        !isMonotonicallyGrowing
            && growthBytes <= budget
            && mallocGrowthBytes <= budget
            && peakLiveIOSurfaceCount <= surfaceCountLimit
            && !hasGrowingLiveIOSurfaceRetention
    }

    public var summaryText: String {
        guard !samples.isEmpty else { return "rss --" }
        let leakMarker =
            isMonotonicallyGrowing || hasGrowingLiveIOSurfaceRetention
            ? " LEAK?"
            : ""
        return String(
            format: "rss %.1fMB %+.1fMB malloc %+.1fMB iosurf %d%@",
            Double(samples.last?.footprintBytes ?? 0) / 1_048_576,
            growthMegabytes,
            mallocGrowthMegabytes,
            peakLiveIOSurfaceCount,
            leakMarker
        )
    }
}

/// Collects a trend by running a cycle repeatedly.
public struct StudioMemorySampler {
    public let warmupCycles: Int
    private var samples: [StudioMemoryReading] = []
    private var liveIOSurfaceIDSamples: [Set<UInt32>] = []

    /// - Parameter warmupCycles: discarded before measurement starts. Real and
    ///   necessary: the first passes fill shader caches, decoder pools and
    ///   texture caches, and that growth is legitimate one-off cost rather than
    ///   a leak. Stated explicitly rather than hidden inside the numbers.
    public init(warmupCycles: Int = 2) {
        self.warmupCycles = max(0, warmupCycles)
    }

    /// Records page/malloc memory and the live decoder-surface set together.
    /// Empty is meaningful for a path that owns no IOSurface-backed frames.
    public mutating func record(cycle: Int, liveIOSurfaceIDs: Set<UInt32>) {
        guard cycle >= warmupCycles, let reading = StudioMemoryProbe.read() else { return }
        samples.append(reading)
        liveIOSurfaceIDSamples.append(liveIOSurfaceIDs)
    }

    public var trend: StudioMemoryTrend {
        StudioMemoryTrend(
            samples: samples,
            warmupCycles: warmupCycles,
            liveIOSurfaceIDSamples: liveIOSurfaceIDSamples
        )
    }
}
