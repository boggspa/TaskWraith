import { isOllamaCloudModelId } from '../../shared/ollamaModelAvailability'
import type { ProviderId } from '../store/types'
import { isConcreteUltraTaskModelId } from './UltraTaskCapabilityResolver'

export type UltraTaskQuotaKind = 'metered' | 'not_applicable' | 'unknown'
export type UltraTaskQuotaSatisfaction = 'all' | 'any'

export interface UltraTaskQuotaBinding {
  kind: UltraTaskQuotaKind
  /** Exact pool identities for this model/lane only. Never provider-wide
   * wildcard state: an exhausted bespoke pool must not disable siblings. */
  poolIds: string[]
  satisfaction: UltraTaskQuotaSatisfaction
}

const binding = (
  kind: UltraTaskQuotaKind,
  poolIds: readonly string[] = [],
  satisfaction: UltraTaskQuotaSatisfaction = 'all'
): UltraTaskQuotaBinding => ({ kind, poolIds: [...new Set(poolIds)], satisfaction })

/**
 * Stable model/lane → quota-pool contract. Snapshot fetchers remain separate;
 * they publish these ids when evidence exists. Missing mappings stay unknown
 * instead of borrowing another model family's exhaustion.
 */
export function resolveUltraTaskQuotaBinding(
  provider: ProviderId,
  modelId: string
): UltraTaskQuotaBinding {
  if (!isConcreteUltraTaskModelId(modelId)) return binding('unknown')
  const model = modelId.trim().toLowerCase()

  switch (provider) {
    case 'codex':
      return binding('metered', [
        model === 'gpt-5.3-codex-spark' ? 'codex:spark' : 'codex:standard'
      ])
    case 'claude':
      return binding('metered', [model.includes('fable') ? 'claude:fable' : 'claude:standard'])
    case 'antigravity':
      if (model.startsWith('gemini-api:')) {
        return binding('metered', ['antigravity:gemini-api-budget'])
      }
      if (model.includes('claude')) return binding('metered', ['antigravity:claude'])
      if (model.includes('gpt') || model.includes('openai')) {
        return binding('metered', ['antigravity:gpt'])
      }
      if (model.includes('gemini') || model.includes('flash')) {
        return binding('metered', ['antigravity:gemini'])
      }
      return binding('unknown')
    case 'ollama':
      return isOllamaCloudModelId(modelId)
        ? binding('metered', ['ollama:cloud'])
        : binding('not_applicable')
    case 'pi': {
      const slash = model.indexOf('/')
      return slash > 0 ? binding('metered', [`pi:${model.slice(0, slash)}`]) : binding('unknown')
    }
    case 'muse':
      return binding('metered', ['muse:monthly-budget'])
    case 'mistral':
      return binding('metered', ['mistral:subscription'])
    case 'kimi':
      return binding('metered', ['kimi:subscription'])
    case 'grok':
      return binding('metered', ['grok:subscription'])
    case 'cursor':
      return binding('metered', ['cursor:subscription'])
    case 'gemini':
      return binding('metered', ['gemini:standard'])
    default:
      return binding('unknown')
  }
}
