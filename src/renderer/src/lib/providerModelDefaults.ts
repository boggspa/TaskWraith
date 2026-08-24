import { isPreviewModelPlaceholder } from '../../../shared/previewModelCatalog'
import { activeCodexModelRows } from '../../../shared/codexModelLifecycle'
import type { ProviderId } from '../../../main/store/types'
import {
  CURSOR_GROK_45_BASE_MODEL_ID,
  CURSOR_GROK_46_BASE_MODEL_ID,
  GROK_45_DEFAULT_REASONING_EFFORT,
  GROK_45_MODEL_ID,
  GROK_45_REASONING_EFFORTS,
  GROK_46_DEFAULT_REASONING_EFFORT,
  GROK_46_MODEL_ID,
  GROK_46_REASONING_EFFORTS
} from '../../../shared/grok45Models'

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
  /** Ollama `/api/show` capability names retained for model-aware controls. */
  capabilities?: string[]
  additionalSpeedTiers?: string[]
  ultraTaskSupported?: boolean
  /** 1.0.7-mini — ISO date (YYYY-MM-DD) when this model is retired by the
   * provider. When set, the model picker renders a small clock + ordinal-
   * date pill on the row (red, !important-styled so theme/shell rules can't
   * override the warning colour). Pre-1.0.7 this was baked into `label` as
   * "(retiring Jun 2)" which (a) flashed on first paint then resolved away
   * via `modelDisplayName.ts` and (b) wasn't machine-readable. Drop this
   * field once the model is actually removed from the list. */
  retiresAt?: string
}

/** Curated fallback rows are executable UltraTask candidates unless an exact
 * row opts out. Custom ids stay unclassified until live discovery proves
 * them; an explicit false (currently Claude Haiku) always wins. */
function withCuratedUltraTaskSupport<T extends CodexModelOption>(
  models: readonly T[]
): Array<T & { ultraTaskSupported?: boolean }> {
  return models.map((model) =>
    model.id === 'custom' ? { ...model } : { ultraTaskSupported: true, ...model }
  )
}

