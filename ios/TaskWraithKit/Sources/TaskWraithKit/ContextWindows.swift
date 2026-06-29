import Foundation

/// Per-model / per-provider context-window sizes.
///
/// Ported from the desktop renderer's single source of truth,
/// `src/renderer/src/lib/contextWindows.ts` — keep the two tables in sync when
/// the desktop list changes. The phone only receives raw token counts in the
/// thread snapshot (no run-reported `totalTokenLimit` / live-Ollama metadata),
/// so `resolve` covers just the model-id → provider-fallback → default chain.
public enum ContextWindows {
    /// Model id → context window (tokens). Mirrors `CONTEXT_WINDOWS_BY_MODEL`.
    static let byModel: [String: Int] = [
        // Gemini
        "pro": 1_048_576,
        "flash": 1_048_576,
        "flash-lite": 200_000,
        "auto": 1_048_576,
        "cli-default": 1_048_576,
        // Codex
        "gpt-5.5": 1_050_000,
        "gpt-5.4": 1_050_000,
        "gpt-5.4-mini": 400_000,
        "gpt-5.3-codex": 400_000,
        "gpt-5.3-codex-spark": 200_000,
        "gpt-5.2": 400_000,
        // Claude
        "claude-fable-5": 200_000,
        "claude-fable-5-1m": 1_000_000,
        "claude-opus-4-8": 200_000,
        "claude-opus-4-8-1m": 1_000_000,
        "claude-opus-4-7": 200_000,
        "claude-opus-4-7-1m": 1_000_000,
        "claude-sonnet-4-6": 200_000,
        "claude-haiku-4-5": 200_000,
        "claude-opus-4-6": 200_000,
        "default": 200_000,
        "sonnet": 200_000,
        "opus": 200_000,
        "haiku": 200_000,
        // Kimi
        "kimi-k2.7-code": 256_000,
        "kimi-k2.6": 256_000,
        // Grok — Composer 2.5 Fast runs through Grok Build CLI; grok-build is the
        // 256K build model and grok-4.3 is the 1M API model.
        "grok-composer-2.5-fast": 200_000,
        "grok-build": 256_000,
        "grok-4.3": 1_000_000,
        // Ollama local defaults — conservative UI fallbacks when no live limit
        // is known.
        "qwen3:4b-instruct": 262_144,
        "qwen3.5:9b": 262_144,
        "qwen3.6:35b": 262_144,
        "qwen3.6:35b-a3b": 262_144,
        "gemma4:12b": 262_144,
        "gemma4:12b-it-qat": 262_144,
        "gemma4:12b-it-q4_k_m": 262_144,
        "gemma4:12b-it-q8_0": 262_144,
        "gemma4:12b-it-bf16": 262_144,
        "ornith": 262_144,
        "ornith:latest": 262_144,
        "ornith:9b": 262_144,
        "ornith:35b": 262_144,
        "gpt-oss": 131_072,
        "gpt-oss:20b": 131_072,
        "gpt-oss:latest": 131_072,
        "openai/gpt-oss-20b": 131_072,
        "lfm2.5": 131_072,
        "lfm2.5:8b": 131_072,
        "lfm2.5:latest": 131_072,
        "minicpm-v4.5:8b": 40_960,
        "granite4.1:3b": 131_072,
        "granite4.1:30b": 131_072,
        "nemotron3:33b": 131_072,
    ]

    /// Provider id (lowercased) → fallback window. Mirrors
    /// `PROVIDER_FALLBACK_WINDOW`.
    static let providerFallback: [String: Int] = [
        "gemini": 1_048_576,
        "codex": 1_050_000,
        "claude": 200_000,
        "kimi": 256_000,
        "grok": 256_000,
        "cursor": 200_000,
        "ollama": 262_144,
    ]

    /// Resolve the context-window size for a thread, mirroring the desktop's
    /// `resolveContextWindow`: exact model id wins, then the provider fallback,
    /// then a universal 200k default.
    public static func resolve(provider: String?, model: String?) -> Int {
        if let model, let hit = byModel[model] {
            return hit
        }
        if let provider, let hit = providerFallback[provider.lowercased()] {
            return hit
        }
        return 200_000
    }
}
