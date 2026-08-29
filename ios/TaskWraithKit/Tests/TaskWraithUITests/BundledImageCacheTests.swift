import Foundation
import SwiftUI
import Testing

@testable import TaskWraithUI

/// `.serialized` because `BundledImageCache` is process-wide state. Swift
/// Testing runs a suite's tests in parallel by default, and two tests that each
/// call `resetForTesting()` would otherwise clear each other's counters.
@Suite("Bundled image cache", .serialized)
@MainActor
struct BundledImageCacheTests {
    @Test func repeatedLookupsOfOneKeyLoadOnce() {
        BundledImageCache.resetForTesting()

        _ = AgentIdentityBadge.catalogImage(for: "uno")
        _ = AgentIdentityBadge.catalogImage(for: "uno")
        _ = AgentIdentityBadge.catalogImage(for: "uno")

        // Without the cache this is 3: a bundle lookup, a ~20 KB disk read and
        // a PNG decode per SwiftUI body evaluation.
        #expect(BundledImageCache.loadCount == 1)
    }

    @Test func missesAreCachedToo() {
        BundledImageCache.resetForTesting()

        let first = AgentIdentityBadge.catalogImage(for: "no-such-baked-character")
        let second = AgentIdentityBadge.catalogImage(for: "no-such-baked-character")

        #expect(first == nil)
        #expect(second == nil)
        // The miss is the common path — an agent outside the hand-drawn catalog
        // used to pay a failed bundle lookup plus a failed asset-catalog lookup
        // on every render. Caching only hits would leave that untouched.
        #expect(BundledImageCache.loadCount == 1)
    }

    @Test func distinctKeysLoadIndependently() {
        BundledImageCache.resetForTesting()

        _ = AgentIdentityBadge.catalogImage(for: "uno")
        _ = AgentIdentityBadge.catalogImage(for: "volkarr")
        _ = AgentIdentityBadge.catalogImage(for: "uno")

        // Two keys, two loads — proves the cache is keyed rather than latching
        // the first image it ever saw and serving it to every slug.
        #expect(BundledImageCache.loadCount == 2)
    }

    @Test func absentSlugsNeverReachTheCache() {
        BundledImageCache.resetForTesting()

        #expect(AgentIdentityBadge.catalogImage(for: nil) == nil)
        #expect(AgentIdentityBadge.catalogImage(for: "") == nil)

        // The pre-existing guard still short-circuits ahead of any lookup, so
        // an empty slug cannot occupy a cache entry.
        #expect(BundledImageCache.loadCount == 0)
    }

    @Test func nothingFoundIsDistinctFromNeverLookedUp() {
        BundledImageCache.resetForTesting()

        let first = BundledImageCache.image(forKey: "probe") { nil }
        let second = BundledImageCache.image(forKey: "probe") { nil }

        #expect(first == nil)
        #expect(second == nil)
        #expect(BundledImageCache.loadCount == 1)
    }

    /// Guards every `loadCount` assertion above against passing vacuously.
    ///
    /// Those tests count loads, not images, so every one of them would still
    /// pass if `identicon-uno.png` were renamed out of the bundle and each
    /// lookup silently became a miss. This asserts the fixtures are really
    /// there — and it goes through `catalogResourceURL` rather than
    /// `catalogImage` so it runs on macOS too, where `canImport(UIKit)` is
    /// false and `catalogImage` returns nil for every slug, unable to tell
    /// "no artwork" apart from "no UIKit".
    @Test func theCatalogFixturesTheseTestsRelyOnAreRealBundledPNGs() throws {
        let pngSignature = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

        for slug in ["uno", "volkarr"] {
            let url = try #require(
                AgentIdentityBadge.catalogResourceURL(for: slug),
                "identicon-\(slug).png is missing — the loadCount tests above would pass vacuously"
            )
            let data = try Data(contentsOf: url)
            #expect(data.prefix(pngSignature.count) == pngSignature)
        }
    }

    /// The other half of that guard: a fixture that is present must actually
    /// decode to an `Image`. Only meaningful where UIKit exists, so it runs on
    /// an iOS destination rather than the macOS `swift test` build.
    #if canImport(UIKit)
        @Test func bakedCatalogSlugsResolveToArtwork() {
            BundledImageCache.resetForTesting()

            #expect(AgentIdentityBadge.catalogImage(for: "uno") != nil)
            #expect(AgentIdentityBadge.catalogImage(for: "volkarr") != nil)
        }
    #endif
}
