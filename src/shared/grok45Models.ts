export const GROK_45_MODEL_ID = 'grok-4.5'
export const GROK_45_LATEST_MODEL_ID = 'grok-4.5-latest'
export const GROK_BUILD_LATEST_MODEL_ID = 'grok-build-latest'
export const GROK_46_MODEL_ID = 'grok-4.6'

export const GROK_45_REASONING_EFFORTS = [
  { reasoningEffort: 'low' },
  { reasoningEffort: 'medium' },
  { reasoningEffort: 'high' }
] as const

export const GROK_45_DEFAULT_REASONING_EFFORT = 'high'
export const CURSOR_GROK_45_BASE_MODEL_ID = GROK_45_MODEL_ID

export const GROK_46_REASONING_EFFORTS = [
  { reasoningEffort: 'low' },
  { reasoningEffort: 'medium' },
  { reasoningEffort: 'high' },
  { reasoningEffort: 'xhigh' }
] as const

export const GROK_46_DEFAULT_REASONING_EFFORT = 'high'
export const CURSOR_GROK_46_BASE_MODEL_ID = GROK_46_MODEL_ID

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

/** Exact Cursor Agent ids captured from `cursor-agent models` 2026.08.04. */
export const CURSOR_GROK_46_WIRE_MODEL_IDS = [
  'cursor-grok-4.6-low',
  'cursor-grok-4.6-low-fast',
  'cursor-grok-4.6-medium',
  'cursor-grok-4.6-medium-fast',
  'cursor-grok-4.6-high',
  'cursor-grok-4.6-high-fast',
  'cursor-grok-4.6-xhigh',
  'cursor-grok-4.6-xhigh-fast'
] as const

const CURSOR_GROK_46_MODEL_IDS = new Set<string>([
  CURSOR_GROK_46_BASE_MODEL_ID,
  ...CURSOR_GROK_46_WIRE_MODEL_IDS
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
  // Top-of-ladder tiers clamp to Grok 4.5's 'high' ceiling.
  if (effort === 'ultra' || effort === 'ultracode' || effort === 'ultratask' || effort === 'max') {
    return 'high'
  }
  return effort === 'low' || effort === 'medium' || effort === 'high' ? effort : fallback
}

export function normalizeGrok46ReasoningEffort(
  value: string | null | undefined,
  fallback: string = GROK_46_DEFAULT_REASONING_EFFORT
): string {
  const effort = String(value || '').trim().toLowerCase()
  // Top-of-ladder tiers clamp to Grok 4.6's 'xhigh' ceiling.
  if (effort === 'ultra' || effort === 'ultracode' || effort === 'ultratask' || effort === 'max') {
    return 'xhigh'
  }
  return effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh'
    ? effort
    : fallback
}

export function isCursorGrok45ModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return CURSOR_GROK_45_MODEL_IDS.has(id)
}

/** True for a TaskWraith base id or exact Cursor wire id in either Grok family. */
export function isCursorGrokModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return CURSOR_GROK_45_MODEL_IDS.has(id) || CURSOR_GROK_46_MODEL_IDS.has(id)
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

/** Standalone Grok reasoning-capable base/compatibility ids. */
export function isGrokReasoningModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return isGrok45ReasoningModelId(id) || id === GROK_46_MODEL_ID
}

export function isCursorGrok45ConcreteModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return id.startsWith('grok-4.5') && id !== CURSOR_GROK_45_BASE_MODEL_ID
}

export function isCursorGrokConcreteModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return (
    isCursorGrok45ConcreteModelId(id) ||
    (CURSOR_GROK_46_MODEL_IDS.has(id) && id !== CURSOR_GROK_46_BASE_MODEL_ID)
  )
}

export function cursorGrokBaseModelId(
  modelId: string | null | undefined
): typeof CURSOR_GROK_45_BASE_MODEL_ID | typeof CURSOR_GROK_46_BASE_MODEL_ID | null {
  const id = String(modelId || '').trim().toLowerCase()
  if (CURSOR_GROK_45_MODEL_IDS.has(id)) return CURSOR_GROK_45_BASE_MODEL_ID
  if (CURSOR_GROK_46_MODEL_IDS.has(id)) return CURSOR_GROK_46_BASE_MODEL_ID
  return null
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

export function cursorGrokReasoningFromModelId(
  modelId: string | null | undefined
): 'low' | 'medium' | 'high' | 'xhigh' | null {
  const id = String(modelId || '').trim().toLowerCase()
  if (CURSOR_GROK_45_MODEL_IDS.has(id)) return cursorGrok45ReasoningFromModelId(id)
  if (!CURSOR_GROK_46_MODEL_IDS.has(id)) return null
  const match = id.match(/^cursor-grok-4\.6-(low|medium|high|xhigh)(?:-fast)?$/)
  return (match?.[1] as 'low' | 'medium' | 'high' | 'xhigh' | undefined) ??
    GROK_46_DEFAULT_REASONING_EFFORT
}

export function cursorGrok45FastFromModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return isCursorGrok45ModelId(id) && id.includes('-fast-')
}

export function cursorGrokFastFromModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  if (CURSOR_GROK_45_MODEL_IDS.has(id)) return cursorGrok45FastFromModelId(id)
  return CURSOR_GROK_46_MODEL_IDS.has(id) && id.endsWith('-fast')
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

export function resolveCursorGrokCliModelId(input: {
  model?: string | null
  reasoningEffort?: string | null
  fastModeEnabled?: boolean | null
}): string | null {
  const rawModel = String(input.model || '').trim().toLowerCase()
  if (CURSOR_GROK_45_MODEL_IDS.has(rawModel)) return resolveCursorGrok45CliModelId(input)
  if (!CURSOR_GROK_46_MODEL_IDS.has(rawModel)) return null
  if (rawModel !== CURSOR_GROK_46_BASE_MODEL_ID) return rawModel
  const effort = normalizeGrok46ReasoningEffort(input.reasoningEffort)
  return `cursor-grok-4.6-${effort}${input.fastModeEnabled ? '-fast' : ''}`
}
