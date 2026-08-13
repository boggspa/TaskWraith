import Foundation

/// What the sound should be doing, given what the transport is doing.
public enum StudioAudioSyncDecision: Equatable, Sendable {
    /// Sound and picture already agree. Touching the player would only click.
    case leave
    /// Nothing should be audible: the transport is stopped, or the playhead has
    /// run past the end of the sound.
    case pause
    /// Start (or restart) the sound at this media position.
    case reschedule(ticks: Int64)
}

/// Decides, once per displayed frame, whether the sound still addresses the
/// position the picture is at.
///
/// WHY THIS IS A POLICY AND NOT ELEVEN CALL SITES. The transport is mutated from
/// eleven places in the viewer — play, pause, toggle, seek, scrub, frame-step,
/// range loop, review loop, timecode entry — and driving the audio player from
/// each of them would be eleven chances to forget one. That is the same defect
/// that dropped proposals at the stdio pump and then very nearly dropped the
/// timeline: a surface that ENUMERATES the things it must handle gains a new way
/// to fail every time the product grows. So nothing tells this policy what the
/// operator did. It compares where the sound is with where the picture is, and a
/// DIVERGENCE is what triggers a correction — which means a gesture nobody has
/// written yet is already handled the moment it moves the playhead.
public enum StudioAudioSyncPolicy {
    /// A re-schedule is AUDIBLE — it stops a player node and starts another
    /// buffer — so the threshold has to sit comfortably above ordinary jitter or
    /// scrubbing becomes a machine gun. Two frames is the smallest value that is
    /// not chasing the measurement, and it is derived from the timebase rather
    /// than picked in milliseconds so it means the same thing at 23.976 as at 60.
    public static func toleranceTicks(for timebase: StudioTimebase) -> Int64 {
        timebase.frameDurationTicks * 2
    }

    /// - Parameters:
    ///   - audioEndTicks: one tick past the last sample of the attached sound.
    ///     Past it the answer is `.pause`, never `.reschedule`: a viewer whose
    ///     video outlasts its audio must fall silent rather than restart the
    ///     head of the track, and returning `.reschedule` there would also spin
    ///     a failed start on every single frame.
    ///   - audioPositionTicks: the RAW device position, not the latency-corrected
    ///     audible one. The audible figure describes sound already in the room
    ///     and belongs to the sync meter; scheduling must compare against the
    ///     sample the device is rendering, or output latency alone would read as
    ///     permanent divergence and re-schedule every frame forever.
    public static func decide(
        transportIsPlaying: Bool,
        intendedTicks: Int64,
        audioEndTicks: Int64,
        audioIsPlaying: Bool,
        audioPositionTicks: Int64?,
        toleranceTicks: Int64
    ) -> StudioAudioSyncDecision {
        guard transportIsPlaying, intendedTicks < audioEndTicks else {
            return audioIsPlaying ? .pause : .leave
        }
        guard audioIsPlaying, let audioPositionTicks else {
            return .reschedule(ticks: intendedTicks)
        }
        let divergence = abs(audioPositionTicks &- intendedTicks)
        return divergence <= toleranceTicks ? .leave : .reschedule(ticks: intendedTicks)
    }
}
