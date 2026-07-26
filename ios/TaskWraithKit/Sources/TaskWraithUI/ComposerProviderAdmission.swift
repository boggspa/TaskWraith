import Foundation

struct ComposerProviderAdmission: Equatable {
    let provider: String
    let isLive: Bool
    let unavailableReason: String?
}

/// Resolve the provider that an iOS composer action would actually dispatch.
/// Existing threads are bound to their projected provider unless the host has
/// explicitly allowed a first-turn/provider change; new-task composers always
/// use the picker selection.
func resolveComposerProviderAdmission(
    selectedProvider: String,
    cardProvider: String?,
    canChangeProvider: Bool,
    isNewTask: Bool,
    dynamicallySelectableProviderIds: Set<String> = []
) -> ComposerProviderAdmission {
    let selected = selectedProvider.trimmingCharacters(in: .whitespacesAndNewlines)
    let stored = cardProvider?.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolved = (canChangeProvider || isNewTask)
        ? selected
        : ((stored?.isEmpty == false ? stored : nil) ?? selected)
    let provider = resolved.lowercased()
    let isDynamicallyOffered =
        provider == "antigravity"
        && dynamicallySelectableProviderIds.contains {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == provider
        }
    guard TWTheme.isLiveSelectableProvider(provider)
        || isDynamicallyOffered
    else {
        let canChooseProvider = canChangeProvider || isNewTask
        let unavailableReason: String
        if TWTheme.isRetiredProvider(provider) {
            let nextStep = canChooseProvider
                ? "Choose a provider currently offered by the connected Mac."
                : "Existing history remains available; open a new chat with an offered provider to continue."
            unavailableReason =
                "\(TWTheme.providerLabel(provider)) is retired for new runs. \(nextStep)"
        } else if provider == "antigravity" {
            unavailableReason =
                "AntiGravity is not currently offered by the connected Mac. Complete its consent and credential setup on the Mac, then refresh provider models."
        } else {
            let nextStep = canChooseProvider
                ? "Choose a provider currently offered by the connected Mac."
                : "Open a new chat with a provider offered by the connected Mac to continue."
            unavailableReason =
                "\(TWTheme.providerLabel(provider)) is not offered for new runs by the connected Mac. \(nextStep)"
        }
        return ComposerProviderAdmission(
            provider: provider,
            isLive: false,
            unavailableReason: unavailableReason)
    }

    return ComposerProviderAdmission(provider: provider, isLive: true, unavailableReason: nil)
}
