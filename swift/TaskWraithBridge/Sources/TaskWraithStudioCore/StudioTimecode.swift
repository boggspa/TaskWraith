import Foundation

/// SMPTE timecode, exact.
///
/// Timecode is where editors lose trust in a tool, because it is the number they
/// read out loud to each other. It is also where 29.97 quietly breaks things: a
/// "frame per second" count of 30 against a real rate of 30000/1001 drifts about
/// 3.6 seconds per hour, which is exactly why drop-frame notation exists. This
/// type therefore separates two ideas the arithmetic must never conflate:
///
/// * the NOMINAL rate — 30 for 29.97, 24 for 23.976 — which is how many frames a
///   timecode second counts, and
/// * the REAL rate, which StudioTimebase already holds exactly as ticks.
///
/// Drop-frame does NOT drop pictures. It skips LABELS: at the start of every
/// minute except every tenth, the first two frame numbers (four at 59.94) are
/// never used, so wall-clock and timecode stay aligned. A drop-frame timecode of
/// 00:01:00;00 does not exist, and parsing one is an error rather than a value
/// quietly rounded to something else.
public struct StudioTimecode: Equatable, Sendable {
    public let hours: Int
    public let minutes: Int
    public let seconds: Int
    public let frames: Int
    /// Drop-frame is rendered with a semicolon before the frames field, which is
    /// the convention every NLE and deck uses to make the distinction visible.
    public let isDropFrame: Bool

    public init(hours: Int, minutes: Int, seconds: Int, frames: Int, isDropFrame: Bool = false) {
        self.hours = hours
        self.minutes = minutes
        self.seconds = seconds
        self.frames = frames
        self.isDropFrame = isDropFrame
    }

    public var text: String {
        let separator = isDropFrame ? ";" : ":"
        return String(
            format: "%02d:%02d:%02d%@%02d",
            hours,
            minutes,
            seconds,
            separator,
            frames
        )
    }
}

public enum StudioTimecodeError: Error, Equatable {
    case malformed(String)
    case componentOutOfRange(String)
    /// Drop-frame is only defined for 1001-denominator rates at nominal 30 or 60.
    case dropFrameUnsupportedForRate(nominalRate: Int)
    /// A label that drop-frame skips, e.g. 00:01:00;00.
    case nonexistentDropFrameLabel(String)
    case negativeFrame
}

public enum StudioTimecodeConverter {
    /// Frames counted by one timecode second: 30 for 29.97, 24 for 23.976.
    public static func nominalRate(for timebase: StudioTimebase) -> Int {
        let exact = Double(timebase.timescale) / Double(timebase.frameDurationTicks)
        return Int(exact.rounded())
    }

    /// True when the timebase is a 1001-denominator rate at nominal 30 or 60,
    /// which is the only place drop-frame is defined.
    public static func supportsDropFrame(_ timebase: StudioTimebase) -> Bool {
        guard timebase.frameDurationTicks == 1001 else { return false }
        let nominal = nominalRate(for: timebase)
        return nominal == 30 || nominal == 60
    }

    /// Frames skipped at each dropping minute: 2 at 29.97, 4 at 59.94.
    static func droppedLabels(perMinute nominal: Int) -> Int {
        nominal / 15
    }

    // MARK: - Frame -> timecode

    public static func timecode(
        forFrame frame: Int64,
        timebase: StudioTimebase,
        dropFrame: Bool = false
    ) throws -> StudioTimecode {
        guard frame >= 0 else { throw StudioTimecodeError.negativeFrame }
        let nominal = nominalRate(for: timebase)
        guard nominal > 0 else { throw StudioTimecodeError.componentOutOfRange("rate") }

        guard dropFrame else {
            return decompose(frame, nominal: nominal, isDropFrame: false)
        }
        guard supportsDropFrame(timebase) else {
            throw StudioTimecodeError.dropFrameUnsupportedForRate(nominalRate: nominal)
        }

        // Re-insert the skipped labels so the plain decomposition below lands on
        // the right numbers.
        let dropped = Int64(droppedLabels(perMinute: nominal))
        let framesPerMinute = Int64(nominal) * 60 - dropped
        let framesPerTenMinutes = Int64(nominal) * 600 - dropped * 9

        let tenMinuteBlocks = frame / framesPerTenMinutes
        let remainder = frame % framesPerTenMinutes

        var adjusted = frame + dropped * 9 * tenMinuteBlocks
        if remainder > dropped {
            adjusted += dropped * ((remainder - dropped) / framesPerMinute)
        }
        return decompose(adjusted, nominal: nominal, isDropFrame: true)
    }

