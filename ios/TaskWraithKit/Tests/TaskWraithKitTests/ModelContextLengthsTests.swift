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

    @Test("claude-fable-5 row: 1_000_000 / 1.0M")
    func claudeFable5() {
        let groups = ModelContextLengths.buildGroups()
        let row = groups.first { $0.provider == "claude" }?
            .models.first { $0.modelId == "claude-fable-5" }
        #expect(row != nil)
        #expect(row?.label == "Fable 5")
        #expect(row?.contextWindow == 1_000_000)
        #expect(row?.formatted == "1.0M")
    }

    @Test("claude-sonnet-5 row: 1_000_000 / 1.0M")
    func claudeSonnet5() {
        let groups = ModelContextLengths.buildGroups()
        let row = groups.first { $0.provider == "claude" }?
            .models.first { $0.modelId == "claude-sonnet-5" }
        #expect(row != nil)
        #expect(row?.label == "Sonnet 5")
        #expect(row?.contextWindow == 1_000_000)
        #expect(row?.formatted == "1.0M")
    }

    @Test("claude-sonnet-4-6 row: 200_000 / 200k")
    func claudeSonnet46Legacy() {
        let groups = ModelContextLengths.buildGroups()
        let row = groups.first { $0.provider == "claude" }?
            .models.first { $0.modelId == "claude-sonnet-4-6" }
        #expect(row != nil)
        #expect(row?.label == "Sonnet 4.6 Legacy")
        #expect(row?.contextWindow == 200_000)
        #expect(row?.formatted == "200k")
    }

    @Test("claude group mirrors the current picker rows")
    func claudeGroupMirrorsPickerRows() {
        let groups = ModelContextLengths.buildGroups()
        let claudeModels = groups.first { $0.provider == "claude" }?.models ?? []
        // Current models first, the Legacy cluster (4.8 1M among them) below.
        #expect(claudeModels.map(\.modelId) == [
            "claude-opus-5",
            "claude-fable-5",
            "claude-sonnet-5",
            "claude-sonnet-4-6",
            "claude-opus-4-8-1m",
            "claude-opus-4-7-1m",
            "claude-haiku-4-5",
        ])
        #expect(!claudeModels.contains { $0.modelId == "claude-opus-4-8" })
        #expect(!claudeModels.contains { $0.modelId == "claude-mythos-5" })
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

    @Test("kimi kimi-k3: 256k base and plan-dependent 1M maximum")
    func kimiK3() {
        let groups = ModelContextLengths.buildGroups()
        let row = groups.first { $0.provider == "kimi" }?
            .models.first { $0.modelId == "kimi-k3" }
        #expect(row != nil)
        #expect(row?.label == "K3")
        #expect(row?.contextWindow == 256_000)
        #expect(row?.maxContextWindow == 1_048_576)
        #expect(row?.formatted == "256k–1.0M")
    }

    @Test("kimi group mirrors the current picker rows (K2.7 default first, then K3)")
    func kimiGroupMirrorsPickerRows() {
        let groups = ModelContextLengths.buildGroups()
        let kimiModels = groups.first { $0.provider == "kimi" }?.models ?? []
        #expect(kimiModels.map(\.modelId) == ["kimi-k2.7-code", "kimi-k3"])
    }

    // MARK: - Grok group

    @Test("grok grok-4.5: 500_000 / 500k")
    func grok45() {
        // The primary grok CLI model is Grok 4.5 (500k); it replaced grok-build in
        // buildGroups when Grok 4.5 landed (1db1f1d8c).
        let groups = ModelContextLengths.buildGroups()
        let row = groups.first { $0.provider == "grok" }?
            .models.first { $0.modelId == "grok-4.5" }
        #expect(row?.contextWindow == 500_000)
        #expect(row?.formatted == "500k")
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

    @Test("buildGroups() default: order is gemini/codex/claude/kimi/grok/cursor/pi, no ollama")
    func defaultProviderOrder() {
        let groups = ModelContextLengths.buildGroups()
        let providers = groups.map(\.provider)
        #expect(providers == ["gemini", "codex", "claude", "kimi", "grok", "cursor", "pi"])
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

    @Test("ollama lfm2.5:8b: 131_072 / 131k")
    func ollamaLfm25() {
        let groups = ModelContextLengths.buildGroups(includeOllama: true)
        let row = groups.first { $0.provider == "ollama" }?
            .models.first { $0.modelId == "lfm2.5:8b" }
        #expect(row?.label == "LFM 2.5 (8B-A1B)")
        #expect(row?.contextWindow == 131_072)
        #expect(row?.formatted == "131k")
    }

    @Test("ollama ornith:35b: 262_144 / 262k")
    func ollamaOrnith35b() {
        let groups = ModelContextLengths.buildGroups(includeOllama: true)
        let row = groups.first { $0.provider == "ollama" }?
            .models.first { $0.modelId == "ornith:35b" }
        #expect(row?.label == "Ornith 1.0 (35B Param)")
        #expect(row?.contextWindow == 262_144)
        #expect(row?.formatted == "262k")
    }

    @Test("ollama laguna-xs-2.1:q8_0: 262_144 / 262k")
    func ollamaLagunaXs21Q8() {
        let groups = ModelContextLengths.buildGroups(includeOllama: true)
        let row = groups.first { $0.provider == "ollama" }?
            .models.first { $0.modelId == "laguna-xs-2.1:q8_0" }
        #expect(row?.label == "Laguna XS 2.1 (33B-A3B Q8)")
        #expect(row?.contextWindow == 262_144)
        #expect(row?.formatted == "262k")
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
