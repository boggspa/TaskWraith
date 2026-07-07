export type PreviewModelProvider = 'codex' | 'claude'

export type PreviewModelAccessState = 'requires_preview_access' | 'available'

export interface PreviewModelCatalogEntry {
  id: string
  provider: PreviewModelProvider
  label: string
  description: string
  disabled: boolean
  disabledReason?: string
  hidden: boolean
  runnable: boolean
  accessState: PreviewModelAccessState
  previewFamily: string
  previewRole: string
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string
    description?: string
    disabled?: boolean
    disabledReason?: string
  }>
  defaultReasoningEffort?: string | null
}

export const PREVIEW_MODEL_ACCESS_REASON = 'Requires preview access'
export const OPENAI_PREVIEW_MODEL_ACCESS_REASON = 'Requires OpenAI preview access'
export const CLAUDE_PREVIEW_MODEL_ACCESS_REASON = 'Requires Claude preview access'

const OPENAI_GPT56_REASONING_EFFORTS = [
  { reasoningEffort: 'low' },
  { reasoningEffort: 'medium' },
  { reasoningEffort: 'high' },
  { reasoningEffort: 'xhigh' }
]

const OPENAI_GPT56_SOL_REASONING_EFFORTS = [
  ...OPENAI_GPT56_REASONING_EFFORTS,
  { reasoningEffort: 'max' }
]

// 2026-07-07 — GPT-5.6 launch-day un-gate. The trio is selectable and
// runnable with concrete slugs; the run-time safety net is unchanged:
// ProviderPreflightService still treats every gpt-5.6* id as preview-risk and
// blocks dispatch with "Requires OpenAI preview access" until the live Codex
// CLI `model/list` returns the id (previewModelAccessProvenForPayload), so a
// not-yet-released model errors cleanly instead of failing mid-run.
export const PREVIEW_MODEL_CATALOG: PreviewModelCatalogEntry[] = [
  {
    id: 'gpt-5.6-sol',
    provider: 'codex',
    label: 'GPT-5.6 Sol',
    description: 'Hardest long-horizon coding and research.',
    disabled: false,
    hidden: false,
    runnable: true,
    accessState: 'available',
    previewFamily: 'gpt-5.6',
    previewRole: 'Hardest long-horizon coding/research',
    supportedReasoningEfforts: OPENAI_GPT56_SOL_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'gpt-5.6-terra',
    provider: 'codex',
    label: 'GPT-5.6 Terra',
    description: 'Strong everyday advanced agentic work.',
    disabled: false,
    hidden: false,
    runnable: true,
    accessState: 'available',
    previewFamily: 'gpt-5.6',
    previewRole: 'Strong everyday advanced agentic work',
    supportedReasoningEfforts: OPENAI_GPT56_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'gpt-5.6-luna',
    provider: 'codex',
    label: 'GPT-5.6 Luna',
    description: 'Fast triage, board planning, and lightweight subagents.',
    disabled: false,
    hidden: false,
    runnable: true,
    accessState: 'available',
    previewFamily: 'gpt-5.6',
    previewRole: 'Fast triage, board planning, summarization, lightweight subagents',
    supportedReasoningEfforts: OPENAI_GPT56_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium'
  }
]

// Ids of the disabled preview:… placeholder rows the picker showed before the
// trio became selectable. Never valid CLI model ids — normalizeCodexModel maps
// a stale persisted id to its concrete slug via this table.
export const PREVIEW_PLACEHOLDER_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'preview:openai:gpt-5.6:sol': 'gpt-5.6-sol',
  'preview:openai:gpt-5.6:terra': 'gpt-5.6-terra',
  'preview:openai:gpt-5.6:luna': 'gpt-5.6-luna'
}

const RETIRED_PREVIEW_MODEL_PLACEHOLDER_IDS = new Set([
  'preview:anthropic:claude-fable-5',
  'preview:anthropic:claude-mythos-5'
])

export function previewModelAccessReason(provider: string): string {
  if (provider === 'codex') return OPENAI_PREVIEW_MODEL_ACCESS_REASON
  if (provider === 'claude') return CLAUDE_PREVIEW_MODEL_ACCESS_REASON
  return PREVIEW_MODEL_ACCESS_REASON
}

export function previewModelsForProvider(provider: string): PreviewModelCatalogEntry[] {
  return PREVIEW_MODEL_CATALOG.filter((entry) => entry.provider === provider)
}

export function isPreviewModelPlaceholder(model?: string | null): boolean {
  const id = normalizePreviewModelKey(model)
  return (
    Boolean(PREVIEW_PLACEHOLDER_MODEL_ALIASES[id]) || RETIRED_PREVIEW_MODEL_PLACEHOLDER_IDS.has(id)
  )
}

/** Concrete slug for a stale preview:… placeholder id, or null. */
export function concreteModelForPreviewPlaceholder(model?: string | null): string | null {
  return PREVIEW_PLACEHOLDER_MODEL_ALIASES[normalizePreviewModelKey(model)] || null
}

/**
 * True when the id is a preview-family catalog row TaskWraith curates itself.
 * The live `model/list` merge uses this to append catalog rows the CLI does
 * not return yet without resurrecting any other static-fallback row.
 */
export function isPreviewCatalogModelId(model?: string | null): boolean {
  const id = normalizePreviewModelKey(model)
  return PREVIEW_MODEL_CATALOG.some((entry) => entry.id.toLowerCase() === id)
}

export function isPreviewRiskModel(provider: string, model?: string | null): boolean {
  const id = normalizePreviewModelKey(model)
  if (!id) return false
  if (isPreviewModelPlaceholder(id)) return true
  if (provider === 'codex') {
    return /^gpt-5\.6(?:$|[^0-9])/i.test(id)
  }
  if (provider === 'claude') {
    // Concrete Claude 5 family ids are runnable model ids now; only explicit
    // preview placeholders are blocked by the generic placeholder check above.
    return false
  }
  return false
}

export function previewModelCatalogEnabled(
  env: Record<string, string | undefined> | undefined
): boolean {
  return envFlagEnabled(env, 'TASKWRAITH_PREVIEW_MODELS', true)
}

export function previewModelCatalogEnabledForProvider(
  provider: string,
  env: Record<string, string | undefined> | undefined
): boolean {
  if (previewModelCatalogEnabled(env)) return true
  if (provider === 'codex') return envFlagEnabled(env, 'TASKWRAITH_OPENAI_PREVIEW_MODELS', false)
  if (provider === 'claude') return envFlagEnabled(env, 'TASKWRAITH_CLAUDE_PREVIEW_MODELS', false)
  return false
}

export function previewModelAccessFlagEnabledForProvider(
  provider: string,
  env: Record<string, string | undefined> | undefined
): boolean {
  if (provider === 'codex') return envFlagEnabled(env, 'TASKWRAITH_OPENAI_PREVIEW_ACCESS', false)
  if (provider === 'claude') return envFlagEnabled(env, 'TASKWRAITH_CLAUDE_PREVIEW_ACCESS', false)
  return false
}

function normalizePreviewModelKey(model?: string | null): string {
  return String(model || '')
    .trim()
    .toLowerCase()
}

function envFlagEnabled(
  env: Record<string, string | undefined> | undefined,
  key: string,
  defaultEnabled: boolean
): boolean {
  const value = env?.[key]
  if (value === '0' || value === 'false' || value === 'no') return false
  if (value === '1' || value === 'true' || value === 'yes') return true
  return defaultEnabled
}
