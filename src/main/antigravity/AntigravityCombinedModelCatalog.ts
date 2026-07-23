import type { AppSettings, ProviderId } from '../store/types'
import { isAntigravityOptInEnabled } from '../../shared/retiredProviders'
import {
  discoverAuthenticatedAntigravityGeminiApiModels,
  type AntigravityGeminiApiDiscoveredModel
} from './AntigravityGeminiApiModelDiscovery'
import type { AntigravityGeminiApiSecretStore } from './AntigravityGeminiApiSecretStore'
import {
  discoverAuthenticatedAgyModels,
  type AuthenticatedAgyModelDiscoveryDependencies
} from './AntigravityModelDiscovery'

export interface AntigravityCombinedCatalogModel {
  readonly id: string
  readonly label: string
}

export interface AntigravityCombinedModelCatalogDependencies {
  readonly discoverAgy?: (
    settings: Pick<AppSettings, 'antigravityEnabled' | 'antigravityOptInAcceptedAt'>
  ) => Promise<readonly AntigravityCombinedCatalogModel[]>
  readonly discoverGeminiApi?: typeof discoverAuthenticatedAntigravityGeminiApiModels
  readonly getSecretStore: () => Pick<AntigravityGeminiApiSecretStore, 'loadApiKey'> | null
  readonly agyDependencies?: AuthenticatedAgyModelDiscoveryDependencies
  readonly geminiApiLoadSdk?: Parameters<typeof discoverAuthenticatedAntigravityGeminiApiModels>[1]['loadSdk']
  readonly timeoutMs?: number
}

const DEFAULT_LANE_TIMEOUT_MS = 900
const MAX_CATALOG_MODELS = 128
const API_LABEL_PREFIX = 'Gemini API'

export function isAntigravityGeminiApiModelId(value: unknown): value is string {
  return typeof value === 'string' && /^gemini-api:gemini-[a-z0-9][a-z0-9._-]{0,127}$/.test(value)
}

export function hasAuthenticatedAgyCatalogRow(
  models: readonly AntigravityCombinedCatalogModel[] | null | undefined
): boolean {
  return Boolean(models?.some((model) => !isAntigravityGeminiApiModelId(model.id)))
}

export function isAuthenticatedAgyRateLimitConnection(
  snapshot: { ready: boolean; configuredProviders: ReadonlySet<string> },
  models: readonly AntigravityCombinedCatalogModel[] | null | undefined
): boolean {
  return (
    snapshot.ready &&
    snapshot.configuredProviders.has('antigravity') &&
    hasAuthenticatedAgyCatalogRow(models)
  )
}

/**
 * Independently probes the two authenticated AntiGravity lanes and projects
 * only bounded, nonsecret picker rows. A failed lane never suppresses the
 * other lane and this function never invokes either transport runtime.
 */
export async function discoverAuthenticatedAntigravityCombinedModels(
  settings:
    | Pick<
        AppSettings,
        'antigravityEnabled' | 'antigravityOptInAcceptedAt' | 'antigravityGeminiApiDisclosureAcceptedAt'
      >
    | null
    | undefined,
  deps: AntigravityCombinedModelCatalogDependencies
): Promise<AntigravityCombinedCatalogModel[]> {
  if (!isAntigravityOptInEnabled(settings)) return []

  const timeoutMs =
    Number.isFinite(deps.timeoutMs) && (deps.timeoutMs ?? 0) > 0
      ? Math.floor(deps.timeoutMs!)
      : DEFAULT_LANE_TIMEOUT_MS
  const discoverAgy = deps.discoverAgy ?? ((value) => discoverAuthenticatedAgyModels(value, deps.agyDependencies))
  const discoverGeminiApi = deps.discoverGeminiApi ?? discoverAuthenticatedAntigravityGeminiApiModels

  const admittedSettings = settings!
  const [agy, api] = await Promise.all([
    boundedLane(() => discoverAgy(admittedSettings), timeoutMs),
    boundedLane(
      () => {
        const secretStore = deps.getSecretStore()
        if (!secretStore) {
          return Promise.resolve({ status: 'keyUnavailable' as const, models: [] as const })
        }
        return discoverGeminiApi(admittedSettings, {
          secretStore,
          loadSdk: deps.geminiApiLoadSdk
        })
      },
      timeoutMs
    )
  ])

  const rows: AntigravityCombinedCatalogModel[] = []
  const seen = new Set<string>()
  for (const model of agy.status === 'ok' ? agy.value : []) {
    if (!isSafeModelRow(model) || seen.has(model.id)) continue
    seen.add(model.id)
    rows.push({ id: model.id, label: model.label })
    if (rows.length >= MAX_CATALOG_MODELS) return rows
  }
  if (api.status === 'ok' && api.value.status === 'ok') {
    for (const model of api.value.models) {
      const row = projectGeminiApiModel(model)
      if (!row || seen.has(row.id)) continue
      seen.add(row.id)
      rows.push(row)
      if (rows.length >= MAX_CATALOG_MODELS) break
    }
  }
  return rows
}

function projectGeminiApiModel(
  model: AntigravityGeminiApiDiscoveredModel
): AntigravityCombinedCatalogModel | null {
  if (
    !model ||
    !isAntigravityGeminiApiModelId(model.id) ||
    typeof model.modelId !== 'string' ||
    !model.modelId
  ) {
    return null
  }
  return {
    id: model.id,
    label: `${API_LABEL_PREFIX} · ${model.modelId} · separate billing`
  }
}

function isSafeModelRow(value: unknown): value is AntigravityCombinedCatalogModel {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { label?: unknown }).label === 'string' &&
    (value as { id: string }).id.length > 0 &&
    (value as { label: string }).label.length > 0 &&
    (value as { id: string }).id.length <= 512 &&
    (value as { label: string }).label.length <= 512
  )
}

async function boundedLane<T>(
  run: () => Promise<T>,
  timeoutMs: number
): Promise<{ status: 'ok'; value: T } | { status: 'failed' }> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ status: 'failed' })
    }, timeoutMs)
    timer.unref?.()
    void Promise.resolve()
      .then(run)
      .then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ status: 'ok', value })
        },
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ status: 'failed' })
        }
      )
  })
}

export const ANTIGRAVITY_COMBINED_MODEL_CATALOG_CONSTANTS = {
  DEFAULT_LANE_TIMEOUT_MS,
  MAX_CATALOG_MODELS
} as const

export type AntigravityCombinedCatalogProviderId = Extract<ProviderId, 'antigravity'>
