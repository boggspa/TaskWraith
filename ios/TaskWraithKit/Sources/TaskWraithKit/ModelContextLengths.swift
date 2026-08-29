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
    public let maxContextWindow: Int?
    public let formatted: String
}

public struct ModelContextLengthGroup: Hashable, Sendable, Identifiable {
    /// Provider identifier: 'gemini'|'codex'|'claude'|'kimi'|'grok'|'cursor'|
    /// 'antigravity'|'pi'|'mistral'|'ollama'
    public let provider: String
    public let models: [ModelContextLengthRow]
    public var id: String { provider }
}

// MARK: - ModelContextLengths

public enum ModelContextLengths {

    // Mirrors desktop MODEL_USAGE_PROVIDER_ORDER. Ollama is appended separately
    // only when includeOllama is true (ollama-last convention).
    private static let providerOrder: [String] = [
        "gemini", "codex", "claude", "kimi", "grok", "cursor", "antigravity", "pi", "mistral"
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
                // Labels omit the "Claude " prefix and the Legacy cluster sits
                // below the current models — VERBATIM mirror of the TS picker
                // (StaticProviderModels.ts CLAUDE_STATIC_MODELS).
                (id: "claude-opus-5",       label: "Opus 5"),
                (id: "claude-fable-5",      label: "Fable 5"),
                (id: "claude-sonnet-5",     label: "Sonnet 5"),
                (id: "claude-sonnet-4-6",   label: "Sonnet 4.6 Legacy"),
                (id: "claude-opus-4-8-1m",  label: "Opus 4.8 1M Legacy"),
                (id: "claude-opus-4-7-1m",  label: "Opus 4.7 1M Legacy"),
                (id: "claude-haiku-4-5",    label: "Haiku 4.5"),
            ]
        case "kimi":
            return [
                (id: "kimi-k2.7-code", label: "K2.7 Coding"),
                // K3 (2026-07-16) — Moonshot's flagship; 256K on Moderato and
                // up to 1M on Allegretto+, with no Highspeed tier.
                (id: "kimi-k3",        label: "K3 (up to 1M)"),
                // Same K3 generation through the fixed, quota-efficient route.
                (id: "kimi-k3-256k",   label: "K3 256K"),
            ]
        case "pi":
            // BYOK seat: the flagship row per allowed upstream. Wire ids stay
            // `<upstream>/<model>` so the window lookup matches the desktop.
            return [
                (id: "deepseek/deepseek-v4-flash",  label: "DeepSeek V4 Flash"),
                (id: "deepseek/deepseek-v4-pro",    label: "DeepSeek V4 Pro"),
                (id: "zai/glm-5.2",                 label: "GLM-5.2"),
                (id: "qwen-token-plan/qwen3.7-max", label: "Qwen3.7 Max"),
                (id: "minimax/MiniMax-M3",          label: "MiniMax M3"),
                (id: "xiaomi-token-plan-sgp/mimo-v2.5-pro", label: "MiMo V2.5 Pro (SGP)"),
                (id: "mistral/devstral-2512",       label: "Devstral 2"),
                (id: "openrouter/stealth/ox-alpha", label: "Ox Alpha"),
                (id: "openrouter/z-ai/glm-5.2",      label: "GLM 5.2"),
                (id: "openrouter/poolside/laguna-s-2.1", label: "Laguna S 2.1"),
                (id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra"),
            ]
        case "grok":
            return [
                // Grok's CLI models are permanently Fast-mode. Cursor's
                // provider-scoped Grok rows keep a separate Fast toggle.
                (id: "grok-4.6",                label: "Grok 4.6 Fast"),
                (id: "grok-4.5",                label: "Grok 4.5 Fast"),
                (id: "grok-composer-2.5-fast",  label: "Grok Composer 2.5 Fast"),
            ]
        case "cursor":
            return [
                (id: "composer-2.5",       label: "Composer 2.5"),
                (id: "composer-2.5-fast",  label: "Composer 2.5 Fast"),
                (id: "grok-4.6",           label: "Cursor Grok 4.6"),
                (id: "grok-4.5",           label: "Cursor Grok 4.5"),
            ]
        case "antigravity":
            // Gemini-api lane. The `gemini-api:` prefix is load-bearing
            // (dispatch + discovery both key on it); the live discovery
            // snapshot may extend this list, but these four wire models are
            // the deterministic floor. Mirrors ANTIGRAVITY_MODELS and the
            // contextWindows registrations.
            return [
                (id: "gemini-api:gemini-2.5-pro",         label: "Gemini 2.5 Pro (API)"),
                (id: "gemini-api:gemini-2.5-flash",       label: "Gemini 2.5 Flash (API)"),
                (id: "gemini-api:gemini-2.5-flash-lite",  label: "Gemini 2.5 Flash Lite (API)"),
                (id: "gemini-api:gemini-2.0-flash",       label: "Gemini 2.0 Flash (API)"),
            ]
        case "mistral":
            // Mistral Vibe seat. BARE ids only — a `mistral/<model>` id
            // belongs to Pi's BYOK upstream, a different provider that shares
            // the brand word. devstral-small leads because it is the seat
            // default. Mirrors MISTRAL_MODELS and the contextWindows
            // registrations.
            return [
                (id: "devstral-small",      label: "Devstral Small"),
                (id: "mistral-medium-3.5",  label: "Mistral Medium 3.5"),
            ]
        case "ollama":
            return [
                (id: "qwen3:4b-instruct",  label: "Qwen 3 (4B Param)"),
                (id: "qwen3.5:2b",         label: "Qwen 3.5 (2B Param)"),
                (id: "qwen3.5:4b",         label: "Qwen 3.5 (4B Param)"),
                (id: "qwen3.5:9b",         label: "Qwen 3.5 (9B Param)"),
                (id: "qwen3.6:35b",        label: "Qwen 3.6 (35B-A3B)"),
                (id: "qwen3.8:27b-mlx",    label: "Qwen 3.8 (27B-MLX)"),
                (id: "qwen3.8-flash-next:125b-mlx", label: "Qwen 3.8 Flash Next (125B-MLX)"),
                (id: "gemma3:4b",          label: "Gemma 3 (4B Param)"),
                (id: "gemma4:12b",         label: "Gemma 4 (12B Param)"),
                (id: "ornith:9b",          label: "Ornith 1.0 (9B Param)"),
                (id: "ornith:35b",         label: "Ornith 1.0 (35B Param)"),
                (id: "ornith-1.5:9b",     label: "Ornith 1.5 (9B Param)"),
                (id: "ornith-1.5:35b",     label: "Ornith 1.5 (35B Param)"),
                (id: "laguna-xs-2.1:q8_0", label: "Laguna XS 2.1 (33B-A3B Q8)"),
                (id: "gpt-oss:20b",        label: "GPT OSS (20B Param)"),
                (id: "lfm2.5-thinking:1.2b", label: "LFM 2.5 Thinking (1.2B Param)"),
                (id: "lfm2.5:8b",          label: "LFM 2.5 (8B-A1B)"),
                (id: "minicpm-v4.5:8b",    label: "MiniCPM-V 4.5 (8B Param)"),
                (id: "granite4:3b",        label: "Granite 4.0 (3B Param)"),
                (id: "granite4.1:3b",      label: "Granite 4.1 (3B Param)"),
                (id: "granite4.1:30b",     label: "Granite 4.1 (30B Param)"),
                (id: "granite4.2:3b",      label: "Granite 4.2 (3B Param)"),
                (id: "granite4.2:8b",      label: "Granite 4.2 (8B Param)"),
                (id: "granite4.2:30b",     label: "Granite 4.2 (30B Param)"),
                (id: "nemotron-3-nano:4b", label: "Nemotron 3 Nano (4B Param)"),
                (id: "nemotron3:33b",      label: "Nemotron 3 Nano Omni (33B Param)"),
                (id: "nemotron-3.5-lightning:30b-mlx", label: "Nemotron 3.5 Lightning (30B-MLX)"),
                (id: "devstral-small-2:24b", label: "Devstral Small 2 (24B Param)"),
                (id: "mistral-medium-3.5:128b", label: "Mistral Medium 3.5 (128B Param)"),
                (id: "ministral-3:3b",     label: "Ministral 3 (3B Param)"),
                (id: "ministral-3:14b",    label: "Ministral 3 (14B Param)"),
                (id: "muse-glimmer:30b-mlx", label: "Muse Glimmer (30B-MLX)"),
                (id: "llama3.1:8b",         label: "Llama 3.1 (8B Param)"),
                (id: "deepseek-r1:1.5b",    label: "DeepSeek R1 (1.5B Param)"),
                (id: "deepseek-r1:8b",      label: "DeepSeek R1 (8B Param)"),
                (id: "rnj-1",               label: "Rnj-1 (8B Param)"),
                (id: "glm-4.7-flash:q4_K_M", label: "GLM-4.7-Flash (30B-A3B Q4)"),
                (id: "north-mini-code-1.0:q4_K_M", label: "North Mini Code 1.0 (30B-A3B Q4)"),
                (id: "llama3.2:3b",         label: "Llama 3.2 (3B Param)"),
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
                    let maxWindow: Int? =
                        provider == "kimi" && opt.id == "kimi-k3" ? 1_048_576 : nil
                    let formattedWindow =
                        provider == "kimi" && window == 262_144
                            ? "256k"
                            : formatContextTokens(window)
                    return ModelContextLengthRow(
                        modelId: opt.id,
                        label: opt.label,
                        contextWindow: window,
                        maxContextWindow: maxWindow,
                        formatted: maxWindow.map {
                            "\(formattedWindow)–\(formatContextTokens($0))"
                        } ?? formattedWindow
                    )
                }
            if !rows.isEmpty {
                groups.append(ModelContextLengthGroup(provider: provider, models: rows))
            }
        }
        return groups
    }
}
