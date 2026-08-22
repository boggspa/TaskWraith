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
  /** Paid speed tiers this model exposes (e.g. ['fast']). Absent = standard only. */
  additionalSpeedTiers?: string[]
  /** Whether this model supports UltraTask orchestration */
  ultraTaskSupported?: boolean
}

export const PREVIEW_MODEL_ACCESS_REASON = 'Requires preview access'
export const OPENAI_PREVIEW_MODEL_ACCESS_REASON = 'Requires OpenAI preview access'
export const CLAUDE_PREVIEW_MODEL_ACCESS_REASON = 'Requires Claude preview access'

// 2026-07-07 — GPT-5.6 launch-day un-gate: the trio became selectable and
// runnable with concrete slugs (59357640e), but isPreviewRiskModel still flagged
// every gpt-5.6* id, so ProviderPreflightService blocked dispatch until the live
// Codex CLI `model/list` echoed the id back.
// 2026-07-09 — GPT-5.6 full parity: isPreviewRiskModel('codex', <concrete
// gpt-5.6* id>) now returns false, so NONE of the 5 preview-risk clamps apply.
// 2026-07-09 (GA) — GPT-5.6 GRADUATED out of this catalog: official metadata
// confirmed against the upstream Codex catalog (codex-rs/models-manager/
// models.json) + developers.openai.com, and the trio now lives as first-class
// rows in CODEX_STATIC_MODELS (StaticProviderModels.ts), appended to the live
// `model/list` via CODEX_STAGED_ROLLOUT_MODEL_IDS while OpenAI's account-cohort
// ramp + the CLI's minimal_client_version=0.144.0 gate keep it out of some
// accounts' lists. This catalog is intentionally EMPTY — it is the structural
// slot for the NEXT preview family (mirrors the claude branch narrowing when
// claude-sonnet-5 went GA in e7b906273). Do not delete the machinery.
// Stale `preview:openai:gpt-5.6:*` PLACEHOLDER ids still resolve preview-risk
// via isPreviewModelPlaceholder — harmless: they're legacy persisted ids only,
// rewritten to a concrete slug by normalizeCodexModel on read, so no live run
// reaches a clamp carrying the placeholder string.
export const PREVIEW_MODEL_CATALOG: PreviewModelCatalogEntry[] = []

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
    // GPT-5.6 (sol/terra/luna) is GA now: concrete gpt-5.6* ids are runnable
    // models with full GPT-5.5 parity, NOT preview-risk. This branch is kept as
    // the structural slot for the NEXT codex preview family — add its regex here
    // when one ships gated behind explicit access (mirrors the claude branch
    // below, narrowed the same way when claude-sonnet-5 went GA in e7b906273).
    return false
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
