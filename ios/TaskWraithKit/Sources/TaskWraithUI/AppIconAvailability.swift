import Foundation

/// Swift twin of the WWDC26 availability gate in `src/shared/iconVariants.ts`.
/// KEEP IN SYNC — `iconVariants.test.ts` drift-guards the cutoff against this
/// file's literal. WWDC26 is OFFERED strictly before the cutoff instant.
///
/// INVARIANT: consulted only on OFFER surfaces (the Settings picker). The apply
/// path (`TWAppIconController`) never calls this, so a chosen WWDC26 icon is
/// grandfathered past the cutoff instead of being reset.
public enum TWAppIconAvailability {
    /// 2026-09-01T00:00:00Z. Mirrors `Date.UTC(2026, 8, 1)` (= 1_788_220_800_000 ms).
    public static let wwdc26AvailableUntil = Date(timeIntervalSince1970: 1_788_220_800)

    /// Mirror of `WWDC26_AVAILABILITY`: `.auto` honours the date; `.always` /
    /// `.never` force the offer on/off (extend or retire the promo early).
    public enum Mode: Sendable { case auto, always, never }
    public static let wwdc26Mode: Mode = .auto

    /// Whether the WWDC26 variant may be OFFERED at `now`.
    public static func isWWDC26Available(now: Date = Date()) -> Bool {
        switch wwdc26Mode {
        case .always: return true
        case .never: return false
        case .auto: return now < wwdc26AvailableUntil
        }
    }
}
