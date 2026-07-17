import Foundation

/// Per-provider, per-model curated model catalog joined with official context-window sizes.
///
/// Swift twin of the desktop renderer's `src/renderer/src/lib/modelContextLengths.ts`.
/// The curated catalog (id/label pairs) mirrors `src/renderer/src/lib/ensembleProviderDefaults.ts`.
/// Context windows come from `ContextWindows.resolve` (READ-ONLY) — no window numbers are
/// duplicated here. Keep the catalog in sync when the desktop lists change (same discipline
/// as `ContextWindows.swift`'s header note).
///
/// Ollama is excluded by default; pass `includeOllama: true` to include it.
/// `excludeProviders` drops whole providers (e.g. the sidebar variant omits Gemini for space).
///
/// Pure, side-effect-free module — no UIKit, no SwiftUI.

// MARK: - Public types

public struct ModelContextLengthRow: Hashable, Sendable {
    public let modelId: String
    public let label: String
    public let contextWindow: Int
    public let formatted: String
}

public struct ModelContextLengthGroup: Hashable, Sendable, Identifiable {
    /// Provider identifier: 'gemini'|'codex'|'claude'|'kimi'|'grok'|'cursor'|'ollama'
    public let provider: String
    public let models: [ModelContextLengthRow]
    public var id: String { provider }
}

// MARK: - ModelContextLengths

public enum ModelContextLengths {

    // Mirrors desktop MODEL_USAGE_PROVIDER_ORDER. Ollama is appended separately
    // only when includeOllama is true (ollama-last convention).
    private static let providerOrder: [String] = [
        "gemini", "codex", "claude", "kimi", "grok", "cursor"
    ]

    // Gemini router alias — NOT a concrete model with a single official window.
    private static let aliasIds: Set<String> = ["auto"]

    // MARK: Catalog

    /// (id, label) pairs per provider. Mirrors ensembleProviderDefaults.ts VERBATIM.
    private static func options(for provider: String) -> [(id: String, label: String)] {
        switch provider {
        case "gemini":
            return [
                (id: "auto",        label: "Auto"),
                (id: "pro",         label: "Pro"),
                (id: "flash",       label: "Flash"),
                (id: "flash-lite",  label: "Flash Lite"),
            ]
        case "codex":
            return [
                (id: "gpt-5.5",              label: "GPT-5.5"),
                // GPT-5.6 trio — GA 2026-07-09, official hyphenated display
                // names; mirrors ensembleProviderDefaults.ts order VERBATIM.
                (id: "gpt-5.6-sol",          label: "GPT-5.6-Sol"),
                (id: "gpt-5.6-terra",        label: "GPT-5.6-Terra"),
                (id: "gpt-5.6-luna",         label: "GPT-5.6-Luna"),
                (id: "gpt-5.4",              label: "GPT-5.4"),
                (id: "gpt-5.4-mini",         label: "GPT-5.4 Mini"),
                (id: "gpt-5.3-codex-spark",  label: "GPT-5.3 Codex Spark"),
            ]
        case "claude":
            return [
                (id: "claude-opus-4-8-1m",  label: "Claude Opus 4.8 1M"),
                (id: "claude-fable-5",      label: "Claude Fable 5"),
                (id: "claude-sonnet-5",     label: "Claude Sonnet 5"),
                (id: "claude-sonnet-4-6",   label: "Claude Sonnet 4.6 Legacy"),
                (id: "claude-opus-4-7-1m",  label: "Claude Opus 4.7 1M"),
                (id: "claude-haiku-4-5",    label: "Claude Haiku 4.5"),
            ]
        case "kimi":
            return [
                (id: "kimi-k2.7-code", label: "K2.7 Coding"),
                // K3 (2026-07-16) — Moonshot's flagship; 256K context,
                // always-on Low/High/Max thinking, no Highspeed tier.
                (id: "kimi-k3",        label: "K3"),
            ]
        case "grok":
            return [
                // Grok's CLI models are permanently Fast-mode (Cursor's grok-4.5
                // keeps a separate Fast toggle and stays "Cursor Grok 4.5").
                (id: "grok-4.5",                label: "Grok 4.5 Fast"),
                (id: "grok-composer-2.5-fast",  label: "Grok Composer 2.5 Fast"),
            ]
        case "cursor":
            return [
                (id: "composer-2.5",       label: "Composer 2.5"),
                (id: "composer-2.5-fast",  label: "Composer 2.5 Fast"),
                (id: "grok-4.5",           label: "Cursor Grok 4.5"),
            ]
        case "ollama":
            return [
                (id: "qwen3:4b-instruct",  label: "Qwen 3 (4B Param)"),
                (id: "qwen3.5:9b",         label: "Qwen 3.5 (9B Param)"),
                (id: "qwen3.6:35b",        label: "Qwen 3.6 (35B-A3B)"),
                (id: "gemma4:12b",         label: "Gemma 4 (12B Param)"),
                (id: "ornith:9b",          label: "Ornith 1.0 (9B Param)"),
                (id: "ornith:35b",         label: "Ornith 1.0 (35B Param)"),
                (id: "laguna-xs-2.1:q8_0", label: "Laguna XS 2.1 (33B-A3B Q8)"),
                (id: "gpt-oss:20b",        label: "GPT OSS (20B Param)"),
                (id: "lfm2.5:8b",          label: "LFM 2.5 (8B-A1B)"),
                (id: "minicpm-v4.5:8b",    label: "MiniCPM-V 4.5 (8B Param)"),
                (id: "granite4.1:3b",      label: "Granite 4.1 (3B Param)"),
                (id: "granite4.1:30b",     label: "Granite 4.1 (30B Param)"),
                (id: "nemotron3:33b",      label: "Nemotron 3 Nano Omni (33B Param)"),
            ]
        default:
            return []
        }
    }

