// PiBrandTable — Swift twin of desktop src/shared/piBrandTable.ts.
// Parity tests mirror desktop piBrandTable.test.ts.

import Testing

@testable import TaskWraithKit

@Suite("Pi brand table")
struct PiBrandTableTests {

    @Test("splits on the FIRST slash so Groq two-slash ids keep their upstream")
    func splitsOnFirstSlash() {
        // The landmine: splitting on the LAST slash yields upstream
        // "groq/openai", which matches no brand and mis-colours every Groq row.
        let split = PiBrandTable.splitWireModelId("groq/openai/gpt-oss-120b")
        #expect(split?.upstream == "groq")
        #expect(split?.modelId == "openai/gpt-oss-120b")
    }

    @Test("rejects malformed wire ids")
    func rejectsMalformed() {
        for wire in ["", "noslash", "/leading", "trailing/"] {
            #expect(PiBrandTable.splitWireModelId(wire) == nil)
        }
        #expect(PiBrandTable.splitWireModelId(nil) == nil)
    }

    @Test("resolves each surfaced upstream to its brand")
    func resolvesBrands() {
        #expect(PiBrandTable.brand(forWireModelId: "mistral/devstral-2512")?.label == "Mistral")
        #expect(PiBrandTable.brand(forWireModelId: "mistral/devstral-2512")?.hueClass == "mistral")
        #expect(PiBrandTable.brand(forWireModelId: "groq/openai/gpt-oss-120b")?.label == "Groq")
        #expect(PiBrandTable.brand(forWireModelId: "minimax/MiniMax-M3")?.label == "MiniMax")
    }

    @Test("maps qwen-token-plan to the EXISTING qwen hue, not a new one")
    func qwenSharesHue() {
        // Qwen must read identically whether it arrives via Ollama or via Pi.
        let brand = PiBrandTable.brand(forWireModelId: "qwen-token-plan/qwen3.7-max")
        #expect(brand?.hueClass == "qwen")
        #expect(brand?.label == "Qwen")
    }

    @Test("returns nil for unknown upstreams so callers keep the pi seat")
    func unknownUpstream() {
        #expect(PiBrandTable.brand(forWireModelId: "anthropic/claude-opus") == nil)
        #expect(PiBrandTable.brand(forWireModelId: "garbage") == nil)
    }

    @Test("humanises catalogued wire ids")
    func humanisesModels() {
        #expect(PiBrandTable.modelLabel(forWireModelId: "mistral/devstral-2512") == "Devstral 2")
        #expect(PiBrandTable.modelLabel(forWireModelId: "mistral/zai-glm-5-2") == "GLM-5.2 (via Mistral)")
        #expect(
            PiBrandTable.modelLabel(forWireModelId: "deepseek/deepseek-v4-flash")
                == "DeepSeek V4 Flash")
    }

    @Test("keeps the disambiguating suffix on models two upstreams both serve")
    func disambiguatesSharedModels() {
        #expect(
            PiBrandTable.modelLabel(forWireModelId: "groq/openai/gpt-oss-120b")
                == "GPT-OSS 120B (Groq)")
        #expect(
            PiBrandTable.modelLabel(forWireModelId: "cerebras/gpt-oss-120b")
                == "GPT-OSS 120B (Cerebras)")
    }

    @Test("drops the redundant upstream prefix for an uncatalogued model")
    func uncataloguedModel() {
        // The upstream is already rendered beside the label as the brand name.
        #expect(PiBrandTable.modelLabel(forWireModelId: "mistral/some-future") == "some-future")
        #expect(PiBrandTable.modelLabel(forWireModelId: "anthropic/claude-opus") == nil)
    }

    @Test("brandLabel returns the BYOK upstream for Pi and nil elsewhere")
    func brandLabelForPi() {
        #expect(
            OllamaDisplayBrands.brandLabel(provider: "pi", modelId: "mistral/devstral-2512")
                == "Mistral")
        #expect(
            OllamaDisplayBrands.brandLabel(provider: "pi", modelId: "groq/qwen/qwen3-32b") == "Groq")
        // An unknown upstream keeps the plain "Pi" seat name.
        #expect(OllamaDisplayBrands.brandLabel(provider: "pi", modelId: "anthropic/x") == nil)
        #expect(OllamaDisplayBrands.brandLabel(provider: "claude", modelId: "claude-opus-5") == nil)
    }

    @Test("hue class and brand label agree on which upstreams exist")
    func hueAndLabelAgree() {
        // These were two separate lists until the hue resolver was folded onto
        // this table; a brand present in one and missing from the other renders
        // a correctly-named row in the wrong colour, or vice versa.
        for (upstream, brand) in PiBrandTable.upstreams {
            let wire = "\(upstream)/some-model"
            #expect(OllamaDisplayBrands.piUpstreamHueClass(modelId: wire) == brand.hueClass)
            #expect(OllamaDisplayBrands.brandLabel(provider: "pi", modelId: wire) == brand.label)
        }
    }

    @Test("agrees with the context-length catalog on every model it also lists")
    func agreesWithContextLengthCatalog() {
        // `ModelContextLengths` carries the flagship row per upstream with its
        // own copy of the label. Where both name a model they must name it the
        // same, or the picker and the transcript disagree on the phone.
        let piRows =
            ModelContextLengths.buildGroups()
            .first(where: { $0.provider == "pi" })?
            .models ?? []
        #expect(!piRows.isEmpty, "context-length catalog lists no Pi rows to compare")
        for row in piRows {
            #expect(
                PiBrandTable.modelLabels[row.modelId] == row.label,
                "label drift for \(row.modelId): \(String(describing: PiBrandTable.modelLabels[row.modelId])) vs \(row.label)"
            )
        }
    }
}
