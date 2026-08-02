// OllamaDisplayBrand — Swift twin of desktop src/renderer/src/lib/ollamaDisplayBrand.ts.
// Parity tests mirror desktop ollamaDisplayBrand.test.ts.

import Testing

@testable import TaskWraithKit

@Suite("Ollama display brands")
struct OllamaDisplayBrandTests {

    @Test("maps curated Ollama models to their upstream provider brands")
    func mapsCuratedBrands() {
        #expect(
            OllamaDisplayBrands.resolve(modelId: "qwen3.6:35b", modelLabel: "Qwen 3.6 (35B-A3B)")?
                .providerClass == "alibaba")
        #expect(
            OllamaDisplayBrands.resolve(modelId: "ornith:35b", modelLabel: "Ornith 1.0 (35B Param)")?
                .providerLabel == "Deep Reinforce")
        #expect(
            OllamaDisplayBrands.resolve(modelId: "gemma4:12b")?.providerClass == "google")
        #expect(
            OllamaDisplayBrands.resolve(modelId: "granite4.1:30b")?.providerLabel == "IBM")
        #expect(
            OllamaDisplayBrands.resolve(modelId: "lfm2.5:8b")?.providerClass == "liquid")
        #expect(
            OllamaDisplayBrands.resolve(modelId: "nemotron3:33b")?.providerLabel == "NVIDIA")
        #expect(
            OllamaDisplayBrands.resolve(modelId: "gpt-oss:20b")?.providerClass == "openai")
        #expect(
            OllamaDisplayBrands.resolve(modelId: "minicpm-v4.5:8b")?.providerLabel == "OpenBMB")
        #expect(
            OllamaDisplayBrands.resolve(modelId: "laguna-xs-2.1:q8_0")?.providerLabel
                == "Poolside")
        #expect(
            OllamaDisplayBrands.resolve(modelId: "devstral-small-2:24b")?.providerLabel
                == "Mistral")
        // `ministral` carries its own needle — 'mistral' is NOT a substring of it.
        #expect(
            OllamaDisplayBrands.resolve(modelId: "ministral-3:14b")?.providerClass == "mistral")
        #expect(OllamaDisplayBrands.resolve(modelId: "llama3.1:8b")?.providerClass == "meta")
        #expect(OllamaDisplayBrands.resolve(modelId: "llama3.2:3b")?.providerLabel == "Meta")
        #expect(
            OllamaDisplayBrands.resolve(modelId: "deepseek-r1:8b")?.providerClass == "deepseek")
        #expect(OllamaDisplayBrands.resolve(modelId: "rnj-1")?.providerLabel == "Essential AI")
        #expect(
            OllamaDisplayBrands.resolve(modelId: "glm-4.7-flash:q4_K_M")?.providerClass == "zai")
        #expect(
            OllamaDisplayBrands.resolve(modelId: "north-mini-code-1.0:q4_K_M")?.providerClass
                == "cohere")
    }

    @Test("returns nil for unbranded / empty models")
    func returnsNilForUnknown() {
        #expect(OllamaDisplayBrands.resolve(modelId: "mystery-local") == nil)
        #expect(OllamaDisplayBrands.resolve(modelId: "") == nil)
        #expect(OllamaDisplayBrands.resolve(modelId: nil) == nil)
    }

    @Test("falls back to the brand's default model label when none provided")
    func fallbackLabel() {
        #expect(OllamaDisplayBrands.resolve(modelId: "qwen")?.modelLabel == "Qwen 3 (4B Param)")
    }

    @Test("keeps the provider picker order explicit")
    func explicitOrder() {
        #expect(
            OllamaDisplayBrands.all.map(\.id) == [
                "alibaba", "cohere", "deepseek", "deep-reinforce", "essential", "google", "ibm",
                "liquid", "meta", "mistral", "nvidia", "openai", "openbmb", "poolside", "zai",
            ])
    }

    @Test("providerHueClass spoofs the brand class for Ollama brands only")
    func hueClass() {
        #expect(
            OllamaDisplayBrands.providerHueClass(provider: "ollama", modelId: "qwen3.5:9b")
                == "alibaba")
        #expect(
            OllamaDisplayBrands.providerHueClass(
                provider: "ollama", modelId: "laguna-xs-2.1:q8_0") == "poolside")
        // Reuses the first-class Mistral seat's hue — one brand, one colour.
        #expect(
            OllamaDisplayBrands.providerHueClass(
                provider: "ollama", modelId: "devstral-small-2:24b") == "mistral")
        #expect(
            OllamaDisplayBrands.providerHueClass(provider: "ollama", modelId: "llama3.2:3b")
                == "meta")
        #expect(
            OllamaDisplayBrands.providerHueClass(provider: "ollama", modelId: "mystery") == "ollama")
        #expect(
            OllamaDisplayBrands.providerHueClass(provider: "claude", modelId: "claude-opus-4-8")
                == "claude")
    }

    @Test("brandLabel returns the upstream name for Ollama brands and nil otherwise")
    func brandLabel() {
        #expect(
            OllamaDisplayBrands.brandLabel(provider: "ollama", modelId: "nemotron3:33b") == "NVIDIA")
        #expect(
            OllamaDisplayBrands.brandLabel(provider: "ollama", modelId: "laguna-xs-2.1:q8_0")
                == "Poolside")
        #expect(
            OllamaDisplayBrands.brandLabel(provider: "ollama", modelId: "rnj-1")
                == "Essential AI")
        #expect(OllamaDisplayBrands.brandLabel(provider: "ollama", modelId: "mystery") == nil)
        #expect(OllamaDisplayBrands.brandLabel(provider: "claude", modelId: "claude-opus-4-8") == nil)
    }
}
