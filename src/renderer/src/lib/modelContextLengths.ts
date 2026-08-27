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
import {
  isContextWindowProviderId,
  resolveContextWindow,
  formatContextTokens
} from './contextWindows'
import {
  KIMI_256K_CONTEXT_WINDOW,
  KIMI_K3_LONG_CONTEXT_WINDOW,
  KIMI_K3_MODEL_ID
} from '../../../shared/kimiModels'

// Catalog entries that are router/selection ALIASES, not concrete models, so
// they have no single official context window of their own (their effective
// window depends on what they route to). Excluded from the per-model table —
// the user asked for the official length "for each model".
const NON_MODEL_ALIAS_IDS = new Set<string>(['auto'])

export interface ModelContextLengthRow {
  modelId: string          // canonical model id, e.g. 'claude-opus-4-8-1m'
  label: string            // curated catalog picker label, e.g. 'Claude Opus 4.8 1M'
  contextWindow: number    // resolved base/default window in tokens
  maxContextWindow?: number // plan-dependent upper bound, when different
  formatted: string        // e.g. '1.0M', '256k', or plan-dependent '256k–1.0M'
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
        const contextWindow = resolveContextWindow(
          isContextWindowProviderId(provider) ? provider : undefined,
          opt.id
        )
        const maxContextWindow =
          provider === 'kimi' && opt.id === KIMI_K3_MODEL_ID
            ? KIMI_K3_LONG_CONTEXT_WINDOW
            : undefined
        const formattedContextWindow =
          provider === 'kimi' && contextWindow === KIMI_256K_CONTEXT_WINDOW
            ? '256k'
            : formatContextTokens(contextWindow)
        return {
          modelId: opt.id,
          label: opt.label,
          contextWindow,
          ...(maxContextWindow ? { maxContextWindow } : {}),
          formatted: maxContextWindow
            ? `${formattedContextWindow}–${formatContextTokens(maxContextWindow)}`
            : formattedContextWindow
        }
      })
    if (models.length > 0) {
      groups.push({ provider, models })
    }
  }

  return groups
}
