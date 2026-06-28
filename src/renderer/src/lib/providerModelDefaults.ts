interface CodexModelOption {
  id: string
  label?: string
  description?: string
  isDefault?: boolean
  disabled?: boolean
  disabledReason?: string
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string
    description?: string
    disabled?: boolean
    disabledReason?: string
  }>
  defaultReasoningEffort?: string | null
  additionalSpeedTiers?: string[]
  /** 1.0.7-mini — ISO date (YYYY-MM-DD) when this model is retired by the
   * provider. When set, the model picker renders a small clock + ordinal-
   * date pill on the row (red, !important-styled so theme/shell rules can't
   * override the warning colour). Pre-1.0.7 this was baked into `label` as
   * "(retiring Jun 2)" which (a) flashed on first paint then resolved away
   * via `modelDisplayName.ts` and (b) wasn't machine-readable. Drop this
   * field once the model is actually removed from the list. */
  retiresAt?: string
}

const CODEX_DEFAULT_MODELS = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ],
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ],
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
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
    // No Fast tier — per product spec only 5.5 + 5.4 retain Fast.
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
    defaultReasoningEffort: 'low'
    // Fast tier removed alongside 5.3 — see note above.
  }
  // gpt-5.2 and gpt-5.3-codex were HARD-retired (the API rejects requests for
  // them) and removed from the picker. The authoritative removal lives in the
  // main process (CODEX_RETIRED_MODEL_IDS, applied in the get-agent-models
  // handler); this renderer fallback list is only shown on mount before IPC
  // resolves / on IPC failure, so it's kept in sync by deletion here.
] satisfies CodexModelOption[]
const CODEX_DEFAULT_MODEL = CODEX_DEFAULT_MODELS[0].id
const CLAUDE_REASONING_UNAVAILABLE = 'Not available for this Claude model'
const CLAUDE_FULL_REASONING_EFFORTS = [
  { reasoningEffort: 'low' },
  { reasoningEffort: 'medium' },
  { reasoningEffort: 'high' },
  { reasoningEffort: 'xhigh' },
  { reasoningEffort: 'max' },
  { reasoningEffort: 'ultracode' }
]
const claudeReasoningEfforts = (enabled: ReadonlySet<string>) =>
  CLAUDE_FULL_REASONING_EFFORTS.map((option) =>
    enabled.has(option.reasoningEffort)
      ? option
      : { ...option, disabled: true, disabledReason: CLAUDE_REASONING_UNAVAILABLE }
  )
