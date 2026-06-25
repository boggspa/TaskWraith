/**
 * modelContextLengths — per-provider, per-model official context window table.
 *
 * Joins the user-facing model catalog (ensembleProviderDefaults) with the
 * official static windows (resolveContextWindow over the Codex-owned
 * shared/contextWindows table — READ ONLY). The result is a flat list of
 * ModelContextLengthGroup values suitable for display in the Settings →
 * Model Usage tab.
 *
 * Ollama is excluded by default: its conservative UI fallbacks (e.g. 256k for
 * qwen3.5:9b) are not vendor-official context windows but rather safe
 * upper-bounds chosen for the composer context meter. Pass
 * `{ includeOllama: true }` to include them anyway. `excludeProviders` drops
 * whole providers (e.g. the sidebar variant omits Gemini for space).
 *
 * Pure module — no React, no component imports.
 */

import type { ProviderId } from '../../../main/store/types'
import { MODEL_USAGE_PROVIDER_ORDER } from './modelUsageTable'
import { getEnsembleModelDefaults } from './ensembleProviderDefaults'
import { resolveContextWindow, formatContextTokens } from './contextWindows'

// Catalog entries that are router/selection ALIASES, not concrete models, so
// they have no single official context window of their own (their effective
// window depends on what they route to). Excluded from the per-model table —
// the user asked for the official length "for each model".
const NON_MODEL_ALIAS_IDS = new Set<string>(['auto'])

export interface ModelContextLengthRow {
  modelId: string          // canonical model id, e.g. 'claude-opus-4-8-1m'
  label: string            // curated catalog picker label, e.g. 'Claude Opus 4.8 1M'
  contextWindow: number    // resolved official window in tokens
  formatted: string        // formatContextTokens(contextWindow), e.g. '1.0M' / '256k' / '200k'
}

export interface ModelContextLengthGroup {
  provider: ProviderId
  models: ModelContextLengthRow[]
}

export function buildModelContextLengthGroups(
  options?: { includeOllama?: boolean; excludeProviders?: ProviderId[] }
): ModelContextLengthGroup[] {
  const excluded = new Set<ProviderId>(options?.excludeProviders ?? [])
  const order: ProviderId[] = [
    ...MODEL_USAGE_PROVIDER_ORDER,
    ...(options?.includeOllama ? (['ollama'] as const) : [])
  ].filter((provider) => !excluded.has(provider))

  const groups: ModelContextLengthGroup[] = []
  for (const provider of order) {
    const models = getEnsembleModelDefaults(provider)
      .modelOptions.filter((opt) => !NON_MODEL_ALIAS_IDS.has(opt.id))
      .map((opt) => {
        const contextWindow = resolveContextWindow(provider, opt.id)
        return {
          modelId: opt.id,
          label: opt.label,
          contextWindow,
          formatted: formatContextTokens(contextWindow)
        }
      })
    if (models.length > 0) {
      groups.push({ provider, models })
    }
  }

  return groups
}
