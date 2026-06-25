// ModelContextLengths — the Swift twin of desktop src/renderer/src/lib/modelContextLengths.ts.
// Parity tests mirror desktop modelContextLengths.test.ts + the shared formatter tests.

import Testing

@testable import TaskWraithKit

@Suite("Model context lengths")
struct ModelContextLengthsTests {

    // MARK: - formatContextTokens

    @Test("1_000_000 -> 1.0M")
    func format1M() {
        #expect(ModelContextLengths.formatContextTokens(1_000_000) == "1.0M")
    }

    @Test("1_048_576 -> 1.0M (Gemini flash rounds down)")
    func format1048576() {
        #expect(ModelContextLengths.formatContextTokens(1_048_576) == "1.0M")
    }

    @Test("1_050_000 -> 1.1M (Codex gpt-5.5/5.4)")
    func format1050000() {
        #expect(ModelContextLengths.formatContextTokens(1_050_000) == "1.1M")
    }

    @Test("256_000 -> 256k")
    func format256k() {
        #expect(ModelContextLengths.formatContextTokens(256_000) == "256k")
    }

    @Test("200_000 -> 200k")
    func format200k() {
        #expect(ModelContextLengths.formatContextTokens(200_000) == "200k")
    }

    @Test("262_144 -> 262k (Ollama default)")
    func format262144() {
        #expect(ModelContextLengths.formatContextTokens(262_144) == "262k")
    }

    @Test("40_960 -> 41k (MiniCPM)")
    func format40960() {
        #expect(ModelContextLengths.formatContextTokens(40_960) == "41k")
    }

    @Test("999 -> 999 (sub-kilo passthrough)")
    func format999() {
        #expect(ModelContextLengths.formatContextTokens(999) == "999")
    }

    // MARK: - Claude group

    @Test("claude-opus-4-8-1m row: 1_000_000 / 1.0M")
    func claudeOpus48_1m() {
        let groups = ModelContextLengths.buildGroups()
        let row = groups.first { $0.provider == "claude" }?
            .models.first { $0.modelId == "claude-opus-4-8-1m" }
        #expect(row != nil)
        #expect(row?.contextWindow == 1_000_000)
        #expect(row?.formatted == "1.0M")
    }

    @Test("claude-opus-4-8 row: 200_000 / 200k (two honest rows coexist)")
    func claudeOpus48() {
        let groups = ModelContextLengths.buildGroups()
        let claudeModels = groups.first { $0.provider == "claude" }?.models ?? []
        let row = claudeModels.first { $0.modelId == "claude-opus-4-8" }
        #expect(row != nil)
        #expect(row?.contextWindow == 200_000)
        #expect(row?.formatted == "200k")
        // Both rows must be present in the same group
        let has1m = claudeModels.contains { $0.modelId == "claude-opus-4-8-1m" }
        #expect(has1m)
    }

    // MARK: - Codex group

    @Test("codex gpt-5.5: 1_050_000 / 1.1M")
    func codexGpt55() {
        let groups = ModelContextLengths.buildGroups()
        let row = groups.first { $0.provider == "codex" }?
            .models.first { $0.modelId == "gpt-5.5" }
        #expect(row?.contextWindow == 1_050_000)
        #expect(row?.formatted == "1.1M")
    }

    @Test("codex gpt-5.4-mini: 400_000 / 400k")
    func codexGpt54Mini() {
        let groups = ModelContextLengths.buildGroups()
        let row = groups.first { $0.provider == "codex" }?
            .models.first { $0.modelId == "gpt-5.4-mini" }
        #expect(row?.contextWindow == 400_000)
        #expect(row?.formatted == "400k")
    }

    // MARK: - Cursor group

    @Test("cursor composer-2.5: 200_000 / 200k (resolves via provider fallback)")
    func cursorComposer25() {
        let groups = ModelContextLengths.buildGroups()
        let row = groups.first { $0.provider == "cursor" }?
            .models.first { $0.modelId == "composer-2.5" }
        #expect(row?.contextWindow == 200_000)
        #expect(row?.formatted == "200k")
    }

    // MARK: - Kimi group

    @Test("kimi kimi-k2.7-code: 256_000 / 256k")
    func kimiK27Code() {
        let groups = ModelContextLengths.buildGroups()
        let row = groups.first { $0.provider == "kimi" }?
            .models.first { $0.modelId == "kimi-k2.7-code" }
        #expect(row?.contextWindow == 256_000)
        #expect(row?.formatted == "256k")
    }

