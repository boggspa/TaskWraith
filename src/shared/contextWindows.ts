// NOTE: the iOS companion hand-mirrors these two tables in
// ios/TaskWraithKit/Sources/TaskWraithKit/ContextWindows.swift (the phone has no
// TS->Swift codegen). When you add or change a model/provider window here, update
// that Swift file too, or the composer context donut on iOS will drift.

export type ContextWindowProviderId =
  | 'gemini'
  | 'codex'
  | 'claude'
  | 'kimi'
  | 'grok'
  | 'cursor'
  | 'ollama'
  | 'antigravity'
  | 'pi'

const CONTEXT_WINDOWS_BY_MODEL: Record<string, number> = {
  // Gemini
  pro: 1_048_576,
  flash: 1_048_576,
  'flash-lite': 200_000,
  auto: 1_048_576,
  'cli-default': 1_048_576,
  // Gemini wire model ids (antigravity gemini-api lane resolves aliases to
  // these; runs may report either the bare wire id or the catalog-prefixed
  // `gemini-api:` form, so both spellings are registered).
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-lite': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  'gemini-api:gemini-2.5-pro': 1_048_576,
  'gemini-api:gemini-2.5-flash': 1_048_576,
  'gemini-api:gemini-2.5-flash-lite': 1_048_576,
  'gemini-api:gemini-2.0-flash': 1_048_576,
  // Pi seat wire ids (`<upstream>/<model>`, pi 0.82.1 bundled catalog).
  'deepseek/deepseek-v4-pro': 1_000_000,
  'deepseek/deepseek-v4-flash': 1_000_000,
  'zai/glm-5.2': 1_000_000,
  'zai/glm-5.1': 200_000,
  'zai/glm-4.7': 204_800,
  'qwen-token-plan/qwen3.7-max': 1_000_000,
  'qwen-token-plan/qwen3.7-plus': 1_000_000,
  'qwen-token-plan/qwen3.8-max-preview': 1_000_000,
  'minimax/MiniMax-M3': 1_000_000,
  'minimax/MiniMax-M2.7': 204_800,
  'mistral/devstral-2512': 262_144,
  'mistral/mistral-medium-3.5': 262_144,
  'groq/openai/gpt-oss-120b': 131_072,
  'groq/qwen/qwen3-32b': 131_072,
  'cerebras/zai-glm-4.7': 131_072,
  'cerebras/gpt-oss-120b': 131_072,
  // Codex
  // GPT-5.6 trio (GA 2026-07-09): official raw API window is 1,050,000 on all
  // three (developers.openai.com; TaskWraith's context-config override raises
  // the CLI working window to match — see CODEX_MODEL_CONTEXT_CONFIGS).
  'gpt-5.6-sol': 1_050_000,
  'gpt-5.6-terra': 1_050_000,
  'gpt-5.6-luna': 1_050_000,
  'gpt-5.5': 1_050_000,
  'gpt-5.4': 1_050_000,
  'gpt-5.4-mini': 400_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.3-codex-spark': 200_000,
  'gpt-5.2': 400_000,
  // Claude
  'claude-fable-5': 1_000_000,
  'claude-fable-5-1m': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 200_000,
  'claude-opus-4-8-1m': 1_000_000,
  'claude-opus-4-7': 200_000,
  'claude-opus-4-7-1m': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-opus-4-6': 200_000,
  default: 200_000,
  sonnet: 200_000,
  opus: 200_000,
  haiku: 200_000,
  // Kimi
  'kimi-k3': 256_000,
  'kimi-k2.7-code': 256_000,
  'kimi-k2.6': 256_000,
  // Grok
  'grok-composer-2.5-fast': 200_000,
  'grok-4.5': 500_000,
  'grok-4.5-latest': 500_000,
  'grok-build-latest': 500_000,
  'grok-build': 500_000,
  'grok-build-0.1': 500_000,
  'grok-4.3': 1_000_000,
  // Cursor
  'composer-2.5': 200_000,
  'composer-2.5-fast': 200_000,
  'cursor-grok-4.5': 500_000,
  'grok-4.5-medium': 500_000,
  'grok-4.5-fast-medium': 500_000,
  'grok-4.5-high': 500_000,
  'grok-4.5-fast-high': 500_000,
  'grok-4.5-xhigh': 500_000,
  'grok-4.5-fast-xhigh': 500_000,
  // Ollama local defaults. qwen3:4b advertises a large context in Ollama
  // metadata, but use a conservative UI fallback when no live limit is known.
  'qwen3:4b-instruct': 262_144,
  'qwen3.5:9b': 262_144,
  'qwen3.6:35b': 262_144,
  'qwen3.6:35b-a3b': 262_144,
  'gemma4:12b': 262_144,
  'gemma4:12b-it-qat': 262_144,
  'gemma4:12b-it-q4_k_m': 262_144,
  'gemma4:12b-it-q8_0': 262_144,
  'gemma4:12b-it-bf16': 262_144,
  ornith: 262_144,
  'ornith:latest': 262_144,
  'ornith:9b': 262_144,
  'ornith:35b': 262_144,
  'laguna-xs-2.1:q8_0': 262_144,
  'gpt-oss': 131_072,
  'gpt-oss:20b': 131_072,
  'gpt-oss:latest': 131_072,
  'openai/gpt-oss-20b': 131_072,
  'lfm2.5': 131_072,
  'lfm2.5:8b': 131_072,
  'lfm2.5:latest': 131_072,
  'minicpm-v4.5:8b': 40_960,
  'granite4.1:3b': 131_072,
  'granite4.1:30b': 131_072,
  'nemotron3:33b': 131_072
}

