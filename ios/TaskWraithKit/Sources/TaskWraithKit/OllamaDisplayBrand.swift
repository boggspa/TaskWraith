import Foundation

/// Swift twin of the desktop renderer's
/// `src/renderer/src/lib/ollamaDisplayBrand.ts`.
///
/// Local and Cloud Ollama models are still `provider == "ollama"` at runtime;
/// this presentation layer "spoofs" the upstream brand NAME + accent HUE while
/// the Cloud badge remains the source classifier — exactly like the Mac.
///
/// Pure, side-effect-free module — no UIKit, no SwiftUI. Keep the brand table
/// in lockstep with the desktop file when brands change.

// MARK: - Public types

public struct OllamaDisplayBrand: Hashable, Sendable {
    /// Spoofed upstream provider name, e.g. "Alibaba".
    public let providerLabel: String
    /// CSS/theme hue class, e.g. "alibaba". Maps to a brand accent color.
    public let providerClass: String
    /// Humanised model label, e.g. "Qwen 3 (4B Param)".
    public let modelLabel: String
}

public struct OllamaDisplayBrandDefinition: Hashable, Sendable {
    public let id: String
    public let providerLabel: String
    public let providerClass: String
    public let needles: [String]
    public let fallbackModelLabel: String
}

// MARK: - OllamaDisplayBrand resolver

public enum OllamaDisplayBrands {

    /// Exact catalogue labels for models that share an upstream brand with a
    /// differently named family. Brand-wide fallbacks cannot distinguish these
    /// newer families when callers only have the raw Ollama tag.
    private static let exactModelLabels = [
        "deepseek-v4-flash": "V4 Flash",
        "deepseek-v4-flash:0731": "V4 Flash (0731)",
        "deepseek-v4-flash:preview": "V4 Flash (Preview)",
        "deepseek-v4-pro": "V4 Pro",
        "deepseek-v4-pro:0813": "V4 Pro (0813)",
        "deepseek-v4-pro:preview": "V4 Pro (Preview)",
        "gemma4": "Gemma 4",
        "gemma4:31b": "Gemma 4 (31B Param)",
        "glm-5.3-flash": "GLM 5.3 Flash",
        "glm-5.3": "GLM 5.3",
        "glm-5.1": "GLM 5.1",
        "glm-5.2": "GLM 5.2",
        "gpt-oss:20b": "GPT OSS (20B Param)",
        "gpt-oss:120b": "GPT OSS (120B Param)",
        "kimi-k2.5": "K2.5",
        "kimi-k2.6": "K2.6",
        "kimi-k2.7-code": "K2.7 Code",
        "kimi-k3": "K3",
        "minimax-m2.7": "M2.7",
        "minimax-m3": "M3",
        "mistral-large-3:675b": "Mistral Large 3 (675B Param)",
        "nemotron-3-nano:30b": "Nemotron 3 Nano (30B Param)",
        "nemotron-3-super": "Nemotron 3 Super",
        "nemotron-3-ultra": "Nemotron 3 Ultra",
        "qwen3.5:397b": "Qwen 3.5 (397B Param)",
        "qwen3.8:27b-mlx": "Qwen 3.8 (27B-MLX)",
        "qwen3.8-flash-next:125b-mlx": "Qwen 3.8 Flash Next (125B-MLX)",
        "mistral-medium-3.5": "Mistral Medium 3.5 (128B Param)",
        "mistral-medium-3.5:latest": "Mistral Medium 3.5 (128B Param)",
        "mistral-medium-3.5:128b": "Mistral Medium 3.5 (128B Param)",
        "granite4.2": "Granite 4.2 (8B Param)",
        "granite4.2:latest": "Granite 4.2 (8B Param)",
        "granite4.2:3b": "Granite 4.2 (3B Param)",
        "granite4.2:8b": "Granite 4.2 (8B Param)",
        "granite4.2:30b": "Granite 4.2 (30B Param)",
        "nemotron-3.5-lightning:30b-mlx": "Nemotron 3.5 Lightning (30B-MLX)",
        "muse-glimmer:30b-mlx": "Muse Glimmer (30B-MLX)",
        "ornith-1.5:9b": "Ornith 1.5 (9B Param)",
        "ornith-1.5:35b": "Ornith 1.5 (35B Param)",
    ]

