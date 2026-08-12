import Foundation

/// The single playback authority for TaskWraith Studio (mission outcome 4).
///
/// Design notes
/// ------------
/// * Media position is an INTEGER TICK COUNT in a fixed timescale, matching the
///   CMTime / FCPXML convention the host already uses in
///   `src/main/studio/StudioRationalTime.ts`. Frame boundaries are therefore
///   exact for broadcast rates such as 30000/1001, where holding position as
///   seconds-in-a-Double accumulates error and eventually lands the playhead a
///   frame off.
/// * Position is always RECOMPUTED FROM AN ANCHOR (`anchorTicks` observed at
///   `anchorHostSeconds`) rather than accumulated per displayed frame, so a long
///   playback session cannot integrate rounding error. Every transport change
///   re-anchors.
/// * The clock is I/O-free: host time arrives as a parameter instead of being
///   read from `CACurrentMediaTime()` inside. That is what makes it
///   deterministically testable without a window, and it is the same seam that
///   later lets an audio render-thread timestamp drive it without an API change.
/// * There is exactly ONE of these across viewers. Source/Audition and Review
///   read the same snapshot; neither may keep a private playhead, or A/B
///   comparison silently compares two different instants.
///
/// Not in this slice: audio clock slaving and measured A/V sync (outcome 5).
/// The `atHost:` parameter is the seam they will attach to.

/// A frame rate expressed exactly, as ticks-per-second plus ticks-per-frame.
public struct StudioTimebase: Equatable, Sendable {
    /// Ticks per second, e.g. 30000 for NTSC-family rates.
    public let timescale: Int64
    /// Ticks in one frame, e.g. 1001 for 30000/1001 (29.97 fps).
    public let frameDurationTicks: Int64

    public init?(timescale: Int64, frameDurationTicks: Int64) {
        guard timescale > 0, frameDurationTicks > 0 else { return nil }
        self.timescale = timescale
        self.frameDurationTicks = frameDurationTicks
    }

    /// 30000/1001 — 29.97 fps drop-frame family.
    public static let ntsc2997 = StudioTimebase(timescale: 30000, frameDurationTicks: 1001)!
    /// 24000/1001 — 23.976 fps.
    public static let ntsc23976 = StudioTimebase(timescale: 24000, frameDurationTicks: 1001)!
    /// 25/1 — PAL.
    public static let pal25 = StudioTimebase(timescale: 25, frameDurationTicks: 1)!
    /// 60/1 — integer 60 fps.
    public static let fps60 = StudioTimebase(timescale: 60, frameDurationTicks: 1)!

    /// Diagnostics only. Never use this to compute a position; it is lossy for
    /// 1001-denominator rates, which is the entire reason this type exists.
    public var framesPerSecond: Double {
        Double(timescale) / Double(frameDurationTicks)
    }
}

/// A half-open loop region `[startTicks, endTicks)`.
public struct StudioLoopRange: Equatable, Sendable {
    public let startTicks: Int64
    public let endTicks: Int64

    public init?(startTicks: Int64, endTicks: Int64) {
        guard startTicks >= 0, endTicks > startTicks else { return nil }
        self.startTicks = startTicks
        self.endTicks = endTicks
    }

    public var spanTicks: Int64 { endTicks - startTicks }
}

/// An immutable read of the transport at one instant. Viewers render from this
/// rather than querying the clock repeatedly, so every surface in one displayed
/// frame agrees on the instant it is showing.
public struct StudioTransportSnapshot: Equatable, Sendable {
    public let positionTicks: Int64
    public let frameIndex: Int64
    public let seconds: Double
    public let isPlaying: Bool
    public let rate: Double
}

public struct StudioPlaybackClock: Equatable, Sendable {
    public enum Transport: Equatable, Sendable {
        case paused
        case playing
    }

    public let timebase: StudioTimebase
    public private(set) var durationTicks: Int64
    public private(set) var transport: Transport
    public private(set) var rate: Double
    public private(set) var loopRange: StudioLoopRange?

    private var anchorTicks: Int64
    private var anchorHostSeconds: Double

    public init(timebase: StudioTimebase, durationTicks: Int64) {
        self.timebase = timebase
        self.durationTicks = max(0, durationTicks)
        self.transport = .paused
        self.rate = 1.0
        self.loopRange = nil
        self.anchorTicks = 0
        self.anchorHostSeconds = 0
    }

    // MARK: - Reading

