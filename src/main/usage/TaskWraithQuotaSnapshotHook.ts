import type { PiKeyLoadResult } from '../pi/PiKeyStore'
import type { UsageRecord } from '../store/types'
import {
  QUOTA_SNAPSHOT_HOOK_STALE_AFTER_MS,
  type QuotaSnapshotHookProviderId,
  type QuotaSnapshotHookSnapshot,
  type QuotaSnapshotHookWindow
} from '../../shared/quotaSnapshotHook'
import { resolveMuseMonthlySpendCapUsd } from '../../shared/museSpendBudget'

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const DEEPSEEK_RESPONSE_LIMIT_BYTES = 1024 * 1024
const DEEPSEEK_REQUEST_TIMEOUT_MS = 10_000
const DEEPSEEK_CACHE_TTL_MS = 5 * 60 * 1000
const DEEPSEEK_FAILURE_RETRY_MS = 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const MAX_MONEY_VALUE = 1_000_000_000_000_000

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface TaskWraithQuotaSnapshotHookDependencies {
  loadPiKeys: () => PiKeyLoadResult | null | undefined
  getUsageRecords: () => readonly UsageRecord[]
  getProviderRates: () => unknown
  getMuseConfigured: () => boolean | Promise<boolean>
  getMuseMonthlySpendCapUsd: () => number | null | undefined
  fetchImpl?: FetchLike
  now?: () => number
  deepSeekCacheTtlMs?: number
  deepSeekFailureRetryMs?: number
}

export interface DeepSeekBalanceObservation {
  isAvailable: boolean
  currency: string
  totalBalance: number
  grantedBalance: number
  toppedUpBalance: number
}

interface SpendSummary {
  currentMonthUsd: number
  last30DaysUsd: number
  runs: number
}

interface ModelRate {
  modelId: string
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  cachedInputUsdPerMillion?: number
  longContextThresholdTokens?: number
  longContextInputUsdPerMillion?: number
  longContextOutputUsdPerMillion?: number
  longContextCachedInputUsdPerMillion?: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finiteNonNegative(value: unknown, maximum = MAX_MONEY_VALUE): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null
}

