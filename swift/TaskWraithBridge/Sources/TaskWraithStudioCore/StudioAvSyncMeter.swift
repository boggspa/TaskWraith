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
/// The worst reading the meter has seen, kept whole rather than reduced to a
/// magnitude, so a peak can be EXPLAINED and not merely reported.
///
/// WHY THE OPERANDS ARE KEPT SEPARATELY. `peakAbsoluteErrorTicks` answers "how
/// bad" and discards everything needed to answer "why": which of the two clocks
/// moved, in which direction, and how far apart in wall time the two reads
/// were. A one-second peak has at least two unrelated causes that produce a
/// byte-identical number, so the magnitude alone cannot choose between them.
///
/// This is ONE value, not a history. The meter deliberately keeps no per-frame
/// storage — see the member audit in StudioAvSyncMeterTests — so a ring buffer
/// of recent samples is not available here, and a leak in a diagnostic would be
/// a worse defect than the one it is diagnosing.
/// Whether a retained reading's error is accounted for by the gap between the
/// two clock reads.
///
/// THREE STATES, NOT A BOOL, AND THE THIRD IS THE POINT. A Bool answers false
/// both when the window PROVES the error is genuine and when no window was
/// measured at all. Those are opposite claims. Collapsing them is how "we
/// never measured this" gets read downstream as "we measured, and the desync
/// was real" — a fabricated finding rather than a missing one.
public enum StudioAvSyncExplanation: String, Equatable, Sendable {
    /// The read window is wide enough to account for the error on its own.
    case explained
    /// A window was measured and it cannot account for the error.
    case notExplained = "not_explained"
    /// No window was measured. Says nothing in either direction.
    case unknown
}

public struct StudioAvSyncSample: Equatable, Sendable {
    public let timebase: StudioTimebase
    /// PTS of the frame this reading compared, exactly as recorded.
    public let presentedFrameTicks: Int64
    /// Audio playhead this reading compared it against, exactly as recorded.
    public let audiblePositionTicks: Int64
    public let errorTicks: Int64
    /// Wall-clock nanoseconds between the transport snapshot that SELECTED this
    /// frame and the audio-clock read it was compared AGAINST.
    ///
    /// Nil when the caller did not measure it. Nil means "unknown", never
    /// "zero" — the difference decides whether a peak can be explained at all.
    public let measurementWindowNanoseconds: UInt64?
    /// False when this reading came from a tick that drew nothing and left the
    /// previous picture ageing on screen.
    public let wasDrawn: Bool

    public var errorMilliseconds: Double {
        Double(errorTicks) / Double(timebase.timescale) * 1000.0
    }

    public var measurementWindowMilliseconds: Double? {
        guard let measurementWindowNanoseconds else { return nil }
        return Double(measurementWindowNanoseconds) / 1_000_000.0
    }

    /// True when the gap between the two clock reads is large enough to account
    /// for the error on its own.
    ///
    /// The audio playhead is the operand read LAST, so any time spent between
    /// the two reads — a drawable wait, an inline decode, a keyframe restart —
    /// is time the audio device kept counting while the frame number stayed
    /// fixed. That inflates the error in the audio-advanced direction only,
    /// which is why a positive error can never be explained this way.
    ///
    /// THIS DOES NOT SUPPRESS ANYTHING. The peak still rises, the tolerance
    /// still fails, the "!" still shows. It records what the number means so a
    /// repair can be aimed at the right thing: sampling both clocks together,
    /// or the pipeline stall itself.
    public var errorIsExplainedByMeasurementWindow: Bool {
        guard let window = measurementWindowMilliseconds else { return false }
        guard errorMilliseconds < 0 else { return false }
        let quantisation =
            Double(timebase.frameDurationTicks) / Double(timebase.timescale) * 1000.0
        return -errorMilliseconds <= window + quantisation
    }

    /// Tri-state form of the above. Prefer this wherever the answer is recorded
    /// or exported, because it distinguishes "measured and genuine" from
    /// "never measured".
    public var explanation: StudioAvSyncExplanation {
        guard measurementWindowNanoseconds != nil else { return .unknown }
        return errorIsExplainedByMeasurementWindow ? .explained : .notExplained
    }

