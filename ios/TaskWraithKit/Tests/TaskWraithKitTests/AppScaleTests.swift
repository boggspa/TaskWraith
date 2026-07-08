// Persisted scale buckets + clamped step behaviour.

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("App scale")
struct AppScaleTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "test.tw.app-scale.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    @Test("Unknown, missing, or out-of-range values clamp to nearest bucket")
    func defaultsFallbackToStandard() {
        let defaults = freshDefaults()
        #expect(TWAppScaleStore(defaults: defaults).scale == .standard)

        defaults.set(80, forKey: TWAppScaleStore.defaultsKey)
        #expect(TWAppScaleStore(defaults: defaults).scale == .large5)

        defaults.set(-80, forKey: TWAppScaleStore.defaultsKey)
        #expect(TWAppScaleStore(defaults: defaults).scale == .compact5)

        defaults.removeObject(forKey: TWAppScaleStore.defaultsKey)
        #expect(TWAppScaleStore(defaults: defaults).scale == .standard)
    }

    @Test("Persisted value round-trips through a fresh store")
    func persistsAndReadsBack() {
        let defaults = freshDefaults()
        var store = TWAppScaleStore(defaults: defaults)
        store.scale = .compact
        #expect(TWAppScaleStore(defaults: defaults).scale == .compact)

        store.scale = .large
        #expect(TWAppScaleStore(defaults: defaults).scale == .large)
        #expect(store.scale == .large)
    }

    @Test("Stepping clamps at min and max")
    func clampedStepping() {
        #expect(TWAppScale.compact5.steppedDown() == .compact5)
        #expect(TWAppScale.standard.steppedDown() == .compact)
        #expect(TWAppScale.large5.steppedUp() == .large5)
        #expect(TWAppScale.standard.steppedUp() == .large)
    }

    @Test("Stepping walks through every bucket in order")
    func steppingWalksAllBuckets() {
        #expect(TWAppScale.standard.steppedDown() == .compact)
        #expect(TWAppScale.compact.steppedDown() == .compact2)
        #expect(TWAppScale.compact2.steppedDown() == .compact3)
        #expect(TWAppScale.compact3.steppedDown() == .compact4)
        #expect(TWAppScale.compact4.steppedDown() == .compact5)

        #expect(TWAppScale.standard.steppedUp() == .large)
        #expect(TWAppScale.large.steppedUp() == .large2)
        #expect(TWAppScale.large2.steppedUp() == .large3)
        #expect(TWAppScale.large3.steppedUp() == .large4)
        #expect(TWAppScale.large4.steppedUp() == .large5)
    }

    @Test("Static clamping maps out-of-range raw values to nearest step")
    func staticClamping() {
        #expect(TWAppScale.clamped(-11) == .compact5)
        #expect(TWAppScale.clamped(11) == .large5)
        #expect(TWAppScale.clamped(0) == .standard)
    }

    @Test("Scale multipliers are centered on standard and increase monotonically")
    func multipliers() {
        #expect(TWAppScale.standard.multiplier == 1.0)
        #expect(TWAppScale.compact.multiplier < TWAppScale.standard.multiplier)
        #expect(TWAppScale.large.multiplier > TWAppScale.standard.multiplier)
        #expect(TWAppScale.compact5.multiplier == 0.60)
        #expect(TWAppScale.large5.multiplier == 1.50)

        let ordered = TWAppScale.allCases.sorted { $0.rawValue < $1.rawValue }
        for (previous, next) in zip(ordered, ordered.dropFirst()) {
            #expect(previous.multiplier < next.multiplier)
        }
    }

    @Test("Control labels match the three-button settings affordance")
    func controlLabels() {
        #expect(TWAppScale.compact.controlLabel == "-")
        #expect(TWAppScale.compact5.controlLabel == "-")
        #expect(TWAppScale.standard.controlLabel == "Default")
        #expect(TWAppScale.large.controlLabel == "+")
        #expect(TWAppScale.large5.controlLabel == "+")
        #expect(TWAppScale.standard.label == "Default")
        #expect(TWAppScale.large.valueLabel == "110%")
        #expect(TWAppScale.compact5.valueLabel == "60%")
        #expect(TWAppScale.large5.valueLabel == "150%")
    }

    @Test("Scaled values preserve standard as the current layout")
    func scaledValues() {
        #expect(TWAppScale.standard.scaled(300) == 300)
        #expect(TWAppScale.large.scaled(300) > 300)
        #expect(TWAppScale.compact.scaled(300) < 300)
        #expect(TWAppScale.large5.scaled(300) == 450)
        #expect(TWAppScale.compact5.scaled(300) == 180)
    }
}
