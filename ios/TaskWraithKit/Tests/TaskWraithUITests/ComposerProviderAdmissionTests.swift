import Testing

@testable import TaskWraithUI

@Suite("Composer provider admission")
struct ComposerProviderAdmissionTests {
    @Test func existingCursorThreadIsLiveAgain() {
        let admission = resolveComposerProviderAdmission(
            selectedProvider: "claude",
            cardProvider: "cursor",
            canChangeProvider: false,
            isNewTask: false)

        #expect(admission.provider == "cursor")
        #expect(admission.isLive)
        #expect(admission.unavailableReason == nil)
    }

    @Test func newCursorTaskDispatchesLive() {
        let admission = resolveComposerProviderAdmission(
            selectedProvider: "cursor",
            cardProvider: nil,
            canChangeProvider: false,
            isNewTask: true)

        #expect(admission.provider == "cursor")
        #expect(admission.isLive)
        #expect(admission.unavailableReason == nil)
    }

    @Test func existingRetiredThreadRemainsBoundAndUnavailable() {
        let admission = resolveComposerProviderAdmission(
            selectedProvider: "claude",
            cardProvider: "gemini",
            canChangeProvider: false,
            isNewTask: false)

        #expect(admission.provider == "gemini")
        #expect(!admission.isLive)
        #expect(admission.unavailableReason?.contains("Gemini managed runs are unavailable") == true)
        #expect(admission.unavailableReason?.contains("Open a new chat") == true)
    }

    @Test func changeableHistoricalThreadCanSelectALiveProvider() {
        let admission = resolveComposerProviderAdmission(
            selectedProvider: "claude",
            cardProvider: "gemini",
            canChangeProvider: true,
            isNewTask: false)

        #expect(admission.provider == "claude")
        #expect(admission.isLive)
        #expect(admission.unavailableReason == nil)
    }

    @Test func changeableRetiredSelectionStaysBlockedUntilUserSwitches() {
        let admission = resolveComposerProviderAdmission(
            selectedProvider: "gemini",
            cardProvider: "gemini",
            canChangeProvider: true,
            isNewTask: false)

        #expect(!admission.isLive)
        #expect(admission.unavailableReason?.contains("Choose a live provider") == true)
    }

    @Test func newTaskUsesPickerSelectionRatherThanHistoricalCardProvider() {
        let admission = resolveComposerProviderAdmission(
            selectedProvider: "kimi",
            cardProvider: "gemini",
            canChangeProvider: false,
            isNewTask: true)

        #expect(admission.provider == "kimi")
        #expect(admission.isLive)
    }
}
