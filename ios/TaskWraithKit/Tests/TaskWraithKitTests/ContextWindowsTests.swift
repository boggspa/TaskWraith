// Context-window resolution — the Swift mirror of the desktop renderer's
// `resolveContextWindow` (src/renderer/src/lib/contextWindows.ts). Asserts the
// model-id → provider-fallback → default chain the composer donut relies on.

import Testing

@testable import TaskWraithKit

@Suite("Context windows")
struct ContextWindowsTests {
    @Test("exact model id wins over the provider fallback")
    func modelIdWins() {
        // gpt-oss:20b is 131_072 even though Ollama's provider fallback is 262_144.
        #expect(ContextWindows.resolve(provider: "ollama", model: "gpt-oss:20b") == 131_072)
        #expect(ContextWindows.resolve(provider: "ollama", model: "ornith") == 262_144)
        #expect(ContextWindows.resolve(provider: "ollama", model: "ornith:latest") == 262_144)
        #expect(ContextWindows.resolve(provider: "ollama", model: "ornith:35b") == 262_144)
        #expect(ContextWindows.resolve(provider: "ollama", model: "laguna-xs-2.1:q8_0") == 262_144)
        #expect(ContextWindows.resolve(provider: "ollama", model: "qwen3.5:4b") == 262_144)
        #expect(
            ContextWindows.resolve(provider: "ollama", model: "devstral-small-2:24b") == 393_216)
        #expect(ContextWindows.resolve(provider: "ollama", model: "ministral-3:14b") == 262_144)
        #expect(
            ContextWindows.resolve(provider: "ollama", model: "muse-glimmer:30b-mlx") == 131_072)
        #expect(ContextWindows.resolve(provider: "ollama", model: "lfm2.5:8b") == 128_000)
        #expect(ContextWindows.resolve(provider: "ollama", model: "llama3.1:8b") == 131_072)
        #expect(ContextWindows.resolve(provider: "ollama", model: "deepseek-r1:8b") == 131_072)
        #expect(ContextWindows.resolve(provider: "ollama", model: "rnj-1") == 32_768)
        #expect(ContextWindows.resolve(provider: "ollama", model: "rnj-1:latest") == 32_768)
        #expect(
            ContextWindows.resolve(provider: "ollama", model: "glm-4.7-flash:q4_K_M") == 202_752)
        #expect(
            ContextWindows.resolve(provider: "ollama", model: "north-mini-code-1.0:q4_K_M")
                == 500_000)
        #expect(
            ContextWindows.resolve(
                provider: "ollama", model: "nemotron-3.5-lightning:30b-mlx") == 262_144)
        #expect(ContextWindows.resolve(provider: "ollama", model: "llama3.2:3b") == 131_072)
        let lightweightWindows = [
            "ministral-3:3b": 262_144,
            "granite4:3b": 131_072,
            "qwen3.5:2b": 262_144,
            "deepseek-r1:1.5b": 131_072,
            "nemotron-3-nano:4b": 262_144,
            "lfm2.5-thinking:1.2b": 128_000,
            "gemma3:4b": 131_072,
        ]
        for (modelId, window) in lightweightWindows {
            #expect(ContextWindows.resolve(provider: "ollama", model: modelId) == window)
        }
        #expect(ContextWindows.resolve(provider: "codex", model: "gpt-5.5") == 1_050_000)
        #expect(ContextWindows.resolve(provider: "codex", model: "gpt-5.4") == 1_050_000)
        #expect(ContextWindows.resolve(provider: "codex", model: "gpt-5.4-mini") == 400_000)
        #expect(ContextWindows.resolve(provider: "claude", model: "claude-opus-5") == 1_000_000)
        #expect(ContextWindows.resolve(provider: "claude", model: "claude-opus-4-8-1m") == 1_000_000)
        #expect(ContextWindows.resolve(provider: "claude", model: "claude-opus-4-8") == 200_000)
        #expect(ContextWindows.resolve(provider: "claude", model: "claude-sonnet-5") == 1_000_000)
        #expect(ContextWindows.resolve(provider: "claude", model: "claude-sonnet-4-6") == 200_000)
        #expect(ContextWindows.resolve(provider: "muse", model: "muse-spark-1.2") == 200_000)
    }

    @Test("unknown / missing model falls back to the provider window")
    func providerFallback() {
        #expect(ContextWindows.resolve(provider: "ollama", model: "totally-unknown:1b") == 262_144)
        #expect(ContextWindows.resolve(provider: "gemini", model: nil) == 1_048_576)
        #expect(ContextWindows.resolve(provider: "codex", model: nil) == 1_050_000)
        #expect(ContextWindows.resolve(provider: "muse", model: nil) == 200_000)
    }

    @Test("provider match is case-insensitive")
    func providerCaseInsensitive() {
        #expect(ContextWindows.resolve(provider: "Claude", model: nil) == 200_000)
        #expect(ContextWindows.resolve(provider: "OLLAMA", model: nil) == 262_144)
    }

    @Test("no provider and no model resolves to the universal default")
    func universalDefault() {
        #expect(ContextWindows.resolve(provider: nil, model: nil) == 200_000)
        #expect(ContextWindows.resolve(provider: "made-up-provider", model: nil) == 200_000)
    }
}
