import CoreMedia
import Foundation
import IOSurface

/// Observes application ownership. No token owns its measured resource, and no
/// observation clears a cache, renders a frame, or changes a resource lifetime.
/// Framework/driver retention remains opaque and needs process memory evidence.
public enum StudioResourceDiagnostics {
    static let census = StudioResourceCensus()
    static let videoFields = [
        "decoderSessions", "activeDecodeOperations", "pendingSourceLoads", "frameObjects",
        "decodedFrameObjects", "planeTextures", "ioSurfaces", "ioSurfaceBytes",
        "gpuCommandFrameHolds", "presentationLeases", "presentationLeaseCapacity",
        "reorderCacheEntries", "reorderCacheCapacity", "compressedCacheEntries",
        "compressedCacheCapacity", "compressedCacheBytes",
    ]
    static let audioFields = [
        "playerObjects", "engineObjects", "runningEngines", "attachedTracks", "playingPlayers",
        "playersWithQueuedOutput", "queuedBuffers", "queuedPcmBytes", "pcmBuffers", "pcmBytes",
    ]
    static let cacheFields = [
        "lutTextures", "lutBytes", "overlayAtlasTextures", "overlayAtlasBytes",
        "metalTextureCacheObjects",
    ]
    static let activityFields = [
        "decodeSubmissions", "decodeCompletions", "decodeFailures", "presentedFrames",
        "droppedFrames", "textureBinds", "frameCacheHits", "samplePayloadReads",
    ]

    static func record(_ name: String) { census.record(name) }

    @MainActor
    public static func snapshot() throws -> StudioResourceCensusSnapshot {
        try census.snapshot()
    }
}

public struct StudioResourceCensusSnapshot {
    public let video: [String: Int]
    public let ioSurfaceIds: [UInt32]
    public let audio: [String: Int]
    public let persistentCaches: [String: Int]
    public let activity: [String: Int]
}

enum StudioResourceObservationError: Error {
    case unavailable
}

private struct StudioResourceObservation {
    var values: [String: Int]
    var surfaces: [UInt32: Int] = [:]
    var compressedBuffers: [ObjectIdentifier: Int] = [:]
    var pcmBuffers: [ObjectIdentifier: Int] = [:]
    var probe: (@MainActor @Sendable () -> [String: Int])?
}

/// Shared by all value copies of a wrapper. Counts change only on actual
/// acquisition/release or cache mutation, never because a window is hidden.
final class StudioResourceLease: @unchecked Sendable {
    private let id = UUID()

    init(_ values: [String: Int] = [:], surface: IOSurfaceRef? = nil) {
        var observation = StudioResourceObservation(values: values)
        if let surface {
            observation.surfaces[IOSurfaceGetID(surface)] = IOSurfaceGetAllocSize(surface)
        }
        StudioResourceDiagnostics.census.insert(id, observation)
    }

    deinit { finish() }

    var isActive: Bool { StudioResourceDiagnostics.census.contains(id) }

    func update(_ values: [String: Int]) {
        StudioResourceDiagnostics.census.update(id) { $0.values = values }
    }

    func setProbe(_ probe: @escaping @MainActor @Sendable () -> [String: Int]) {
        StudioResourceDiagnostics.census.update(id) { $0.probe = probe }
    }

    func setCompressedBuffers(_ buffers: [CMSampleBuffer], capacity: Int) {
        var sizes: [ObjectIdentifier: Int] = [:]
        for buffer in buffers { sizes[ObjectIdentifier(buffer)] = CMSampleBufferGetTotalSampleSize(buffer) }
        StudioResourceDiagnostics.census.update(id) {
            $0.values = ["compressedCacheEntries": buffers.count, "compressedCacheCapacity": capacity]
            $0.compressedBuffers = sizes
        }
    }

    func setPCMBuffer(_ buffer: AnyObject, capacityBytes: Int) {
        StudioResourceDiagnostics.census.update(id) {
            $0.pcmBuffers = [ObjectIdentifier(buffer): capacityBytes]
        }
    }

