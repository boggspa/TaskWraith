// Memoization for bundled-resource image loads (provider logos, identicons)
// that are resolved from inside SwiftUI `body`. Fixed marks are not routed
// through this cache; they load once via their own static caches.

import SwiftUI

/// Caches `Image` values loaded from the SwiftPM resource bundle, keyed by
/// asset.
///
/// Every caller resolves its artwork from inside a view `body`, which SwiftUI
/// re-evaluates on each state change — during a live run that is many times a
/// second, once per visible row. Each of those evaluations previously paid a
/// bundle lookup, a ~20 KB disk read and a full PNG decode. `UIImage(named:)`
/// is backed by the system's own asset cache, but `UIImage(data:)` is not, so
/// nothing upstream absorbed the repeat cost.
///
/// **Misses are cached too.** `entries` stores an `Image?`, so a key that
/// resolves to nothing is remembered as "looked up, found nothing" rather than
/// being retried forever. That is the common path, not the rare one: an agent
/// outside the hand-drawn identicon catalog used to pay a failed bundle lookup
/// *plus* a failed asset-catalog lookup on every single render.
///
/// `@MainActor` because every caller is a view body, and this package builds
/// under the Swift 6 language mode, where mutable static state must be
/// isolated.
@MainActor
enum BundledImageCache {
    /// Two levels of optional are load-bearing: the outer level distinguishes
    /// "never looked up" from "looked up and found nothing".
    private static var entries: [String: Image?] = [:]

    /// How many times `load` has actually run — i.e. cache misses. Exposed so
    /// tests can assert that repeated lookups of one key hit the bundle once;
    /// without that counter a caching test can only compare two equal `Image`
    /// values, which passes whether or not the cache exists.
    private(set) static var loadCount = 0

    static func image(forKey key: String, load: () -> Image?) -> Image? {
        if let cached = entries[key] { return cached }
        loadCount += 1
        let loaded = load()
        entries[key] = loaded
        return loaded
    }

    /// Drops every entry and zeroes `loadCount`. Tests only — the cache is
    /// process-wide, so a test that did not reset it would observe whichever
    /// lookups an earlier test happened to perform first.
    static func resetForTesting() {
        entries.removeAll()
        loadCount = 0
    }
}
