import Foundation

/// Per-model / per-provider context-window sizes.
///
/// Ported from the desktop's single source of truth,
/// `src/shared/contextWindows.ts` — keep the two tables in sync when
/// the desktop list changes. The phone only receives raw token counts in the
/// thread snapshot (no run-reported `totalTokenLimit` / live-Ollama metadata),
/// so `resolve` covers the provider-model override → model-id → provider-
/// fallback → default chain.
public enum ContextWindows {
    /// Model id → context window (tokens). Mirrors `CONTEXT_WINDOWS_BY_MODEL`.
    static let byModel: [String: Int] = [
        // Gemini
        "pro": 1_048_576,
        "flash": 1_048_576,
        "flash-lite": 200_000,
        "auto": 1_048_576,
        "cli-default": 1_048_576,
        // Gemini wire model ids (antigravity gemini-api lane; both bare and
        // catalog-prefixed spellings) — mirrors src/shared/contextWindows.ts.
        "gemini-2.5-pro": 1_048_576,
        "gemini-2.5-flash": 1_048_576,
        "gemini-2.5-flash-lite": 1_048_576,
        "gemini-2.0-flash": 1_048_576,
        "gemini-api:gemini-2.5-pro": 1_048_576,
        "gemini-api:gemini-2.5-flash": 1_048_576,
        "gemini-api:gemini-2.5-flash-lite": 1_048_576,
        "gemini-api:gemini-2.0-flash": 1_048_576,
        // Codex
        // GPT-5.6 trio (GA 2026-07-09): official raw API window is 1,050,000 on
        // all three — mirrors src/shared/contextWindows.ts.
        "gpt-5.6-sol": 1_050_000,
        "gpt-5.6-terra": 1_050_000,
        "gpt-5.6-luna": 1_050_000,
        "gpt-5.5": 1_050_000,
        "gpt-5.4": 1_050_000,
        "gpt-5.4-mini": 400_000,
        "gpt-5.3-codex": 400_000,
        "gpt-5.3-codex-spark": 200_000,
        "gpt-5.2": 400_000,
        // Claude
        "claude-fable-5": 1_000_000,
        "claude-fable-5-1m": 1_000_000,
        "claude-mythos-5": 1_000_000,
        "claude-opus-5": 1_000_000,
        "claude-opus-4-8": 200_000,
        "claude-opus-4-8-1m": 1_000_000,
        "claude-opus-4-7": 200_000,
        "claude-opus-4-7-1m": 1_000_000,
        "claude-sonnet-5": 1_000_000,
        "claude-sonnet-4-6": 200_000,
        "claude-haiku-4-5": 200_000,
        "claude-opus-4-6": 200_000,
        "default": 200_000,
        "sonnet": 200_000,
        "opus": 200_000,
        "haiku": 200_000,
        // Pi seat wire ids (`<upstream>/<model>`); mirrors contextWindows.ts.
        "deepseek/deepseek-v4-pro": 1_000_000,
        "deepseek/deepseek-v4-flash": 1_000_000,
        "zai/glm-5.2": 1_000_000,
        "zai/glm-5.1": 200_000,
        "zai/glm-4.7": 204_800,
        "qwen-token-plan/qwen3.7-max": 1_000_000,
        "qwen-token-plan/qwen3.7-plus": 1_000_000,
        "qwen-token-plan/qwen3.8-max-preview": 1_000_000,
        "minimax/MiniMax-M3": 1_000_000,
        "minimax/MiniMax-M2.7": 204_800,
        "mistral/zai-glm-5-2": 1_000_000,
        "mistral/mistral-medium-3.5": 262_144,
        "mistral/mistral-medium-latest": 262_144,
        "mistral/mistral-small-2603": 256_000,
        "mistral/mistral-large-2512": 262_144,
        "mistral/devstral-2512": 262_144,
        "mistral/codestral-2508": 131_072,
        "mistral/labs-leanstral-1-5": 262_144,
        "mistral/mistral-medium-2508": 262_144,
        "mistral/mistral-medium-2505": 131_072,
        "mistral/ministral-14b-2512": 262_144,
        "mistral/ministral-8b-2512": 262_144,
        "mistral/ministral-3b-2512": 262_144,
        // Mistral Vibe CLI seat (ProviderId `mistral`) — a DIFFERENT provider
        // from the Pi upstream directly above, which merely shares the brand
        // word. Seat model ids are always BARE; the presence of a `/` is what
        // separates the two identities everywhere they meet. The CLI exposes
        // `mistral-medium-3.5` as an alias of its own wire id
        // `mistral-vibe-cli-latest`, so both resolve here.
        "mistral-medium-3.5": 262_144,
        "mistral-vibe-cli-latest": 262_144,
        "devstral-small": 262_144,
        "mistral-large-2512": 262_144,
        "zai-glm-5-2": 1_000_000,
        "codestral-2508": 131_072,
        "mistral-small-2603": 256_000,
        "devstral-2512": 262_144,
        "labs-leanstral-1-5": 262_144,
        "mistral-medium-latest": 262_144,
        "mistral-medium-2508": 262_144,
        "mistral-medium-2505": 131_072,
        "ministral-14b-2512": 262_144,
        "ministral-8b-2512": 262_144,
        "ministral-3b-2512": 262_144,
        // Muse Code CLI default model (opaque exec seat).
        "muse-spark-1.2": 200_000,
        "groq/openai/gpt-oss-120b": 131_072,
        "groq/qwen/qwen3-32b": 131_072,
        "cerebras/zai-glm-4.7": 131_072,
        "cerebras/gpt-oss-120b": 131_072,
        // Kimi
        "kimi-k3": 256_000,
        "kimi-k2.7-code": 256_000,
        "kimi-k2.6": 256_000,
        // Grok
        "grok-composer-2.5-fast": 200_000,
        "grok-4.6": 500_000,
        "grok-4.5": 500_000,
        "grok-4.5-latest": 500_000,
        "grok-build-latest": 500_000,
        "grok-build": 500_000,
        "grok-build-0.1": 500_000,
        "grok-4.3": 1_000_000,
        // Cursor
        "composer-2.5": 200_000,
        "composer-2.5-fast": 200_000,
        "cursor-grok-4.5": 500_000,
        "grok-4.5-medium": 500_000,
        "grok-4.5-fast-medium": 500_000,
        "grok-4.5-high": 500_000,
        "grok-4.5-fast-high": 500_000,
        "grok-4.5-xhigh": 500_000,
        "grok-4.5-fast-xhigh": 500_000,
        "cursor-grok-4.6-low": 256_000,
        "cursor-grok-4.6-low-fast": 256_000,
        "cursor-grok-4.6-medium": 256_000,
        "cursor-grok-4.6-medium-fast": 256_000,
        "cursor-grok-4.6-high": 256_000,
        "cursor-grok-4.6-high-fast": 256_000,
        "cursor-grok-4.6-xhigh": 256_000,
        "cursor-grok-4.6-xhigh-fast": 256_000,
        // Ollama local defaults — conservative UI fallbacks when no live limit
        // is known.
        "qwen3:4b-instruct": 262_144,
        "qwen3.5:2b": 262_144,
        "qwen3.5:4b": 262_144,
        "qwen3.5:9b": 262_144,
        "qwen3.6:35b": 262_144,
        "qwen3.6:35b-a3b": 262_144,
        // Official Ollama model config (`max_position_embeddings`), verified 2026-08-14.
        "qwen3.8:27b-mlx": 262_144,
        "gemma3:4b": 131_072,
        "gemma4:12b": 262_144,
        "gemma4:12b-it-qat": 262_144,
        "gemma4:12b-it-q4_k_m": 262_144,
        "gemma4:12b-it-q8_0": 262_144,
        "gemma4:12b-it-bf16": 262_144,
        "ornith": 262_144,
        "ornith:latest": 262_144,
        "ornith:9b": 262_144,
        "ornith:35b": 262_144,
        "laguna-xs-2.1:q8_0": 262_144,
        "gpt-oss": 131_072,
        "gpt-oss:20b": 131_072,
        "gpt-oss:latest": 131_072,
        "openai/gpt-oss-20b": 131_072,
        // 128_000, not 131_072 — the daemon reports a round 128k for this one.
        // Mirrors src/shared/contextWindows.ts. iOS has no daemon to probe, so
        // unlike desktop this table IS the only source here.
        "lfm2.5": 128_000,
        "lfm2.5:8b": 128_000,
        "lfm2.5:latest": 128_000,
        // Ollama stretches the 32,768-token base model to a round 128,000-token
        // runtime window (shown as 125K in its registry card).
        "lfm2.5-thinking:1.2b": 128_000,
        "minicpm-v4.5:8b": 40_960,
        "granite4:3b": 131_072,
        "granite4.1:3b": 131_072,
        "granite4.1:30b": 131_072,
        "nemotron-3-nano:4b": 262_144,
        "nemotron3:33b": 131_072,
        // Official Ollama MLX config (`max_position_embeddings`), verified 2026-08-11.
        "nemotron-3.5-lightning:30b-mlx": 262_144,
        "devstral-small-2:24b": 393_216,
        "ministral-3:3b": 262_144,
        "ministral-3:14b": 262_144,
        // Official Ollama MLX config (`max_position_embeddings`), verified 2026-08-11.
        "muse-glimmer:30b-mlx": 131_072,
        // Exact GGUF metadata (`*.context_length`) from the Ollama registry /
        // local daemon on 2026-08-02. GLM/North's pages round to 198K/488K.
        "llama3.1:8b": 131_072,
        "deepseek-r1:1.5b": 131_072,
        "deepseek-r1:8b": 131_072,
        "rnj-1": 32_768,
        "rnj-1:latest": 32_768,
        "rnj-1:8b": 32_768,
        "glm-4.7-flash:q4_K_M": 202_752,
        "north-mini-code-1.0:q4_K_M": 500_000,
        "llama3.2:3b": 131_072,
    ]