const CODEX_DEFAULT_MODEL_ROWS = activeCodexModelRows([
  // GPT-5.6 trio leads the picker (above 5.5); 5.5 below stays the default.
  // GA rows with OFFICIAL metadata (2026-07-09, upstream Codex catalog +
  // developers.openai.com): hyphenated display names, Sol defaults to LOW,
  // `max` on all three, top `ultra` tier (internal token 'ultracode') on
  // Sol + Terra only. This is the pre-IPC fallback list — the authoritative
  // rows come from the main process (CODEX_STATIC_MODELS + live model/list).
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' },
      { reasoningEffort: 'max' },
      { reasoningEffort: 'ultracode' }
    ],
    defaultReasoningEffort: 'low',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6-Terra',
    description: 'Balanced agentic coding model for everyday work.',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' },
      { reasoningEffort: 'max' },
      { reasoningEffort: 'ultracode' }
    ],
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6-Luna',
    description: 'Fast and affordable agentic coding model.',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' },
      { reasoningEffort: 'max' }
    ],
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
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
      { reasoningEffort: 'low' },
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
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ],
    defaultReasoningEffort: 'low'
    // Fast tier removed alongside 5.3 — see note above.
  }
  // gpt-5.2 and gpt-5.3-codex were HARD-retired (the API rejects requests for
  // them) and removed from the picker. The shared lifecycle policy filters this
  // renderer fallback as well as the main-process catalog; this list is only
  // shown on mount before IPC resolves / on IPC failure.
] satisfies CodexModelOption[])
const CODEX_DEFAULT_MODELS = withCuratedUltraTaskSupport(CODEX_DEFAULT_MODEL_ROWS)
// The 5.6 trio now leads CODEX_DEFAULT_MODELS, so the default can't be [0] any
// more — pin it to GPT-5.5 (falling back to the first row only if 5.5 is gone).
const CODEX_DEFAULT_MODEL =
  CODEX_DEFAULT_MODELS.find((model) => model.id === 'gpt-5.5')?.id ?? CODEX_DEFAULT_MODELS[0].id
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
const CLAUDE_OPUS_REASONING_EFFORTS = claudeReasoningEfforts(
  new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
)
const CLAUDE_SONNET_REASONING_EFFORTS = claudeReasoningEfforts(
  new Set(['low', 'medium', 'high', 'max'])
)
const CLAUDE_HAIKU_REASONING_EFFORTS = claudeReasoningEfforts(new Set())
const CLAUDE_THINKING_EFFORTS = CLAUDE_OPUS_REASONING_EFFORTS
const CLAUDE_DEFAULT_REASONING_EFFORT = 'medium'
const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5'
// Labels omit the "Claude " prefix (provider header/chip already carries it —
// see StaticProviderModels.ts); Legacy cluster sits below the current models.
const CLAUDE_DEFAULT_MODEL_ROWS = [
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    description: '1M context window — adaptive thinking',
    supportedReasoningEfforts: CLAUDE_OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    description: '1M context window — adaptive thinking',
    supportedReasoningEfforts: CLAUDE_OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium'
  },
  {
    id: CLAUDE_DEFAULT_MODEL,
    label: 'Sonnet 5',
    description: '1M context window — extended thinking',
    isDefault: true,
    supportedReasoningEfforts: CLAUDE_OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6 Legacy',
    description: '200K context window — legacy Sonnet',
    supportedReasoningEfforts: CLAUDE_SONNET_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'claude-opus-4-8-1m',
    label: 'Opus 4.8 1M Legacy',
    description: '1M context window — extended thinking',
    supportedReasoningEfforts: CLAUDE_OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'claude-opus-4-7-1m',
    label: 'Opus 4.7 1M Legacy',
    description: '1M context window — extended thinking',
    supportedReasoningEfforts: CLAUDE_OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    description: 'Fast & efficient',
    supportedReasoningEfforts: CLAUDE_HAIKU_REASONING_EFFORTS,
    ultraTaskSupported: false
  }
] satisfies CodexModelOption[]
const CLAUDE_DEFAULT_MODELS = withCuratedUltraTaskSupport(CLAUDE_DEFAULT_MODEL_ROWS)
const KIMI_DEFAULT_MODEL_ROWS = [
  {
    id: 'kimi-k2.7-code',
    label: 'K2.7 Coding',
    description: 'Standard and Highspeed tiers with always-on thinking',
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'on' }],
    defaultReasoningEffort: 'on',
    additionalSpeedTiers: ['fast']
  },
  {
    // Managed `kimi-code/k3` alias: 256K on Moderato and up to 1M on
    // Allegretto+, with Low/High/Max effort choices. No Highspeed tier — Fast
    // stays a K2.7 Coding capability — and K2.7 Coding remains the default.
    id: 'kimi-k3',
    label: 'K3',
    description:
      "Moonshot's flagship K3 - 256K on Moderato, up to 1M on Allegretto+ - Low, High, or Max thinking",
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'max' }
    ],
    defaultReasoningEffort: 'max'
  }
] satisfies CodexModelOption[]
const KIMI_DEFAULT_MODELS = withCuratedUltraTaskSupport(KIMI_DEFAULT_MODEL_ROWS)
const KIMI_DEFAULT_MODEL = KIMI_DEFAULT_MODELS[0].id
// Single source of truth for Gemini's composer model list. Mirrors the
// claude/kimi constants above so `getProviderModelOptions` returns the
// same `CodexModelOption[]` shape for every provider and the composer's
// `<option>` rendering no longer needs a Gemini-only inline branch.
const GEMINI_DEFAULT_MODEL_ROWS = [
  { id: 'auto', label: 'Auto' },
  { id: 'pro', label: 'Pro' },
  { id: 'flash', label: 'Flash' },
  { id: 'flash-lite', label: 'Flash Lite', isDefault: true }
] satisfies CodexModelOption[]
const GEMINI_DEFAULT_MODELS = withCuratedUltraTaskSupport(GEMINI_DEFAULT_MODEL_ROWS)
const GEMINI_DEFAULT_MODEL = 'flash-lite'
// Grok - the live Grok Build CLI now defaults to Grok 4.6. Grok 4.5 and
// Composer 2.5 Fast remain selectable for historical/specialized runs.
const GROK_DEFAULT_MODEL = GROK_46_MODEL_ID
const GROK_DEFAULT_MODEL_ROWS = [
  {
    id: GROK_DEFAULT_MODEL,
    // Direct Grok CLI models run permanently in Fast mode, so the label
    // distinguishes them from Cursor's separately toggled resale rows.
    label: 'Grok 4.6 Fast',
    description: '500K context - low/medium/high/extra-high reasoning',
    isDefault: true,
    supportedReasoningEfforts: [...GROK_46_REASONING_EFFORTS],
    defaultReasoningEffort: GROK_46_DEFAULT_REASONING_EFFORT
  },
  {
    id: GROK_45_MODEL_ID,
    label: 'Grok 4.5 Fast',
    description: '500K context - low/medium/high reasoning',
    supportedReasoningEfforts: [...GROK_45_REASONING_EFFORTS],
    defaultReasoningEffort: GROK_45_DEFAULT_REASONING_EFFORT
  },
  { id: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' }
] satisfies CodexModelOption[]
const GROK_DEFAULT_MODELS = withCuratedUltraTaskSupport(GROK_DEFAULT_MODEL_ROWS)
// Mistral Vibe seat catalog. BARE ids only — a `mistral/<model>` id belongs to
// Pi's BYOK upstream, a DIFFERENT provider that shares the brand word, and is
// served through the `pi` group in this same picker.
//
// devstral-small leads and is the default: graded head-to-head it was ~26x
// cheaper and more accurate on lane work. Note the two are NOT equivalent —
// only mistral-medium-3.5 has thinking + vision; the seat's provider-level
// `imageAttachments` is false because the default model has none.
const MISTRAL_DEFAULT_MODEL = 'devstral-small'
const MISTRAL_DEFAULT_MODEL_ROWS = [
  {
    id: MISTRAL_DEFAULT_MODEL,
    label: 'Devstral Small',
    description: '256K context - coding-tuned',
    isDefault: true
  },
  {
    id: 'mistral-medium-3.5',
    label: 'Mistral Medium 3.5',
    description: '256K context - flagship'
  },
  {
    id: 'mistral-large-2512',
    label: 'Mistral Large 3',
    description: '262K context - flagship'
  },
  {
    id: 'zai-glm-5-2',
    label: 'GLM-5.2 (via Mistral)',
    description: '1M context - coding model'
  },
  {
    id: 'codestral-2508',
    label: 'Codestral (Aug 2025)',
    description: '131K context - coding-tuned'
  },
  {
    id: 'mistral-small-2603',
    label: 'Mistral Small 4',
    description: '256K context - reasoning'
  },
  {
    id: 'devstral-2512',
    label: 'Devstral 2',
    description: '262K context'
  },
  {
    id: 'labs-leanstral-1-5',
    label: 'Leanstral 1.5 (Labs)',
    description: '262K context - free research tier'
  },
  {
    id: 'mistral-medium-latest',
    label: 'Mistral Medium (Latest)',
    description: '262K context - flagship'
  },
  {
    id: 'mistral-medium-2508',
    label: 'Mistral Medium 3.1',
    description: '262K context'
  },
  {
    id: 'mistral-medium-2505',
    label: 'Mistral Medium 3',
    description: '131K context'
  },
  {
    id: 'ministral-14b-2512',
    label: 'Ministral 3 (14B)',
    description: '262K context'
  },
  {
    id: 'ministral-8b-2512',
    label: 'Ministral 3 (8B)',
    description: '262K context'
  },
  {
    id: 'ministral-3b-2512',
    label: 'Ministral 3 (3B)',
    description: '262K context'
  }
] satisfies CodexModelOption[]
const MISTRAL_DEFAULT_MODELS = withCuratedUltraTaskSupport(MISTRAL_DEFAULT_MODEL_ROWS)
// Muse Code CLI seat catalog (opaque exec). Decode-ready; not live-selectable yet.
const MUSE_DEFAULT_MODEL = 'muse-spark-1.2'
const MUSE_DEFAULT_MODEL_ROWS = [
  {
    id: MUSE_DEFAULT_MODEL,
    label: 'Muse Spark 1.2',
    description: 'Muse Code CLI default model',
    isDefault: true
  }
] satisfies CodexModelOption[]
const MUSE_DEFAULT_MODELS = withCuratedUltraTaskSupport(MUSE_DEFAULT_MODEL_ROWS)
// Cursor model catalog — backs live Path-B Cursor selection and decodes
// stored historical selections.
const CURSOR_DEFAULT_MODEL = 'composer-2.5-fast'
const CURSOR_DEFAULT_MODEL_ROWS = [
  { id: CURSOR_DEFAULT_MODEL, label: 'Composer 2.5 Fast', isDefault: true },
  { id: 'composer-2.5', label: 'Composer 2.5' },
  {
    id: CURSOR_GROK_46_BASE_MODEL_ID,
    label: 'Cursor Grok 4.6',
    description: 'First-party Cursor model pool - 256K context',
    supportedReasoningEfforts: [...GROK_46_REASONING_EFFORTS],
    defaultReasoningEffort: GROK_46_DEFAULT_REASONING_EFFORT,
    additionalSpeedTiers: ['fast']
  },
  {
    id: CURSOR_GROK_45_BASE_MODEL_ID,
    label: 'Cursor Grok 4.5',
    description: 'First-party Cursor model pool - 500K context',
    supportedReasoningEfforts: [...GROK_45_REASONING_EFFORTS],
    defaultReasoningEffort: GROK_45_DEFAULT_REASONING_EFFORT,
    additionalSpeedTiers: ['fast']
  }
] satisfies CodexModelOption[]
const CURSOR_DEFAULT_MODELS = withCuratedUltraTaskSupport(CURSOR_DEFAULT_MODEL_ROWS)
const OLLAMA_DEFAULT_MODEL_ROWS = [
  {
    id: 'qwen3:4b-instruct',
    label: 'Qwen 3 (4B Param)',
    description: 'Local Ollama model · 262k context',
    isDefault: true
  },
  {
    id: 'qwen3.5:2b',
    label: 'Qwen 3.5 (2B Param)',
    description: 'Qwen 3.5 2B via Ollama · 262k context · vision/tools/thinking'
  },
  {
    id: 'qwen3.5:4b',
    label: 'Qwen 3.5 (4B Param)',
    description: 'Qwen 3.5 4B via Ollama · 262k context'
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
    id: 'qwen3.8:27b-mlx',
    label: 'Qwen 3.8 (27B-MLX)',
    description: 'Alibaba Qwen 3.8 27B-MLX via Ollama · 262k context · vision/tools/thinking'
  },
  {
    id: 'gemma3:4b',
    label: 'Gemma 3 (4B Param)',
    description: 'Google Gemma 3 4B via Ollama · 131k context · vision'
  },
  {
    id: 'gemma4:12b',
    label: 'Gemma 4 (12B Param)',
    description: 'Google Gemma 4 12B via Ollama · 262k context'
  },
  {
    id: 'gemma4:31b-mlx',
    label: 'Gemma 4 (31B-MLX)',
    description: 'Google Gemma 4 31B-MLX via Ollama · 262k context'
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
    id: 'ornith-1.5:9b',
    label: 'Ornith 1.5 (9B Param)',
    description: 'Ornith 1.5 9B via Ollama · 262k context · agentic coding'
  },
  {
    id: 'ornith-1.5:35b',
    label: 'Ornith 1.5 (35B Param)',
    description: 'Ornith 1.5 35B via Ollama · 262k context · agentic coding'
  },
  {
    id: 'laguna-xs-2.1:q8_0',
    label: 'Laguna XS 2.1 (33B-A3B Q8)',
    description: 'Poolside Laguna XS 2.1 33B-A3B Q8 via Ollama · 262k context · tools/thinking'
  },
  {
    id: 'gpt-oss:20b',
    label: 'GPT OSS (20B Param)',
    description: 'OpenAI gpt-oss 20B via Ollama · 131k context'
  },
  {
    id: 'lfm2.5-thinking:1.2b',
    label: 'LFM 2.5 Thinking (1.2B Param)',
    description: 'Liquid LFM2.5 Thinking 1.2B via Ollama · 128k context · tools/thinking'
  },
  {
    id: 'lfm2.5:8b',
    label: 'LFM 2.5 (8B-A1B)',
    description: 'Liquid LFM2.5 8B-A1B via Ollama · 131k context · tools/thinking'
  },
  {
    id: 'minicpm-v4.5:8b',
    label: 'MiniCPM-V 4.5 (8B Param)',
    description: 'MiniCPM-V 4.5 8B via Ollama · 40k context · vision/tools/thinking'
  },
  {
    id: 'granite4:3b',
    label: 'Granite 4.0 (3B Param)',
    description: 'IBM Granite 4.0 3B via Ollama · 131k context · tools'
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
    id: 'nemotron-3-nano:4b',
    label: 'Nemotron 3 Nano (4B Param)',
    description: 'NVIDIA Nemotron 3 Nano 4B via Ollama · 262k context · tools/thinking'
  },
  {
    id: 'nemotron3:33b',
    label: 'Nemotron 3 Nano Omni (33B Param)',
    description: 'NVIDIA Nemotron 3 Nano Omni 33B via Ollama · 131k context · vision/tools/thinking'
  },
  {
    id: 'nemotron-3.5-lightning:30b-mlx',
    label: 'Nemotron 3.5 Lightning (30B-MLX)',
    description:
      'NVIDIA Nemotron 3.5 Lightning 30B-MLX via Ollama · 262k context · tools/thinking · 3B active · always-on agents'
  },
  {
    id: 'devstral-small-2:24b',
    label: 'Devstral Small 2 (24B Param)',
    description:
      'Mistral Devstral Small 2 24B via Ollama · 393k context · vision/tools · agentic coding'
  },
  {
    id: 'ministral-3:3b',
    label: 'Ministral 3 (3B Param)',
    description: 'Mistral Ministral 3 3B via Ollama · 262k context · vision/tools'
  },
  {
    id: 'ministral-3:14b',
    label: 'Ministral 3 (14B Param)',
    description: 'Mistral Ministral 3 14B via Ollama · 262k context · vision/tools'
  },
  {
    id: 'muse-glimmer:30b-mlx',
    label: 'Muse Glimmer (30B-MLX)',
    description:
      'Meta Muse Glimmer 30B-MLX via Ollama · 131k context · vision/tools/thinking · agentic'
  },
  {
    id: 'llama3.1:8b',
    label: 'Llama 3.1 (8B Param)',
    description: 'Meta Llama 3.1 8B via Ollama · 131k context · tools'
  },
  {
    id: 'deepseek-r1:1.5b',
    label: 'DeepSeek R1 (1.5B Param)',
    description: 'DeepSeek R1 Distill Qwen 1.5B via Ollama · 131k context · tools/thinking'
  },
  {
    id: 'deepseek-r1:8b',
    label: 'DeepSeek R1 (8B Param)',
    description: 'DeepSeek R1 0528 8B via Ollama · 131k context · tools/thinking'
  },
  {
    id: 'rnj-1',
    label: 'Rnj-1 (8B Param)',
    description: 'Essential AI Rnj-1 8B via Ollama · 33k context · tools · agentic coding'
  },
  {
    id: 'glm-4.7-flash:q4_K_M',
    label: 'GLM-4.7-Flash (30B-A3B Q4)',
    description: 'Z.ai GLM-4.7-Flash 30B-A3B Q4 via Ollama · 203k context · tools/thinking'
  },
  {
    id: 'north-mini-code-1.0:q4_K_M',
    label: 'North Mini Code 1.0 (30B-A3B Q4)',
    description: 'Cohere North Mini Code 1.0 30B-A3B Q4 via Ollama · 500k context · tools/thinking'
  },
  {
    id: 'llama3.2:3b',
    label: 'Llama 3.2 (3B Param)',
    description: 'Meta Llama 3.2 3B via Ollama · 131k context · tools'
  },
  { id: 'custom', label: 'Custom model ID' }
] satisfies CodexModelOption[]
const OLLAMA_DEFAULT_MODELS = withCuratedUltraTaskSupport(OLLAMA_DEFAULT_MODEL_ROWS)
const OLLAMA_DEFAULT_MODEL = OLLAMA_DEFAULT_MODELS[0].id

// ---------------------------------------------------------------------------
// Exhaustive static-catalogue dispatch (the composer picker's model lookups).
//
// App.tsx's `getProviderModelOptions` / `getDefaultModelForProvider` are
// `if`-chains declared INSIDE the App component, and both used to end in a
// silent terminal arm — `[]` and `GEMINI_DEFAULT_MODEL` respectively. Adding a
// ProviderId to the union compiled cleanly and the new seat quietly got an
// empty picker and, far worse, A GEMINI MODEL ID ON ITS OWN RUN. Two providers
// fell in: Pi, and then Mistral one provider later, which reached a live dev
// instance past typecheck, four guards and 16k+ tests because main's catalogue
// was correct and type-level exhaustiveness stopped at this module's boundary.
// A prose warning sat directly above the arm both times.
//
// The STATIC half of both dispatchers now lives here as a pure switch whose
// `default` arm takes a `never`, so the next ProviderId added to the union
// fails `npm run typecheck` — the error lands on the `never` in whichever
// switch below is missing the case — instead of shipping a plausible wrong
// answer. The providers in DYNAMIC_CATALOGUE_PROVIDER_IDS are absent by
// design: their catalogues come from live component state (IPC-hydrated model
// lists, the Ollama merge, the AntiGravity snapshot), so they cannot be
// resolved from module scope and stay in the App closure — where the same
// `never` check still forces them to be handled before reaching here.
const DYNAMIC_CATALOGUE_PROVIDER_IDS = [
  'codex',
  'claude',
  'ollama',
  'antigravity',
  'pi'
] as const satisfies readonly ProviderId[]

/** Providers whose picker catalogue is read from live App component state. */
type DynamicCatalogueProviderId = (typeof DYNAMIC_CATALOGUE_PROVIDER_IDS)[number]
/** Providers whose catalogue is a fixed, compile-time list in this module. */
type StaticCatalogueProviderId = Exclude<ProviderId, DynamicCatalogueProviderId>

const isDynamicCatalogueProvider = (provider: ProviderId): provider is DynamicCatalogueProviderId =>
  (DYNAMIC_CATALOGUE_PROVIDER_IDS as readonly ProviderId[]).includes(provider)

/**
 * Terminal arm for both static dispatchers. Unreachable through a typed
 * caller — that is what the `never` parameter buys — so reaching it at runtime
 * means an untyped seam handed us a provider the catalogue has never heard of.
 */
function reportUnhandledProviderCatalogue<T>(
  provider: never,
  surface: string,
  productionFallback: T
): T {
  const message =
    `[providerModelDefaults] No ${surface} for provider "${String(provider)}". ` +
    'Add a case to the static switch in providerModelDefaults.ts, or a branch to ' +
    'the state-backed dispatcher in App.tsx. Do NOT let it fall through: a ' +
    'wrong-but-plausible model id is exactly the failure this guard exists to stop.'
  // Dev and test: fail loudly and immediately. This is the entire point — the
  // bug class is defined by looking correct, so the guard must be impossible
  // to read past.
  if (import.meta.env.DEV) throw new Error(message)
  // Production: never blank the renderer over it. Both dispatchers are reached
  // through `any`-typed props (MainAppLayout.types.ts, Composer.tsx), so a
  // corrupt persisted provider string can still arrive here in a shipped
  // build. Log it, then return the honest EMPTY answer rather than another
  // provider's data.
  console.error(message)
  return productionFallback
}

/**
 * Fixed model catalogue for the providers that have one. Callers must peel off
 * the state-backed providers first; the type makes that mandatory.
 */
function getStaticProviderModelOptions(provider: StaticCatalogueProviderId): CodexModelOption[] {
  switch (provider) {
    case 'gemini':
      return GEMINI_DEFAULT_MODELS
    case 'kimi':
      return KIMI_DEFAULT_MODELS
    case 'grok':
      return GROK_DEFAULT_MODELS
    case 'cursor':
      return CURSOR_DEFAULT_MODELS
    case 'mistral':
      return MISTRAL_DEFAULT_MODELS
    case 'muse':
      return MUSE_DEFAULT_MODELS
    default:
      // NOTE the semantics: `[]` here means "this provider has no catalogue at
      // all", which is NOT the claim Pi's `[]` makes in App.tsx ("no upstream
      // keys stored yet" — a true, recoverable state). Do not collapse the two.
      return reportUnhandledProviderCatalogue<CodexModelOption[]>(
        provider,
        'static model catalogue',
        []
      )
  }
}

/** Pinned default model id for each static-catalogue provider. */
function getStaticProviderDefaultModel(provider: StaticCatalogueProviderId): string {
  switch (provider) {
    case 'gemini':
      return GEMINI_DEFAULT_MODEL
    case 'kimi':
      return KIMI_DEFAULT_MODEL
    case 'grok':
      return GROK_DEFAULT_MODEL
    case 'cursor':
      return CURSOR_DEFAULT_MODEL
    case 'mistral':
      return MISTRAL_DEFAULT_MODEL
    case 'muse':
      return MUSE_DEFAULT_MODEL
    default:
      // '' — never another provider's id, which is the precise damage this
      // whole block exists to prevent. An empty string is falsy at every
      // consumer: the ensemble path chains `|| getDefaultEnsembleParticipant-
      // Config(provider).model`, and the composer paths hand it to main, whose
      // `resolveRequestedModel` then applies THAT provider's own default. A
      // Gemini id would instead be dispatched verbatim onto the foreign seat.
      return reportUnhandledProviderCatalogue(provider, 'default model', '')
  }
}

const GEMINI_MODEL_IDS = new Set(['auto', 'pro', 'flash', 'flash-lite', 'custom'])
const CLAUDE_MODEL_IDS = new Set([
  'sonnet',
  'opus',
  'haiku',
  'fable',
  'mythos',
  'custom',
  'claude-opus-5',
  'claude-opus-4-8-1m',
  'claude-fable-5',
  'claude-fable-5-1m',
  'claude-mythos-5',
  'claude-opus-4-7-1m',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5'
])
const KIMI_MODEL_IDS = new Set(KIMI_DEFAULT_MODELS.map((model) => model.id))
const OLLAMA_MODEL_IDS = new Set(OLLAMA_DEFAULT_MODELS.map((model) => model.id))
const isGeminiModelId = (modelId: string): boolean => GEMINI_MODEL_IDS.has(modelId)
const isCodexModelId = (modelId: string): boolean =>
  modelId.startsWith('gpt-') || modelId.includes('codex')
const isClaudeModelId = (modelId: string): boolean =>
  !isPreviewModelPlaceholder(modelId) &&
  // Any preview-namespaced id (catalogued or stale, e.g. a persisted
  // `preview:anthropic:claude-sonnet-5` from before Sonnet 5 went GA) is never
  // a directly-selectable Claude model — dispatch normalizes it to the default.
  !normalizeProviderModelKey(modelId).startsWith('preview:') &&
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

export type { CodexModelOption, DynamicCatalogueProviderId, StaticCatalogueProviderId }
export {
  DYNAMIC_CATALOGUE_PROVIDER_IDS,
  isDynamicCatalogueProvider,
  getStaticProviderModelOptions,
  getStaticProviderDefaultModel,
  CURSOR_DEFAULT_MODEL,
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
  MISTRAL_DEFAULT_MODEL,
  MISTRAL_DEFAULT_MODELS,
  MUSE_DEFAULT_MODELS,
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
