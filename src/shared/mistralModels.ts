/**
 * Mistral Vibe model constants and reasoning effort configuration.
 *
 * This file mirrors the structure of grok45Models.ts and provides
 * constants for Mistral's Thinking levels (off, low, medium, high, max)
 * which are now configurable for Devstral Small and Mistral 3.5 Medium models.
 */

export const MISTRAL_DEVSTRAL_SMALL_MODEL_ID = 'devstral-small'
export const MISTRAL_MEDIUM_35_MODEL_ID = 'mistral-medium-3.5'

/**
 * Mistral Thinking levels as reasoning effort options.
 * These match the Vibe CLI's ThinkingLevel enum (off, low, medium, high, max).
 */
export const MISTRAL_REASONING_EFFORTS = [
  { reasoningEffort: 'off' },
  { reasoningEffort: 'low' },
  { reasoningEffort: 'medium' },
  { reasoningEffort: 'high' },
  { reasoningEffort: 'max' }
] as const

/**
 * Default reasoning effort for Mistral models that support configurable
 * thinking.
 */
export const MISTRAL_DEFAULT_REASONING_EFFORT = 'medium'

/**
 * Set of Mistral model IDs that support configurable Thinking levels.
 * Includes current aliases and legacy IDs so existing chats/presets keep
 * their picker semantics.
 */
export const MISTRAL_THINKING_CAPABLE_MODEL_IDS = new Set<string>([
  MISTRAL_DEVSTRAL_SMALL_MODEL_ID,
  MISTRAL_MEDIUM_35_MODEL_ID,
  'devstral-small-latest',
  'mistral-vibe-cli-latest',
  'mistral-small-2603',
  'mistral-medium-latest'
] as const)

/**
 * Check if a given Mistral seat model ID supports configurable Thinking
 * levels.
 */
export function isMistralThinkingCapableModel(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  return MISTRAL_THINKING_CAPABLE_MODEL_IDS.has(id)
}

/**
 * Check if a Pi namespace model ID is a Mistral model that supports
 * configurable Thinking levels when routed through the Pi BYOK lane.
 */
export function isPiMistralThinkingCapableModel(modelId: string | null | undefined): boolean {
  const id = String(modelId || '').trim().toLowerCase()
  if (!id.startsWith('mistral/')) return false
  return isMistralThinkingCapableModel(id.slice('mistral/'.length))
}

/**
 * Normalize a reasoning effort value to a valid Mistral Thinking level.
 * Clamps unknown values to the default rather than passing them through.
 */
export function normalizeMistralReasoningEffort(
  value: string | null | undefined,
  fallback: string = MISTRAL_DEFAULT_REASONING_EFFORT
): string {
  const effort = String(value || '').trim().toLowerCase()
  const validEfforts = MISTRAL_REASONING_EFFORTS.map((effortOption) => effortOption.reasoningEffort)
  return validEfforts.includes(effort as any) ? effort : fallback
}
