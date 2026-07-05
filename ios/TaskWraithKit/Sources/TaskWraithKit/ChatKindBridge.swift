import Foundation

/// Helpers for in-place solo ↔ ensemble toggles over `bridge.setChatKind`.
public enum ChatKindBridge {
    /// Build the seed participant the Mac requires for solo→ensemble conversion.
    /// Mirrors desktop `buildEnsembleSeedParticipantFromChat`.
    public static func buildSeedParticipant(
        from card: RemoteTaskCard,
        provider: String,
        model: String? = nil,
        permissionPresetId: String = "default"
    ) -> [String: Any] {
        buildSeedParticipant(
            provider: provider,
            model: model ?? card.customModel ?? card.selectedModelType,
            codexReasoningEffort: card.codexReasoningEffort,
            claudeReasoningEffort: card.claudeReasoningEffort,
            permissionPresetId: permissionPresetId)
    }

    public static func buildSeedParticipant(
        provider: String,
        model: String? = nil,
        codexReasoningEffort: String? = nil,
        claudeReasoningEffort: String? = nil,
        permissionPresetId: String = "default"
    ) -> [String: Any] {
        let normalizedProvider = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let resolvedModel: String = {
            if let model, !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return model.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return "cli-default"
        }()
        var seed: [String: Any] = [
            "id": "ensemble-seed-\(normalizedProvider)-\(UUID().uuidString)",
            "provider": normalizedProvider,
            "enabled": true,
            "role": providerDisplayName(normalizedProvider),
            "instructions": "",
            "order": 1,
            "model": resolvedModel,
            "permissionPresetId": permissionPresetId,
        ]
        if normalizedProvider == "codex", let effort = codexReasoningEffort {
            seed["reasoningEffort"] = effort
        }
        if normalizedProvider == "claude", let effort = claudeReasoningEffort {
            seed["reasoningEffort"] = effort
        }
        return seed
    }

    public static func isLinkedChild(_ card: RemoteTaskCard) -> Bool {
        card.isSubThread || card.parentChatRelation == "sideChat"
    }

    private static func providerDisplayName(_ provider: String) -> String {
        switch provider {
        case "codex": return "Codex"
        case "claude": return "Claude"
        case "kimi": return "Kimi"
        case "grok": return "Grok"
        case "cursor": return "Cursor"
        case "ollama": return "Ollama"
        default:
            return provider.prefix(1).uppercased() + provider.dropFirst()
        }
    }
}
