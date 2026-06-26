import Foundation

/// Small, app-wide scale bucket for UI size controls.
///
/// The enum keeps scale as a compact, clamped integer step space so UI can
/// expose controls as '-', 'Default', '+'. `standard` is the existing layout:
/// it maps to a factor of `1.0`, so a clean install keeps current appearance.
///
/// Persisted through UserDefaults as the raw Int so older settings remain a no-op
/// if they drift out-of-range — the value clamps back into the nearest bucket.
public enum TWAppScale: Int, Codable, Sendable, Hashable, Identifiable, CaseIterable {
    /// Compact layout bucket (one step smaller than standard).
    case compact = -1
    /// Current baseline layout, used as the default for new installs.
    case standard = 0
    /// Expanded layout (one step larger than standard).
    case large = 1

    public var id: Int { rawValue }

    /// Persisted bucket extrema used by clamping and stepper controls.
    public static let minimum = compact
    public static let maximum = large

    /// Human-facing labels used by the settings control.
    public var controlLabel: String {
        switch self {
        case .compact: return "-"
        case .standard: return "Default"
        case .large: return "+"
        }
    }

    /// Numeric scale multiplier applied to typography and spacing-sensitive values.
    public var multiplier: CGFloat {
        switch self {
        case .compact: return 0.92
        case .standard: return 1.00
        case .large: return 1.10
        }
    }

    public var label: String {
        switch self {
        case .compact: return "Smaller"
        case .standard: return "Default"
        case .large: return "Larger"
        }
    }

    public var valueLabel: String {
        switch self {
        case .compact: return "92%"
        case .standard: return "100%"
        case .large: return "110%"
        }
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
