import type { AppSettings, ProviderId } from '../store/types'
import { isAntigravityOptInEnabled } from '../../shared/retiredProviders'
import {
  discoverAuthenticatedAntigravityGeminiApiModels,
  type AntigravityGeminiApiDiscoveredModel,
  type AntigravityGeminiApiDiscoveryResult,
  type AntigravityGeminiApiDiscoveryStatus
} from './AntigravityGeminiApiModelDiscovery'
import {
  antigravityGeminiApiStaticModels,
  formatAntigravityGeminiApiLabel
} from './AntigravityGeminiApiStaticModels'
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
  readonly geminiApiLoadSdk?: Parameters<
    typeof discoverAuthenticatedAntigravityGeminiApiModels
  >[1]['loadSdk']
  readonly timeoutMs?: number
}

const DEFAULT_LANE_TIMEOUT_MS = 900
const MAX_CATALOG_MODELS = 128

/**
 * Discovery outcomes that mean "a key is configured, we asked, and could not
 * confirm the catalogue" — the case the static fallback covers. Statuses that
 * mean there is nothing to offer at all (`keyUnavailable`, `disclosureRequired`,
 * `sdkUnavailable`) or that the caller withdrew (`cancelled`) are excluded, so
 * an unconfigured lane still contributes no rows.
 */
const UNVERIFIED_KEY_STATUSES: ReadonlySet<AntigravityGeminiApiDiscoveryStatus> = new Set([
  'unauthorized',
  'rateLimited',
  'projectLimited',
  'unavailable',
  'invalidResponse',
  'empty'
])

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
 *
 * Lane admission is intentionally independent, not a single blanket gate:
 * the agy lane is admitted only by the ban-risk opt-in (unchanged); the
 * Gemini API-key lane is admitted by a configured dedicated secret store
 * alone and does not require opt-in — its own internal Gemini-API data-use
 * disclosure check still applies inside `discoverGeminiApi`.
 */
export async function discoverAuthenticatedAntigravityCombinedModels(
  settings:
    | Pick<
        AppSettings,
        | 'antigravityEnabled'
        | 'antigravityOptInAcceptedAt'
        | 'antigravityGeminiApiDisclosureAcceptedAt'
      >
    | null
    | undefined,
  deps: AntigravityCombinedModelCatalogDependencies
): Promise<AntigravityCombinedCatalogModel[]> {
  if (!settings) return []

  const agyAdmitted = isAntigravityOptInEnabled(settings)
  const secretStore = deps.getSecretStore()
  const apiAdmitted = Boolean(secretStore)
  if (!agyAdmitted && !apiAdmitted) return []

  const timeoutMs =
    Number.isFinite(deps.timeoutMs) && (deps.timeoutMs ?? 0) > 0
      ? Math.floor(deps.timeoutMs!)
      : DEFAULT_LANE_TIMEOUT_MS
  const discoverAgy =
    deps.discoverAgy ?? ((value) => discoverAuthenticatedAgyModels(value, deps.agyDependencies))
  const discoverGeminiApi =
    deps.discoverGeminiApi ?? discoverAuthenticatedAntigravityGeminiApiModels

  const [agy, api] = await Promise.all([
    agyAdmitted
      ? boundedLane(() => discoverAgy(settings), timeoutMs)
      : Promise.resolve({ status: 'ok' as const, value: [] as AntigravityCombinedCatalogModel[] }),
    apiAdmitted
      ? boundedLane(
          () =>
            discoverGeminiApi(settings, {
              secretStore: secretStore!,
              loadSdk: deps.geminiApiLoadSdk
            }),
          timeoutMs
        )
      : Promise.resolve({
          status: 'ok' as const,
          value: { status: 'keyUnavailable' as const, models: [] as const }
        })
  ])

  const rows: AntigravityCombinedCatalogModel[] = []
  const seen = new Set<string>()
  for (const model of agy.status === 'ok' ? agy.value : []) {
    if (!isSafeModelRow(model) || seen.has(model.id)) continue
    seen.add(model.id)
    rows.push({ id: model.id, label: model.label })
    if (rows.length >= MAX_CATALOG_MODELS) return rows
  }
  const apiRows =
    api.status === 'ok' && api.value.status === 'ok'
      ? api.value.models.map(projectGeminiApiModel)
      : offersUnverifiedKeyFallback(apiAdmitted, api)
        ? antigravityGeminiApiStaticModels()
        : []
  for (const row of apiRows) {
    if (!row || seen.has(row.id)) continue
    seen.add(row.id)
    rows.push(row)
    if (rows.length >= MAX_CATALOG_MODELS) break
  }
  return rows
}

/**
 * A configured key whose catalogue we could not verify still offers the static
 * rows, so one failed probe cannot make the provider vanish everywhere. A
 * timed-out lane counts: the key was there and we simply never heard back.
 */
function offersUnverifiedKeyFallback(
  apiAdmitted: boolean,
  api: { status: 'ok'; value: AntigravityGeminiApiDiscoveryResult } | { status: 'failed' }
): boolean {
  if (!apiAdmitted) return false
  if (api.status === 'failed') return true
  return UNVERIFIED_KEY_STATUSES.has(api.value.status)
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
    label: formatAntigravityGeminiApiLabel(model.modelId)
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
