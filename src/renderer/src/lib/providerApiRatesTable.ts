import type { ProviderId } from '../../../main/store/types'
import { MODEL_USAGE_PROVIDER_ORDER } from './modelUsageTable'

export type ProviderApiRateStatus =
  | 'baseline'
  | 'manual-override'
  | 'verified'
  | 'not-verified'
  | 'fetch-failed'
  | 'stale-probe'

export interface ProviderApiRateRow {
  provider: ProviderId
  modelId: string
  inputUsdPerMillion: number
  cachedInputUsdPerMillion?: number
  outputUsdPerMillion: number
  longContextThresholdTokens?: number
  longContextInputUsdPerMillion?: number
  longContextCachedInputUsdPerMillion?: number
  longContextOutputUsdPerMillion?: number
  sourceUrl: string
  lastVerified: string
  notes?: string
  confidence: 'baked-in' | 'manual-override'
  status: ProviderApiRateStatus
  statusMessage?: string
}

export interface ProviderApiRateGroup {
  provider: ProviderId
  pricingUrl: string
  rateTableVersion: string
  rows: ProviderApiRateRow[]
}

const RATE_PROVIDER_ORDER: ProviderId[] = [...MODEL_USAGE_PROVIDER_ORDER]

const isFiniteNonNeg = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const providerOrder = new Map<ProviderId, number>(
  RATE_PROVIDER_ORDER.map((provider, index) => [provider, index])
)

function confidenceOf(raw: unknown): 'baked-in' | 'manual-override' {
  return raw === 'manual-override' ? 'manual-override' : 'baked-in'
}

function probeMatchesCurrentRate(probe: Record<string, unknown>, row: ProviderApiRateRow): boolean {
  const baseline = probe.baseline
  if (!baseline || typeof baseline !== 'object') return false
  const b = baseline as Record<string, unknown>
  return (
    b.inputUsdPerMillion === row.inputUsdPerMillion &&
    b.outputUsdPerMillion === row.outputUsdPerMillion &&
    b.longContextThresholdTokens === row.longContextThresholdTokens &&
    b.longContextInputUsdPerMillion === row.longContextInputUsdPerMillion &&
    b.longContextCachedInputUsdPerMillion === row.longContextCachedInputUsdPerMillion &&
    b.longContextOutputUsdPerMillion === row.longContextOutputUsdPerMillion &&
    confidenceOf(b.confidence) === row.confidence
  )
}

function dateOnlyMs(value: string | undefined): number | null {
  if (!value) return null
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  if (!match) return null
  const ms = Date.parse(`${match[1]}T00:00:00.000Z`)
  return Number.isFinite(ms) ? ms : null
}

function probeIsFreshForRow(
  probeRunAt: string | undefined,
  row: ProviderApiRateRow,
  rateTableVersion: string
): boolean {
  const probeMs = dateOnlyMs(probeRunAt)
  if (probeMs === null) return false
  const rateTableMs = dateOnlyMs(rateTableVersion)
  if (rateTableMs !== null && probeMs < rateTableMs) return false
  const rowVerifiedMs = dateOnlyMs(row.lastVerified)
  if (rowVerifiedMs !== null && probeMs < rowVerifiedMs) return false
  return true
}

function rowStatus(
  probe: Record<string, unknown> | undefined,
  row: ProviderApiRateRow,
  probeRunAt: string | undefined,
  rateTableVersion: string
): { status: ProviderApiRateStatus; statusMessage?: string } {
  if (row.confidence === 'manual-override') return { status: 'manual-override' }
  if (!probe) return { status: 'baseline' }
  if (!probeIsFreshForRow(probeRunAt, row, rateTableVersion)) {
    return {
      status: 'baseline',
      statusMessage: 'Best-effort source probe predates this rate table; baseline source link is shown.'
    }
  }
  if (!probeMatchesCurrentRate(probe, row)) {
    return {
      status: 'stale-probe',
      statusMessage: 'Probe baseline no longer matches this displayed rate.'
    }
  }
  const status = probe.status
  if (status === 'verified' || status === 'not-verified' || status === 'fetch-failed') {
    const message = typeof probe.errorMessage === 'string' ? probe.errorMessage : undefined
    return message ? { status, statusMessage: message } : { status }
  }
  return { status: 'baseline' }
}

/**
 * Builds the Settings reference table from the raw providerRates:get snapshot.
 * Keeps provenance fields that the estimator intentionally strips, and omits
 * local Ollama rows so they are not presented as paid API rates.
 */
