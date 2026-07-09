import type { ProviderId } from '../../../main/store/types'

/**
 * 1.0.5-EW50 — Shared model-id → human-readable display name
 * resolver. Pre-EW50 only `welcomeUsageDashboard.ts` had a
 * humaniser, and it only mapped Kimi ids — every other provider
 * fell through to the raw CLI/API id (`gemini-3-flash-preview`,
 * `claude-opus-4-7`, `gpt-5.5`). The Favorite Model chip on the
 * dashboard and the Model Comparisons + Settings Model Usage
 * lists all surfaced these raw ids, which read as developer-y
 * noise. EW50 extracts the resolver into this module so both
 * surfaces share one mapping table.
 *
 * Mapping table is hand-built rather than algorithmic because:
 *   - Capitalisation is not derivable from the id alone (GPT vs
 *     Gemini vs Claude vs Kimi all have different conventions).
 *   - Preview / numeric suffixes vary across providers
 *     (`-preview`, `-1m`, `-thinking`, dated `-0711-preview`).
 *   - A wrong heuristic-derived label is worse than the raw id;
 *     a missing mapping just falls back to the id and reads as
 *     "unknown but readable".
 *
 * To add a new model: append to `KNOWN_MODEL_LABELS` with the
 * exact lower-cased id key. The `humaniseModelId` lookup is
 * case-insensitive on the key side.
 */

