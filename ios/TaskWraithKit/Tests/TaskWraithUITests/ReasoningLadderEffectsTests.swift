import Testing

@testable import TaskWraithUI

@Suite("Reasoning ladder effects")
struct ReasoningLadderEffectsTests {
    @Test func offIsNeutralAndLowStartsTheVisualTaper() {
        let off = TWReasoningLadderEffectProfile.forIndex(0)
        let low = TWReasoningLadderEffectProfile.forIndex(1)

        #expect(!off.isActive)
        #expect(off.intensity == 0)
        #expect(off.sparkleCount == 0)
        #expect(off.shimmerBandCount == 0)
        #expect(low.isActive)
        #expect(low.intensity == 1.0 / 6.0)
        #expect(low.sparkleCount == 3)
        #expect(low.shimmerBandCount == 1)
    }

    @Test func visualStrengthAndEffectDensityIncreaseThroughTheTopStop() {
        let profiles = (0...6).map(TWReasoningLadderEffectProfile.forIndex)

        #expect(profiles.map(\.sparkleCount) == [0, 3, 5, 8, 11, 13, 16])
        #expect(profiles.map(\.shimmerBandCount) == [0, 1, 1, 2, 2, 3, 3])
        #expect(
            profiles.map(\.intensity)
                == [0, 1.0 / 6, 2.0 / 6, 3.0 / 6, 4.0 / 6, 5.0 / 6, 1])
        #expect(zip(profiles, profiles.dropFirst()).allSatisfy { $0.intensity < $1.intensity })
    }

    @Test func outOfRangeIndicesClampToTheNearestEndpoint() {
        #expect(
            TWReasoningLadderEffectProfile.forIndex(-4)
                == TWReasoningLadderEffectProfile.forIndex(0))
        #expect(
            TWReasoningLadderEffectProfile.forIndex(12)
                == TWReasoningLadderEffectProfile.forIndex(6))
    }

    @Test func museMetaEffortMapsOntoSharedLadderStops() {
        #expect(twLadderIndex(for: "minimal", provider: "muse") == 0)
        #expect(twLadderIndex(for: "low", provider: "muse") == 1)
        #expect(twLadderIndex(for: "medium", provider: "muse") == 2)
        #expect(twLadderIndex(for: "high", provider: "muse") == 3)
        #expect(twLadderIndex(for: "xhigh", provider: "muse") == 4)
        #expect(twLadderIndex(for: "ultra", provider: "muse") == 6)
        // Muse-scoped: other providers must not treat minimal as Off.
        #expect(twLadderIndex(for: "minimal", provider: "codex") == nil)
    }

    @Test func piEffortsRetainTheirNativeSevenStopOrdering() {
        let efforts = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

        #expect(efforts.enumerated().allSatisfy { index, effort in
            twLadderIndex(for: effort, provider: "pi") == index
        })
        #expect(efforts.indices.allSatisfy { index in
            twLadderWireEffort(index: index, provider: "pi") == efforts[index]
        })
    }

    @Test func museMetaEffortDisplayLabelsMatchDesktop() {
        #expect(twReasoningDisplayLabel("minimal", provider: "muse") == "Minimal")
        #expect(twReasoningDisplayLabel("xhigh", provider: "muse") == "Extra High")
        #expect(twReasoningDisplayLabel("xhigh", provider: "pi") == "Extra High")
        #expect(twReasoningDisplayLabel("ultra", provider: "muse") == "Ultra")
        #expect(twReasoningDisplayLabel("ultracode", provider: "muse") == "Ultra")
        #expect(twReasoningDisplayLabel("xhigh", provider: "claude") == "Extra")
    }

    @Test func museMetaWireTokensStayOnSharedFloorAndCeiling() {
        #expect(twLadderWireEffort(index: 0, provider: "muse") == "minimal")
        #expect(twLadderWireEffort(index: 6, provider: "muse") == "ultra")
        #expect(twLadderWireEffort(index: 0, provider: "codex") == "off")
        #expect(twLadderWireEffort(index: 6, provider: "codex") == "ultracode")
    }
}
