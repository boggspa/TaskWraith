import { providerLabel } from './EnsemblePrompt'
import type { NormalizedProviderUsageSnapshot } from './ProviderQuotaSnapshots'
import { summarizeProviderUsage, type ProviderUsageSummary } from './ProviderUsageStatus'
import { getStaticProviderModels } from './providers/StaticProviderModels'
import { selectableProviderIds } from './settings/MainSanitizers'
import type { ProviderId } from './store/types'
import { isContextWindowProviderId, resolveContextWindow } from '../shared/contextWindows'

export interface EnsembleParticipantModelCatalogEntry {
  id: string
  label: string
  contextWindow: number
  isDefault?: boolean
  description?: string
  reasoningEfforts?: Array<{
    id: string
    disabled?: boolean
    disabledReason?: string
  }>
  defaultReasoningEffort?: string
  speedTiers?: string[]
}

export interface EnsembleParticipantProviderCatalogEntry {
  provider: ProviderId
  label: string
  /** Runtime/auth configuration probe when the caller can afford one. */
  configured?: boolean
  usage: ProviderUsageSummary
  models: EnsembleParticipantModelCatalogEntry[]
}

function staticModelRecord(model: unknown): Record<string, any> | null {
  return model && typeof model === 'object' && !Array.isArray(model)
    ? (model as Record<string, any>)
    : null
}

function modelReasoningEfforts(
  model: Record<string, any>
): EnsembleParticipantModelCatalogEntry['reasoningEfforts'] | undefined {
  if (!Array.isArray(model.supportedReasoningEfforts)) return undefined
  const efforts = model.supportedReasoningEfforts
    .map((entry: unknown) => {
      if (typeof entry === 'string' && entry.trim()) return { id: entry.trim() }
      const record = staticModelRecord(entry)
      if (!record) return null
      const id = typeof record.reasoningEffort === 'string' ? record.reasoningEffort.trim() : ''
      if (!id) return null
      return {
        id,
        ...(record.disabled === true ? { disabled: true } : {}),
        ...(typeof record.disabledReason === 'string' && record.disabledReason.trim()
          ? { disabledReason: record.disabledReason.trim() }
          : {})
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  return efforts.length > 0 ? efforts : undefined
}

export function buildEnsembleParticipantModelCatalog(
  provider: ProviderId
): EnsembleParticipantModelCatalogEntry[] {
  return getStaticProviderModels(provider)
    .map((model) => {
      const record = staticModelRecord(model)
      if (!record) return null
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      if (!id) return null
      const label = typeof record.label === 'string' && record.label.trim() ? record.label.trim() : id
      const reasoningEfforts = modelReasoningEfforts(record)
      return {
        id,
        label,
        contextWindow: resolveContextWindow(
          isContextWindowProviderId(provider) ? provider : undefined,
          id
        ),
        ...(record.isDefault === true ? { isDefault: true } : {}),
        ...(typeof record.description === 'string' && record.description.trim()
          ? { description: record.description.trim() }
          : {}),
        ...(reasoningEfforts ? { reasoningEfforts } : {}),
        ...(typeof record.defaultReasoningEffort === 'string' &&
        record.defaultReasoningEffort.trim()
          ? { defaultReasoningEffort: record.defaultReasoningEffort.trim() }
          : {}),
        ...(Array.isArray(record.additionalSpeedTiers)
          ? {
              speedTiers: record.additionalSpeedTiers.filter(
                (tier): tier is string => typeof tier === 'string'
              )
            }
          : {})
      }
    })
    .filter((entry): entry is EnsembleParticipantModelCatalogEntry => Boolean(entry))
}

export function buildEnsembleParticipantProviderCatalog(
  getProviderUsageSnapshot?: (
    provider: ProviderId
  ) => NormalizedProviderUsageSnapshot | null | undefined,
  configuredProviders?: ReadonlySet<ProviderId>
): EnsembleParticipantProviderCatalogEntry[] {
  return selectableProviderIds().map((provider) => {
    const usage = summarizeProviderUsage(provider, getProviderUsageSnapshot?.(provider))
    return {
      provider,
      label: providerLabel(provider),
      ...(configuredProviders
        ? { configured: configuredProviders.has(provider) || usage.configured }
        : {}),
      usage,
      models: buildEnsembleParticipantModelCatalog(provider)
    }
  })
}
