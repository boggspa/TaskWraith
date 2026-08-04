import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Selectable home-screen app-icon variants. Mirror of `AppIconVariant` in
/// `src/shared/iconVariants.ts` (drift-guarded by `iconVariants.test.ts`).
/// Monoline (v2 art) is the PRIMARY appiconset — `nil` alternate — so fresh
/// installs never trigger the system alternate-icon alert. Each other case maps
/// to an alternate appiconset declared via
/// `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES`; the system auto-renders each
/// set's Dark/Tinted appearance, so theme-awareness needs no runtime code.
public enum TWAppIconVariant: String, CaseIterable, Identifiable {
    case regular
    case monoline
    case glass

    public var id: String { rawValue }

    /// Alternate-icon name for `setAlternateIconName`; `nil` = the primary icon.
    public var alternateIconName: String? {
        switch self {
        case .monoline: return nil
        case .regular: return "AppIcon-Regular"
        case .glass: return "AppIcon-Glass"
        }
    }

    public var label: String {
        switch self {
        case .regular: return "Regular"
        case .monoline: return "Monoline"
        case .glass: return "Glass"
        }
    }

    /// Asset-catalog imageset used as the Settings picker thumbnail.
    public var thumbnailAssetName: String {
        switch self {
        case .regular: return "app-icon-regular"
        case .monoline: return "app-icon-monoline"
        case .glass: return "app-icon-glass"
        }
    }

    /// Variants to OFFER in the picker. All variants are always offered (the
    /// limited-time WWDC26 variant and its availability gate were retired).
    public static func available() -> [TWAppIconVariant] {
        allCases
    }
}

/// Persists the chosen variant and applies it to the home-screen icon.
///
/// State lives in a STANDALONE UserDefaults key (`tw.appIcon`) — NOT on
/// `TWThemeStore` — so changing the icon does not bump `revision` and tear down
/// RootView (the swap is an OS-level change with no in-app repaint). A stale
/// persisted `wwdc26` fails the raw-value init and falls back to the default,
/// which reconciles the retired icon back to the primary.
public enum TWAppIconController {
    private static let defaultsKey = "tw.appIcon"

    /// The stored choice (defaults to `.monoline`, the primary icon).
    public static var selected: TWAppIconVariant {
        let raw = UserDefaults.standard.string(forKey: defaultsKey) ?? ""
        return TWAppIconVariant(rawValue: raw) ?? .monoline
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
