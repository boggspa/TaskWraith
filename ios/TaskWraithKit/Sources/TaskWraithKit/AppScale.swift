import Foundation

/// Small, app-wide scale bucket for UI size controls.
///
/// The enum keeps scale as a compact, clamped integer step space so UI can
/// expose controls as '-', 'Default', '+'. `standard` is the existing layout:
/// it maps to a factor of `1.0`, so a clean install keeps current appearance.
///
/// Persisted through UserDefaults as the raw Int so older settings remain a no-op
/// if they drift out-of-range — the value clamps back into the nearest bucket.
///
/// Five steps in each direction from `standard` — down to `compact5` (60%) and
/// up to `large5` (150%) — covering the extremes past the original single-step
/// `compact`/`large` (kept at their original -1/+1 raw values and 92%/110%
/// factors so previously-persisted choices don't shift).
public enum TWAppScale: Int, Codable, Sendable, Hashable, Identifiable, CaseIterable {
    case compact5 = -5
    case compact4 = -4
    case compact3 = -3
    case compact2 = -2
    /// Compact layout bucket (one step smaller than standard).
    case compact = -1
    /// Current baseline layout, used as the default for new installs.
    case standard = 0
    /// Expanded layout (one step larger than standard).
    case large = 1
    case large2 = 2
    case large3 = 3
    case large4 = 4
    case large5 = 5

    public var id: Int { rawValue }

    /// Persisted bucket extrema used by clamping and stepper controls.
    public static let minimum = compact5
    public static let maximum = large5

    /// Human-facing labels used by the settings control. The settings row only
    /// ever shows the three '-' / 'Default' / '+' buttons regardless of the
    /// current bucket, so every negative/positive step shares its symbol.
    public var controlLabel: String {
        if rawValue < 0 { return "-" }
        if rawValue > 0 { return "+" }
        return "Default"
    }

    /// Numeric scale multiplier applied to typography and spacing-sensitive
    /// values. Linear per-step, matching the original single-step deltas:
    /// -8% per step down (0.92, 0.84, 0.76, 0.68, 0.60), +10% per step up
    /// (1.10, 1.20, 1.30, 1.40, 1.50).
    public var multiplier: CGFloat {
        let step = CGFloat(rawValue)
        return step >= 0 ? 1.00 + step * 0.10 : 1.00 + step * 0.08
    }

    public var label: String {
        if rawValue < 0 { return "Smaller" }
        if rawValue > 0 { return "Larger" }
        return "Default"
    }

    public var valueLabel: String {
        "\(Int((multiplier * 100).rounded()))%"
    }

    public func scaled(_ value: CGFloat) -> CGFloat {
        value * multiplier
    }

    public static var fallback: Self { .standard }

    /// Clamp an arbitrary raw value into the supported step domain.
    public static func clamped(_ rawValue: Int) -> Self {
        return Self(rawValue: rawValue.clamped(to: minimum.rawValue...maximum.rawValue))
            ?? .standard
    }

    /// One-step left control behavior. Already at minimum => no change.
    public func steppedDown() -> Self {
        Self.clamped(rawValue - 1)
    }

    /// One-step right control behavior. Already at maximum => no change.
    public func steppedUp() -> Self {
        Self.clamped(rawValue + 1)
    }

    /// Persisted default that matches current UI.
    public var isDefault: Bool { self == .standard }
}

private extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self {
        if self < range.lowerBound { return range.lowerBound }
        if self > range.upperBound { return range.upperBound }
        return self
    }
}

/// UserDefaults-backed persistence for app scale, injection-friendly for tests.
public struct TWAppScaleStore {
    public static let defaultsKey = "tw.appScale.v1"

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Returns `TWAppScale.standard` when the stored value is absent or invalid.
    public var scale: TWAppScale {
        get {
            guard let raw = defaults.object(forKey: Self.defaultsKey) as? NSNumber else {
                return .standard
            }
            return TWAppScale.clamped(raw.intValue)
        }
        set {
            defaults.set(newValue.rawValue, forKey: Self.defaultsKey)
        }
    }
}