const KNOWN_MODEL_LABELS: Record<string, string> = {
  // ── Gemini ────────────────────────────────────────────────
  // Full API/CLI ids
  'gemini-3-flash-preview': 'Gemini 3 Flash Preview',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
  'gemini-3.1-pro': 'Gemini 3.1 Pro',
  'gemini-3.1-flash-lite-preview': 'Gemini 3.1 Flash Lite Preview',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.0-flash': 'Gemini 2.0 Flash',
  // Composer-side short ids (from `GEMINI_DEFAULT_MODELS`)
  auto: 'Gemini Auto',
  pro: 'Gemini Pro',
  flash: 'Gemini Flash',
  'flash-lite': 'Gemini Flash Lite',

  // ── Codex (GPT) ───────────────────────────────────────────
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'gpt-5.2': 'GPT-5.2',
  // Official hyphenated display names (GA 2026-07-09, upstream Codex catalog).
  'gpt-5.6-sol': 'GPT-5.6-Sol',
  'gpt-5.6-terra': 'GPT-5.6-Terra',
  'gpt-5.6-luna': 'GPT-5.6-Luna',
  // Stale pre-un-gate placeholder ids — kept so historical runs still render.
  'preview:openai:gpt-5.6:sol': 'GPT-5.6-Sol',
  'preview:openai:gpt-5.6:terra': 'GPT-5.6-Terra',
  'preview:openai:gpt-5.6:luna': 'GPT-5.6-Luna',

  // ── Claude ────────────────────────────────────────────────
  'claude-sonnet-5': 'Claude Sonnet 5',
  'preview:anthropic:claude-sonnet-5': 'Claude Sonnet 5',
  'claude-fable-5': 'Claude Fable 5',
  'claude-fable-5-1m': 'Claude Fable 5 (1M)',
  'claude-mythos-5': 'Claude Mythos 5',
  'preview:anthropic:claude-fable-5': 'Claude Fable 5',
  'preview:anthropic:claude-mythos-5': 'Claude Mythos 5',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-opus-4-8-1m': 'Claude Opus 4.8 (1M)',
  'claude-opus-4-7': 'Claude Opus 4.7',
  'claude-opus-4-7-1m': 'Claude Opus 4.7 (1M)',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'claude-opus-4-6': 'Claude Opus 4.6',
  // Composer-side short ids
  sonnet: 'Claude Sonnet',
  opus: 'Claude Opus',
  haiku: 'Claude Haiku',
  fable: 'Claude Fable',
  mythos: 'Claude Mythos',

  // ── Kimi (extends the original welcomeUsageDashboard.ts
  // mappings; includes the variants visible in the user's
  // Settings → Model usage list). The legacy K2.6 aliases remain
  // readable for historical usage rows; new dispatch defaults to
  // Kimi K2.7 Code. ───────────────────────────────────────────
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k2.7-code-thinking': 'Kimi K2.7 Code Thinking',
  'kimi-k2.7-thinking': 'Kimi K2.7 Code Thinking',
  'kimi-k2.6': 'Kimi K2.6',
  'kimi-k2.6-thinking': 'Kimi K2.6 Thinking',
  'kimi-k2-thinking': 'Kimi K2.6 Thinking',
  'kimi-k2.5': 'Kimi K2.5',
  'kimi-k2': 'Kimi K2',
  'kimi-latest': 'Kimi (Latest)',
  'kimi-k2-turbo-preview': 'Kimi K2 Turbo Preview',
  'kimi-k2-0711-preview': 'Kimi K2 (0711 Preview)',
  'kimi-k2-0905-preview': 'Kimi K2 (0905 Preview)',

  // ── Grok ─────────────────────────────────────────────────
  // Grok's CLI models are permanently Fast-mode; the Grok-only ids read
  // "Grok 4.5 Fast". The bare `grok-4.5` key stays "Grok 4.5" because it is
  // SHARED with Cursor's base Grok row (Fast is a toggle there); `humaniseModelId`
  // upgrades it to "Grok 4.5 Fast" only when the provider is Grok.
  'grok-composer-2.5-fast': 'Grok Composer 2.5 Fast',
  'grok-4.5': 'Grok 4.5',
  'grok-4.5-latest': 'Grok 4.5 Fast',
  'grok-build-latest': 'Grok 4.5 Fast',
  'grok-build': 'Grok 4.5 Fast',
  'grok-build-0.1': 'Grok 4.5 Fast',

  // ── Cursor ────────────────────────────────────────────────
  'composer-2.5': 'Composer 2.5',
  'composer-2.5-fast': 'Composer 2.5 Fast',
  'cursor-grok-4.5': 'Grok 4.5',
  'grok-4.5-medium': 'Grok 4.5',
  'grok-4.5-fast-medium': 'Grok 4.5 Fast',
  'grok-4.5-high': 'Grok 4.5',
  'grok-4.5-fast-high': 'Grok 4.5 Fast',
  'grok-4.5-xhigh': 'Grok 4.5',
  'grok-4.5-fast-xhigh': 'Grok 4.5 Fast',

  // ── Ollama ────────────────────────────────────────────────
  'qwen3:4b-instruct': 'Qwen 3 (4B Param)',
  'qwen3.5:9b': 'Qwen 3.5 (9B Param)',
  'qwen3.6:35b': 'Qwen 3.6 (35B-A3B)',
  'gemma4:12b': 'Gemma 4 (12B Param)',
  'gemma4:12b-it-qat': 'Gemma 4 (12B Param)',
  'gemma4:12b-it-q4_k_m': 'Gemma 4 (12B Param)',
  'gemma4:12b-it-q8_0': 'Gemma 4 (12B Param)',
  'gemma4:12b-it-bf16': 'Gemma 4 (12B Param)',
  'gemma4:12b-mlx': 'Gemma 4 (12B Param)',
  'gemma4:12b-mlx-bf16': 'Gemma 4 (12B Param)',
  'gemma4:12b-mxfp8': 'Gemma 4 (12B Param)',
  'gemma4:12b-nvfp4': 'Gemma 4 (12B Param)',
  ornith: 'Ornith 1.0 (9B Param)',
  'ornith:latest': 'Ornith 1.0 (9B Param)',
  'ornith:9b': 'Ornith 1.0 (9B Param)',
  'ornith:35b': 'Ornith 1.0 (35B Param)',
  'laguna-xs-2.1:q8_0': 'Laguna XS 2.1 (33B-A3B Q8)',
  'gpt-oss': 'GPT OSS (20B Param)',
  'gpt-oss:20b': 'GPT OSS (20B Param)',
  'gpt-oss:latest': 'GPT OSS (20B Param)',
  'openai/gpt-oss-20b': 'GPT OSS (20B Param)',
  'lfm2.5:8b': 'LFM 2.5 (8B-1A)',
  'lfm2.5:latest': 'LFM 2.5 (8B-1A)',
  'minicpm-v4.5:8b': 'MiniCPM-V 4.5 (8B Param)',
  'granite4.1:3b': 'Granite 4.1 (3B Param)',
  'granite4.1:30b': 'Granite 4.1 (30B Param)',
  'nemotron3:33b': 'Nemotron 3 Nano Omni (33B Param)'
}

const STALE_GEMINI_PLACEHOLDER_MODEL_IDS = new Set([
  'flash-lite',
  'gemini-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview'
])