    /// One machine-parseable line, for carrying this reading OUT of the process.
    ///
    /// WHY A STRING, AND WHY THIS SHAPE. Reading the retained sample from a
    /// packaged run previously meant attaching a debugger and resolving an
    /// internal Swift type by name, which failed twice on type lookup before
    /// reaching the data. Accessibility values already cross the process
    /// boundary and are already read by the acceptance driver, so the sample
    /// travels as text on a surface that works.
    ///
    /// `av1` is a schema version so a parser can fail closed rather than
    /// mis-key a later format. An absent window serialises as `-`, never `0`:
    /// zero would parse as "both clocks were read together", the strongest
    /// possible claim and the exact opposite of what absence means.
    public var diagnosticsExportText: String {
        let window = measurementWindowNanoseconds.map(String.init) ?? "-"
        let windowMilliseconds =
            measurementWindowMilliseconds.map { String(format: "%.3f", $0) } ?? "-"
        return "av1 pf=\(presentedFrameTicks) ap=\(audiblePositionTicks)"
            + " err=\(errorTicks) errms=\(String(format: "%.3f", errorMilliseconds))"
            + " win=\(window) winms=\(windowMilliseconds)"
            + " drawn=\(wasDrawn ? 1 : 0) expl=\(explanation.rawValue)"
    }
}

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

    /// The picture currently ON SCREEN, in ticks. Nil until something has been
    /// drawn, because an empty viewer has no picture to be out of sync with.
    public private(set) var onScreenFrameTicks: Int64?

    /// The single reading that set the current peak, kept whole. One optional
    /// value, never a history — see StudioAvSyncSample.
    public private(set) var peakSample: StudioAvSyncSample?

    /// Records one presented frame against the audio playhead at that instant.
    ///
    /// - Parameter presentedFrameTicks: PTS of the frame actually drawn.
    /// - Parameter audiblePositionTicks: audio position genuinely in the room,
    ///   i.e. the device's sample counter already corrected for output latency.
    /// - Parameter measurementWindowNanoseconds: wall-clock nanoseconds between
    ///   the transport snapshot that selected this frame and the audio read
    ///   above. Optional because only the live viewer can measure it; omitting
    ///   it changes no statistic, it only leaves the peak unexplainable.
    public mutating func record(
        presentedFrameTicks: Int64,
        audiblePositionTicks: Int64,
        measurementWindowNanoseconds: UInt64? = nil
    ) {
        onScreenFrameTicks = presentedFrameTicks
        accumulate(
            errorTicks: presentedFrameTicks &- audiblePositionTicks,
            presentedFrameTicks: presentedFrameTicks,
            audiblePositionTicks: audiblePositionTicks,
            measurementWindowNanoseconds: measurementWindowNanoseconds,
            wasDrawn: true
        )
    }

    /// Records a display tick on which NOTHING NEW WAS DRAWN.
    ///
    /// THIS IS THE MEASUREMENT THIS METER WAS MISSING, and its absence was not a
    /// gap in coverage — it was an exemption for the only desync this pipeline
    /// actually produces. A dropped frame does not blank the screen. The viewer
    /// keeps showing the last frame that WAS drawn, and that picture ages by
    /// another display period against sound which did not stop. Skipping these
    /// ticks meant the error was sampled only while the pipeline was healthy, so
    /// the number was bounded by frame quantisation BY CONSTRUCTION and could
    /// not report the failure it existed to report.
    ///
    /// I wrote the original exclusion, and the reasoning was wrong in a specific
    /// way worth keeping: "a dropped frame is not evidence about sync" is true
    /// of the frame that failed to arrive and false of the frame still on
    /// screen. The stale picture is the evidence.
    ///
    /// Records nothing when the viewer has never drawn, since "no picture" and
    /// "picture at position zero" are different claims.
    public mutating func recordDroppedFrame(
        audiblePositionTicks: Int64,
        measurementWindowNanoseconds: UInt64? = nil
    ) {
        guard let onScreenFrameTicks else { return }
        accumulate(
            errorTicks: onScreenFrameTicks &- audiblePositionTicks,
            presentedFrameTicks: onScreenFrameTicks,
            audiblePositionTicks: audiblePositionTicks,
            measurementWindowNanoseconds: measurementWindowNanoseconds,
            wasDrawn: false
        )
    }

    private mutating func accumulate(
        errorTicks error: Int64,
        presentedFrameTicks: Int64,
        audiblePositionTicks: Int64,
        measurementWindowNanoseconds: UInt64?,
        wasDrawn: Bool
    ) {
        currentErrorTicks = error
        let magnitude = abs(error)
        // Compared BEFORE the peak moves, so the retained sample is the tick
        // that actually set it rather than the one that merely tied it.
        if peakSample == nil || magnitude > peakAbsoluteErrorTicks {
            peakSample = StudioAvSyncSample(
                timebase: timebase,
                presentedFrameTicks: presentedFrameTicks,
                audiblePositionTicks: audiblePositionTicks,
                errorTicks: error,
                measurementWindowNanoseconds: measurementWindowNanoseconds,
                wasDrawn: wasDrawn
            )
        }
        peakAbsoluteErrorTicks = max(peakAbsoluteErrorTicks, magnitude)
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
        // The picture on screen after a seek is not the picture from before it,
        // so carrying it forward would measure against a frame nobody is
        // looking at any more.
        onScreenFrameTicks = nil
        // The explanation goes with the peak it explained.
        peakSample = nil
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