    /// Provider + model id → context window (tokens). Kept outside `byModel`
    /// because Cursor hosts the same semantic Grok ids with a smaller window.
    /// Mirrors desktop `PROVIDER_MODEL_CONTEXT_WINDOW_OVERRIDES`.
    static let providerModelOverrides: [String: [String: Int]] = [
        "grok": [
            "grok-4.6": 500_000,
        ],
        "cursor": [
            "grok-4.6": 256_000,
        ],
    ]

    /// Provider id (lowercased) → fallback window. Mirrors
    /// `PROVIDER_FALLBACK_WINDOW`.
    static let providerFallback: [String: Int] = [
        "gemini": 1_048_576,
        "codex": 1_050_000,
        "claude": 200_000,
        "kimi": 256_000,
        "grok": 500_000,
        "cursor": 200_000,
        "ollama": 262_144,
        "antigravity": 1_048_576,
        "pi": 1_000_000,
        // Both Vibe seat models sit at 262_144; see the bare `mistral-medium-3.5`
        // / `devstral-small` rows above. NOT the same identity as the
        // `mistral/<model>` rows, which are Pi's BYOK upstream.
        "mistral": 262_144,
        // Muse opaque CLI seat — conservative fallback until a measured window lands.
        "muse": 200_000,
    ]

    /// Resolve the context-window size for a thread, mirroring the desktop's
    /// `resolveContextWindow`: provider-scoped model id wins, then global model
    /// id, then the provider fallback, then a universal 200k default.
    public static func resolve(provider: String?, model: String?) -> Int {
        if let provider, let model,
            let hit = providerModelOverrides[provider.lowercased()]?[model.lowercased()]
        {
            return hit
        }
        if let model, let hit = byModel[model] {
            return hit
        }
        if let provider, let hit = providerFallback[provider.lowercased()] {
            return hit
        }
        return 200_000
    }
}
