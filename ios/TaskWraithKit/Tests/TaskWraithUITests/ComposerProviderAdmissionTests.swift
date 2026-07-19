import Testing

@testable import TaskWraithUI

@Suite("Composer provider admission")
struct ComposerProviderAdmissionTests {
    @Test func existingHistoricalThreadRemainsBoundAndUnavailable() {
        let admission = resolveComposerProviderAdmission(
            selectedProvider: "claude",
            cardProvider: "cursor",
            canChangeProvider: false,
            isNewTask: false)

        #expect(admission.provider == "cursor")
        #expect(!admission.isLive)
        #expect(admission.unavailableReason?.contains("Cursor managed runs are unavailable") == true)
        #expect(admission.unavailableReason?.contains("Open a new chat") == true)
    }

    @Test func changeableHistoricalThreadCanSelectALiveProvider() {
        let admission = resolveComposerProviderAdmission(
            selectedProvider: "claude",
            cardProvider: "cursor",
            canChangeProvider: true,
            isNewTask: false)

        #expect(admission.provider == "claude")
        #expect(admission.isLive)
        #expect(admission.unavailableReason == nil)
    }

    @Test func changeableHistoricalSelectionStaysBlockedUntilUserSwitches() {
        let admission = resolveComposerProviderAdmission(
            selectedProvider: "cursor",
            cardProvider: "cursor",
            canChangeProvider: true,
            isNewTask: false)

        #expect(!admission.isLive)
        #expect(admission.unavailableReason?.contains("Choose a live provider") == true)
    }

    @Test func newTaskUsesPickerSelectionRatherThanHistoricalCardProvider() {
        let admission = resolveComposerProviderAdmission(
            selectedProvider: "kimi",
            cardProvider: "cursor",
            canChangeProvider: false,
            isNewTask: true)

        #expect(admission.provider == "kimi")
        #expect(admission.isLive)
    }
}