    /// Curated brand table. Order mirrors the desktop picker ordering.
    public static let all: [OllamaDisplayBrandDefinition] = [
        OllamaDisplayBrandDefinition(
            id: "alibaba",
            providerLabel: "Alibaba",
            providerClass: "alibaba",
            needles: ["qwen3", "qwen 3", "qwen"],
            fallbackModelLabel: "Qwen 3 (4B Param)"),
        OllamaDisplayBrandDefinition(
            id: "cohere",
            providerLabel: "Cohere",
            providerClass: "cohere",
            needles: ["north-mini-code-1.0", "north mini code 1.0", "north mini code"],
            fallbackModelLabel: "North Mini Code 1.0 (30B-A3B Q4)"),
        OllamaDisplayBrandDefinition(
            id: "deepseek",
            providerLabel: "DeepSeek",
            providerClass: "deepseek",
            needles: ["deepseek-r1", "deepseek r1", "deepseek"],
            fallbackModelLabel: "R1 (8B Param)"),
        OllamaDisplayBrandDefinition(
            id: "deep-reinforce",
            providerLabel: "Deep Reinforce",
            providerClass: "deep-reinforce",
            needles: ["ornith"],
            fallbackModelLabel: "Ornith 1.0 (9B Param)"),
        OllamaDisplayBrandDefinition(
            id: "essential",
            providerLabel: "Essential AI",
            providerClass: "essential",
            needles: ["rnj-1", "rnj 1"],
            fallbackModelLabel: "Rnj-1 (8B Param)"),
        OllamaDisplayBrandDefinition(
            id: "google",
            providerLabel: "Google",
            providerClass: "google",
            needles: ["gemma4", "gemma 4", "gemma"],
            fallbackModelLabel: "Gemma 4 (12B Param)"),
        OllamaDisplayBrandDefinition(
            id: "ibm",
            providerLabel: "IBM",
            providerClass: "ibm",
            needles: ["granite4.1", "granite 4.1", "granite"],
            fallbackModelLabel: "Granite 4.1 (3B Param)"),
        OllamaDisplayBrandDefinition(
            id: "kimi",
            providerLabel: "Kimi",
            providerClass: "kimi",
            needles: ["kimi-"],
            fallbackModelLabel: "K3"),
        OllamaDisplayBrandDefinition(
            id: "liquid",
            providerLabel: "Liquid",
            providerClass: "liquid",
            needles: ["lfm2.5", "lfm 2.5", "lfm"],
            fallbackModelLabel: "LFM 2.5 (8B-A1B)"),
        OllamaDisplayBrandDefinition(
            id: "meta",
            providerLabel: "Meta",
            providerClass: "meta",
            needles: [
                "muse-glimmer", "muse glimmer", "llama3.1", "llama 3.1", "llama3.2",
                "llama 3.2",
            ],
            fallbackModelLabel: "Llama 3.1 (8B Param)"),
        OllamaDisplayBrandDefinition(
            id: "minimax",
            providerLabel: "MiniMax",
            providerClass: "minimax",
            needles: ["minimax-", "minimax "],
            fallbackModelLabel: "M3"),
        // The `mistral` hue class + label already exist for the first-class
        // Mistral Vibe seat, so a local Devstral / Ministral tag reuses them
        // rather than introducing a tenth brand colour. `ministral` needs its
        // own needle: 'mistral' is NOT a substring of 'ministral'.
        OllamaDisplayBrandDefinition(
            id: "mistral",
            providerLabel: "Mistral",
            providerClass: "mistral",
            needles: ["devstral", "ministral", "magistral", "mistral"],
            fallbackModelLabel: "Devstral Small 2 (24B Param)"),
        OllamaDisplayBrandDefinition(
            id: "nvidia",
            providerLabel: "NVIDIA",
            providerClass: "nvidia",
            needles: ["nemotron3", "nemotron 3", "nemotron"],
            fallbackModelLabel: "Nemotron 3 Nano Omni (33B Param)"),
        OllamaDisplayBrandDefinition(
            id: "openai",
            providerLabel: "OpenAI",
            providerClass: "openai",
            needles: ["gpt-oss", "gpt oss", "openai/gpt-oss"],
            fallbackModelLabel: "GPT OSS (20B Param)"),
        OllamaDisplayBrandDefinition(
            id: "openbmb",
            providerLabel: "OpenBMB",
            providerClass: "openbmb",
            needles: ["minicpm-v4.5", "minicpm v4.5", "minicpm"],
            fallbackModelLabel: "MiniCPM-V 4.5 (8B Param)"),
        OllamaDisplayBrandDefinition(
            id: "poolside",
            providerLabel: "Poolside",
            providerClass: "poolside",
            needles: ["laguna-xs-2.1", "laguna xs 2.1", "laguna"],
            fallbackModelLabel: "Laguna XS 2.1 (33B-A3B Q8)"),
        OllamaDisplayBrandDefinition(
            id: "zai",
            providerLabel: "Z.ai",
            providerClass: "zai",
            needles: ["glm-", "glm "],
            fallbackModelLabel: "GLM-4.7-Flash (30B-A3B Q4)"),
    ]

