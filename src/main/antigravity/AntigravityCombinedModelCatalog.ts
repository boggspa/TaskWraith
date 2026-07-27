import type { AppSettings, ProviderId } from '../store/types'
import { isAntigravityOptInEnabled } from '../../shared/retiredProviders'
import {
  discoverAuthenticatedAntigravityGeminiApiModels,
  type AntigravityGeminiApiDiscoveredModel,
  type AntigravityGeminiApiDiscoveryResult,
  type AntigravityGeminiApiDiscoveryStatus
} from './AntigravityGeminiApiModelDiscovery'
import type { AntigravityGeminiApiDiscoveryOutcomeStatus } from './AntigravityGeminiApiDiscoveryOutcome'
import {
  antigravityGeminiApiStaticModels,
  formatAntigravityGeminiApiLabel
} from './AntigravityGeminiApiStaticModels'
import { curateAntigravityGeminiApiModels } from './AntigravityGeminiApiModelNaming'
import type { AntigravityGeminiApiSecretStore } from './AntigravityGeminiApiSecretStore'
import {
  discoverAuthenticatedAgyModels,
  type AuthenticatedAgyModelDiscoveryDependencies
} from './AntigravityModelDiscovery'
import { antigravityAgyStaticModels } from './AntigravityAgyStaticModels'
import { resolveAgyCliBinary } from './AntigravityCli'

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
  /**
   * Presence-only check for the consented AGY fallback. It runs alongside
   * model discovery so a slow `agy models` cannot erase the CLI lane before
   * the picker deadline. Omit it with a custom discoverAgy seam to keep tests
   * and alternate callers conservative unless they explicitly opt in.
   */
  readonly resolveAgyBinary?: typeof resolveAgyCliBinary
  readonly geminiApiLoadSdk?: Parameters<
    typeof discoverAuthenticatedAntigravityGeminiApiModels
  >[1]['loadSdk']
  readonly timeoutMs?: number
  /**
   * Receives the nonsecret reason this pass did or did not produce live Gemini
   * API rows. This function is the only place that sees both discovery's own
   * classification and its own lane timeout, so it is the only place that can
   * report the timeout case at all. Recording must never change which rows are
   * offered — a throwing sink is swallowed for exactly that reason.
   */
  readonly recordGeminiApiOutcome?: (outcome: {
    readonly status: AntigravityGeminiApiDiscoveryOutcomeStatus
    readonly modelCount: number
  }) => void
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
  // `agy models` is an authenticated CLI round-trip and can take longer than
  // the bounded picker probe (it takes roughly 2.4s on the currently installed
  // official CLI). Resolve the local binary concurrently so a timeout can use
  // the consented static floor without ever exposing it on a machine where agy
  // is absent. A custom `discoverAgy` owns its own binary gate unless it also
  // explicitly supplies this resolver.
  const resolveAgyBinary =
    deps.resolveAgyBinary ?? (deps.discoverAgy ? undefined : resolveAgyCliBinary)

  const [agy, api, agyBinary] = await Promise.all([
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
        }),
    agyAdmitted && resolveAgyBinary
      ? boundedLane(() => resolveAgyBinary(), timeoutMs)
      : Promise.resolve({ status: 'ok' as const, value: null })
  ])

  const liveApiRows =
    api.status === 'ok' && api.value.status === 'ok'
      ? curateAntigravityGeminiApiModels(
          api.value.models.map(projectGeminiApiModel).filter((row) => row !== null)
        )
      : null
  // Recorded before any row assembly can return early, so the outcome is
  // reported for every probed pass. The count is of curated rows actually
  // offered, not of raw `models.list` entries, so "N models available" matches
  // what the picker shows.
  if (apiAdmitted) {
    reportGeminiApiOutcome(deps.recordGeminiApiOutcome, {
      status: geminiApiOutcomeStatus(api),
      modelCount: liveApiRows?.length ?? 0
    })
  }

  const rows: AntigravityCombinedCatalogModel[] = []
  const seen = new Set<string>()
  // A timed-out AGY model list previously contributed no rows at all, even
  // after the user had accepted the ban-risk warning and the official binary
  // was present. That made every picker show only the separately billed Gemini
  // API rows. Keep the live result when it arrives; otherwise the verified
  // binary-presence result admits the static CLI floor.
  const agyRows =
    agy.status === 'ok'
      ? agy.value
      : agyBinary.status === 'ok' && Boolean(agyBinary.value?.binaryPath)
        ? antigravityAgyStaticModels()
        : []
  for (const model of agyRows) {
    if (!isSafeModelRow(model) || seen.has(model.id)) continue
    seen.add(model.id)
    rows.push({ id: model.id, label: model.label })
    if (rows.length >= MAX_CATALOG_MODELS) return rows
  }
  const apiRows =
    liveApiRows ??
    (offersUnverifiedKeyFallback(apiAdmitted, api) ? antigravityGeminiApiStaticModels() : [])
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
  api: LaneResult<AntigravityGeminiApiDiscoveryResult>
): boolean {
  if (!apiAdmitted) return false
  if (api.status === 'failed') return true
  return UNVERIFIED_KEY_STATUSES.has(api.value.status)
}

/**
 * Collapses the lane result into one reportable reason. A timed-out lane is
 * distinct from a rejected one: the key may be perfectly good and merely slow,
 * because the lane's own timeout is nested inside the caller's shorter overall
 * probe deadline.
 */
function geminiApiOutcomeStatus(
  api: LaneResult<AntigravityGeminiApiDiscoveryResult>
): AntigravityGeminiApiDiscoveryOutcomeStatus {
  if (api.status === 'ok') return api.value.status
  return api.reason === 'timeout' ? 'timedOut' : 'unavailable'
}

function reportGeminiApiOutcome(
  record: AntigravityCombinedModelCatalogDependencies['recordGeminiApiOutcome'],
  outcome: { status: AntigravityGeminiApiDiscoveryOutcomeStatus; modelCount: number }
): void {
  if (typeof record !== 'function') return
  try {
    record(outcome)
  } catch {
    // Reporting is a diagnostic side channel. It must never be able to
    // suppress the rows this pass already resolved.
  }
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

/**
 * `reason` separates "never answered in time" from "answered with a rejection".
 * Both still fall back to static rows identically; only the reported reason
 * differs, so the card can distinguish a slow network from a broken key.
 */
type LaneResult<T> = { status: 'ok'; value: T } | { status: 'failed'; reason: 'timeout' | 'error' }

async function boundedLane<T>(run: () => Promise<T>, timeoutMs: number): Promise<LaneResult<T>> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ status: 'failed', reason: 'timeout' })
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
          resolve({ status: 'failed', reason: 'error' })
        }
      )
  })
}

export const ANTIGRAVITY_COMBINED_MODEL_CATALOG_CONSTANTS = {
  DEFAULT_LANE_TIMEOUT_MS,
  MAX_CATALOG_MODELS
} as const

export type AntigravityCombinedCatalogProviderId = Extract<ProviderId, 'antigravity'>