function positive(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function parseDeepSeekBalanceResponse(value: unknown): DeepSeekBalanceObservation | null {
  const envelope = record(value)
  if (!envelope || typeof envelope.is_available !== 'boolean') return null
  const rows = Array.isArray(envelope.balance_infos) ? envelope.balance_infos.slice(0, 16) : []
  const parsed = rows.flatMap((candidate) => {
    const row = record(candidate)
    if (!row || typeof row.currency !== 'string') return []
    const currency = row.currency.trim().toUpperCase()
    if (!/^[A-Z]{3,8}$/.test(currency)) return []
    const totalBalance = finiteNonNegative(row.total_balance)
    const grantedBalance = finiteNonNegative(row.granted_balance)
    const toppedUpBalance = finiteNonNegative(row.topped_up_balance)
    if (totalBalance === null || grantedBalance === null || toppedUpBalance === null) return []
    return [{ currency, totalBalance, grantedBalance, toppedUpBalance }]
  })
  const selected = parsed.find((row) => row.currency === 'USD') ?? parsed[0]
  if (!selected) return null
  return { isAvailable: envelope.is_available, ...selected }
}

function formatMoney(amount: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : ''
  const value = amount.toFixed(2)
  return symbol ? `${symbol}${value}` : `${value} ${currency}`
}

function fetchedAt(now: number): string {
  return new Date(Number.isFinite(now) ? now : Date.now()).toISOString()
}

function emptySnapshot(
  provider: QuotaSnapshotHookProviderId,
  now: number,
  configured: boolean,
  error?: string
): QuotaSnapshotHookSnapshot {
  return {
    provider,
    source: 'taskwraith-native',
    configured,
    fetchedAt: fetchedAt(now),
    stale: false,
    ...(error ? { error } : {}),
    windows: [],
    balances: []
  }
}

function providerRateModels(raw: unknown, provider: 'pi' | 'muse'): ModelRate[] {
  const envelope = record(raw)
  if (!envelope) return []
  const tables = record(envelope.baseline) ?? envelope
  const table = record(tables[provider])
  const candidates = Array.isArray(table?.models) ? table.models : []
  return candidates.flatMap((candidate) => {
    const row = record(candidate)
    const modelId = typeof row?.modelId === 'string' ? row.modelId.trim() : ''
    const inputUsdPerMillion = positive(row?.inputUsdPerMillion)
    const outputUsdPerMillion = positive(row?.outputUsdPerMillion)
    if (!modelId || inputUsdPerMillion <= 0 || outputUsdPerMillion <= 0) return []
    const cachedInputUsdPerMillion = finiteNonNegative(row?.cachedInputUsdPerMillion)
    const longContextThresholdTokens = positive(row?.longContextThresholdTokens)
    const longContextInputUsdPerMillion = positive(row?.longContextInputUsdPerMillion)
    const longContextOutputUsdPerMillion = positive(row?.longContextOutputUsdPerMillion)
    const longContextCachedInputUsdPerMillion = finiteNonNegative(
      row?.longContextCachedInputUsdPerMillion
    )
    return [
      {
        modelId,
        inputUsdPerMillion,
        outputUsdPerMillion,
        ...(cachedInputUsdPerMillion !== null ? { cachedInputUsdPerMillion } : {}),
        ...(longContextThresholdTokens > 0 &&
        longContextInputUsdPerMillion > 0 &&
        longContextOutputUsdPerMillion > 0 &&
        longContextCachedInputUsdPerMillion !== null
          ? {
              longContextThresholdTokens,
              longContextInputUsdPerMillion,
              longContextOutputUsdPerMillion,
              longContextCachedInputUsdPerMillion
            }
          : {})
      }
    ]
  })
}

function resolveRate(
  rates: readonly ModelRate[],
  model: string,
  allowFallback: boolean
): ModelRate | null {
  const wanted = model.trim().toLowerCase()
  const exact = rates.find((rate) => rate.modelId.toLowerCase() === wanted)
  if (exact) return exact
  const prefix = rates.find((rate) => {
    const id = rate.modelId.toLowerCase()
    return wanted.startsWith(id) || id.startsWith(wanted)
  })
  return prefix ?? (allowFallback ? (rates[0] ?? null) : null)
}

function recordCostUsd(recordValue: UsageRecord, rates: readonly ModelRate[]): number {
  const raw = recordValue as unknown as Record<string, unknown>
  const explicitValue = raw.explicitCostUsd ?? raw.cost_usd
  if (explicitValue !== undefined) {
    const explicit = finiteNonNegative(explicitValue)
    if (explicit !== null) return explicit
  }
  const rate = resolveRate(
    rates,
    recordValue.costRateModel || recordValue.model,
    recordValue.provider === 'muse'
  )
  if (!rate) return 0
  const input = positive(recordValue.inputTokens)
  const output = positive(recordValue.outputTokens)
  const cacheRead = positive(recordValue.cacheReadInputTokens)
  const cacheCreation = positive(recordValue.cacheCreationInputTokens)
  const promptTokens = input + cacheRead + cacheCreation
  const longContext =
    rate.longContextThresholdTokens !== undefined &&
    promptTokens >= rate.longContextThresholdTokens &&
    rate.longContextInputUsdPerMillion !== undefined &&
    rate.longContextOutputUsdPerMillion !== undefined &&
    rate.longContextCachedInputUsdPerMillion !== undefined
  const inputRate = longContext ? rate.longContextInputUsdPerMillion! : rate.inputUsdPerMillion
  const outputRate = longContext ? rate.longContextOutputUsdPerMillion! : rate.outputUsdPerMillion
  const cacheReadRate = longContext
    ? rate.longContextCachedInputUsdPerMillion!
    : (rate.cachedInputUsdPerMillion ?? rate.inputUsdPerMillion)
  const total =
    ((input + cacheCreation) / 1_000_000) * inputRate +
    (cacheRead / 1_000_000) * cacheReadRate +
    (output / 1_000_000) * outputRate
  return Number.isFinite(total) && total > 0 ? total : 0
}

function monthBounds(now: number, local: boolean): { start: number; next: string } {
  const date = new Date(now)
  const start = local
    ? new Date(date.getFullYear(), date.getMonth(), 1)
    : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  const next = local
    ? new Date(date.getFullYear(), date.getMonth() + 1, 1)
    : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
  return { start: start.getTime(), next: next.toISOString() }
}

function summarizeSpend(
  records: readonly UsageRecord[],
  providerRates: unknown,
  lane: 'deepseek' | 'cerebras' | 'meta',
  now: number
): SpendSummary & { nextMonth: string } {
  const isMeta = lane === 'meta'
  const rates = providerRateModels(providerRates, isMeta ? 'muse' : 'pi')
  const month = monthBounds(now, isMeta)
  const cutoff = now - THIRTY_DAYS_MS
  let currentMonthUsd = 0
  let last30DaysUsd = 0
  let runs = 0
  for (const usage of records) {
    if (!usage || usage.usageKind === 'reset_hint') continue
    const model = String(usage.model || '')
      .trim()
      .toLowerCase()
    const matches = isMeta
      ? usage.provider === 'muse'
      : usage.provider === 'pi' && model.startsWith(`${lane}/`)
    if (!matches) continue
    const timestamp = Number(usage.timestamp)
    if (
      !Number.isFinite(timestamp) ||
      timestamp > now ||
      (timestamp < cutoff && timestamp < month.start)
    ) {
      continue
    }
    const cost = recordCostUsd(usage, rates)
    if (timestamp >= month.start) currentMonthUsd += cost
    if (timestamp >= cutoff) last30DaysUsd += cost
    runs += Math.max(1, Math.trunc(positive(usage.runCount)))
  }
  return { currentMonthUsd, last30DaysUsd, runs, nextMonth: month.next }
}

function estimateWindow(input: {
  id: string
  label: string
  amountUsd: number
  subtitle: string
  totalUsd?: number | null
  resetAt?: string
}): QuotaSnapshotHookWindow {
  const total = input.totalUsd && input.totalUsd > 0 ? input.totalUsd : null
  const usedPercent = total ? Math.max(0, Math.min(100, (input.amountUsd / total) * 100)) : 0
  const valueText = `~${formatMoney(input.amountUsd)}`
  return {
    id: input.id,
    label: input.label,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    limitLabel: total
      ? `${valueText} of ${formatMoney(total)} · ${input.subtitle}`
      : `${valueText} · ${input.subtitle}`,
    valueText,
    unit: 'USD',
    windowKind: 'local-estimate',
    ...(input.resetAt ? { resetAt: input.resetAt } : {})
  }
}

function deepSeekSnapshot(
  observation: DeepSeekBalanceObservation,
  observationFetchedAt: number,
  spend: SpendSummary & { nextMonth: string },
  now: number
): QuotaSnapshotHookSnapshot {
  const valueText = formatMoney(observation.totalBalance, observation.currency)
  const windows: QuotaSnapshotHookWindow[] = [
    {
      id: 'deepseek-available-balance',
      label: 'Available balance',
      usedPercent: 0,
      remainingPercent: 100,
      limitLabel: `${valueText} available · official DeepSeek balance API`,
      valueText,
      unit: observation.currency,
      windowKind: 'balance'
    }
  ]
  if (spend.runs > 0) {
    windows.push(
      estimateWindow({
        id: 'deepseek-month-estimate',
        label: 'Estimated this month',
        amountUsd: spend.currentMonthUsd,
        subtitle: 'TaskWraith estimate · not vendor billing',
        resetAt: spend.nextMonth
      })
    )
  }
  return {
    provider: 'deepseek',
    source: 'taskwraith-native',
    configured: true,
    fetchedAt: fetchedAt(observationFetchedAt),
    stale: now - observationFetchedAt > QUOTA_SNAPSHOT_HOOK_STALE_AFTER_MS,
    planType: observation.isAvailable ? 'API Credits' : 'Balance unavailable',
    windows,
    balances: [
      {
        id: 'deepseek-total-available',
        label: 'Total available',
        amount: observation.totalBalance,
        unit: observation.currency,
        subtitle: 'Official DeepSeek API'
      },
      {
        id: 'deepseek-prepaid-remaining',
        label: 'Prepaid remaining',
        amount: observation.toppedUpBalance,
        unit: observation.currency,
        subtitle: 'Official DeepSeek API'
      },
      {
        id: 'deepseek-granted',
        label: 'Granted',
        amount: observation.grantedBalance,
        unit: observation.currency,
        subtitle: 'Official DeepSeek API'
      }
    ]
  }
}

function cerebrasSnapshot(
  spend: SpendSummary & { nextMonth: string },
  now: number
): QuotaSnapshotHookSnapshot {
  return {
    provider: 'cerebras',
    source: 'taskwraith-native',
    configured: true,
    fetchedAt: fetchedAt(now),
    stale: false,
    planType: 'TaskWraith estimate',
    windows: [
      estimateWindow({
        id: 'cerebras-month-estimate',
        label: 'Estimated this month',
        amountUsd: spend.currentMonthUsd,
        subtitle: 'TaskWraith-recorded Cerebras runs · not vendor billing',
        resetAt: spend.nextMonth
      }),
      estimateWindow({
        id: 'cerebras-30d-estimate',
        label: 'Estimated last 30 days',
        amountUsd: spend.last30DaysUsd,
        subtitle: 'TaskWraith-recorded Cerebras runs · not vendor billing'
      })
    ],
    balances: []
  }
}

function metaSnapshot(
  spend: SpendSummary & { nextMonth: string },
  monthlyCapUsd: number | null,
  now: number
): QuotaSnapshotHookSnapshot {
  return {
    provider: 'meta',
    source: 'taskwraith-native',
    configured: true,
    fetchedAt: fetchedAt(now),
    stale: false,
    planType: 'Muse local estimate',
    windows: [
      estimateWindow({
        id: 'meta-month-estimate',
        label: 'Estimated this month',
        amountUsd: spend.currentMonthUsd,
        totalUsd: monthlyCapUsd,
        subtitle: monthlyCapUsd
          ? 'TaskWraith soft budget · not vendor billing'
          : 'TaskWraith estimate · no soft budget configured',
        resetAt: spend.nextMonth
      }),
      estimateWindow({
        id: 'meta-30d-estimate',
        label: 'Estimated last 30 days',
        amountUsd: spend.last30DaysUsd,
        subtitle: 'Muse session tokens × catalog rates · not vendor billing'
      })
    ],
    balances: []
  }
}

async function fetchDeepSeekBalance(
  apiKey: string,
  fetchImpl: FetchLike
): Promise<DeepSeekBalanceObservation> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEEPSEEK_REQUEST_TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`DeepSeek balance HTTP ${response.status}`)
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > DEEPSEEK_RESPONSE_LIMIT_BYTES) {
      throw new Error('DeepSeek balance response was too large')
    }
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > DEEPSEEK_RESPONSE_LIMIT_BYTES) {
      throw new Error('DeepSeek balance response was too large')
    }
    const parsed = parseDeepSeekBalanceResponse(JSON.parse(text) as unknown)
    if (!parsed) throw new Error('DeepSeek balance response was malformed')
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Main-owned supplemental quota reader. It never reads another application's
 * container: DeepSeek uses the official balance API with TaskWraith's encrypted
 * Pi key, while Cerebras and Meta are transparently labelled projections from
 * TaskWraith's own usage journal and rate table.
 */
