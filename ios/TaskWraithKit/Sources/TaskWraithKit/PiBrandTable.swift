import Foundation

/// Swift twin of `src/shared/piBrandTable.ts`.
///
/// A Pi run is always `provider == "pi"`, but the model wire id names the BYOK
/// upstream that will serve it (`deepseek/deepseek-v4-flash`). Presenting every
/// Pi row in one seat colour and calling it "Pi" throws that away, so this table
/// maps an upstream to its brand LABEL and hue CLASS — the same spoof the Ollama
/// table performs for local models, in the other direction.
///
/// Pure, side-effect-free — no UIKit, no SwiftUI. There is no codegen across the
/// platform boundary, so `piBrandTable.test.ts` pins the contents of this file
/// against the TypeScript original: a brand added on one side and forgotten on
/// the other fails the desktop suite rather than shipping a mis-branded phone.
public enum PiBrandTable {

    /// Upstream id -> presentation. `hueClass` indexes the theme accent map.
    public struct Brand: Hashable, Sendable {
        public let label: String
        public let hueClass: String

        public init(label: String, hueClass: String) {
            self.label = label
            self.hueClass = hueClass
        }
    }

    /// `qwen-token-plan` deliberately resolves to the EXISTING `qwen` hue class
    /// rather than minting a new one, so Qwen reads the same whether it arrives
    /// via Ollama or via Pi.
    public static let upstreams: [String: Brand] = [
        "deepseek": Brand(label: "DeepSeek", hueClass: "deepseek"),
        "zai": Brand(label: "Z.ai", hueClass: "zai"),
        "qwen-token-plan": Brand(label: "Qwen", hueClass: "qwen"),
        "minimax": Brand(label: "MiniMax", hueClass: "minimax"),
        "mistral": Brand(label: "Mistral", hueClass: "mistral"),
        "groq": Brand(label: "Groq", hueClass: "groq"),
        "cerebras": Brand(label: "Cerebras", hueClass: "cerebras"),
    ]

    /// Wire id -> human display label for the curated Pi catalog.
    ///
    /// `ModelContextLengths` carries only the flagship row per upstream (it is a
    /// context-window catalog, not a naming one), so without this table every
    /// non-flagship Pi model — both Groq rows, both Cerebras rows, the second
    /// Mistral and MiniMax — rendered its raw wire id on the phone.
    ///
    /// The `(Groq)` / `(Cerebras)` suffixes are load-bearing: the same
    /// open-weights model is served by two upstreams and the rows would
    /// otherwise be indistinguishable.
    public static let modelLabels: [String: String] = [
        "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro",
        "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash",
        "zai/glm-5.2": "GLM-5.2",
        "zai/glm-5.1": "GLM-5.1",
        "zai/glm-4.7": "GLM-4.7",
        "qwen-token-plan/qwen3.7-max": "Qwen3.7 Max",
        "qwen-token-plan/qwen3.7-plus": "Qwen3.7 Plus",
        "qwen-token-plan/qwen3.8-max-preview": "Qwen3.8 Max Preview",
        "minimax/MiniMax-M3": "MiniMax M3",
        "minimax/MiniMax-M2.7": "MiniMax M2.7",
        "mistral/zai-glm-5-2": "GLM-5.2 (via Mistral)",
        "mistral/mistral-medium-3.5": "Mistral Medium 3.5",
        "mistral/mistral-medium-latest": "Mistral Medium (Latest)",
        "mistral/mistral-small-2603": "Mistral Small 4",
        "mistral/mistral-large-2512": "Mistral Large 3",
        "mistral/devstral-2512": "Devstral 2",
        "mistral/codestral-2508": "Codestral (Aug 2025)",
        "mistral/labs-leanstral-1-5": "Leanstral 1.5 (Labs)",
        "mistral/mistral-medium-2508": "Mistral Medium 3.1",
        "mistral/mistral-medium-2505": "Mistral Medium 3",
        "mistral/ministral-14b-2512": "Ministral 3 (14B)",
        "mistral/ministral-8b-2512": "Ministral 3 (8B)",
        "mistral/ministral-3b-2512": "Ministral 3 (3B)",
        "groq/openai/gpt-oss-120b": "GPT-OSS 120B (Groq)",
        "groq/qwen/qwen3-32b": "Qwen3 32B (Groq)",
        "cerebras/zai-glm-4.7": "GLM-4.7 (Cerebras)",
        "cerebras/gpt-oss-120b": "GPT-OSS 120B (Cerebras)",
    ]

    /// Split a Pi wire id on the FIRST slash: upstream vs pi model id.
    ///
    /// Splitting on the LAST slash silently breaks Groq, whose ids carry a
    /// SECOND slash (`groq/openai/gpt-oss-120b`) — the upstream then reads
    /// "groq/openai", matches no brand, and mis-colours every Groq row.
    public static func splitWireModelId(_ wireId: String?) -> (upstream: String, modelId: String)? {
        let wire = (wireId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let slash = wire.firstIndex(of: "/"), slash != wire.startIndex else { return nil }
        let modelStart = wire.index(after: slash)
        guard modelStart < wire.endIndex else { return nil }
        return (String(wire[wire.startIndex..<slash]), String(wire[modelStart...]))
    }

    /// Brand for a Pi wire model id, or `nil` when the id is malformed or names
    /// an upstream this build does not surface. Callers fall back to the plain
    /// `pi` hue and the "Pi" seat name, so an unknown upstream degrades to the
    /// seat rather than guessing.
    public static func brand(forWireModelId wireId: String?) -> Brand? {
        guard let split = splitWireModelId(wireId) else { return nil }
        return upstreams[split.upstream]
    }

    /// Human label for a Pi wire id, or `nil` when the id is malformed / names
    /// no surfaced upstream.
    ///
    /// A wire id from an upstream we DO surface but a model we have not
    /// catalogued (a mid-cycle upstream release) falls back to the model half
    /// alone: the upstream is already rendered beside this label as the brand
    /// name, so repeating it — "Mistral · mistral/some-new-model" — is noise.
    public static func modelLabel(forWireModelId wireId: String?) -> String? {
        let wire = (wireId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wire.isEmpty else { return nil }
        if let known = modelLabels[wire] { return known }
        guard let split = splitWireModelId(wire), upstreams[split.upstream] != nil else {
            return nil
        }
        return split.modelId
    }
}