    /// Media position at `hostSeconds`, in ticks.
    ///
    /// Rounds to the NEAREST tick rather than flooring: a media clock should
    /// land on the closest representable instant, and flooring makes results
    /// fragile against the last bit of a host-time Double (a delta that should
    /// be 60060.0 can arrive as 60059.9999999 and floor a whole frame early).
    public func positionTicks(atHost hostSeconds: Double) -> Int64 {
        guard transport == .playing, rate != 0, hostSeconds.isFinite else {
            return anchorTicks
        }
        let elapsed = hostSeconds - anchorHostSeconds
        let advanced = (elapsed * rate * Double(timebase.timescale))
            .rounded(.toNearestOrAwayFromZero)
        guard advanced.isFinite else { return anchorTicks }
        // Clamp before the Int64 conversion: converting an out-of-range Double
        // is a runtime trap, not a wrap.
        let bounded = min(max(advanced, -9.0e18), 9.0e18)
        return normalised(anchorTicks &+ Int64(bounded))
    }

    public func snapshot(atHost hostSeconds: Double) -> StudioTransportSnapshot {
        let ticks = positionTicks(atHost: hostSeconds)
        return StudioTransportSnapshot(
            positionTicks: ticks,
            frameIndex: frameIndex(ofTicks: ticks),
            seconds: Double(ticks) / Double(timebase.timescale),
            isPlaying: transport == .playing,
            rate: rate
        )
    }

    /// Frame containing `ticks`, flooring toward negative infinity so that the
    /// frame boundary at exactly `n * frameDurationTicks` belongs to frame `n`.
    public func frameIndex(ofTicks ticks: Int64) -> Int64 {
        let duration = timebase.frameDurationTicks
        if ticks >= 0 { return ticks / duration }
        return -((-ticks + duration - 1) / duration)
    }

    /// First tick of `frame`.
    public func ticks(ofFrame frame: Int64) -> Int64 {
        frame &* timebase.frameDurationTicks
    }

    // MARK: - Transport

    public mutating func play(atHost hostSeconds: Double) {
        reanchor(atHost: hostSeconds)
        transport = .playing
    }

    public mutating func pause(atHost hostSeconds: Double) {
        reanchor(atHost: hostSeconds)
        transport = .paused
    }

    /// Seeks to an absolute tick position, CLAMPED to `[0, durationTicks]`.
    /// A seek deliberately does not wrap into an active loop range: the loop
    /// governs playback, not explicit user navigation.
    public mutating func seek(toTicks ticks: Int64, atHost hostSeconds: Double) {
        anchorTicks = clampedToDuration(ticks)
        anchorHostSeconds = hostSeconds
    }

    /// Frame-step. Always pauses first, because stepping while playing has no
    /// coherent meaning. From a position inside frame `f`, `delta` lands on
    /// frame `f + delta`, so `-1` from mid-frame moves to the previous boundary.
    public mutating func stepFrames(_ delta: Int64, atHost hostSeconds: Double) {
        let current = positionTicks(atHost: hostSeconds)
        let target = ticks(ofFrame: frameIndex(ofTicks: current) &+ delta)
        transport = .paused
        anchorTicks = clampedToDuration(target)
        anchorHostSeconds = hostSeconds
    }

    public mutating func setRate(_ newRate: Double, atHost hostSeconds: Double) {
        guard newRate.isFinite else { return }
        reanchor(atHost: hostSeconds)
        rate = newRate
    }

    public mutating func setLoopRange(_ range: StudioLoopRange?, atHost hostSeconds: Double) {
        reanchor(atHost: hostSeconds)
        loopRange = range
    }

    public mutating func setDurationTicks(_ ticks: Int64, atHost hostSeconds: Double) {
        reanchor(atHost: hostSeconds)
        durationTicks = max(0, ticks)
        anchorTicks = clampedToDuration(anchorTicks)
    }

    // MARK: - Internals

    /// Freezes the current position as the new anchor. Every transport mutation
    /// goes through here so no change can make the playhead jump.
    private mutating func reanchor(atHost hostSeconds: Double) {
        anchorTicks = positionTicks(atHost: hostSeconds)
        anchorHostSeconds = hostSeconds
    }

    /// Loop wrapping is exact integer modulo, so a loop cannot drift no matter
    /// how many cycles play.
    private func normalised(_ raw: Int64) -> Int64 {
        if let loop = loopRange {
            if raw >= loop.endTicks {
                let offset = (raw - loop.startTicks) % loop.spanTicks
                return loop.startTicks + offset
            }
            return raw < 0 ? 0 : raw
        }
        return clampedToDuration(raw)
    }

    private func clampedToDuration(_ ticks: Int64) -> Int64 {
        if ticks < 0 { return 0 }
        if durationTicks > 0, ticks > durationTicks { return durationTicks }
        return ticks
    }
}
