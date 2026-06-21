import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Selectable home-screen app-icon variants. Mirror of `AppIconVariant` in
/// `src/shared/iconVariants.ts`. Each non-`regular` case maps to an alternate
/// appiconset declared via `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES`; the
/// system auto-renders each set's Dark/Tinted appearance, so theme-awareness of
/// the alternate icon needs no per-appearance runtime code.
public enum TWAppIconVariant: String, CaseIterable, Identifiable {
    case regular
    case wwdc26
    case monoline
    case glass

    public var id: String { rawValue }

    /// Alternate-icon name for `setAlternateIconName`; `nil` = the primary icon.
    public var alternateIconName: String? {
        switch self {
        case .regular: return nil
        case .wwdc26: return "AppIcon-WWDC26"
        case .monoline: return "AppIcon-Monoline"
        case .glass: return "AppIcon-Glass"
        }
    }

    public var label: String {
        switch self {
        case .regular: return "Regular"
        case .wwdc26: return "WWDC26"
        case .monoline: return "Monoline"
        case .glass: return "Glass"
        }
    }

    /// Asset-catalog imageset used as the Settings picker thumbnail.
    public var thumbnailAssetName: String {
        switch self {
        case .regular: return "app-icon-regular"
        case .wwdc26: return "app-icon-wwdc26"
        case .monoline: return "app-icon-monoline"
        case .glass: return "app-icon-glass"
        }
    }

    public var isLimitedTime: Bool { self == .wwdc26 }

    /// Variants to OFFER now. Applies the WWDC26 gate (OFFER surface only).
    public static func available(now: Date = Date()) -> [TWAppIconVariant] {
        allCases.filter { variant in
            variant == .wwdc26 ? TWAppIconAvailability.isWWDC26Available(now: now) : true
        }
    }
}

/// Persists the chosen variant and applies it to the home-screen icon.
///
/// State lives in a STANDALONE UserDefaults key (`tw.appIcon`) — NOT on
/// `TWThemeStore` — so changing the icon does not bump `revision` and tear down
/// RootView (the swap is an OS-level change with no in-app repaint). Reads are
/// ungated, so a grandfathered WWDC26 choice keeps applying past the cutoff.
public enum TWAppIconController {
    private static let defaultsKey = "tw.appIcon"

    /// The stored choice (defaults to `.regular`).
    public static var selected: TWAppIconVariant {
        let raw = UserDefaults.standard.string(forKey: defaultsKey) ?? ""
        return TWAppIconVariant(rawValue: raw) ?? .regular
    }

    /// Persist + apply a user selection.
    @MainActor
    public static func select(_ variant: TWAppIconVariant) {
        UserDefaults.standard.set(variant.rawValue, forKey: defaultsKey)
        applyToSystem(variant)
    }

    /// Re-apply the stored choice if the live icon has drifted (call on
    /// foreground-active). Cheap no-op when already in sync.
    @MainActor
    public static func reconcile() {
        applyToSystem(selected)
    }

    @MainActor
    private static func applyToSystem(_ variant: TWAppIconVariant) {
        #if canImport(UIKit)
        guard UIApplication.shared.supportsAlternateIcons else { return }
        let target = variant.alternateIconName
        // setAlternateIconName fires a system alert on every *successful* change,
        // so never call it when the requested icon is already current.
        guard target != UIApplication.shared.alternateIconName else { return }
        UIApplication.shared.setAlternateIconName(target) { error in
            if let error {
                print("[tw] setAlternateIconName failed: \(error.localizedDescription)")
            }
        }
        #endif
    }
}