/**
 * Normalise provider/model pairs before grouping usage rows.
 *
 * During the 1.0.6 Grok/Cursor bring-up, a few usage records were
 * persisted with the right provider but Gemini's default `flash-lite`
 * model id. Without this provider-aware repair the dashboard shows
 * black/yellow duplicate "Gemini Flash Lite" rows. Collapse those
 * placeholders to each provider's real default so historical samples
 * merge into the correct model row.
 */
export function canonicalModelIdForProvider(
  provider: ProviderId | undefined,
  modelId: string | undefined | null
): string {
  const trimmed = String(modelId || '').trim()
  if (!trimmed) return ''
  const key = trimmed.toLowerCase()
  if (key === 'default' || key === 'cli-default') {
    if (provider === 'codex') return 'gpt-5.5'
    if (provider === 'claude') return 'claude-sonnet-5'
    if (provider === 'gemini') return 'flash-lite'
    if (provider === 'kimi') return 'kimi-k2.7-code'
    if (provider === 'grok') return 'grok-4.5'
    if (provider === 'cursor') return 'composer-2.5-fast'
    if (provider === 'ollama') return 'qwen3:4b-instruct'
  }
  if (provider === 'grok') {
    if (STALE_GEMINI_PLACEHOLDER_MODEL_IDS.has(key)) return 'grok-4.5'
    if (!key || key === 'grok') {
      return 'grok-4.5'
    }
    if (
      key === 'grok composer 2.5 fast' ||
      key === 'grok-composer-2.5-fast' ||
      key === 'composer 2.5 fast' ||
      key === 'composer-2.5-fast'
    ) {
      return 'grok-composer-2.5-fast'
    }
    if (
      key === 'grok 4.5' ||
      key === 'grok-4.5' ||
      key === 'grok-4.5-latest' ||
      key === 'grok-build-latest' ||
      key === 'grok build' ||
      key === 'grok build 0.1' ||
      key === 'grok-build-0.1' ||
      key === 'grok-build'
    ) {
      return 'grok-4.5'
    }
  }
  if (provider === 'cursor') {
    if (STALE_GEMINI_PLACEHOLDER_MODEL_IDS.has(key)) return 'composer-2.5-fast'
    if (!key || key === 'cursor' || key === 'composer') return 'composer-2.5-fast'
    if (
      key === 'cursor-grok-4.5' ||
      key === 'grok 4.5' ||
      key === 'grok-4.5' ||
      key.startsWith('grok-4.5-')
    ) {
      return 'grok-4.5'
    }
    if (key === 'composer 2.5 fast' || key === 'composer-2.5-fast') return 'composer-2.5-fast'
    if (key === 'composer 2.5' || key === 'composer-2.5') return 'composer-2.5'
    if (key.startsWith('composer-')) return key
    if (key.includes('fast')) return 'composer-2.5-fast'
    if (key.includes('composer')) return 'composer-2.5'
    return 'composer-2.5-fast'
  }
  if (provider === 'ollama') {
    if (
      key === 'gpt-oss' ||
      key === 'gpt-oss:latest' ||
      key === 'gpt-oss:20b' ||
      key === 'openai/gpt-oss-20b'
    ) {
      return 'gpt-oss:20b'
    }
    if (key === 'qwen3.6:35b-a3b') {
      return 'qwen3.6:35b'
    }
    if (key === 'ornith' || key === 'ornith:latest') {
      return 'ornith:9b'
    }
    if (key === 'lfm2.5' || key === 'lfm2.5:latest') {
      return 'lfm2.5:8b'
    }
  }
  return trimmed
}

/**
 * Resolve a model id to a human-readable display name. Falls
 * back to the input id when no mapping exists, so unfamiliar
 * models stay readable (vs. returning a placeholder like
 * "Unknown model" which would lose information).
 *
 * The `provider` argument is used for ambiguous legacy ids such as
 * `flash-lite`, which can be a real Gemini short id or stale
 * Grok/Cursor bootstrap metadata.
 */
