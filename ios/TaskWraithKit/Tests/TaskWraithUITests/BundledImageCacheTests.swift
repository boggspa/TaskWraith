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

    #if canImport(UIKit)
        @Test func bakedCatalogSlugStillResolvesToArtwork() {
            BundledImageCache.resetForTesting()

            // Guards the tests above against passing vacuously: if "uno" stopped
            // resolving, every loadCount assertion would still hold while the
            // badge silently fell back to the ring.
            #expect(AgentIdentityBadge.catalogImage(for: "uno") != nil)
        }
    #endif
}
