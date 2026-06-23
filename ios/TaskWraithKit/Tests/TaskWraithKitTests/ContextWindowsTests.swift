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
        #expect(ContextWindows.resolve(provider: "codex", model: "gpt-5.5") == 1_050_000)
        #expect(ContextWindows.resolve(provider: "codex", model: "gpt-5.4") == 1_050_000)
        #expect(ContextWindows.resolve(provider: "codex", model: "gpt-5.4-mini") == 400_000)
        #expect(ContextWindows.resolve(provider: "claude", model: "claude-opus-4-8-1m") == 1_000_000)
        #expect(ContextWindows.resolve(provider: "claude", model: "claude-opus-4-8") == 200_000)
    }

    @Test("unknown / missing model falls back to the provider window")
    func providerFallback() {
        #expect(ContextWindows.resolve(provider: "ollama", model: "totally-unknown:1b") == 262_144)
        #expect(ContextWindows.resolve(provider: "gemini", model: nil) == 1_048_576)
        #expect(ContextWindows.resolve(provider: "codex", model: nil) == 1_050_000)
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
