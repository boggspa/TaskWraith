import Foundation

/// Media position derived from the AUDIO HARDWARE's own sample counter
/// (mission outcome 4's audio clock).
///
/// WHY AUDIO IS MASTER. A dropped video frame is a flicker; an audio glitch is a
/// click, and people hear clicks. Every serious player therefore slaves picture
/// to sound rather than the reverse, and so does this: when an asset has audio,
/// the audio device's sample counter becomes the oscillator that drives
/// StudioPlaybackClock.
///
/// THERE IS STILL EXACTLY ONE AUTHORITY. This type does NOT become a second
/// opinion about where playback is — that would be the same failure class as the
/// three command queues, two things agreeing by luck. StudioPlaybackClock
/// remains the only thing that answers "what position are we at"; all this does
/// is supply the TIME it reads, in place of the host monotonic clock. Swapping
/// the oscillator is not adding an authority.
///
/// WHY INTEGER ARITHMETIC — AND WHAT THAT IS ACTUALLY WORTH. Sample counts
/// convert to ticks by gcd-reduced integer maths. I first wrote here that a
/// seconds-as-Double round trip "accumulates error over a long playback run",
/// then measured it before banking the claim: across three hours at every
/// buffer boundary, for 48k/44.1k/32k against 30000- and 25000-tick timescales,
/// the Double path and the integer path disagreed ZERO times. Three hours is
/// 5.2e8 samples and the intermediate products sit far below 2^53, so Double is
/// simply exact at these magnitudes. The claim was false and is corrected here
/// rather than left as flattering commentary.
///
/// The integer path stays, for the reasons that ARE true: it cannot depend on
/// floating-point rounding mode, it reports overflow explicitly instead of
/// silently saturating, and it matches the tick arithmetic the rest of this
/// package already uses. What actually protects long runs is something else
/// entirely — position is always recomputed FROM AN ANCHOR and never
/// accumulated, exactly as StudioPlaybackClock does it. That is the load-bearing
/// choice; the integer maths is merely the tidy one.
public struct StudioAudioClock: Equatable, Sendable {
    public let timebase: StudioTimebase
    public let sampleRate: Int

    /// `timescale / gcd` and `sampleRate / gcd`. Reducing first keeps the
    /// multiply small — at 48 kHz into 30000 the ratio is 5/8, so an hour of
    /// audio multiplies by 5 rather than by 30000.
    private let tickNumerator: Int64
    private let sampleDenominator: Int64

    private var anchorTicks: Int64 = 0
    private var anchorSample: Int64 = 0

    public init?(timebase: StudioTimebase, sampleRate: Int) {
        guard sampleRate > 0 else { return nil }
        self.timebase = timebase
        self.sampleRate = sampleRate
        let divisor = Self.greatestCommonDivisor(Int64(timebase.timescale), Int64(sampleRate))
        self.tickNumerator = Int64(timebase.timescale) / divisor
        self.sampleDenominator = Int64(sampleRate) / divisor
    }

    /// Pins media position `ticks` to audio sample `samplePosition`.
    ///
    /// Called on every transport change for the same reason StudioPlaybackClock
    /// re-anchors: a position recomputed from an anchor cannot integrate
    /// rounding error, while an accumulated one always does.
    public mutating func anchor(atTicks ticks: Int64, samplePosition: Int64) {
        anchorTicks = ticks
        anchorSample = samplePosition
    }

    /// Media position, in ticks, at an audio device sample position.
    public func ticks(atSamplePosition samplePosition: Int64) -> Int64 {
        let elapsedSamples = samplePosition &- anchorSample
        return anchorTicks &+ Self.ticks(
            forSamples: elapsedSamples,
            numerator: tickNumerator,
            denominator: sampleDenominator
        )
    }

    /// Seconds on the AUDIO DEVICE's timeline, for driving StudioPlaybackClock
    /// in place of host monotonic time.
    ///
    /// Deliberately relative to the anchor rather than absolute: the caller
    /// anchors the playback clock against the same instant, so only the delta
    /// has to be meaningful and the Double never has to carry a large absolute
    /// magnitude where its precision is worst.
    public func seconds(atSamplePosition samplePosition: Int64) -> Double {
        Double(samplePosition &- anchorSample) / Double(sampleRate)
    }

    /// Ticks spanned by a sample count, rounded to nearest. Exposed so the sync
    /// meter can convert a latency in samples without duplicating the ratio.
    public func ticks(forSamples samples: Int64) -> Int64 {
        Self.ticks(forSamples: samples, numerator: tickNumerator, denominator: sampleDenominator)
    }

    /// Samples spanned by a duration in seconds, rounded to nearest.
    public func samples(forSeconds seconds: Double) -> Int64 {
        guard seconds.isFinite else { return 0 }
        let scaled = (seconds * Double(sampleRate)).rounded(.toNearestOrAwayFromZero)
        return Int64(min(max(scaled, -9.0e18), 9.0e18))
    }

    // MARK: - Internals

    private static func ticks(
        forSamples samples: Int64,
        numerator: Int64,
        denominator: Int64
    ) -> Int64 {
        guard denominator != 0 else { return 0 }
        let scaled = samples.multipliedReportingOverflow(by: numerator)
        guard !scaled.overflow else {
            // Falls back to a lossy path rather than trapping. Reaching this
            // needs order-of-centuries playback, but a media clock must not be
            // the thing that kills the viewer.
            return Int64(
                (Double(samples) * Double(numerator) / Double(denominator))
                    .rounded(.toNearestOrAwayFromZero)
            )
        }
        // Round to nearest, away from zero, matching StudioPlaybackClock.
        let doubled = scaled.partialValue
        if doubled >= 0 {
            return (doubled &+ denominator / 2) / denominator
        }
        return -((-doubled &+ denominator / 2) / denominator)
    }

    private static func greatestCommonDivisor(_ lhs: Int64, _ rhs: Int64) -> Int64 {
        var a = abs(lhs)
        var b = abs(rhs)
        while b != 0 {
            (a, b) = (b, a % b)
        }
        return a == 0 ? 1 : a
    }
}
