import { isAboveXhighReasoningEffort } from './reasoningEffortLadder'
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

export const GROK_46_REASONING_EFFORTS = [
  { reasoningEffort: 'low' },
  { reasoningEffort: 'medium' },
  { reasoningEffort: 'high' },
  { reasoningEffort: 'xhigh' }
] as const

export const GROK_46_DEFAULT_REASONING_EFFORT = 'high'
export const CURSOR_GROK_46_BASE_MODEL_ID = GROK_46_MODEL_ID

/**
 * RETIRED. Cursor resold Grok 4.5 until its catalogue dropped the family
 * outright: `cursor-agent --list-models` (2026.09.02-c22c1a3) carries only
 * `cursor-grok-4.6-*`, and passing any id below fails the run hard —
 * "Cannot use this model: grok-4.5-xhigh", exit 1, before any work happens.
 *
 * Kept ONLY to migrate seats that persisted one of these ids (see
 * {@link migrateRetiredCursorGrokModelId}). This set is Cursor's resale
 * vocabulary and says nothing about the standalone xAI `grok` provider, which
 * still offers Grok 4.5 through `GROK_45_MODEL_ID` and
 * {@link isGrok45ReasoningModelId}.
 */
const RETIRED_CURSOR_GROK_45_MODEL_IDS = new Set([
  GROK_45_MODEL_ID,
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

export function normalizeGrok45ReasoningEffort(
  value: string | null | undefined,
  fallback: string = GROK_45_DEFAULT_REASONING_EFFORT
): string {
  const effort = String(value || '').trim().toLowerCase()
  // Top-of-ladder tiers clamp to Grok 4.5's 'high' ceiling.
  if (isAboveXhighReasoningEffort(effort)) {
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
  if (isAboveXhighReasoningEffort(effort)) {
    return 'xhigh'
  }
  return effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh'
    ? effort
    : fallback
}

/**
 * Map a retired Cursor Grok 4.5 id onto its live successor, or null when the id
 * is not one. Grok 4.6 keeps the user's Grok intent and its ladder is a
 * superset of 4.5's (low/medium/high, plus xhigh), so nothing is narrowed;
 * falling back to Composer instead would silently change which model answers.
 */
export function migrateRetiredCursorGrokModelId(
  modelId: string | null | undefined
): typeof GROK_46_MODEL_ID | null {
  const id = String(modelId || '').trim().toLowerCase()
  return RETIRED_CURSOR_GROK_45_MODEL_IDS.has(id) ? GROK_46_MODEL_ID : null
}

/** True for the TaskWraith base id or an exact Cursor Grok wire id. */
export function isCursorGrokModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return CURSOR_GROK_46_MODEL_IDS.has(id)
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

export function isCursorGrokConcreteModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return CURSOR_GROK_46_MODEL_IDS.has(id) && id !== CURSOR_GROK_46_BASE_MODEL_ID
}

export function cursorGrokBaseModelId(
  modelId: string | null | undefined
): typeof CURSOR_GROK_46_BASE_MODEL_ID | null {
  const id = String(modelId || '').trim().toLowerCase()
  return CURSOR_GROK_46_MODEL_IDS.has(id) ? CURSOR_GROK_46_BASE_MODEL_ID : null
}


export function cursorGrokReasoningFromModelId(
  modelId: string | null | undefined
): 'low' | 'medium' | 'high' | 'xhigh' | null {
  const id = String(modelId || '').trim().toLowerCase()
  if (!CURSOR_GROK_46_MODEL_IDS.has(id)) return null
  const match = id.match(/^cursor-grok-4\.6-(low|medium|high|xhigh)(?:-fast)?$/)
  return (match?.[1] as 'low' | 'medium' | 'high' | 'xhigh' | undefined) ??
    GROK_46_DEFAULT_REASONING_EFFORT
}


export function cursorGrokFastFromModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return CURSOR_GROK_46_MODEL_IDS.has(id) && id.endsWith('-fast')
}


export function resolveCursorGrokCliModelId(input: {
  model?: string | null
  reasoningEffort?: string | null
  fastModeEnabled?: boolean | null
}): string | null {
  const rawModel = String(input.model || '').trim().toLowerCase()
  // A retired Grok 4.5 id resolves to NOTHING rather than to a 4.6 guess: the
  // caller must migrate it first (migrateRetiredCursorGrokModelId) so the
  // persisted seat and the wire id cannot drift apart.
  if (!CURSOR_GROK_46_MODEL_IDS.has(rawModel)) return null
  if (rawModel !== CURSOR_GROK_46_BASE_MODEL_ID) return rawModel
  const effort = normalizeGrok46ReasoningEffort(input.reasoningEffort)
  return `cursor-grok-4.6-${effort}${input.fastModeEnabled ? '-fast' : ''}`
}
