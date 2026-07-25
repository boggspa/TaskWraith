import Foundation

/// Swift twin of the desktop renderer's
/// `src/renderer/src/lib/ollamaDisplayBrand.ts`.
///
/// Curated local Ollama models are still `provider == "ollama"` at runtime;
/// this presentation layer "spoofs" the upstream brand NAME + accent HUE so a
/// Qwen / Gemma / Nemotron model reads as Alibaba / Google / NVIDIA in the
/// transcript header, model picker, and usage dashboard — exactly like the Mac.
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

    /// Curated brand table. Order mirrors the desktop picker ordering.
    public static let all: [OllamaDisplayBrandDefinition] = [
        OllamaDisplayBrandDefinition(
            id: "alibaba",
            providerLabel: "Alibaba",
            providerClass: "alibaba",
            needles: ["qwen3", "qwen 3", "qwen"],
            fallbackModelLabel: "Qwen 3 (4B Param)"),
        OllamaDisplayBrandDefinition(
            id: "deep-reinforce",
            providerLabel: "Deep Reinforce",
            providerClass: "deep-reinforce",
            needles: ["ornith"],
            fallbackModelLabel: "Ornith 1.0 (9B Param)"),
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
            id: "liquid",
            providerLabel: "Liquid",
            providerClass: "liquid",
            needles: ["lfm2.5", "lfm 2.5", "lfm"],
            fallbackModelLabel: "LFM 2.5 (8B-A1B)"),
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

        return OllamaDisplayBrand(
            providerLabel: definition.providerLabel,
            providerClass: definition.providerClass,
            modelLabel: label.isEmpty ? definition.fallbackModelLabel : label)
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
    /// Twin of `shared/piBrandTable.ts`; keep the two in lockstep. Splits on the
    /// FIRST slash: Groq ids carry a SECOND one (`groq/openai/gpt-oss-120b`), so
    /// splitting on the last silently mis-brands every Groq model.
    /// `qwen-token-plan` maps to the existing `qwen` class on purpose.
    public static func piUpstreamHueClass(modelId: String?) -> String? {
        let wire = (modelId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let slash = wire.firstIndex(of: "/"), slash != wire.startIndex else { return nil }
        let upstream = String(wire[wire.startIndex..<slash])
        guard wire.index(after: slash) < wire.endIndex else { return nil }
        switch upstream {
        case "deepseek", "zai", "minimax", "mistral", "groq", "cerebras": return upstream
        case "qwen-token-plan": return "qwen"
        default: return nil
        }
    }

    /// Spoofed upstream brand label for an Ollama-backed model (e.g. "Alibaba"),
    /// or `nil` for non-Ollama providers / unbranded Ollama models. Mirrors the
    /// desktop's `resolveProviderBrandLabel`.
    public static func brandLabel(
        provider: String?, modelId: String? = nil, modelLabel: String? = nil
    ) -> String? {
        guard (provider ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            == "ollama"
        else { return nil }
        return resolve(modelId: modelId, modelLabel: modelLabel)?.providerLabel
    }
}
