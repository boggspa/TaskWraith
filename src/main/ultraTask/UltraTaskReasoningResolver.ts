/**
 * UltraTaskReasoningResolver.ts
 *
 * Resolves the highest available reasoning tier for any provider/model combination.
 * This enables the "UltraTask" philosophy: auto-select maximum reasoning + encourage
 * multi-agent delegation patterns.
 */
import type { ProviderId } from '../store/types'
import { getStaticProviderModels } from '../providers/StaticProviderModels'

/**
 * Known reasoning effort tiers in order from lowest to highest.
 * Used for fallback when a provider doesn't have explicit ultra/ultracode support.
 */
const REASONING_EFFORT_HIERARCHY = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode'
] as const

export type ReasoningEffort = (typeof REASONING_EFFORT_HIERARCHY)[number]

/**
 * Normalizes non-standard effort tokens (such as Kimi 'on') to standard hierarchy tiers.
 */
function normalizeEffortToken(effort: string): ReasoningEffort {
  const lowered = effort.trim().toLowerCase()
  if (lowered === 'on') return 'high'
  if (REASONING_EFFORT_HIERARCHY.includes(lowered as ReasoningEffort)) {
    return lowered as ReasoningEffort
  }
  return 'none'
}

/**
 * Type guard for models with ultraTaskSupported property.
 */
function hasUltraTaskSupport(model: unknown): model is { ultraTaskSupported: boolean } {
  return typeof model === 'object' && model !== null && 'ultraTaskSupported' in model
}

/**
 * Type guard for models with supportedReasoningEfforts property.
 */
function hasSupportedReasoningEfforts(model: unknown): model is { supportedReasoningEfforts: Array<{ reasoningEffort: string; disabled?: boolean }> } {
  return typeof model === 'object' && model !== null && 'supportedReasoningEfforts' in model
}

/**
 * Type guard for models with defaultReasoningEffort property.
 */
function hasDefaultReasoningEffort(model: unknown): model is { defaultReasoningEffort: string } {
  return typeof model === 'object' && model !== null && 'defaultReasoningEffort' in model
}

/**
 * Resolve the highest available reasoning effort for a given provider and model.
 *
 * Strategy:
 * 1. Retrieve the static provider model catalog via getStaticProviderModels(provider)
 * 2. Locate the model entry by ID or alias
 * 3. Inspect supportedReasoningEfforts and select the highest ranking tier in the hierarchy
 * 4. Respect ultraTaskSupported: false by returning 'none'
 * 5. Fallback to defaultReasoningEffort or provider-level defaults
 */
export function resolveUltraTaskReasoningEffort(
  provider: ProviderId,
  modelId: string
): ReasoningEffort {
  const normalizedModel = String(modelId || '').trim().toLowerCase()
  const normalizedProvider = (provider ? provider.toLowerCase() : '') as ProviderId

  let models: unknown[] = []
  try {
    models = getStaticProviderModels(normalizedProvider)
  } catch {
    models = []
  }

  const model = models.find((m: any) => {
    const id = m.id.toLowerCase()
    return (
      id === normalizedModel ||
      id === normalizedModel.replace(/^claude-/, '') ||
      normalizedModel.startsWith(id)
    )
  })

  if (model) {
    if (hasUltraTaskSupport(model) && model.ultraTaskSupported === false) {
      return 'none'
    }
    if (hasSupportedReasoningEfforts(model) && model.supportedReasoningEfforts.length > 0) {
      let highestRank = -1
      let highestEffort: ReasoningEffort = 'none'
      for (const entry of model.supportedReasoningEfforts) {
        if (entry.disabled) continue
        const norm = normalizeEffortToken(entry.reasoningEffort)
        const rank = REASONING_EFFORT_HIERARCHY.indexOf(norm)
        if (rank > highestRank) {
          highestRank = rank
          highestEffort = norm
        }
      }
      if (highestEffort !== 'none') {
        return highestEffort
      }
    }
    if (hasDefaultReasoningEffort(model)) {
      const norm = normalizeEffortToken(model.defaultReasoningEffort)
      if (norm !== 'none') {
        return norm
      }
    }
  }

  // Fallback: provider-level defaults
  switch (normalizedProvider) {
    case 'codex':
      return 'xhigh'
    case 'claude':
      return 'high'
    case 'kimi':
      return 'high'
    case 'grok':
      return 'xhigh'
    case 'cursor':
    case 'ollama':
    case 'pi':
    case 'mistral':
    case 'muse':
      return 'high'
    default:
      return 'high'
  }
}

/**
 * Check if a provider/model combination supports UltraTask.
 * UltraTask is supported when:
 * - The provider has at least one reasoning effort tier
 * - The model is not explicitly excluded
 *
 * @param provider - The provider identifier
 * @param modelId - The model identifier
 * @returns True if UltraTask is supported for this provider/model
 */
export function isUltraTaskSupported(provider: ProviderId, modelId: string): boolean {
  const normalizedModel = String(modelId || '').trim().toLowerCase()
  const normalizedProvider = (provider ? provider.toLowerCase() : '') as ProviderId

  let models: unknown[] = []
  try {
    models = getStaticProviderModels(normalizedProvider)
  } catch {
    models = []
  }

  const model = models.find((m: any) => {
    const id = m.id.toLowerCase()
    return (
      id === normalizedModel ||
      id === normalizedModel.replace(/^claude-/, '') ||
      normalizedModel.startsWith(id)
    )
  })
  if (model) {
    if (hasUltraTaskSupport(model)) {
      if (model.ultraTaskSupported === false) {
        return false
      }
      if (model.ultraTaskSupported === true) {
        return true
      }
    }
  }

  const effort = resolveUltraTaskReasoningEffort(provider, modelId)
  return effort !== 'none'
}

/**
 * Get all available reasoning efforts for a provider/model, sorted by hierarchy.
 *
 * @param provider - The provider identifier
 * @param modelId - The model identifier
 * @returns Array of available reasoning efforts, sorted from lowest to highest
 */
export function getAvailableReasoningEfforts(
  provider: ProviderId,
  modelId: string
): ReasoningEffort[] {
  const highestEffort = resolveUltraTaskReasoningEffort(provider, modelId)
  const highestIndex = REASONING_EFFORT_HIERARCHY.indexOf(highestEffort)

  if (highestIndex <= 0) {
    return ['high']
  }

  // Return all efforts from 'low' up to and including the highest
  // Skip 'none' (index 0) as it's not a valid selectable effort
  return REASONING_EFFORT_HIERARCHY.slice(1, highestIndex + 1)
}

/**
 * Compare two reasoning efforts and determine which is higher.
 *
 * @param a - First reasoning effort
 * @param b - Second reasoning effort
 * @returns 1 if a > b, -1 if a < b, 0 if equal
 */
export function compareReasoningEfforts(a: string, b: string): number {
  const indexA = REASONING_EFFORT_HIERARCHY.indexOf(a as ReasoningEffort)
  const indexB = REASONING_EFFORT_HIERARCHY.indexOf(b as ReasoningEffort)

  if (indexA === -1 || indexB === -1) {
    return 0
  }

  return Math.sign(indexA - indexB)
}
