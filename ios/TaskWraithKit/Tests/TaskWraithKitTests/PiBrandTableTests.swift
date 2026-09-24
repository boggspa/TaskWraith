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

    @Test("OpenRouter additions resolve to their original brands")
    func resolvesOpenRouterBrands() {
        let expected = [
            (wireId: "openrouter/cohere/north-mini-code:free", label: "Cohere", hue: "cohere"),
            (wireId: "openrouter/minimax/minimax-m3:free", label: "MiniMax", hue: "minimax"),
            (
                wireId: "openrouter/thinkingmachines/inkling:free",
                label: "Thinking Machines",
                hue: "thinkingmachines"
            ),
            (
                wireId: "openrouter/thinkingmachines/inkling-small:free",
                label: "Thinking Machines",
                hue: "thinkingmachines"
            ),
        ]

        for entry in expected {
            let brand = PiBrandTable.brand(forWireModelId: entry.wireId)
            #expect(brand?.label == entry.label)
            #expect(brand?.hueClass == entry.hue)
        }
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
                == "V4 Flash")
    }

    @Test("humanises new OpenRouter model ids")
    func humanisesOpenRouterModels() {
        let expected = [
            "openrouter/cohere/north-mini-code:free": "North Mini Code",
            "openrouter/minimax/minimax-m3:free": "M3 (OpenRouter)",
            "openrouter/thinkingmachines/inkling:free": "Inkling",
            "openrouter/thinkingmachines/inkling-small:free": "Inkling Small",
        ]

        for (wireId, label) in expected {
            #expect(PiBrandTable.modelLabel(forWireModelId: wireId) == label)
        }
    }

    @Test("labels the Xiaomi token-plan catalogue on every region")
    func xiaomiTokenPlanLabelsPerRegion() {
        // Hand-listed: there is no codegen across the platform boundary, and a
        // dropped row does not read as nil here — an uncatalogued wire id
        // humanises to its bare model id (see `uncataloguedModel`), so the phone
        // would quietly render "mimo-v2.6-pro" where the desktop shows
        // "MiMo V2.6 Pro (CN)". V2.5 and V2.5 Pro stay until Xiaomi's 2026-10-21
        // sunset; the V2.6 pair (2026-09-22) is the current catalogue. Mirrors
        // PI_MODEL_LABELS in src/shared/piBrandTable.ts.
        let expected = [
            (wireId: "xiaomi-token-plan-cn/mimo-v2.5", label: "MiMo V2.5 (CN)"),
            (wireId: "xiaomi-token-plan-cn/mimo-v2.5-pro", label: "MiMo V2.5 Pro (CN)"),
            (wireId: "xiaomi-token-plan-cn/mimo-v2.6-pro", label: "MiMo V2.6 Pro (CN)"),
            (wireId: "xiaomi-token-plan-cn/mimo-v2.6-flash", label: "MiMo V2.6 Flash (CN)"),
            (wireId: "xiaomi-token-plan-sgp/mimo-v2.5", label: "MiMo V2.5 (SGP)"),
            (wireId: "xiaomi-token-plan-sgp/mimo-v2.5-pro", label: "MiMo V2.5 Pro (SGP)"),
            (wireId: "xiaomi-token-plan-sgp/mimo-v2.6-pro", label: "MiMo V2.6 Pro (SGP)"),
            (wireId: "xiaomi-token-plan-sgp/mimo-v2.6-flash", label: "MiMo V2.6 Flash (SGP)"),
            (wireId: "xiaomi-token-plan-ams/mimo-v2.5", label: "MiMo V2.5 (AMS)"),
            (wireId: "xiaomi-token-plan-ams/mimo-v2.5-pro", label: "MiMo V2.5 Pro (AMS)"),
            (wireId: "xiaomi-token-plan-ams/mimo-v2.6-pro", label: "MiMo V2.6 Pro (AMS)"),
            (wireId: "xiaomi-token-plan-ams/mimo-v2.6-flash", label: "MiMo V2.6 Flash (AMS)"),
        ]
        #expect(expected.count == 12)
        for entry in expected {
            #expect(
                PiBrandTable.modelLabels[entry.wireId] == entry.label,
                "missing or drifted label row for \(entry.wireId)")
            #expect(PiBrandTable.modelLabel(forWireModelId: entry.wireId) == entry.label)
            #expect(PiBrandTable.brand(forWireModelId: entry.wireId)?.label == "Xiaomi")
        }
    }

    @Test("labels Space Bunny Alpha and dresses it in the stealth brand")
    func spaceBunnyAlphaLabelAndBrand() {
        // A dropped label row does not read as nil: the uncatalogued fallback
        // renders the bare "stealth/space-bunny-alpha" where the desktop shows
        // "Space Bunny Alpha". The brand comes from the `openrouter/stealth`
        // override, never the generic OpenRouter one. Mirrors PI_MODEL_LABELS
        // and PI_UPSTREAM_BRANDS in src/shared/piBrandTable.ts.
        let wireId = "openrouter/stealth/space-bunny-alpha"
        #expect(PiBrandTable.modelLabels[wireId] == "Space Bunny Alpha")
        #expect(PiBrandTable.modelLabel(forWireModelId: wireId) == "Space Bunny Alpha")
        #expect(PiBrandTable.brand(forWireModelId: wireId)?.label == "Stealth")
        #expect(PiBrandTable.brand(forWireModelId: wireId)?.hueClass == "stealth")
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