export function humaniseModelId(
  provider: ProviderId | undefined,
  modelId: string | undefined | null
): string {
  const canonical = canonicalModelIdForProvider(provider, modelId)
  if (!canonical) return ''
  const key = canonical.trim().toLowerCase()
  if (provider === 'ollama' && key.startsWith('qwen3.5:9b-')) {
    return 'Qwen 3.5 (9B Param)'
  }
  if (provider === 'ollama' && key.startsWith('qwen3.6:35b-')) {
    return 'Qwen 3.6 (35B-A3B)'
  }
  if (provider === 'ollama' && key.startsWith('minicpm-v4.5:8b-')) {
    return 'MiniCPM-V 4.5 (8B Param)'
  }
  if (
    provider === 'ollama' &&
    (key === 'ornith' || key === 'ornith:latest' || key.startsWith('ornith:9b-'))
  ) {
    return 'Ornith 1.0 (9B Param)'
  }
  if (provider === 'ollama' && key.startsWith('ornith:35b-')) {
    return 'Ornith 1.0 (35B Param)'
  }
  if (provider === 'ollama' && key.startsWith('lfm2.5:8b-')) {
    return 'LFM 2.5 (8B-1A)'
  }
  if (provider === 'ollama' && key.startsWith('granite4.1:3b-')) {
    return 'Granite 4.1 (3B Param)'
  }
  if (provider === 'ollama' && key.startsWith('granite4.1:30b-')) {
    return 'Granite 4.1 (30B Param)'
  }
  if (provider === 'ollama' && key.startsWith('nemotron3:33b-')) {
    return 'Nemotron 3 Nano Omni (33B Param)'
  }
  // Both Grok CLI models run permanently in Fast mode. The canonicaliser has
  // collapsed every Grok reasoning id to 'grok-4.5' by here, so label the Grok
  // seat "Grok 4.5 Fast". Cursor's grok-4.5 (separate Fast toggle) is untouched
  // and keeps the flat-map "Grok 4.5".
  if (provider === 'grok' && key === 'grok-4.5') {
    return 'Grok 4.5 Fast'
  }
  return KNOWN_MODEL_LABELS[key] || canonical
}

/** Brand prefix stripped when a model name is shown under its provider header. */
const PROVIDER_MODEL_LABEL_PREFIX: Partial<Record<ProviderId, RegExp>> = {
  gemini: /^Gemini\s+/i,
  claude: /^Claude\s+/i,
  kimi: /^Kimi\s+/i,
  grok: /^Grok\s+/i
}

/**
 * Human-readable model label for grouped surfaces (e.g. Settings → Model usage)
 * where the provider is already shown on the parent row. Drops the redundant
 * brand prefix (`Claude Opus 4.8` → `Opus 4.8`) while preserving labels that
 * do not repeat the provider (`GPT-5.5`, `CLI Default`).
 */
export function humaniseModelIdCompact(
  provider: ProviderId | undefined,
  modelId: string | undefined | null
): string {
  const full = humaniseModelId(provider, modelId)
  if (!full || !provider) return full
  const pattern = PROVIDER_MODEL_LABEL_PREFIX[provider]
  if (!pattern) return full
  const stripped = full.replace(pattern, '').trim()
  return stripped || full
}

const DATED_CLAUDE_MODEL_ID = /^claude-(haiku|sonnet|opus|fable|mythos)-(\d+)-(\d+)(?:-\d{8})?$/i

/**
 * Ultra-compact model label for narrow table cells (Settings → Model usage).
 * Applies the compact humaniser, simplifies dated Claude API ids, then hard-
 * truncates with an ellipsis. Callers should keep the full
 * {@link humaniseModelIdCompact} string on the cell `title`.
 */
export function humaniseModelIdTableCell(
  provider: ProviderId | undefined,
  modelId: string | undefined | null,
  maxLength = 25
): string {
  const canonical = canonicalModelIdForProvider(provider, modelId).trim()
  let label = humaniseModelIdCompact(provider, modelId)
  if (provider === 'claude' && label === canonical) {
    const match = canonical.match(DATED_CLAUDE_MODEL_ID)
    if (match) {
      label = `${match[1]} ${match[2]}.${match[3]}`
    }
  }
  if (label.length <= maxLength) return label
  return `${label.slice(0, Math.max(1, maxLength - 1))}\u2026`
}

/**
 * Read-only accessor for tests + tooling that need to enumerate
 * the known mappings (e.g. a future "show every known model"
 * preview surface). Returns a fresh shallow clone so callers
 * can't mutate the source-of-truth table.
 */
export function getKnownModelLabels(): Record<string, string> {
  return { ...KNOWN_MODEL_LABELS }
}