    private static func decompose(
        _ frame: Int64,
        nominal: Int,
        isDropFrame: Bool
    ) -> StudioTimecode {
        let rate = Int64(nominal)
        let totalSeconds = frame / rate
        return StudioTimecode(
            hours: Int(totalSeconds / 3600),
            minutes: Int((totalSeconds / 60) % 60),
            seconds: Int(totalSeconds % 60),
            frames: Int(frame % rate),
            isDropFrame: isDropFrame
        )
    }

    // MARK: - Timecode -> frame

    public static func frameCount(
        for timecode: StudioTimecode,
        timebase: StudioTimebase
    ) throws -> Int64 {
        let nominal = nominalRate(for: timebase)
        guard nominal > 0 else { throw StudioTimecodeError.componentOutOfRange("rate") }
        guard
            timecode.hours >= 0,
            (0..<60).contains(timecode.minutes),
            (0..<60).contains(timecode.seconds),
            (0..<nominal).contains(timecode.frames)
        else {
            throw StudioTimecodeError.componentOutOfRange(timecode.text)
        }

        let totalMinutes = Int64(timecode.hours) * 60 + Int64(timecode.minutes)
        let plain =
            (Int64(timecode.hours) * 3600 + Int64(timecode.minutes) * 60
                + Int64(timecode.seconds)) * Int64(nominal) + Int64(timecode.frames)

        guard timecode.isDropFrame else { return plain }
        guard supportsDropFrame(timebase) else {
            throw StudioTimecodeError.dropFrameUnsupportedForRate(nominalRate: nominal)
        }

        let dropped = Int64(droppedLabels(perMinute: nominal))
        // Labels that drop-frame never assigns are not values to round; they are
        // typos, and saying so is more useful than silently seeking elsewhere.
        if timecode.seconds == 0,
            timecode.minutes % 10 != 0,
            Int64(timecode.frames) < dropped
        {
            throw StudioTimecodeError.nonexistentDropFrameLabel(timecode.text)
        }
        return plain - dropped * (totalMinutes - totalMinutes / 10)
    }

    // MARK: - Text

    /// Accepts HH:MM:SS:FF and the drop-frame HH:MM:SS;FF, plus the shorthand a
    /// timecode field actually receives: bare digits, filled from the right, so
    /// "12" is 12 frames and "10000" is 1 minute 00 seconds 00 frames.
    public static func parse(_ text: String, timebase: StudioTimebase) throws -> StudioTimecode {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { throw StudioTimecodeError.malformed(text) }

        let digitsOnly = trimmed.allSatisfy { $0.isNumber }
        let separators = CharacterSet(charactersIn: ":;")
        let isDropFrame = trimmed.contains(";")

        let fields: [String]
        if digitsOnly {
            guard trimmed.count <= 8 else { throw StudioTimecodeError.malformed(text) }
            let padded = String(repeating: "0", count: 8 - trimmed.count) + trimmed
            fields = stride(from: 0, to: 8, by: 2).map { offset in
                let start = padded.index(padded.startIndex, offsetBy: offset)
                let end = padded.index(start, offsetBy: 2)
                return String(padded[start..<end])
            }
        } else {
            fields = trimmed.components(separatedBy: separators)
        }

        guard fields.count == 4 else { throw StudioTimecodeError.malformed(text) }
        var values: [Int] = []
        for field in fields {
            guard !field.isEmpty, field.allSatisfy({ $0.isNumber }), let value = Int(field) else {
                throw StudioTimecodeError.malformed(text)
            }
            values.append(value)
        }

        let candidate = StudioTimecode(
            hours: values[0],
            minutes: values[1],
            seconds: values[2],
            frames: values[3],
            isDropFrame: isDropFrame
        )
        // Validate by converting; range and drop-frame legality live in one place.
        _ = try frameCount(for: candidate, timebase: timebase)
        return candidate
    }

    /// Convenience: text straight to a frame index.
    public static func frameCount(forText text: String, timebase: StudioTimebase) throws -> Int64 {
        try frameCount(for: try parse(text, timebase: timebase), timebase: timebase)
    }
}
