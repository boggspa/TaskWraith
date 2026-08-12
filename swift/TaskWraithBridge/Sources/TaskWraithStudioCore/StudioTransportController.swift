import Foundation

/// The Source/Audition viewer's transport (mission outcome 2), sitting on top of
/// the one playback authority rather than beside it.
///
/// Every operation here ends in a StudioPlaybackClock mutation, so there is still
/// exactly one playhead. What this adds is the editorial vocabulary the clock
/// deliberately does not know about: In/Out marks, playing or looping just that
/// range, and scrubbing as a gesture with a beginning and an end.
///
/// SCRUB IS A GESTURE, NOT A SEEK. Dragging a playhead while material is playing
/// has to pause, follow the pointer, and then RESTORE what the transport was
/// doing — otherwise letting go either strands the viewer paused or restarts
/// playback that was never running. That resume-state is the whole reason this
/// is a controller and not three free functions.
///
/// Value type on purpose: it mutates in place alongside the clock it owns, and
/// tests can hold one without any lifetime ceremony.
public struct StudioTransportController {
    public private(set) var clock: StudioPlaybackClock
    /// Frame-aligned mark points, in ticks.
    public private(set) var inPointTicks: Int64?
    public private(set) var outPointTicks: Int64?
    public private(set) var isLoopingRange = false
    public private(set) var isScrubbing = false
    /// Whether playback was running when the current scrub began.
    private var resumePlaybackAfterScrub = false

    public init(clock: StudioPlaybackClock) {
        self.clock = clock
    }

    // MARK: - Marks

    /// The marked range, or nil when the marks do not describe one. Out must be
    /// strictly after In: a zero-length or inverted range is not a range, and
    /// silently repairing it would hide a mis-click rather than surface it.
    public var markedRange: StudioLoopRange? {
        guard let inPointTicks, let outPointTicks else { return nil }
        return StudioLoopRange(startTicks: inPointTicks, endTicks: outPointTicks)
    }

    public var hasCompleteRange: Bool { markedRange != nil }

    /// Marks In at the current position, snapped to the frame boundary so the
    /// range is exactly addressable.
    public mutating func markIn(atHost hostSeconds: Double) {
        inPointTicks = frameAlignedPosition(atHost: hostSeconds)
        refreshLoopRange(atHost: hostSeconds)
    }

    /// Marks Out at the current position. Out is the EXCLUSIVE end of the range,
    /// matching StudioLoopRange and the host's half-open insert_range convention,
    /// so a range never double-counts its final frame.
    public mutating func markOut(atHost hostSeconds: Double) {
        outPointTicks = frameAlignedPosition(atHost: hostSeconds)
        refreshLoopRange(atHost: hostSeconds)
    }

    public mutating func setInPoint(ticks: Int64?, atHost hostSeconds: Double) {
        inPointTicks = ticks.map(alignToFrame)
        refreshLoopRange(atHost: hostSeconds)
    }

    public mutating func setOutPoint(ticks: Int64?, atHost hostSeconds: Double) {
        outPointTicks = ticks.map(alignToFrame)
        refreshLoopRange(atHost: hostSeconds)
    }

    public mutating func clearMarks(atHost hostSeconds: Double) {
        inPointTicks = nil
        outPointTicks = nil
        isLoopingRange = false
        clock.setLoopRange(nil, atHost: hostSeconds)
    }

    // MARK: - Range playback

    /// Loop toggle. Turning looping on without a complete range is a no-op that
    /// reports failure rather than silently looping the whole asset.
    @discardableResult
    public mutating func setLoopingRange(_ enabled: Bool, atHost hostSeconds: Double) -> Bool {
        guard enabled else {
            isLoopingRange = false
            clock.setLoopRange(nil, atHost: hostSeconds)
            return true
        }
        guard let range = markedRange else { return false }
        isLoopingRange = true
        clock.setLoopRange(range, atHost: hostSeconds)
        return true
    }

    /// Jumps to In and plays the marked range, looping it if looping is on.
    @discardableResult
    public mutating func playRange(atHost hostSeconds: Double) -> Bool {
        guard let range = markedRange else { return false }
        clock.setLoopRange(isLoopingRange ? range : nil, atHost: hostSeconds)
        clock.seek(toTicks: range.startTicks, atHost: hostSeconds)
        clock.play(atHost: hostSeconds)
        return true
    }

