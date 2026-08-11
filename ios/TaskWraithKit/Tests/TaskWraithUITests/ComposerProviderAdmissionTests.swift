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
        #expect(admission.unavailableReason?.contains("Gemini is retired for new runs") == true)
        #expect(admission.unavailableReason?.contains("Existing history remains available") == true)
        #expect(admission.unavailableReason?.contains("managed runs") == false)
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
        #expect(
            admission.unavailableReason?.contains(
                "Choose a provider currently offered by the connected Mac") == true)
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
        #expect(
            unavailable.unavailableReason?.contains(
                "Complete its consent and credential setup on the Mac") == true)
        #expect(unavailable.unavailableReason?.contains("managed runs") == false)
        #expect(!TWTheme.isLiveSelectableProvider("antigravity"))
    }

    @Test func staticProviderOfferSetMatchesMacProductIntent() {
        #expect(
            TWTheme.liveSelectableProviderIds
                == [
                    "codex", "claude", "kimi", "cursor", "grok", "ollama", "pi", "mistral",
                    "muse",
                ])
        #expect(Set(firstLaunchFallbackProviderIds) == TWTheme.liveSelectableProviderIds)
        #expect(TWTheme.isLiveSelectableProvider("cursor"))
        #expect(TWTheme.isLiveSelectableProvider("pi"))
        #expect(TWTheme.isLiveSelectableProvider("muse"))
        #expect(!TWTheme.isLiveSelectableProvider("antigravity"))
        #expect(!TWTheme.isLiveSelectableProvider("gemini"))
    }

    @MainActor
    @Test func offeredCatalogsRetainStaticProvidersWithoutModels() {
        let emptyCatalogs = twOfferedProviderCatalogs([:])
        let allCatalogsEmpty = emptyCatalogs.allSatisfy { $0.models.isEmpty }
        #expect(Set(emptyCatalogs.map(\.provider)) == TWTheme.liveSelectableProviderIds)
        #expect(allCatalogsEmpty)

        let model = ModelOption(id: "gemini-api:gemini-3.1-pro", isDefault: true)
        let dynamicCatalogs = twOfferedProviderCatalogs([
            " AntiGravity ": [model],
            "gemini": [model],
            "future-provider": [model],
        ])
        let dynamicProviderIds = Set(dynamicCatalogs.map(\.provider))
        #expect(dynamicProviderIds == TWTheme.liveSelectableProviderIds.union(["antigravity"]))
        #expect(!dynamicProviderIds.contains("gemini"))
        #expect(!dynamicProviderIds.contains("future-provider"))
    }

    @MainActor
    @Test func providerOfferIsWorkspaceAgnosticAndMacProjected() {
        let withoutDynamicAdmission = twOfferedProviderCatalogs([:])
        #expect(
            Set(withoutDynamicAdmission.map(\.provider))
                == TWTheme.liveSelectableProviderIds)

        let model = ModelOption(id: "gemini-api:gemini-3.1-pro", isDefault: true)
        let withAntiGravity = twOfferedProviderCatalogs([
            "antigravity": [model]
        ])
        #expect(
            Set(withAntiGravity.map(\.provider))
                == TWTheme.liveSelectableProviderIds.union(["antigravity"]))

        // A historical binding can remain visible, but it cannot make a
        // retired provider selectable for a new run.
        let withHistoricalGemini = twOfferedProviderCatalogs(
            [:], including: ["gemini"])
        #expect(!withHistoricalGemini.map(\.provider).contains("gemini"))
    }

    @Test func ensembleParticipantOfferUsesExplicitDynamicAdmission() {
        #expect(isEnsembleParticipantProviderOffered("cursor"))
        #expect(isEnsembleParticipantProviderOffered("pi"))
        #expect(!isEnsembleParticipantProviderOffered("gemini"))
        #expect(!isEnsembleParticipantProviderOffered("antigravity"))
        #expect(
            isEnsembleParticipantProviderOffered(
                " AntiGravity ",
                dynamicallySelectableProviderIds: ["antigravity"]))
        #expect(
            !isEnsembleParticipantProviderOffered(
                "gemini",
                dynamicallySelectableProviderIds: ["gemini"]))
        #expect(
            !isEnsembleParticipantProviderOffered(
                "future-provider",
                dynamicallySelectableProviderIds: ["future-provider"]))
    }

    @Test func dynamicAdmissionCannotReviveRetiredOrUnknownProviders() {
        let gemini = resolveComposerProviderAdmission(
            selectedProvider: "gemini",
            cardProvider: nil,
            canChangeProvider: true,
            isNewTask: true,
            dynamicallySelectableProviderIds: ["gemini"])
        let unknown = resolveComposerProviderAdmission(
            selectedProvider: "future-provider",
            cardProvider: nil,
            canChangeProvider: true,
            isNewTask: true,
            dynamicallySelectableProviderIds: ["future-provider"])

        #expect(!gemini.isLive)
        #expect(!unknown.isLive)
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
        #expect(!TWTheme.isProviderOfferedByModelCatalog("antigravity", models: []))
        #expect(!TWTheme.isProviderOfferedByModelCatalog("gemini", models: models))
        #expect(!TWTheme.isLiveSelectableProvider("antigravity"))
        #expect(TWTheme.isRetiredProvider("gemini"))
        #expect(!TWTheme.liveSelectableProviderIds.contains("gemini"))
    }
}
