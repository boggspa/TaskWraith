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
        #expect(ContextWindows.resolve(provider: "ollama", model: "ornith-1.5:35b") == 262_144)
        #expect(ContextWindows.resolve(provider: "ollama", model: "laguna-xs-2.1:q8_0") == 262_144)
        #expect(ContextWindows.resolve(provider: "ollama", model: "qwen3.5:4b") == 262_144)
        #expect(ContextWindows.resolve(provider: "ollama", model: "qwen3.8:27b-mlx") == 262_144)
        #expect(
            ContextWindows.resolve(provider: "ollama", model: "qwen3.8-flash-next:125b-mlx")
                == 262_144)
        #expect(
            ContextWindows.resolve(provider: "ollama", model: "mistral-medium-3.5:latest")
                == 262_144)
        #expect(
            ContextWindows.resolve(provider: "ollama", model: "mistral-medium-3.5:128b")
                == 262_144)
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
        for modelId in ["granite4.2:3b", "granite4.2:8b", "granite4.2:30b"] {
            #expect(ContextWindows.resolve(provider: "ollama", model: modelId) == 131_072)
        }
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

    @Test("Grok 4.6 ids use provider-scoped direct and Cursor windows")
    func grokProviderWindows() {
        #expect(ContextWindows.resolve(provider: "grok", model: "grok-4.6") == 500_000)
        #expect(ContextWindows.resolve(provider: "cursor", model: "grok-4.6") == 256_000)

        let cursorWireIds = [
            "cursor-grok-4.6-low",
            "cursor-grok-4.6-low-fast",
            "cursor-grok-4.6-medium",
            "cursor-grok-4.6-medium-fast",
            "cursor-grok-4.6-high",
            "cursor-grok-4.6-high-fast",
            "cursor-grok-4.6-xhigh",
            "cursor-grok-4.6-xhigh-fast",
        ]
        for modelId in cursorWireIds {
            #expect(ContextWindows.resolve(provider: "cursor", model: modelId) == 256_000)
        }

        // Grok 4.5 retains its established provider-agnostic 500k behavior.
        #expect(ContextWindows.resolve(provider: "cursor", model: "grok-4.5") == 500_000)
        #expect(ContextWindows.resolve(provider: "cursor", model: "cursor-grok-4.5") == 500_000)
    }

    @Test("Kimi uses exact fixed windows and honors the discovered plan limit")
    func kimiProviderWindows() {
        #expect(ContextWindows.resolve(provider: "kimi", model: "kimi-k2.7-code") == 262_144)
        #expect(ContextWindows.resolve(provider: "kimi", model: "kimi-k3-256k") == 262_144)
        #expect(ContextWindows.resolve(provider: "kimi", model: "kimi-k3") == 262_144)
        #expect(
            ContextWindows.resolve(
                provider: "kimi", model: "kimi-k3", discoveredContextWindow: 1_048_576)
                == 1_048_576)
    }

    @Test("OpenRouter Pi additions keep exact windows and catalog labels")
    func openRouterPiAdditions() {
        let expected = [
            (
                id: "openrouter/cohere/north-mini-code:free",
                label: "North Mini Code (OpenRouter Free)",
                window: 256_000
            ),
            (
                id: "openrouter/minimax/minimax-m3:free",
                label: "MiniMax M3 (OpenRouter Free)",
                window: 1_048_576
            ),
            (
                id: "openrouter/thinkingmachines/inkling:free",
                label: "Inkling (OpenRouter Free)",
                window: 1_048_576
            ),
            (
                id: "openrouter/thinkingmachines/inkling-small:free",
                label: "Inkling Small (OpenRouter Free)",
                window: 1_048_576
            ),
        ]
        let piRows =
            ModelContextLengths.buildGroups()
            .first(where: { $0.provider == "pi" })?
            .models ?? []
        let rowsById = Dictionary(uniqueKeysWithValues: piRows.map { ($0.modelId, $0) })

        for entry in expected {
            #expect(ContextWindows.resolve(provider: "pi", model: entry.id) == entry.window)
            #expect(rowsById[entry.id]?.label == entry.label)
            #expect(rowsById[entry.id]?.contextWindow == entry.window)
        }
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
