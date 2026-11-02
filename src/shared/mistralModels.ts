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
 * Mistral Large 4 on the API-key lane — the row that existed before the Vibe
 * plan lane, billed per token on the user's own Mistral key.
 */
export const MISTRAL_LARGE_4_MODEL_ID = 'mistral-large-4'

/**
 * Mistral Large 4 on the Vibe PLAN lane (2026-11-02): the same model, billed
 * against the user's Mistral Vibe quota instead of a per-token API key.
 *
 * A DISTINCT TaskWraith id, because the alias the user's `~/.vibe/config.toml`
 * carries is `mistral-large-4` — the same string as the API model id. Two
 * rows cannot share one id, so this row carries its own id and resolves to the
 * Vibe alias at dispatch (see `mistralVibeModelAlias`). The row is only
 * offered when the user's own Vibe config provides the model: Mistral enabled
 * Large 4 on the Vibe quota for the accounts whose config carries it, and
 * TaskWraith does not write that config on the user's behalf.
 */
export const MISTRAL_LARGE_4_VIBE_MODEL_ID = 'mistral-large-4-hosted'

/** The alias the user's `~/.vibe/config.toml` defines for Large 4. */
export const MISTRAL_LARGE_4_VIBE_ALIAS = 'mistral-large-4'

export const MISTRAL_LARGE_4_VIBE_MODEL_LABEL = 'Mistral Large 4 (Vibe Plan)'

/**
 * The window api.mistral.ai/v1/models reports for Large 4 (524,288). Mistral's
 * model page publishes a 1M context, but the served window is the smaller
 * number, so this is what the context meter counts against.
 */
export const MISTRAL_LARGE_4_CONTEXT_WINDOW = 524_288

/**
 * The shared fields of the Vibe-plan row for Large 4, so the desktop picker,
 * the Host catalogue and the TUI all name it the same way.
 */
export const MISTRAL_LARGE_4_VIBE_ROW = {
  id: MISTRAL_LARGE_4_VIBE_MODEL_ID,
  label: MISTRAL_LARGE_4_VIBE_MODEL_LABEL,
  description: 'Vibe plan quota - needs a mistral-large-4 entry in your ~/.vibe/config.toml',
  defaultReasoningEffort: 'high'
} as const

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
  // Hosted GLM-5.2 (Vibe subscription) exposes the same off/low/medium/high/max ladder.
  'glm-5-2',
  // Hosted GLM-5.3 (Vibe subscription, added 2026-09-21) — same ladder as 5.2.
  'glm-5-3',
  // Mistral Large 4 (API key, added 2026-10-06). docs.mistral.ai lists it with
  // adjustable `reasoning_effort`; Vibe maps this ladder onto its none/high.
  MISTRAL_LARGE_4_MODEL_ID,
  // The same model on the Vibe plan: same ladder, different lane.
  MISTRAL_LARGE_4_VIBE_MODEL_ID,
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
  const id = String(modelId || '')
    .trim()
    .toLowerCase()
  return MISTRAL_THINKING_CAPABLE_MODEL_IDS.has(id)
}

/**
 * Check if a Pi namespace model ID is a Mistral model that supports
 * configurable Thinking levels when routed through the Pi BYOK lane.
 */
export function isPiMistralThinkingCapableModel(modelId: string | null | undefined): boolean {
  const id = String(modelId || '')
    .trim()
    .toLowerCase()
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
  const effort = String(value || '')
    .trim()
    .toLowerCase()
  const validEfforts = MISTRAL_REASONING_EFFORTS.map((effortOption) => effortOption.reasoningEffort)
  return validEfforts.includes(effort as any) ? effort : fallback
}
