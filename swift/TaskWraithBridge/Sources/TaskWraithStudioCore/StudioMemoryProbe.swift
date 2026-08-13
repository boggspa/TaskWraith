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
    /// Cycles discarded before measurement began.
    public let warmupCycles: Int

    public init(samples: [StudioMemoryReading], warmupCycles: Int = 0) {
        self.samples = samples
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

    /// Whether the run stayed inside a stated budget AND did not show the leak
    /// shape. Both conditions, because either alone is escapable: a slow leak
    /// can sit inside a generous budget, and a one-off cache fill can exceed a
    /// tight one without leaking anything.
    public func isStable(withinGrowthBytes budget: Int64) -> Bool {
        !isMonotonicallyGrowing && growthBytes <= budget
    }

    public var summaryText: String {
        guard !samples.isEmpty else { return "rss --" }
        return String(
            format: "rss %.1fMB %+.1fMB%@",
            Double(samples.last?.footprintBytes ?? 0) / 1_048_576,
            growthMegabytes,
            isMonotonicallyGrowing ? " LEAK?" : ""
        )
    }
}

/// Collects a trend by running a cycle repeatedly.
public struct StudioMemorySampler {
    public let warmupCycles: Int
    private var samples: [StudioMemoryReading] = []

    /// - Parameter warmupCycles: discarded before measurement starts. Real and
    ///   necessary: the first passes fill shader caches, decoder pools and
    ///   texture caches, and that growth is legitimate one-off cost rather than
    ///   a leak. Stated explicitly rather than hidden inside the numbers.
    public init(warmupCycles: Int = 2) {
        self.warmupCycles = max(0, warmupCycles)
    }

    public mutating func record(cycle: Int) {
        guard cycle >= warmupCycles, let reading = StudioMemoryProbe.read() else { return }
        samples.append(reading)
    }

    public var trend: StudioMemoryTrend {
        StudioMemoryTrend(samples: samples, warmupCycles: warmupCycles)
    }
}