export function createTaskWraithQuotaSnapshotHook(
  dependencies: TaskWraithQuotaSnapshotHookDependencies
): () => Promise<QuotaSnapshotHookSnapshot[]> {
  const now = () => dependencies.now?.() ?? Date.now()
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const successTtlMs = Math.max(0, dependencies.deepSeekCacheTtlMs ?? DEEPSEEK_CACHE_TTL_MS)
  const failureRetryMs = Math.max(
    0,
    dependencies.deepSeekFailureRetryMs ?? DEEPSEEK_FAILURE_RETRY_MS
  )
  let deepSeekCache: {
    apiKey: string
    observation: DeepSeekBalanceObservation | null
    observationFetchedAt: number | null
    nextAttemptAt: number
  } | null = null
  let deepSeekInFlight: { apiKey: string; request: Promise<void> } | null = null
  let activeDeepSeekKey: string | null = null

  const readDeepSeek = async (
    apiKey: string,
    spend: SpendSummary & { nextMonth: string },
    readAt: number
  ): Promise<QuotaSnapshotHookSnapshot> => {
    if (deepSeekCache?.apiKey !== apiKey) deepSeekCache = null
    const shouldRefresh = !deepSeekCache || readAt >= deepSeekCache.nextAttemptAt
    if (shouldRefresh) {
      if (!deepSeekInFlight || deepSeekInFlight.apiKey !== apiKey) {
        const request = (async () => {
          try {
            if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable')
            const observation = await fetchDeepSeekBalance(apiKey, fetchImpl)
            if (activeDeepSeekKey !== apiKey) return
            const completedAt = now()
            deepSeekCache = {
              apiKey,
              observation,
              observationFetchedAt: completedAt,
              nextAttemptAt: completedAt + successTtlMs
            }
          } catch {
            if (activeDeepSeekKey !== apiKey) return
            const failedAt = now()
            deepSeekCache = {
              apiKey,
              observation: deepSeekCache?.apiKey === apiKey ? deepSeekCache.observation : null,
              observationFetchedAt:
                deepSeekCache?.apiKey === apiKey ? deepSeekCache.observationFetchedAt : null,
              nextAttemptAt: failedAt + failureRetryMs
            }
          }
        })()
        deepSeekInFlight = { apiKey, request }
        void request.finally(() => {
          if (deepSeekInFlight?.request === request) deepSeekInFlight = null
        })
      }
      await deepSeekInFlight.request
    }
    const cached = deepSeekCache
    if (cached?.observation && cached.observationFetchedAt !== null) {
      return deepSeekSnapshot(cached.observation, cached.observationFetchedAt, spend, now())
    }
    return emptySnapshot(
      'deepseek',
      now(),
      true,
      'DeepSeek balance is temporarily unavailable. TaskWraith will retry automatically.'
    )
  }

  return async () => {
    const readAt = now()
    let keys: Partial<Record<'deepseek' | 'cerebras', string>> = {}
    try {
      const loaded = dependencies.loadPiKeys()
      if (loaded?.status === 'ok') keys = loaded.keys
    } catch {
      keys = {}
    }
    let usageRecords: readonly UsageRecord[] = []
    let providerRates: unknown = {}
    try {
      usageRecords = dependencies.getUsageRecords()
    } catch {
      usageRecords = []
    }
    try {
      providerRates = dependencies.getProviderRates()
    } catch {
      providerRates = {}
    }

    const deepSeekSpend = summarizeSpend(usageRecords, providerRates, 'deepseek', readAt)
    const cerebrasSpend = summarizeSpend(usageRecords, providerRates, 'cerebras', readAt)
    const metaSpend = summarizeSpend(usageRecords, providerRates, 'meta', readAt)
    const deepSeekKey = typeof keys.deepseek === 'string' ? keys.deepseek.trim() : ''
    const cerebrasKey = typeof keys.cerebras === 'string' ? keys.cerebras.trim() : ''
    activeDeepSeekKey = deepSeekKey || null
    if (!deepSeekKey) deepSeekCache = null

    const [deepSeek, museConfigured] = await Promise.all([
      deepSeekKey
        ? readDeepSeek(deepSeekKey, deepSeekSpend, readAt)
        : Promise.resolve(emptySnapshot('deepseek', readAt, false)),
      Promise.resolve()
        .then(() => dependencies.getMuseConfigured())
        .then(Boolean)
        .catch(() => false)
    ])

    return [
      deepSeek,
      cerebrasKey
        ? cerebrasSnapshot(cerebrasSpend, readAt)
        : emptySnapshot('cerebras', readAt, false),
      museConfigured
        ? metaSnapshot(
            metaSpend,
            resolveMuseMonthlySpendCapUsd(dependencies.getMuseMonthlySpendCapUsd()),
            readAt
          )
        : emptySnapshot('meta', readAt, false)
    ]
  }
}
