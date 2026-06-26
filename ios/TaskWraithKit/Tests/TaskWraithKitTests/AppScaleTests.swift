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

        defaults.set(8, forKey: TWAppScaleStore.defaultsKey)
        #expect(TWAppScaleStore(defaults: defaults).scale == .large)

        defaults.set(-8, forKey: TWAppScaleStore.defaultsKey)
        #expect(TWAppScaleStore(defaults: defaults).scale == .compact)

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
        #expect(TWAppScale.compact.steppedDown() == .compact)
        #expect(TWAppScale.standard.steppedDown() == .compact)
        #expect(TWAppScale.large.steppedUp() == .large)
        #expect(TWAppScale.standard.steppedUp() == .large)
    }

    @Test("Static clamping maps out-of-range raw values to nearest step")
    func staticClamping() {
        #expect(TWAppScale.clamped(-11) == .compact)
        #expect(TWAppScale.clamped(11) == .large)
        #expect(TWAppScale.clamped(0) == .standard)
    }

    @Test("Scale multipliers are centered on standard")
    func multipliers() {
        #expect(TWAppScale.standard.multiplier == 1.0)
        #expect(TWAppScale.compact.multiplier < TWAppScale.standard.multiplier)
        #expect(TWAppScale.large.multiplier > TWAppScale.standard.multiplier)
    }

    @Test("Control labels match the three-button settings affordance")
    func controlLabels() {
        #expect(TWAppScale.compact.controlLabel == "-")
        #expect(TWAppScale.standard.controlLabel == "Default")
        #expect(TWAppScale.large.controlLabel == "+")
        #expect(TWAppScale.standard.label == "Default")
        #expect(TWAppScale.large.valueLabel == "110%")
    }

    @Test("Scaled values preserve standard as the current layout")
    func scaledValues() {
        #expect(TWAppScale.standard.scaled(300) == 300)
        #expect(TWAppScale.large.scaled(300) > 300)
        #expect(TWAppScale.compact.scaled(300) < 300)
    }
}
