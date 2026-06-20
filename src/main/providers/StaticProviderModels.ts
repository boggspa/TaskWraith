import type { ProviderId } from '../store/types'

// Codex models the provider has announced for SOFT retirement, keyed by
// canonical model id. Surfaced to the renderer as `retiresAt` (ISO yyyy-mm-dd)
// so the composer model picker can render a retirement pill — the model is
// still selectable/runnable until the date passes. THIS is the single source
// of truth and it is applied in TWO places:
//   1. the static fallback list below, and
//   2. the live `model/list` normalize step in the `get-agent-models` handler.
// Both are required: on the normal path the renderer's `codexModels` is built
// from the CLI's `model/list` response (see `get-agent-models`), which copies
// only an explicit allow-list of fields — so a literal on the fallback list
// alone never reaches the renderer when the CLI is reachable. That gap is
// exactly what hid the retirement pill on the live dev build.
//
// NOTE: this is distinct from CODEX_RETIRED_MODEL_IDS below (HARD retirement).
// A soft-retired model still works; a hard-retired one is filtered out of the
// picker entirely because the API now rejects requests for it.
export const CODEX_MODEL_RETIREMENTS: Record<string, string> = {}

// Codex models that are HARD-retired: the upstream API no longer accepts
// requests for these ids, so they must never appear in the model/reasoning
// picker (selecting one would only produce a failed run). This is applied in
// the live `get-agent-models` handler (the normal path — the CLI's
// `model/list` can still return retired ids until it's updated) AND to the
// CODEX_STATIC_MODELS fallback below, so a retired id can't slip through on
// either path. Unlike CODEX_MODEL_RETIREMENTS (soft, date-driven pill) these
// are removed outright. Historical lookups (display name, context window,
// billing rates) intentionally keep their entries so past runs still render.
export const CODEX_RETIRED_MODEL_IDS: ReadonlySet<string> = new Set([
  'gpt-5.2',
  'gpt-5.3-codex'
])