export function buildProviderApiRateGroups(raw: unknown): ProviderApiRateGroup[] {
  if (!raw || typeof raw !== 'object') return []
  const snapshot = raw as Record<string, unknown>
  const baseline = snapshot.baseline
  if (!baseline || typeof baseline !== 'object') return []
  const rateTableVersion =
    typeof snapshot.rateTableVersion === 'string' ? snapshot.rateTableVersion : ''
  const probeResultsRaw =
    snapshot.probe &&
    typeof snapshot.probe === 'object' &&
    (snapshot.probe as Record<string, unknown>).results &&
    typeof (snapshot.probe as Record<string, unknown>).results === 'object'
      ? ((snapshot.probe as Record<string, unknown>).results as Record<string, unknown>)
      : {}
  const probeRunAt =
    snapshot.probe &&
    typeof snapshot.probe === 'object' &&
    typeof (snapshot.probe as Record<string, unknown>).runAt === 'string'
      ? ((snapshot.probe as Record<string, unknown>).runAt as string)
      : undefined

  const groups: ProviderApiRateGroup[] = []
  const providerEntries = Object.entries(baseline as Record<string, unknown>).sort(
    ([a], [b]) => (providerOrder.get(a as ProviderId) ?? 999) - (providerOrder.get(b as ProviderId) ?? 999)
  )

  for (const [providerRaw, tableRaw] of providerEntries) {
    const provider = providerRaw as ProviderId
    if (!providerOrder.has(provider)) continue
    if (!tableRaw || typeof tableRaw !== 'object') continue
    const table = tableRaw as Record<string, unknown>
    const models = table.models
    if (!Array.isArray(models)) continue
    const pricingUrl = typeof table.pricingUrl === 'string' ? table.pricingUrl : ''
    const probeTable =
      probeResultsRaw[provider] && typeof probeResultsRaw[provider] === 'object'
        ? (probeResultsRaw[provider] as Record<string, unknown>)
        : null
    const probeModels =
      probeTable && Array.isArray(probeTable.models)
        ? (probeTable.models as unknown[])
        : []
    const probeByModel = new Map<string, Record<string, unknown>>()
    for (const probeModel of probeModels) {
      if (!probeModel || typeof probeModel !== 'object') continue
      const p = probeModel as Record<string, unknown>
      if (typeof p.modelId === 'string') probeByModel.set(p.modelId, p)
    }

    const rows: ProviderApiRateRow[] = []
    for (const rawModel of models) {
      if (!rawModel || typeof rawModel !== 'object') continue
      const model = rawModel as Record<string, unknown>
      if (
        typeof model.modelId !== 'string' ||
        !isFiniteNonNeg(model.inputUsdPerMillion) ||
        !isFiniteNonNeg(model.outputUsdPerMillion)
      ) {
        continue
      }
      const cached =
        isFiniteNonNeg(model.cachedInputUsdPerMillion) &&
        model.cachedInputUsdPerMillion < model.inputUsdPerMillion
          ? model.cachedInputUsdPerMillion
          : undefined
      const hasLongContextTier =
        isFiniteNonNeg(model.longContextThresholdTokens) &&
        Number.isInteger(model.longContextThresholdTokens) &&
        model.longContextThresholdTokens > 0 &&
        isFiniteNonNeg(model.longContextInputUsdPerMillion) &&
        isFiniteNonNeg(model.longContextCachedInputUsdPerMillion) &&
        model.longContextCachedInputUsdPerMillion < model.longContextInputUsdPerMillion &&
        isFiniteNonNeg(model.longContextOutputUsdPerMillion) &&
        model.longContextOutputUsdPerMillion >= model.longContextInputUsdPerMillion
      const row: ProviderApiRateRow = {
        provider,
        modelId: model.modelId,
        inputUsdPerMillion: model.inputUsdPerMillion,
        ...(cached !== undefined ? { cachedInputUsdPerMillion: cached } : {}),
        outputUsdPerMillion: model.outputUsdPerMillion,
        ...(hasLongContextTier
          ? {
              longContextThresholdTokens: model.longContextThresholdTokens as number,
              longContextInputUsdPerMillion: model.longContextInputUsdPerMillion as number,
              longContextCachedInputUsdPerMillion:
                model.longContextCachedInputUsdPerMillion as number,
              longContextOutputUsdPerMillion: model.longContextOutputUsdPerMillion as number
            }
          : {}),
        sourceUrl: typeof model.sourceUrl === 'string' ? model.sourceUrl : pricingUrl,
        lastVerified: typeof model.lastVerified === 'string' ? model.lastVerified : '',
        notes: typeof model.notes === 'string' ? model.notes : undefined,
        confidence: confidenceOf(model.confidence),
        status: 'baseline'
      }
      const status = rowStatus(probeByModel.get(row.modelId), row, probeRunAt, rateTableVersion)
      row.status = status.status
      if (status.statusMessage) row.statusMessage = status.statusMessage
      rows.push(row)
    }

    if (rows.length > 0) {
      groups.push({ provider, pricingUrl, rateTableVersion, rows })
    }
  }

  return groups
}