    // MARK: formatContextTokens

    /// Exact twin of `formatContextTokens` in `src/shared/contextWindows.ts`.
    /// Preserves the 10M branch (0 decimal places at ≥ 10M tokens).
    public static func formatContextTokens(_ n: Int) -> String {
        if n >= 1_000_000 {
            let decimals = n >= 10_000_000 ? 0 : 1
            return String(format: "%.\(decimals)fM", Double(n) / 1_000_000)
        }
        if n >= 1_000 {
            return "\(Int((Double(n) / 1_000).rounded()))k"
        }
        return "\(n)"
    }

    // MARK: buildGroups

    /// Build the ordered provider groups. Mirrors `buildModelContextLengthGroups` on the desktop.
    ///
    /// - Parameters:
    ///   - includeOllama: Append the Ollama group at the end (default `false`).
    ///   - excludeProviders: Provider ids to omit entirely (e.g. `["gemini"]` for the sidebar).
    /// - Returns: Non-empty groups in provider order.
    public static func buildGroups(
        includeOllama: Bool = false,
        excludeProviders: [String] = []
    ) -> [ModelContextLengthGroup] {
        let excluded = Set(excludeProviders)
        let order = (providerOrder + (includeOllama ? ["ollama"] : []))
            .filter { !excluded.contains($0) }

        var groups: [ModelContextLengthGroup] = []
        for provider in order {
            let rows: [ModelContextLengthRow] = options(for: provider)
                .filter { !aliasIds.contains($0.id) }
                .map { opt in
                    let window = ContextWindows.resolve(provider: provider, model: opt.id)
                    return ModelContextLengthRow(
                        modelId: opt.id,
                        label: opt.label,
                        contextWindow: window,
                        formatted: formatContextTokens(window)
                    )
                }
            if !rows.isEmpty {
                groups.append(ModelContextLengthGroup(provider: provider, models: rows))
            }
        }
        return groups
    }
}
