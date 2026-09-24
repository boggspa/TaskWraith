import Foundation
import Testing

@testable import TaskWraithKit
@testable import TaskWraithUI

@Suite("Composer Pi reasoning hydration")
struct ComposerPiReasoningHydrationTests {
    @Test func existingInklingEffortsRoundTripIntoComposerResync() throws {
        for effort in ["off", "minimal", "low", "medium", "high", "max"] {
            let card = try JSONDecoder().decode(
                RemoteTaskCard.self,
                from: Data(
                    """
                    {"id":"pi-thread","provider":"pi","selectedModelType":"openrouter/thinkingmachines/inkling:free","piReasoningEffort":"\(effort)"}
                    """.utf8))

            #expect(card.piReasoningEffort == effort)
            #expect(twRemoteCardReasoningEffort(card, selectedProvider: "codex") == effort)
        }
    }

    @Test func blankOrForeignEffortDoesNotInventASelection() throws {
        let blank = try JSONDecoder().decode(
            RemoteTaskCard.self,
            from: Data(
                #"{"id":"pi-thread","provider":"pi","piReasoningEffort":"   "}"#.utf8))
        let foreign = try JSONDecoder().decode(
            RemoteTaskCard.self,
            from: Data(
                #"{"id":"claude-thread","provider":"claude","piReasoningEffort":"minimal"}"#.utf8))

        #expect(twRemoteCardReasoningEffort(blank, selectedProvider: "pi") == nil)
        #expect(twRemoteCardReasoningEffort(foreign, selectedProvider: "pi") == nil)
    }
}