const PROVIDER_FALLBACK_WINDOW: Record<ContextWindowProviderId, number> = {
  gemini: 1_048_576,
  codex: 1_050_000,
  claude: 200_000,
  kimi: 256_000,
  grok: 500_000,
  cursor: 200_000,
  // Ollama - local models vary by tag, so keep the fallback conservative.
  ollama: 262_144,
  // Antigravity's gemini-api lane runs Gemini wire models (1M family window).
  // Pre-fix this fell through to the generic 200k floor, so the meter showed a
  // ~5x-inflated percent for antigravity chats.
  antigravity: 1_048_576,
  // Pi's default model (DeepSeek V4) carries a 1M window; per-model entries
  // below cover the smaller GLM/Mistral/Groq rows so this floor rarely fires.
  pi: 1_000_000
}

const CONTEXT_WINDOW_PROVIDER_IDS: ReadonlySet<string> = new Set(
  Object.keys(PROVIDER_FALLBACK_WINDOW)
)

/** True for providers that have a static context-window fallback. Providers
 *  without a known window are excluded; callers should pass `undefined` for
 *  them. */
export function isContextWindowProviderId(
  provider: string | null | undefined
): provider is ContextWindowProviderId {
  return provider != null && CONTEXT_WINDOW_PROVIDER_IDS.has(provider)
}

export function resolveContextWindow(
  provider: ContextWindowProviderId | undefined,
  modelId: string | undefined,
  statsTotalTokenLimit?: number,
  liveModelContextLength?: number
): number {
  if (
    typeof statsTotalTokenLimit === 'number' &&
    Number.isFinite(statsTotalTokenLimit) &&
    statsTotalTokenLimit > 0
  ) {
    return statsTotalTokenLimit
  }
  if (
    provider === 'ollama' &&
    typeof liveModelContextLength === 'number' &&
    Number.isFinite(liveModelContextLength) &&
    liveModelContextLength > 0
  ) {
    return liveModelContextLength
  }
  if (modelId && CONTEXT_WINDOWS_BY_MODEL[modelId]) {
    return CONTEXT_WINDOWS_BY_MODEL[modelId]
  }
  if (provider) {
    return PROVIDER_FALLBACK_WINDOW[provider]
  }
  return 200_000
}

export function contextPercent(used: number, window: number): number {
  if (!(window > 0)) return 0
  return Math.min(100, Math.max(0, (used / window) * 100))
}

export function formatContextTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}
