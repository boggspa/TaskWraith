import Foundation

/// Swift twin of `src/shared/greeting.ts`.
///
/// The time-of-day greeting shown in the New General Chat welcome heading is
/// shared across Electron and iOS so a user switching Mac <-> phone sees the
/// same wording. The TypeScript module is the source of truth; THESE VALUES
/// MUST MATCH IT. A drift-guard test (`src/shared/greeting.test.ts`) reads this
/// file and fails CI if any value diverges (same pattern as RevealParams.swift /
/// AppIconAvailability.swift).
///
/// Boundaries are on LOCAL hour-of-day (0-23): morning [0,12), afternoon
/// [12,18), evening [18,24). The greeting is purely presentational and computed
/// from the device-local clock — no timezone is propagated phone<->Mac.
public enum Greeting {
    /// Local hour (0-23) at/after which the greeting becomes "Good afternoon".
    public static let afternoonStartHour = 12
    /// Local hour (0-23) at/after which the greeting becomes "Good evening".
    public static let eveningStartHour = 18

    public static let morning = "Good morning"
    public static let afternoon = "Good afternoon"
    public static let evening = "Good evening"

    /// Map a local hour (0-23) to a time-of-day greeting.
    public static func greeting(forHour hour: Int) -> String {
        if hour < afternoonStartHour { return morning }
        if hour < eveningStartHour { return afternoon }
        return evening
    }

    /// Build the full greeting line, appending the user's name when present.
    /// Empty / whitespace-only names are omitted, so the result is e.g.
    /// "Good morning" or "Good morning, Chris".
    public static func build(forHour hour: Int, name: String?) -> String {
        let base = greeting(forHour: hour)
        let trimmed = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? base : "\(base), \(trimmed)"
    }

    /// Convenience: greeting for the current device-local time.
    public static func current(name: String? = nil, now: Date = Date()) -> String {
        let hour = Calendar.current.component(.hour, from: now)
        return build(forHour: hour, name: name)
    }
}