    // MARK: - Transport

    public mutating func play(atHost hostSeconds: Double) {
        clock.play(atHost: hostSeconds)
    }

    public mutating func pause(atHost hostSeconds: Double) {
        clock.pause(atHost: hostSeconds)
    }

    public mutating func togglePlayback(atHost hostSeconds: Double) {
        if clock.snapshot(atHost: hostSeconds).isPlaying {
            clock.pause(atHost: hostSeconds)
        } else {
            clock.play(atHost: hostSeconds)
        }
    }

    public mutating func stepFrames(_ delta: Int64, atHost hostSeconds: Double) {
        clock.stepFrames(delta, atHost: hostSeconds)
    }

    public mutating func seek(toTicks ticks: Int64, atHost hostSeconds: Double) {
        clock.seek(toTicks: alignToFrame(ticks), atHost: hostSeconds)
    }

    public mutating func seek(toFrame frame: Int64, atHost hostSeconds: Double) {
        clock.seek(toTicks: clock.ticks(ofFrame: frame), atHost: hostSeconds)
    }

    // MARK: - Scrub

    /// Begins a scrub. Remembers whether playback was running and pauses, so the
    /// playhead follows the gesture instead of racing it.
    public mutating func beginScrub(atHost hostSeconds: Double) {
        guard !isScrubbing else { return }
        resumePlaybackAfterScrub = clock.snapshot(atHost: hostSeconds).isPlaying
        isScrubbing = true
        clock.pause(atHost: hostSeconds)
    }

    public mutating func updateScrub(toTicks ticks: Int64, atHost hostSeconds: Double) {
        guard isScrubbing else { return }
        clock.seek(toTicks: alignToFrame(ticks), atHost: hostSeconds)
    }

    public mutating func updateScrub(toFrame frame: Int64, atHost hostSeconds: Double) {
        guard isScrubbing else { return }
        clock.seek(toTicks: clock.ticks(ofFrame: frame), atHost: hostSeconds)
    }

    /// Ends a scrub and restores whatever the transport was doing beforehand.
    public mutating func endScrub(atHost hostSeconds: Double) {
        guard isScrubbing else { return }
        isScrubbing = false
        if resumePlaybackAfterScrub {
            clock.play(atHost: hostSeconds)
        }
        resumePlaybackAfterScrub = false
    }

    // MARK: - Timecode

    public func currentTimecode(
        atHost hostSeconds: Double,
        dropFrame: Bool = false
    ) throws -> StudioTimecode {
        try StudioTimecodeConverter.timecode(
            forFrame: clock.snapshot(atHost: hostSeconds).frameIndex,
            timebase: clock.timebase,
            dropFrame: dropFrame
        )
    }

    /// Timecode entry. Throws on a malformed or nonexistent label rather than
    /// seeking somewhere approximate, because "it went to the wrong frame" is a
    /// far worse failure for an editor than "that is not a timecode".
    public mutating func seek(toTimecodeText text: String, atHost hostSeconds: Double) throws {
        let frame = try StudioTimecodeConverter.frameCount(forText: text, timebase: clock.timebase)
        clock.seek(toTicks: clock.ticks(ofFrame: frame), atHost: hostSeconds)
    }

    // MARK: - Internals

    private func alignToFrame(_ ticks: Int64) -> Int64 {
        clock.ticks(ofFrame: clock.frameIndex(ofTicks: ticks))
    }

    private func frameAlignedPosition(atHost hostSeconds: Double) -> Int64 {
        clock.ticks(ofFrame: clock.snapshot(atHost: hostSeconds).frameIndex)
    }

    /// Keeps the clock's loop in step with the marks while looping is engaged.
    /// Re-marking during a loop must not leave the clock cycling the old range.
    private mutating func refreshLoopRange(atHost hostSeconds: Double) {
        guard isLoopingRange else { return }
        if let range = markedRange {
            clock.setLoopRange(range, atHost: hostSeconds)
        } else {
            isLoopingRange = false
            clock.setLoopRange(nil, atHost: hostSeconds)
        }
    }
}