    /// Resolve an Ollama model id (+ optional human label) to its spoofed
    /// upstream brand, or `nil` for unbranded local models.
    public static func resolve(modelId: String?, modelLabel: String? = nil) -> OllamaDisplayBrand? {
        let id = (modelId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let label = (modelLabel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let key = "\(id) \(label)".trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !key.isEmpty else { return nil }

        guard let definition = all.first(where: { def in
            def.needles.contains(where: { key.contains($0) })
        }) else { return nil }

        let exactModelId = id.lowercased()
            .replacingOccurrences(of: ":cloud", with: "", options: [.anchored, .backwards])
            .replacingOccurrences(of: "-cloud", with: "", options: [.anchored, .backwards])
        return OllamaDisplayBrand(
            providerLabel: definition.providerLabel,
            providerClass: definition.providerClass,
            modelLabel: label.isEmpty
                ? (exactModelLabels[exactModelId] ?? definition.fallbackModelLabel) : label)
    }

    /// CSS/theme hue class for a provider + model. Returns the runtime
    /// provider id for everything except Ollama-backed display brands, which
    /// resolve to their spoofed brand class. Mirrors the desktop's
    /// `resolveProviderHueClass`.
    public static func providerHueClass(
        provider: String?, modelId: String? = nil, modelLabel: String? = nil
    ) -> String {
        let id = (provider ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if id.lowercased() == "ollama", let brand = resolve(modelId: modelId, modelLabel: modelLabel)
        {
            return brand.providerClass
        }
        if id.lowercased() == "pi", let hue = piUpstreamHueClass(modelId: modelId) {
            return hue
        }
        return id
    }

    /// Hue class for a Pi BYOK wire id (`deepseek/deepseek-v4-flash` →
    /// `deepseek`), or `nil` when the id is malformed or names an upstream this
    /// build does not surface — callers then fall back to the `pi` seat colour.
    ///
    /// Delegates to `PiBrandTable` so the hue and the brand LABEL cannot
    /// disagree about which upstreams exist: this used to inline its own list of
    /// upstream ids, which is exactly the kind of second copy that drifts.
    public static func piUpstreamHueClass(modelId: String?) -> String? {
        PiBrandTable.brand(forWireModelId: modelId)?.hueClass
    }

    /// Spoofed upstream brand label for a model whose provider id hides the
    /// brand the user actually picked — "Alibaba" for an Ollama-hosted Qwen,
    /// "Mistral" for a Pi run served by the Mistral API. `nil` for every other
    /// provider, and for models of these two whose brand we cannot identify.
    ///
    /// Mirrors the desktop's `resolveProviderBrandLabel`, including its opt-in
    /// contract: callers pair this with the plain `TWTheme.providerLabel`, so
    /// surfaces that group models by seat or authenticate one keep saying "Pi" /
    /// "Ollama". Do not fold this into `providerLabel(_:)`.
    public static func brandLabel(
        provider: String?, modelId: String? = nil, modelLabel: String? = nil
    ) -> String? {
        let id = (provider ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if id == "ollama" {
            return resolve(modelId: modelId, modelLabel: modelLabel)?.providerLabel
        }
        if id == "pi" {
            return PiBrandTable.brand(forWireModelId: modelId)?.label
        }
        return nil
    }
}
