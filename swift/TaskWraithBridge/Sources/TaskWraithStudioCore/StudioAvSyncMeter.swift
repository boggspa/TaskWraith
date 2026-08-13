import Foundation

/// Measured A/V sync (mission outcome 5's "measured A/V sync", and the thing
/// that finally makes outcome 9's drift a real number).
///
/// WHAT IS COMPARED, AND WHY IT IS NOT CIRCULAR. Last slice I declined to report
/// drift because every clock available derived from StudioPlaybackClock — the
/// same clock that selects which frame to draw — so any number would have been
/// the clock measured against itself. This compares two genuinely different
/// things:
///
/// * WHAT YOU SEE — the presentation timestamp of the frame actually drawn.
///   Quantised to a frame boundary, and late if decode fell behind.
/// * WHAT YOU HEAR — the audio hardware's own sample counter, pulled back by
///   the output device's presentation latency, because samples handed to the
///   device are not yet sound in the room.
///
/// Those diverge for real reasons: frame quantisation, output latency, a decode
/// stall, an audio underrun, or a viewer that adopted the wrong timebase. The
/// number moves when playback is genuinely wrong, which is the only test of
/// whether a metric is worth having.
///
/// WHAT THIS IS HONESTLY NOT. Picture is slaved to the audio clock, so this is
/// not two free-running oscillators racing each other; with a healthy pipeline
/// it should sit inside half a frame plus output latency and STAY there. Its
/// value is as a regression detector — an unbounded or growing error means
/// something in the chain is broken — not as evidence of independent timebases.
public struct StudioAvSyncMeter: Equatable, Sendable {
    /// Detectability thresholds from ITU-R BT.1359, which are ASYMMETRIC and
    /// widely mis-implemented as a symmetric window.
    ///
    /// Hearing an event before seeing it is far more objectionable than the
    /// reverse — a sound has no reason to precede its cause — so audio-advanced
    /// tolerates ~45 ms while audio-delayed tolerates ~125 ms. A symmetric
    /// window is therefore either too slack in one direction or needlessly
    /// strict in the other.
    public static let audioDelayedToleranceMilliseconds: Double = 125
    public static let audioAdvancedToleranceMilliseconds: Double = 45

    public let timebase: StudioTimebase

    /// Signed error of the most recent sample, in ticks.
    ///
    /// POSITIVE means the picture is ahead of the sound (audio delayed).
    /// NEGATIVE means the sound is ahead of the picture (audio advanced), which
    /// is the direction with the tighter tolerance.
    public private(set) var currentErrorTicks: Int64 = 0
    public private(set) var peakAbsoluteErrorTicks: Int64 = 0
    public private(set) var sampleCount: Int = 0
    /// Running sum for the mean. Bounded arithmetic, no history array: a
    /// diagnostic that grows without limit is a leak wearing a badge.
    private var errorSumTicks: Int64 = 0
    /// Samples whose error fell outside the asymmetric tolerance.
    public private(set) var outOfToleranceCount: Int = 0

    public init(timebase: StudioTimebase) {
        self.timebase = timebase
    }

    /// Records one presented frame against the audio playhead at that instant.
    ///
    /// - Parameter presentedFrameTicks: PTS of the frame actually drawn.
    /// - Parameter audiblePositionTicks: audio position genuinely in the room,
    ///   i.e. the device's sample counter already corrected for output latency.
    public mutating func record(presentedFrameTicks: Int64, audiblePositionTicks: Int64) {
        let error = presentedFrameTicks &- audiblePositionTicks
        currentErrorTicks = error
        peakAbsoluteErrorTicks = max(peakAbsoluteErrorTicks, abs(error))
        errorSumTicks = errorSumTicks &+ error
        sampleCount += 1
        if !Self.isWithinTolerance(errorTicks: error, timebase: timebase) {
            outOfToleranceCount += 1
        }
    }

    /// Discards accumulated statistics. Called on seek and on source change,
    /// because a peak from before a seek says nothing about playback after it.
    public mutating func reset() {
        currentErrorTicks = 0
        peakAbsoluteErrorTicks = 0
        errorSumTicks = 0
        sampleCount = 0
        outOfToleranceCount = 0
    }

    public var currentErrorMilliseconds: Double {
        Self.milliseconds(ticks: currentErrorTicks, timebase: timebase)
    }

    public var peakAbsoluteErrorMilliseconds: Double {
        Self.milliseconds(ticks: peakAbsoluteErrorTicks, timebase: timebase)
    }

    /// Mean signed error. Nil rather than zero when nothing has been recorded —
    /// "no measurement" and "measured zero" are different claims, and a HUD
    /// showing 0.0 ms before any frame has been presented is a lie.
    public var meanErrorMilliseconds: Double? {
        guard sampleCount > 0 else { return nil }
        return Self.milliseconds(ticks: errorSumTicks, timebase: timebase) / Double(sampleCount)
    }

    public var isWithinTolerance: Bool {
        Self.isWithinTolerance(errorTicks: currentErrorTicks, timebase: timebase)
    }

    public static func isWithinTolerance(errorTicks: Int64, timebase: StudioTimebase) -> Bool {
        let milliseconds = self.milliseconds(ticks: errorTicks, timebase: timebase)
        if milliseconds >= 0 {
            // Picture ahead of sound: audio delayed, the looser direction.
            return milliseconds <= audioDelayedToleranceMilliseconds
        }
        return -milliseconds <= audioAdvancedToleranceMilliseconds
    }

    private static func milliseconds(ticks: Int64, timebase: StudioTimebase) -> Double {
        Double(ticks) / Double(timebase.timescale) * 1000.0
    }

    /// Compact HUD line. Reports "--" rather than a number before the first
    /// measurement, for the same reason meanErrorMilliseconds is optional.
    public var summaryText: String {
        guard sampleCount > 0 else { return "a/v --" }
        let flag = isWithinTolerance ? "" : "!"
        return String(format: "a/v %+.1fms%@ pk %.1f", currentErrorMilliseconds, flag,
            peakAbsoluteErrorMilliseconds)
    }
}
