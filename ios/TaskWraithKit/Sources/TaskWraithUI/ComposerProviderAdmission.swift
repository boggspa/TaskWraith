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
    guard TWTheme.isLiveSelectableProvider(provider)
        || dynamicallySelectableProviderIds.contains(provider)
    else {
        let nextStep = (canChangeProvider || isNewTask)
            ? "Choose a live provider to continue."
            : "Open a new chat with a live provider to continue."
        return ComposerProviderAdmission(
            provider: provider,
            isLive: false,
            unavailableReason: "\(TWTheme.providerLabel(provider)) managed runs are unavailable. \(nextStep)")
    }

    return ComposerProviderAdmission(provider: provider, isLive: true, unavailableReason: nil)
}