    func finish() { StudioResourceDiagnostics.census.remove(id) }
}

/// ARC, decoder callbacks and GPU/audio completion may run off the main actor.
/// The lock protects only this census; probes run after copying it, on MainActor.
final class StudioResourceCensus: @unchecked Sendable {
    private let lock = NSLock()
    private var observations: [UUID: StudioResourceObservation] = [:]
    private var activity: [String: Int] = [:]
    private var invalid = false
    private static let maximumExactInteger = 9_007_199_254_740_991

    fileprivate func insert(_ id: UUID, _ observation: StudioResourceObservation) {
        lock.lock()
        observations[id] = observation
        lock.unlock()
    }

    fileprivate func update(_ id: UUID, _ body: (inout StudioResourceObservation) -> Void) {
        lock.lock()
        if var observation = observations[id] {
            body(&observation)
            observations[id] = observation
        }
        lock.unlock()
    }

    func contains(_ id: UUID) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return observations[id] != nil
    }

    func remove(_ id: UUID) {
        lock.lock()
        observations.removeValue(forKey: id)
        lock.unlock()
    }

    func record(_ name: String) {
        lock.lock()
        defer { lock.unlock() }
        guard StudioResourceDiagnostics.activityFields.contains(name),
            activity[name, default: 0] < Self.maximumExactInteger
        else {
            invalid = true
            return
        }
        activity[name, default: 0] += 1
    }

    private func state() -> ([StudioResourceObservation], [String: Int], Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (Array(observations.values), activity, invalid)
    }

    @MainActor
    func snapshot() throws -> StudioResourceCensusSnapshot {
        let (observations, recordedActivity, invalid) = state()
        guard !invalid else { throw StudioResourceObservationError.unavailable }
        var totals: [String: Int] = [:]
        var surfaces: [UInt32: Int] = [:]
        var compressed: [ObjectIdentifier: Int] = [:]
        var pcm: [ObjectIdentifier: Int] = [:]
        func add(_ name: String, _ value: Int) throws {
            guard value >= 0, value <= Self.maximumExactInteger,
                totals[name, default: 0] <= Self.maximumExactInteger - value
            else { throw StudioResourceObservationError.unavailable }
            totals[name, default: 0] += value
        }
        func merge<Key: Hashable>(_ source: [Key: Int], into result: inout [Key: Int]) throws {
            for (key, bytes) in source {
                guard bytes >= 0, result[key] == nil || result[key] == bytes else {
                    throw StudioResourceObservationError.unavailable
                }
                result[key] = bytes
            }
        }
        for observation in observations {
            for (name, value) in observation.values { try add(name, value) }
            for (name, value) in observation.probe?() ?? [:] { try add(name, value) }
            try merge(observation.surfaces, into: &surfaces)
            try merge(observation.compressedBuffers, into: &compressed)
            try merge(observation.pcmBuffers, into: &pcm)
        }
        for bytes in surfaces.values { try add("ioSurfaceBytes", bytes) }
        for bytes in compressed.values { try add("compressedCacheBytes", bytes) }
        for bytes in pcm.values { try add("pcmBytes", bytes) }
        totals["ioSurfaces"] = surfaces.count
        totals["pcmBuffers"] = pcm.count
        func select(_ names: [String], from source: [String: Int]) -> [String: Int] {
            Dictionary(uniqueKeysWithValues: names.map { ($0, source[$0, default: 0]) })
        }
        return StudioResourceCensusSnapshot(
            video: select(StudioResourceDiagnostics.videoFields, from: totals),
            ioSurfaceIds: surfaces.keys.sorted(),
            audio: select(StudioResourceDiagnostics.audioFields, from: totals),
            persistentCaches: select(StudioResourceDiagnostics.cacheFields, from: totals),
            activity: select(StudioResourceDiagnostics.activityFields, from: recordedActivity)
        )
    }
}