const CLAUDE_SONNET_REASONING_EFFORTS = claudeReasoningEfforts(
  new Set(['low', 'medium', 'high', 'max'])
)
const CLAUDE_OPUS_REASONING_EFFORTS = claudeReasoningEfforts(
  new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
)
const CLAUDE_HAIKU_REASONING_EFFORTS = claudeReasoningEfforts(new Set())
const CLAUDE_THINKING_EFFORTS = CLAUDE_OPUS_REASONING_EFFORTS
const CLAUDE_DEFAULT_REASONING_EFFORT = 'medium'
const CLAUDE_TEMPORARILY_HIDDEN_MODEL_IDS = new Set([
  'fable',
  'claude-fable-5',
  'claude-fable-5-1m'
])
const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-6'
const CLAUDE_DEFAULT_MODELS = [
  {
    id: 'claude-opus-4-8-1m',
    label: 'Claude Opus 4.8 1M',
    description: '1M context window — extended thinking',
    supportedReasoningEfforts: CLAUDE_OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'claude-fable-5-1m',
    label: 'Claude Fable 5 1M',
    description: 'Temporarily unavailable from Anthropic',
    supportedReasoningEfforts: CLAUDE_OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast'],
    disabled: true,
    disabledReason: 'Temporarily unavailable from Anthropic'
  },
  {
    id: CLAUDE_DEFAULT_MODEL,
    label: 'Claude Sonnet 4.6',
    description: 'Balanced — extended thinking',
    isDefault: true,
    supportedReasoningEfforts: CLAUDE_SONNET_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    description: 'Fast & efficient',
    supportedReasoningEfforts: CLAUDE_HAIKU_REASONING_EFFORTS
  },
  {
    id: 'claude-opus-4-7-1m',
    label: 'Claude Opus 4.7 1M Legacy',
    description: '1M context window — extended thinking',
    supportedReasoningEfforts: CLAUDE_OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  }
] satisfies CodexModelOption[]
const KIMI_DEFAULT_MODELS = [
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    description: 'Kimi Code CLI model',
    isDefault: true
  }
] satisfies CodexModelOption[]
const KIMI_DEFAULT_MODEL = KIMI_DEFAULT_MODELS[0].id
// Single source of truth for Gemini's composer model list. Mirrors the
// claude/kimi constants above so `getProviderModelOptions` returns the
// same `CodexModelOption[]` shape for every provider and the composer's
// `<option>` rendering no longer needs a Gemini-only inline branch.
const GEMINI_DEFAULT_MODELS = [
  { id: 'auto', label: 'Auto' },
  { id: 'pro', label: 'Pro' },
  { id: 'flash', label: 'Flash' },
  { id: 'flash-lite', label: 'Flash Lite', isDefault: true }
] satisfies CodexModelOption[]
const GEMINI_DEFAULT_MODEL = 'flash-lite'
// Grok — keep Grok Build CLI ids provider-native. Build 0.1 is TaskWraith's
// concrete default; Composer 2.5 Fast remains selectable for users who want it.
// Cursor's `composer-2.5-fast` remains a separate provider route.
const GROK_DEFAULT_MODEL = 'grok-build'
const GROK_DEFAULT_MODELS = [
  { id: GROK_DEFAULT_MODEL, label: 'Grok Build 0.1', isDefault: true },
  { id: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' }
] satisfies CodexModelOption[]
// Cursor (Composer 2.5). Two selectable variants = the model + its Fast mode
// (the Fast toggle modelled as a second model id, like Cursor's own picker).
// composer-2.5-fast is Cursor's default; composer-2.5 is the slower/normal tier.
const CURSOR_DEFAULT_MODELS = [
  { id: 'composer-2.5-fast', label: 'Composer 2.5 Fast', isDefault: true },
  { id: 'composer-2.5', label: 'Composer 2.5' }
] satisfies CodexModelOption[]
const OLLAMA_DEFAULT_MODELS = [
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
    id: 'ornith:9b',
    label: 'Ornith 1.0 (9B Param)',
    description: 'Ornith 1.0 9B via Ollama · 262k context · agentic coding'
  },
  {
    id: 'ornith:35b',
    label: 'Ornith 1.0 (35B Param)',
    description: 'Ornith 1.0 35B via Ollama · 262k context · agentic coding'
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
] satisfies CodexModelOption[]
const OLLAMA_DEFAULT_MODEL = OLLAMA_DEFAULT_MODELS[0].id
const GEMINI_MODEL_IDS = new Set(['auto', 'pro', 'flash', 'flash-lite', 'custom'])
const CLAUDE_MODEL_IDS = new Set([
  'sonnet',
  'opus',
  'haiku',
  'custom',
  'claude-opus-4-8-1m',
  'claude-fable-5-1m',
  'claude-opus-4-7-1m',
  'claude-sonnet-4-6',
  'claude-haiku-4-5'
])
const KIMI_MODEL_IDS = new Set(KIMI_DEFAULT_MODELS.map((model) => model.id))
const OLLAMA_MODEL_IDS = new Set(OLLAMA_DEFAULT_MODELS.map((model) => model.id))
const isGeminiModelId = (modelId: string): boolean => GEMINI_MODEL_IDS.has(modelId)
const isCodexModelId = (modelId: string): boolean =>
  modelId.startsWith('gpt-') || modelId.includes('codex')
const isClaudeModelId = (modelId: string): boolean =>
  !CLAUDE_TEMPORARILY_HIDDEN_MODEL_IDS.has(normalizeProviderModelKey(modelId)) &&
  (CLAUDE_MODEL_IDS.has(modelId) || modelId.includes('claude'))
const isKimiModelId = (modelId: string): boolean => KIMI_MODEL_IDS.has(modelId)
const isOllamaModelId = (modelId: string): boolean =>
  OLLAMA_MODEL_IDS.has(modelId) || modelId.includes(':')
const normalizeProviderModelKey = (model?: string | null): string =>
  String(model || '')
    .trim()
    .toLowerCase()

const resolveClaudeReasoningEfforts = (
  model?: CodexModelOption | null
): NonNullable<CodexModelOption['supportedReasoningEfforts']> =>
  model ? (model.supportedReasoningEfforts ?? []) : CLAUDE_THINKING_EFFORTS

const resolveClaudeDefaultReasoningEffort = (model?: CodexModelOption | null): string => {
  const efforts = resolveClaudeReasoningEfforts(model)
    .filter((option) => !option.disabled)
    .map((option) => option.reasoningEffort)
  if (efforts.length === 0) return ''
  if (model?.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort
  }
  if (efforts.includes(CLAUDE_DEFAULT_REASONING_EFFORT)) return CLAUDE_DEFAULT_REASONING_EFFORT
  return efforts[0]
}

export type { CodexModelOption }
export {
  CODEX_DEFAULT_MODELS,
  CODEX_DEFAULT_MODEL,
  CLAUDE_THINKING_EFFORTS,
  CLAUDE_DEFAULT_REASONING_EFFORT,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_DEFAULT_MODELS,
  KIMI_DEFAULT_MODELS,
  KIMI_DEFAULT_MODEL,
  GEMINI_DEFAULT_MODELS,
  GEMINI_DEFAULT_MODEL,
  GROK_DEFAULT_MODEL,
  GROK_DEFAULT_MODELS,
  CURSOR_DEFAULT_MODELS,
  OLLAMA_DEFAULT_MODELS,
  OLLAMA_DEFAULT_MODEL,
  GEMINI_MODEL_IDS,
  CLAUDE_MODEL_IDS,
  KIMI_MODEL_IDS,
  OLLAMA_MODEL_IDS,
  isGeminiModelId,
  isCodexModelId,
  isClaudeModelId,
  isKimiModelId,
  isOllamaModelId,
  normalizeProviderModelKey,
  resolveClaudeDefaultReasoningEffort,
  resolveClaudeReasoningEfforts
}
