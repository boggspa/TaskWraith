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
                "alibaba", "deep-reinforce", "google", "ibm", "liquid", "nvidia", "openai", "openbmb",
            ])
    }

    @Test("providerHueClass spoofs the brand class for Ollama brands only")
    func hueClass() {
        #expect(
            OllamaDisplayBrands.providerHueClass(provider: "ollama", modelId: "qwen3.5:9b")
                == "alibaba")
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
        #expect(OllamaDisplayBrands.brandLabel(provider: "ollama", modelId: "mystery") == nil)
        #expect(OllamaDisplayBrands.brandLabel(provider: "claude", modelId: "claude-opus-4-8") == nil)
    }
}
