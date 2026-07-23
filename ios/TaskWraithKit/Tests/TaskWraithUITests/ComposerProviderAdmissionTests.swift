import Foundation
import Testing
import TaskWraithKit

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

    @Test func authenticatedCatalogAdmitsAntiGravityWithoutWideningTheStaticSet() {
        let admitted = resolveComposerProviderAdmission(
            selectedProvider: "antigravity",
            cardProvider: nil,
            canChangeProvider: true,
            isNewTask: true,
            dynamicallySelectableProviderIds: ["antigravity"])
        #expect(admitted.isLive)

        let unavailable = resolveComposerProviderAdmission(
            selectedProvider: "antigravity",
            cardProvider: nil,
            canChangeProvider: true,
            isNewTask: true)
        #expect(!unavailable.isLive)
        #expect(!TWTheme.isLiveSelectableProvider("antigravity"))
    }

    @Test func geminiApiWireCatalogDecodesSeparateBillingAndAdmitsDynamically() throws {
        let message = try JSONDecoder().decode(
            ProviderModelsMessage.self,
            from: Data(
                #"{"providers":[{"provider":"antigravity","models":[{"id":"gemini-api:gemini-2.5-flash","label":"Gemini API · gemini-2.5-flash · separate billing"}]}]}"#.utf8
            ))
        let models = message.providers.first?.models ?? []
        let row = models.first

        #expect(message.providers.map(\.provider) == ["antigravity"])
        #expect(row?.id == "gemini-api:gemini-2.5-flash")
        #expect(row?.label?.contains("Gemini API") == true)
        #expect(row?.label?.contains("separate billing") == true)
        #expect(TWTheme.isProviderOfferedByModelCatalog("antigravity", models: models))
        #expect(!TWTheme.isLiveSelectableProvider("antigravity"))
        #expect(TWTheme.isRetiredProvider("gemini"))
        #expect(!TWTheme.liveSelectableProviderIds.contains("gemini"))
    }
}
