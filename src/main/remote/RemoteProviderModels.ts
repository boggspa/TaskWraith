import type { ProviderModelOption, ProviderModelsMessage } from '../BridgeBroadcaster'
import { PROVIDER_MODEL_CATALOG_MAX_MODELS_PER_PROVIDER } from '../../shared/providerModelCatalogLimits'

type ProviderModelLoader<Provider extends string> = (
  provider: Provider
) => unknown | Promise<unknown>

interface ProviderModelSourceRow {
  id: string
  label?: unknown
  isDefault?: unknown
  disabled?: unknown
  disabledReason?: unknown
  supportedReasoningEfforts?: unknown
  defaultReasoningEffort?: unknown
  contextWindow?: unknown
}

function isProviderModelSourceRow(value: unknown): value is ProviderModelSourceRow {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string'
  )
}

function normalizeReasoningOptions(
  value: unknown
): ProviderModelOption['supportedReasoningEfforts'] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (
        option
      ): option is {
        reasoningEffort: string
        description?: string
        disabled?: boolean
        disabledReason?: string
      } =>
        Boolean(option) &&
        typeof option === 'object' &&
        typeof (option as { reasoningEffort?: unknown }).reasoningEffort === 'string'
    )
    .map((option) => ({
      reasoningEffort: option.reasoningEffort,
      ...(typeof option.description === 'string' ? { description: option.description } : {}),
      ...(option.disabled === true ? { disabled: true } : {}),
      ...(typeof option.disabledReason === 'string'
        ? { disabledReason: option.disabledReason }
        : {})
    }))
}

function normalizeProviderModel(row: ProviderModelSourceRow): ProviderModelOption {
  return {
    id: row.id,
    label: typeof row.label === 'string' ? row.label : row.id,
    isDefault: Boolean(row.isDefault),
    ...(row.disabled === true ? { disabled: true } : {}),
    ...(typeof row.disabledReason === 'string' ? { disabledReason: row.disabledReason } : {}),
    supportedReasoningEfforts: normalizeReasoningOptions(row.supportedReasoningEfforts),
    defaultReasoningEffort:
      typeof row.defaultReasoningEffort === 'string' ? row.defaultReasoningEffort : null,
    ...(typeof row.contextWindow === 'number' &&
    Number.isSafeInteger(row.contextWindow) &&
    row.contextWindow > 0
      ? { contextWindow: row.contextWindow }
      : {})
  }
}

/**
 * Assemble the bounded wire catalog without interpreting provider/model ids.
 * A failed provider query is isolated to that provider so one unavailable CLI
 * cannot blank every picker.
 */
export async function buildRemoteProviderModelsMessage<Provider extends string>(
  providerIds: readonly Provider[],
  loadModels: ProviderModelLoader<Provider>
): Promise<ProviderModelsMessage> {
  const providers = await Promise.all(
    providerIds.map(async (provider) => {
      let source: unknown
      try {
        source = await loadModels(provider)
      } catch {
        source = []
      }
      const models = (Array.isArray(source) ? source : [])
        .filter(isProviderModelSourceRow)
        .slice(0, PROVIDER_MODEL_CATALOG_MAX_MODELS_PER_PROVIDER)
        .map(normalizeProviderModel)
      return { provider, models }
    })
  )
  return { providers: providers.filter((entry) => entry.models.length > 0) }
}

export interface RemoteProviderModelsPublisher {
  refresh: () => Promise<boolean>
}

export function createRemoteProviderModelsPublisher(deps: {
  build: () => ProviderModelsMessage | Promise<ProviderModelsMessage>
  publish: (message: ProviderModelsMessage) => void
  onError?: (error: unknown) => void
}): RemoteProviderModelsPublisher {
  let generation = 0
  return {
    refresh: async () => {
      const requestGeneration = ++generation
      try {
        const message = await deps.build()
        if (requestGeneration !== generation) return false
        deps.publish(message)
        return true
      } catch (error) {
        if (requestGeneration === generation) deps.onError?.(error)
        return false
      }
    }
  }
}

export interface ReplayableTrigger {
  request: () => void
  register: (trigger: () => void) => void
}

/**
 * Coalesce requests made before late-bound app-ready wiring, then replay one
 * when the consumer registers. Requests after registration run immediately.
 */
export function createReplayableTrigger(): ReplayableTrigger {
  let trigger: (() => void) | null = null
  let pending = false
  return {
    request: () => {
      if (trigger) trigger()
      else pending = true
    },
    register: (next) => {
      trigger = next
      if (!pending) return
      pending = false
      next()
    }
  }
}