// Fallback model list — used ONLY when the live Codex CLI `model/list` query
// fails or returns nothing (see `get-agent-models`). On the normal path the
// renderer's `codexModels` comes from the CLI-derived `normalized` list, not
// from here. Retirement metadata is sourced from CODEX_MODEL_RETIREMENTS so
// the fallback and live paths can never drift.
export const CODEX_STATIC_MODELS = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'Default Codex model',
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ],
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ],
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ],
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',
    description: 'Research preview where available',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
    defaultReasoningEffort: 'low'
  }
  // gpt-5.2 and gpt-5.3-codex are HARD-retired (see CODEX_RETIRED_MODEL_IDS)
  // and intentionally omitted here.
]
const CLAUDE_THINKING_EFFORTS = [
  { reasoningEffort: 'off' },
  { reasoningEffort: 'low' },
  { reasoningEffort: 'medium' },
  { reasoningEffort: 'high' }
]
export const CLAUDE_THINKING_BUDGET: Record<string, number> = { low: 2048, medium: 8000, high: 16000 }
const CLAUDE_TEMPORARILY_UNAVAILABLE_MODEL_IDS = new Set([
  'fable',
  'claude-fable-5',
  'claude-fable-5-1m'
])
// NOTE: keep in sync with the renderer's CLAUDE_DEFAULT_MODELS (App.tsx).
// This list is served to the renderer via `getAgentModels('claude')` and
// becomes `agentModelsByProvider.claude`, which OVERRIDES the renderer's own
// fallback list — so a stale entry here is what the composer/welcome picker
// actually shows. `additionalSpeedTiers` must be carried through so the
// renderer knows which models offer the paid Fast tier.
const CLAUDE_STATIC_MODELS = [
  {
    id: 'default',
    label: 'Default',
    description: 'Claude Code configured default',
    isDefault: true,
    supportedReasoningEfforts: CLAUDE_THINKING_EFFORTS
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    description: 'Most capable Opus — extended thinking',
    supportedReasoningEfforts: CLAUDE_THINKING_EFFORTS,
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'claude-opus-4-8-1m',
    label: 'Claude Opus 4.8 1M',
    description: '1M context window — extended thinking',
    supportedReasoningEfforts: CLAUDE_THINKING_EFFORTS
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    description: 'Balanced — extended thinking',
    supportedReasoningEfforts: CLAUDE_THINKING_EFFORTS
  },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'Fast & efficient' },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7 Legacy',
    description: 'Previous Opus — extended thinking',
    supportedReasoningEfforts: CLAUDE_THINKING_EFFORTS,
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'claude-opus-4-7-1m',
    label: 'Claude Opus 4.7 1M Legacy',
    description: '1M context window — extended thinking',
    supportedReasoningEfforts: CLAUDE_THINKING_EFFORTS
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6 Legacy',
    description: 'Previous Opus generation',
    supportedReasoningEfforts: CLAUDE_THINKING_EFFORTS,
    additionalSpeedTiers: ['fast']
  },
  { id: 'custom', label: 'Custom model ID' }
]
const KIMI_STATIC_MODELS = [
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    description: 'Kimi Code CLI configured default model',
    isDefault: true
  }
]
const OLLAMA_STATIC_MODELS = [
  {
    id: 'qwen3:4b-instruct',
    label: 'Qwen 3 (4B Param)',
    description: 'Local Ollama model · 262k context',
    isDefault: true
  },
  {
    id: 'qwen3.5:9b',
    label: 'Qwen 3.5 (9B Param)',
    description: 'Qwen 3.5 9B via Ollama · 262k context'
  },
  {
    id: 'qwen3.6:35b',
    label: 'Qwen 3.6 (35B-A3B)',
    description: 'Qwen 3.6 35B-A3B via Ollama · 262k context · vision/tools/thinking'
  },
  {
    id: 'gemma4:12b',
    label: 'Gemma 4 (12B Param)',
    description: 'Google Gemma 4 12B via Ollama · 262k context'
  },
  {
    id: 'gpt-oss:20b',
    label: 'GPT OSS (20B Param)',
    description: 'OpenAI gpt-oss 20B via Ollama · 131k context'
  },
  {
    id: 'minicpm-v4.5:8b',
    label: 'MiniCPM-V 4.5 (8B Param)',
    description: 'MiniCPM-V 4.5 8B via Ollama · 40k context · vision/tools/thinking'
  },
  {
    id: 'granite4.1:3b',
    label: 'Granite 4.1 (3B Param)',
    description: 'IBM Granite 4.1 3B via Ollama · 131k context · tools'
  },
  {
    id: 'granite4.1:30b',
    label: 'Granite 4.1 (30B Param)',
    description: 'IBM Granite 4.1 30B via Ollama · 131k context · tools'
  },
  {
    id: 'nemotron3:33b',
    label: 'Nemotron 3 Nano Omni (33B Param)',
    description: 'NVIDIA Nemotron 3 Nano Omni 33B via Ollama · 131k context · vision/tools/thinking'
  },
  { id: 'custom', label: 'Custom model ID' }
]
const GEMINI_STATIC_MODELS = [
  { id: 'cli-default', label: 'CLI Default', isDefault: true },
  { id: 'auto', label: 'Auto' },
  { id: 'pro', label: 'Pro' },
  { id: 'flash', label: 'Flash' },
  { id: 'flash-lite', label: 'Flash Lite' }
]
const GROK_DEFAULT_MODEL = 'grok-composer-2.5-fast'
const GROK_STATIC_MODELS = [
  { id: GROK_DEFAULT_MODEL, label: 'Grok Composer 2.5 Fast', isDefault: true },
  { id: 'grok-build', label: 'Grok Build 0.1' }
]
const CURSOR_STATIC_MODELS = [
  { id: 'composer-2.5-fast', label: 'Composer 2.5 Fast', isDefault: true },
  { id: 'composer-2.5', label: 'Composer 2.5' }
]
const KIMI_DEFAULT_MODEL = 'kimi-k2.7-code'
const KIMI_CLI_MODEL_IDS = new Set(KIMI_STATIC_MODELS.map((model) => model.id))
const KIMI_CLI_MODEL_ALIASES = new Map<string, string>([
  ['default', KIMI_DEFAULT_MODEL],
  ['cli-default', KIMI_DEFAULT_MODEL],
  ['custom', KIMI_DEFAULT_MODEL],
  ['best', KIMI_DEFAULT_MODEL],
  ['kimi-latest', KIMI_DEFAULT_MODEL],
  ['kimi-code', KIMI_DEFAULT_MODEL],
  ['kimi-k2.7', KIMI_DEFAULT_MODEL],
  ['kimi-k2.7-code', KIMI_DEFAULT_MODEL],
  ['kimi-k2.7-code-thinking', KIMI_DEFAULT_MODEL],
  ['kimi-k2.7-thinking', KIMI_DEFAULT_MODEL],
  ['kimi-k2.6', KIMI_DEFAULT_MODEL],
  ['kimi-k2.6-thinking', KIMI_DEFAULT_MODEL],
  ['kimi-k2', KIMI_DEFAULT_MODEL],
  ['kimi-k2-1t', KIMI_DEFAULT_MODEL],
  ['kimi-thinking-preview', KIMI_DEFAULT_MODEL],
  ['kimi-k2.5', KIMI_DEFAULT_MODEL],
  ['kimi-k2-thinking-turbo', KIMI_DEFAULT_MODEL],
  ['kimi-k2-thinking', KIMI_DEFAULT_MODEL],
  ['kimi-k2-turbo-preview', KIMI_DEFAULT_MODEL],
  ['kimi-k2-0905-preview', KIMI_DEFAULT_MODEL],
  ['kimi-k2-0711-preview', KIMI_DEFAULT_MODEL],
  ['kimi-k2-0905', KIMI_DEFAULT_MODEL],
  ['kimi-k2-0711', KIMI_DEFAULT_MODEL],
  ['kimi-k2-turbo', KIMI_DEFAULT_MODEL]
])

