export const GROK_45_MODEL_ID = 'grok-4.5'
export const GROK_45_LATEST_MODEL_ID = 'grok-4.5-latest'
export const GROK_BUILD_LATEST_MODEL_ID = 'grok-build-latest'

export const GROK_45_REASONING_EFFORTS = [
  { reasoningEffort: 'low' },
  { reasoningEffort: 'medium' },
  { reasoningEffort: 'high' }
] as const

export const GROK_45_DEFAULT_REASONING_EFFORT = 'high'
export const CURSOR_GROK_45_BASE_MODEL_ID = GROK_45_MODEL_ID

const CURSOR_GROK_45_MODEL_IDS = new Set([
  CURSOR_GROK_45_BASE_MODEL_ID,
  'cursor-grok-4.5',
  'grok-4.5-medium',
  'grok-4.5-high',
  'grok-4.5-xhigh',
  'grok-4.5-fast-medium',
  'grok-4.5-fast-high',
  'grok-4.5-fast-xhigh'
])

const CURSOR_REASONING_TO_MODEL_SUFFIX: Record<string, string> = {
  low: 'medium',
  medium: 'high',
  high: 'xhigh'
}

export function normalizeGrok45ReasoningEffort(
  value: string | null | undefined,
  fallback: string = GROK_45_DEFAULT_REASONING_EFFORT
): string {
  const effort = String(value || '').trim().toLowerCase()
  return effort === 'low' || effort === 'medium' || effort === 'high' ? effort : fallback
}

export function isCursorGrok45ModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return CURSOR_GROK_45_MODEL_IDS.has(id)
}

export function isGrok45ReasoningModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return (
    id === GROK_45_MODEL_ID ||
    id === GROK_45_LATEST_MODEL_ID ||
    id === GROK_BUILD_LATEST_MODEL_ID ||
    id === 'grok-build' ||
    id === 'grok-build-0.1'
  )
}

export function isCursorGrok45ConcreteModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return id.startsWith('grok-4.5') && id !== CURSOR_GROK_45_BASE_MODEL_ID
}

export function cursorGrok45ReasoningFromModelId(
  modelId: string | null | undefined
): 'low' | 'medium' | 'high' | null {
  const id = String(modelId || '').trim().toLowerCase()
  if (!isCursorGrok45ModelId(id)) return null
  if (id.endsWith('-medium')) return 'low'
  if (id.endsWith('-high')) return 'medium'
  if (id.endsWith('-xhigh')) return 'high'
  return GROK_45_DEFAULT_REASONING_EFFORT
}

export function cursorGrok45FastFromModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return isCursorGrok45ModelId(id) && id.includes('-fast-')
}

export function resolveCursorGrok45CliModelId(input: {
  model?: string | null
  reasoningEffort?: string | null
  fastModeEnabled?: boolean | null
}): string | null {
  const rawModel = String(input.model || '').trim().toLowerCase()
  if (!isCursorGrok45ModelId(rawModel)) return null
  if (isCursorGrok45ConcreteModelId(rawModel)) return rawModel
  const effort = normalizeGrok45ReasoningEffort(input.reasoningEffort)
  const suffix = CURSOR_REASONING_TO_MODEL_SUFFIX[effort]
  return input.fastModeEnabled ? `grok-4.5-fast-${suffix}` : `grok-4.5-${suffix}`
}