    // MARK: - Grok group

    @Test("grok grok-build: 256_000 / 256k")
    func grokBuild() {
        let groups = ModelContextLengths.buildGroups()
        let row = groups.first { $0.provider == "grok" }?
            .models.first { $0.modelId == "grok-build" }
        #expect(row?.contextWindow == 256_000)
        #expect(row?.formatted == "256k")
    }

    // MARK: - Gemini group

    @Test("gemini group contains 'pro' (1_048_576 / 1.0M)")
    func geminiProPresent() {
        let groups = ModelContextLengths.buildGroups()
        let row = groups.first { $0.provider == "gemini" }?
            .models.first { $0.modelId == "pro" }
        #expect(row != nil)
        #expect(row?.contextWindow == 1_048_576)
        #expect(row?.formatted == "1.0M")
    }

    @Test("gemini group contains 'flash-lite' (200_000 / 200k)")
    func geminiFlashLitePresent() {
        let groups = ModelContextLengths.buildGroups()
        let row = groups.first { $0.provider == "gemini" }?
            .models.first { $0.modelId == "flash-lite" }
        #expect(row != nil)
        #expect(row?.contextWindow == 200_000)
        #expect(row?.formatted == "200k")
    }

    @Test("gemini 'auto' alias is excluded from the group")
    func geminiAutoExcluded() {
        let groups = ModelContextLengths.buildGroups()
        let hasAuto = groups.first { $0.provider == "gemini" }?
            .models.contains { $0.modelId == "auto" } ?? false
        #expect(!hasAuto)
    }

    // MARK: - Provider order

    @Test("buildGroups() default: order is gemini/codex/claude/kimi/grok/cursor, no ollama")
    func defaultProviderOrder() {
        let groups = ModelContextLengths.buildGroups()
        let providers = groups.map(\.provider)
        #expect(providers == ["gemini", "codex", "claude", "kimi", "grok", "cursor"])
    }

    // MARK: - Ollama inclusion

    @Test("buildGroups(includeOllama: true): last group is ollama")
    func ollamaLast() {
        let groups = ModelContextLengths.buildGroups(includeOllama: true)
        #expect(groups.last?.provider == "ollama")
    }

    @Test("ollama qwen3:4b-instruct: 262_144 / 262k")
    func ollamaQwen3() {
        let groups = ModelContextLengths.buildGroups(includeOllama: true)
        let row = groups.first { $0.provider == "ollama" }?
            .models.first { $0.modelId == "qwen3:4b-instruct" }
        #expect(row?.contextWindow == 262_144)
        #expect(row?.formatted == "262k")
    }

    @Test("ollama gpt-oss:20b: 131_072 / 131k (explicit byModel entry, not the 262k fallback)")
    func ollamaGptOss20b() {
        let groups = ModelContextLengths.buildGroups(includeOllama: true)
        let row = groups.first { $0.provider == "ollama" }?
            .models.first { $0.modelId == "gpt-oss:20b" }
        #expect(row?.contextWindow == 131_072)
        #expect(row?.formatted == "131k")
    }

    // MARK: - excludeProviders

    @Test("excludeProviders: [\"gemini\"] drops gemini; codex & claude present")
    func excludeGemini() {
        let groups = ModelContextLengths.buildGroups(excludeProviders: ["gemini"])
        let providers = groups.map(\.provider)
        #expect(!providers.contains("gemini"))
        #expect(providers.contains("codex"))
        #expect(providers.contains("claude"))
    }

    @Test("buildGroups(includeOllama: true, excludeProviders: [\"gemini\"]) — iOS Settings config")
    func iOSSettingsConfig() {
        let groups = ModelContextLengths.buildGroups(
            includeOllama: true,
            excludeProviders: ["gemini"]
        )
        let providers = groups.map(\.provider)
        #expect(!providers.contains("gemini"))
        #expect(providers.contains("ollama"))
        #expect(providers.last == "ollama")
    }

    // MARK: - Completeness

    @Test("every row has non-empty formatted and contextWindow > 0 across all providers")
    func allRowsValid() {
        let groups = ModelContextLengths.buildGroups(includeOllama: true)
        for group in groups {
            for row in group.models {
                #expect(row.contextWindow > 0, "provider \(group.provider) model \(row.modelId) has zero window")
                #expect(!row.formatted.isEmpty, "provider \(group.provider) model \(row.modelId) has empty formatted")
            }
        }
    }
}
