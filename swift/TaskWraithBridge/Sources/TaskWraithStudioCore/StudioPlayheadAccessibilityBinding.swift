import Foundation

/// A value an assistive client can set on the Playhead slider.
///
/// VoiceOver increment/decrement uses ticks (the slider's numeric value).
/// Typing a SMPTE label uses the same Core parser the timecode field already
/// trusts, so a spoken seek and a typed seek cannot disagree.
public enum StudioPlayheadAccessibilityValue: Equatable, Sendable {
    case ticks(Int64)
    case timecode(String)

    /// Accepts the shapes AppKit actually delivers through `setAccessibilityValue`:
    /// `NSNumber`, bridged integers, and the spoken/typed string.
    public static func parse(_ raw: Any?) -> StudioPlayheadAccessibilityValue? {
        switch raw {
        case let number as NSNumber:
            return .ticks(number.int64Value)
        case let value as Int64:
            return .ticks(value)
        case let value as Int:
            return .ticks(Int64(value))
        case let value as Double:
            guard value.isFinite else { return nil }
            return .ticks(Int64(value.rounded()))
        case let text as String:
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            if let ticks = Int64(trimmed) { return .ticks(ticks) }
            return .timecode(trimmed)
        default:
            return nil
        }
    }
}

/// Maps an assistive-technology value change onto the ONE transport.
///
/// The overlay already publishes a Playhead slider VoiceOver can READ. Outcome 10
/// also requires that a VoiceOver user can SCRUB. This type is the only place
/// that slider is allowed to become a seek, so a second scheduler cannot grow
/// beside `StudioTransportController` — the audio lane already paid for that bug.
///
/// `isBound` exists so a test can revert the wiring and prove the transport
/// does not move. Production always constructs a bound instance.
public struct StudioPlayheadAccessibilityBinding: Equatable, Sendable {
    public var isBound: Bool

    public init(isBound: Bool = true) {
        self.isBound = isBound
    }

    /// Seeks the supplied transport. Returns false when unbound or the value
    /// cannot be interpreted; the playhead is left exactly where it was.
    @discardableResult
    public func apply(
        _ value: StudioPlayheadAccessibilityValue,
        to transport: inout StudioTransportController,
        atHost hostSeconds: Double
    ) -> Bool {
        guard isBound else { return false }
        switch value {
        case .ticks(let ticks):
            transport.seek(toTicks: ticks, atHost: hostSeconds)
            return true
        case .timecode(let text):
            do {
                try transport.seek(toTimecodeText: text, atHost: hostSeconds)
                return true
            } catch {
                return false
            }
        }
    }

    /// VoiceOver increment/decrement. One frame, same transport.
    @discardableResult
    public func step(
        frames delta: Int64,
        to transport: inout StudioTransportController,
        atHost hostSeconds: Double
    ) -> Bool {
        guard isBound else { return false }
        transport.stepFrames(delta, atHost: hostSeconds)
        return true
    }
}
