export type PreviewModelProvider = 'codex' | 'claude'

export type PreviewModelAccessState = 'requires_preview_access'

export interface PreviewModelCatalogEntry {
  id: string
  provider: PreviewModelProvider
  label: string
  description: string
  disabled: true
  disabledReason: string
  hidden: true
  runnable: false
  accessState: PreviewModelAccessState
  previewFamily: string
  previewRole: string
}

export const PREVIEW_MODEL_ACCESS_REASON = 'Requires preview access'
export const OPENAI_PREVIEW_MODEL_ACCESS_REASON = 'Requires OpenAI preview access'
export const CLAUDE_PREVIEW_MODEL_ACCESS_REASON = 'Requires Claude preview access'

export const PREVIEW_MODEL_CATALOG: PreviewModelCatalogEntry[] = [
  {
    id: 'preview:openai:gpt-5.6:sol',
    provider: 'codex',
    label: 'OpenAI GPT-5.6 Sol Preview',
    description: 'Preview placeholder for hardest long-horizon coding and research.',
    disabled: true,
    disabledReason: OPENAI_PREVIEW_MODEL_ACCESS_REASON,
    hidden: true,
    runnable: false,
    accessState: 'requires_preview_access',
    previewFamily: 'gpt-5.6',
    previewRole: 'Hardest long-horizon coding/research'
  },
  {
    id: 'preview:openai:gpt-5.6:terra',
    provider: 'codex',
    label: 'OpenAI GPT-5.6 Terra Preview',
    description: 'Preview placeholder for strong everyday advanced agentic work.',
    disabled: true,
    disabledReason: OPENAI_PREVIEW_MODEL_ACCESS_REASON,
    hidden: true,
    runnable: false,
    accessState: 'requires_preview_access',
    previewFamily: 'gpt-5.6',
    previewRole: 'Strong everyday advanced agentic work'
  },
  {
    id: 'preview:openai:gpt-5.6:luna',
    provider: 'codex',
    label: 'OpenAI GPT-5.6 Luna Preview',
    description: 'Preview placeholder for fast triage, board planning, and lightweight subagents.',
    disabled: true,
    disabledReason: OPENAI_PREVIEW_MODEL_ACCESS_REASON,
    hidden: true,
    runnable: false,
    accessState: 'requires_preview_access',
    previewFamily: 'gpt-5.6',
    previewRole: 'Fast triage, board planning, summarization, lightweight subagents'
  },
  {
    id: 'preview:anthropic:claude-fable-5',
    provider: 'claude',
    label: 'Claude Fable 5 Preview',
    description: 'Preview model gated behind explicit Claude preview access.',
    disabled: true,
    disabledReason: CLAUDE_PREVIEW_MODEL_ACCESS_REASON,
    hidden: true,
    runnable: false,
    accessState: 'requires_preview_access',
    previewFamily: 'claude-fable-5',
    previewRole: 'Future Claude preview model family'
  },
  {
    id: 'preview:anthropic:claude-mythos-5',
    provider: 'claude',
    label: 'Claude Mythos 5 Preview',
    description: 'Preview model gated behind explicit Claude preview access.',
    disabled: true,
    disabledReason: CLAUDE_PREVIEW_MODEL_ACCESS_REASON,
    hidden: true,
    runnable: false,
    accessState: 'requires_preview_access',
    previewFamily: 'claude-mythos-5',
    previewRole: 'Future Claude preview model family'
  }
]

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
  return PREVIEW_MODEL_CATALOG.some((entry) => entry.id === id)
}

export function isPreviewRiskModel(provider: string, model?: string | null): boolean {
  const id = normalizePreviewModelKey(model)
  if (!id) return false
  if (isPreviewModelPlaceholder(id)) return true
  if (provider === 'codex') {
    return /^gpt-5\.6(?:$|[^0-9])/i.test(id)
  }
  if (provider === 'claude') {
    return /\b(?:claude-)?(?:fable|mythos)-5\b/i.test(id)
  }
  return false
}

export function previewModelCatalogEnabled(
  env: Record<string, string | undefined> | undefined
): boolean {
  return envFlagEnabled(env, 'TASKWRAITH_PREVIEW_MODELS', false)
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
  return String(model || '').trim().toLowerCase()
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