export function getStaticProviderModels(provider: ProviderId) {
  if (provider === 'claude') return CLAUDE_STATIC_MODELS
  if (provider === 'kimi') return KIMI_STATIC_MODELS
  if (provider === 'ollama') return OLLAMA_STATIC_MODELS
  if (provider === 'gemini') return GEMINI_STATIC_MODELS
  if (provider === 'grok') return GROK_STATIC_MODELS
  if (provider === 'cursor') return CURSOR_STATIC_MODELS
  return GEMINI_STATIC_MODELS
}

export function normalizeCliProviderModel(provider: ProviderId, model?: string | null): string {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  const lowered = trimmed.toLowerCase()
  if (provider === 'kimi') {
    if (!lowered) return KIMI_DEFAULT_MODEL
    const alias = KIMI_CLI_MODEL_ALIASES.get(lowered)
    if (alias) return alias
    if (KIMI_CLI_MODEL_IDS.has(lowered)) return lowered
    return KIMI_DEFAULT_MODEL
  }
  if (provider === 'ollama') {
    if (!trimmed || trimmed === 'cli-default' || trimmed === 'auto' || trimmed === 'default') {
      return OLLAMA_STATIC_MODELS[0].id
    }
    return trimmed
  }
  if (provider === 'grok') {
    if (!trimmed || lowered === 'cli-default' || lowered === 'default') return GROK_DEFAULT_MODEL
    if (lowered.startsWith('grok')) return trimmed
    return GROK_DEFAULT_MODEL
  }
  if (provider === 'cursor') {
    if (!trimmed || lowered === 'cli-default' || lowered === 'default') return 'composer-2.5-fast'
    if (trimmed.startsWith('composer-')) return trimmed
    return 'composer-2.5-fast'
  }
  if (provider === 'gemini') {
    if (!trimmed || lowered === 'cli-default' || lowered === 'default') return 'cli-default'
    return trimmed
  }
  if (!trimmed || trimmed === 'cli-default' || trimmed === 'custom' || trimmed === 'best')
    return 'default'
  if (provider === 'claude') {
    if (CLAUDE_TEMPORARILY_UNAVAILABLE_MODEL_IDS.has(lowered)) return 'default'
    if (['default', 'sonnet', 'opus', 'haiku'].includes(trimmed)) return trimmed
    if (trimmed.startsWith('claude-')) {
      // The `-1m` suffix is an TaskWraith-internal marker for the 1M-context
      // variant — it drives the context-window meter (contextWindows.ts) and
      // the rate table, but it is NOT a real Claude CLI/SDK model name. The
      // CLI only accepts the base id (e.g. `claude-opus-4-8`), so `--model
      // claude-opus-4-8-1m` fails with "model not found". Strip it here so the
      // base model is dispatched (the 1M window is entitlement-based on the
      // base model, not a distinct model id).
      return trimmed.endsWith('-1m') ? trimmed.slice(0, -'-1m'.length) : trimmed
    }
  }
  return trimmed || 'default'
}

export function appendKimiThinkingArgs(args: string[], kimiThinking?: boolean | null): void {
  args.push(kimiThinking === false ? '--no-thinking' : '--thinking')
}

function kimiCliModelArg(model: string): string | null {
  const normalized = model.trim().toLowerCase()
  if (!normalized || normalized === 'default' || normalized === KIMI_DEFAULT_MODEL) return null
  return model
}

export function appendKimiModelArgs(args: string[], model: string): void {
  const cliModel = kimiCliModelArg(model)
  if (cliModel) args.push('--model', cliModel)
}

export function claudePermissionModeForApproval(approvalMode?: string): string {
  if (approvalMode === 'plan') return 'plan'
  return 'acceptEdits'
}

export function normalizeCodexModel(model?: string | null): string {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  if (
    !trimmed ||
    ['cli-default', 'auto', 'pro', 'flash', 'flash-lite', 'custom'].includes(trimmed)
  ) {
    return CODEX_STATIC_MODELS[0].id
  }
  return trimmed
}
