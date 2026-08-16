import type { PiKeyLoadResult } from '../pi/PiKeyStore'
import type { UsageRecord } from '../store/types'
import {
  QUOTA_SNAPSHOT_HOOK_STALE_AFTER_MS,
  type QuotaSnapshotHookProviderId,
  type QuotaSnapshotHookSnapshot,
  type QuotaSnapshotHookWindow
} from '../../shared/quotaSnapshotHook'
import { resolveMuseMonthlySpendCapUsd } from '../../shared/museSpendBudget'
import {
  hasApiUsageBillingProvider,
  type ApiUsageBillingCurrency,
  type ApiUsageBillingSettings,
  type CerebrasApiUsageBilling,
  type DeepSeekApiUsageBilling,
  type MetaApiUsageBilling
} from '../../shared/apiUsageBilling'

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
  getFxRates: () => unknown
  getApiUsageBilling: () => ApiUsageBillingSettings | null | undefined
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

function finiteMoney(value: unknown, maximum = MAX_MONEY_VALUE): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= -maximum && parsed <= maximum ? parsed : null
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
    // DeepSeek reports a bounded negative total when an account is a few cents
    // overdrawn. Preserve that vendor reading so the UI can show the overage;
    // only the visual usage fraction is clamped to the meter's 100% ceiling.
    const totalBalance = finiteMoney(row.total_balance)
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

function roundMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 1_000_000) / 1_000_000
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
    if (!usageMatchesSpendLane(usage, lane)) continue
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

function usageMatchesSpendLane(
  usage: UsageRecord | null | undefined,
  lane: 'deepseek' | 'cerebras' | 'meta'
): usage is UsageRecord {
  if (!usage || usage.usageKind === 'reset_hint') return false
  if (lane === 'meta') return usage.provider === 'muse'
  const model = String(usage.model || '')
    .trim()
    .toLowerCase()
  return usage.provider === 'pi' && model.startsWith(`${lane}/`)
}

function summarizeSpendSince(
  records: readonly UsageRecord[],
  providerRates: unknown,
  lane: 'deepseek' | 'cerebras' | 'meta',
  since: number | null,
  now: number
): number {
  if (since === null || !Number.isFinite(since) || since > now) return 0
  const rates = providerRateModels(providerRates, lane === 'meta' ? 'muse' : 'pi')
  let totalUsd = 0
  for (const usage of records) {
    if (!usageMatchesSpendLane(usage, lane)) continue
    const timestamp = Number(usage.timestamp)
    if (!Number.isFinite(timestamp) || timestamp <= since || timestamp > now) continue
    totalUsd += recordCostUsd(usage, rates)
  }
  return totalUsd
}

function fxRatePerUsd(raw: unknown, currency: ApiUsageBillingCurrency): number {
  if (currency === 'USD') return 1
  const envelope = record(raw)
  const rates = record(envelope?.rates) ?? envelope
  const parsed = Number(rates?.[currency])
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return currency === 'GBP' ? 0.79 : 0.92
}

function financialWindow(input: {
  id: string
  label: string
  amount: number
  currency: string
  subtitle: string
  total?: number | null
  resetAt?: string
  estimated?: boolean
  windowKind?: string
}): QuotaSnapshotHookWindow {
  const total = input.total && input.total > 0 ? input.total : null
  const usedPercent = total ? Math.max(0, Math.min(100, (input.amount / total) * 100)) : 0
  const valueText = `${input.estimated ? '~' : ''}${formatMoney(input.amount, input.currency)}`
  return {
    id: input.id,
    label: input.label,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    limitLabel: total
      ? `${valueText} of ${formatMoney(total, input.currency)} · ${input.subtitle}`
      : `${valueText} · ${input.subtitle}`,
    valueText,
    unit: input.currency,
    windowKind: input.windowKind ?? (input.estimated ? 'local-estimate' : 'billing-anchor'),
    ...(input.resetAt ? { resetAt: input.resetAt } : {})
  }
}

function estimateWindow(input: {
  id: string
  label: string
  amountUsd: number
  subtitle: string
  totalUsd?: number | null
  resetAt?: string
}): QuotaSnapshotHookWindow {
  return financialWindow({
    id: input.id,
    label: input.label,
    amount: input.amountUsd,
    currency: 'USD',
    subtitle: input.subtitle,
    total: input.totalUsd,
    resetAt: input.resetAt,
    estimated: true
  })
}

function deepSeekSnapshot(
  observation: DeepSeekBalanceObservation,
  observationFetchedAt: number,
  spend: SpendSummary & { nextMonth: string },
  billing: DeepSeekApiUsageBilling | undefined,
  now: number
): QuotaSnapshotHookSnapshot {
  const totalTopUp = billing?.totalTopUp
  const creditCeiling = totalTopUp ?? billing?.monthlyBudgetUsd
  const windows: QuotaSnapshotHookWindow[] = []
  if (creditCeiling) {
    windows.push(
      financialWindow({
        id: 'deepseek-credit-used',
        label: 'Credit used',
        // Keep an over-budget amount (for example $10.03 of a $10.00
        // top-up) in the text/tooltip. `financialWindow` clamps only the
        // derived percentage, so the progress bar remains capped at 100%.
        amount: Math.max(0, creditCeiling - observation.totalBalance),
        total: creditCeiling,
        currency: observation.currency,
        subtitle: totalTopUp
          ? 'Configured top-ups minus official remaining balance'
          : 'Configured credit budget minus official remaining balance'
      })
    )
  } else {
    windows.push(
      financialWindow({
        id: 'deepseek-available-balance',
        label: 'Available balance',
        amount: observation.totalBalance,
        currency: observation.currency,
        subtitle: 'official DeepSeek balance API',
        windowKind: 'balance'
      })
    )
  }
  if (spend.runs > 0) {
    windows.push(
      estimateWindow({
        id: 'deepseek-month-estimate',
        label: 'Estimated this month',
        amountUsd: spend.currentMonthUsd,
        totalUsd: billing?.monthlyBudgetUsd,
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
      },
      ...(totalTopUp
        ? [
            {
              id: 'deepseek-total-topped-up',
              label: 'Total topped up',
              amount: totalTopUp,
              unit: observation.currency,
              subtitle: 'Manual billing anchor'
            }
          ]
        : [])
    ]
  }
}

function cerebrasSnapshot(
  spend: SpendSummary & { nextMonth: string },
  billing: CerebrasApiUsageBilling | undefined,
  now: number
): QuotaSnapshotHookSnapshot {
  const currency = billing?.currency ?? 'USD'
  const purchased = billing?.purchasedCredits
  const current = billing?.currentBalance
  const hasCreditAnchor = purchased !== undefined && current !== undefined
  const windows: QuotaSnapshotHookWindow[] = []
  if (hasCreditAnchor) {
    windows.push(
      financialWindow({
        id: 'cerebras-credit-used',
        label: 'Credit used',
        amount: Math.max(0, Math.min(purchased, purchased - current)),
        total: purchased,
        currency,
        subtitle: 'Manual Cerebras billing anchor'
      })
    )
  }
  if (!hasCreditAnchor || spend.runs > 0) {
    windows.push(
      estimateWindow({
        id: 'cerebras-month-estimate',
        label: 'Estimated this month',
        amountUsd: spend.currentMonthUsd,
        totalUsd: billing?.monthlyBudgetUsd,
        subtitle: 'TaskWraith-recorded Cerebras runs · not vendor billing',
        resetAt: spend.nextMonth
      })
    )
  }
  if (!hasCreditAnchor) {
    windows.push(
      estimateWindow({
        id: 'cerebras-30d-estimate',
        label: 'Estimated last 30 days',
        amountUsd: spend.last30DaysUsd,
        subtitle: 'TaskWraith-recorded Cerebras runs · not vendor billing'
      })
    )
  }
  return {
    provider: 'cerebras',
    source: 'taskwraith-native',
    configured: true,
    fetchedAt: fetchedAt(now),
    stale: false,
    planType: hasCreditAnchor ? 'Cloud billing anchor' : 'TaskWraith estimate',
    windows,
    balances: [
      ...(current !== undefined
        ? [
            {
              id: 'cerebras-current-balance',
              label: 'Current balance',
              amount: current,
              unit: currency,
              subtitle: 'Manual billing anchor'
            }
          ]
        : []),
      ...(purchased !== undefined
        ? [
            {
              id: 'cerebras-purchased-credits',
              label: 'Purchased credits',
              amount: purchased,
              unit: currency,
              subtitle: 'Manual billing anchor'
            }
          ]
        : [])
    ]
  }
}

function metaSnapshot(
  spend: SpendSummary & { nextMonth: string },
  monthlyCapUsd: number | null,
  billing: MetaApiUsageBilling | undefined,
  localSpendSinceAnchorUsd: number,
  fxRates: unknown,
  now: number
): QuotaSnapshotHookSnapshot {
  const currency = billing?.currency ?? 'USD'
  const perUsd = fxRatePerUsd(fxRates, currency)
  const resetAt = billing?.resetAt ?? spend.nextMonth
  const preload = billing?.preloadCredits
  const threshold = billing?.paymentThreshold
  const remaining = billing?.remainingBalance
  const impliedSpend =
    threshold !== undefined && remaining !== undefined ? Math.max(0, threshold - remaining) : null
  const anchoredSpend = billing?.spent ?? impliedSpend ?? (threshold !== undefined ? 0 : null)
  const localIncrement = billing?.anchorUpdatedAt ? localSpendSinceAnchorUsd * perUsd : 0
  const effectiveRemaining =
    remaining === undefined ? undefined : roundMoney(Math.max(0, remaining - localIncrement))
  const budgetUsd = billing?.monthlyBudgetUsd ?? monthlyCapUsd ?? 0
  const convertedBudget = budgetUsd * perUsd
  const windows: QuotaSnapshotHookWindow[] = []

  if (anchoredSpend !== null && anchoredSpend !== undefined) {
    windows.push(
      financialWindow({
        id: 'meta-billing-period-spend',
        label: 'Spend this billing period',
        amount: roundMoney(anchoredSpend + localIncrement),
        total: threshold ?? (convertedBudget > 0 ? convertedBudget : preload),
        currency,
        subtitle:
          localIncrement > 0
            ? 'Meta console reading plus tracked Muse spend'
            : billing?.spent !== undefined
              ? 'Meta console reading'
              : 'Payment threshold minus remaining balance',
        resetAt
      })
    )
  }

  if (preload !== undefined && effectiveRemaining !== undefined) {
    windows.push(
      financialWindow({
        id: 'meta-credit-used',
        label: 'Credit used',
        amount: Math.max(0, Math.min(preload, preload - effectiveRemaining)),
        total: preload,
        currency,
        subtitle:
          localIncrement > 0
            ? 'Preload minus remaining, advanced by tracked Muse spend'
            : 'Configured preload minus remaining Meta balance'
      })
    )
  }

  if (!billing || windows.length === 0) {
    windows.push(
      estimateWindow({
        id: 'meta-month-estimate',
        label: 'Estimated this month',
        amountUsd: spend.currentMonthUsd,
        totalUsd: billing?.monthlyBudgetUsd ?? monthlyCapUsd,
        subtitle:
          (billing?.monthlyBudgetUsd ?? monthlyCapUsd)
            ? 'TaskWraith soft budget · not vendor billing'
            : 'TaskWraith estimate · no soft budget configured',
        resetAt
      }),
      estimateWindow({
        id: 'meta-30d-estimate',
        label: 'Estimated last 30 days',
        amountUsd: spend.last30DaysUsd,
        subtitle: 'Muse session tokens × catalog rates · not vendor billing'
      })
    )
  } else if (windows.length < 2 && spend.runs > 0) {
    windows.push(
      estimateWindow({
        id: 'meta-month-estimate',
        label: 'Muse estimate this month',
        amountUsd: spend.currentMonthUsd,
        totalUsd: billing.monthlyBudgetUsd ?? monthlyCapUsd,
        subtitle: 'Session tokens × catalog rates · not vendor billing',
        resetAt
      })
    )
  }

  return {
    provider: 'meta',
    source: 'taskwraith-native',
    configured: true,
    fetchedAt: fetchedAt(now),
    stale: false,
    planType: billing?.planName ?? (billing ? 'API Credits' : 'Muse local estimate'),
    windows,
    balances: [
      ...(preload !== undefined
        ? [
            {
              id: 'meta-preload-credit',
              label: 'Preload credit',
              amount: preload,
              unit: currency,
              subtitle: 'Manual billing anchor'
            }
          ]
        : []),
      ...(effectiveRemaining !== undefined
        ? [
            {
              id: 'meta-remaining-balance',
              label: 'Remaining balance',
              amount: effectiveRemaining,
              unit: currency,
              subtitle:
                localIncrement > 0
                  ? 'Manual remaining minus tracked Muse spend since anchor'
                  : 'Manual billing anchor'
            }
          ]
        : []),
      ...(threshold !== undefined
        ? [
            {
              id: 'meta-payment-threshold',
              label: 'Payment threshold',
              amount: threshold,
              unit: currency,
              subtitle: 'Manual billing anchor'
            }
          ]
        : [])
    ]
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
 * Main-owned supplemental quota reader. DeepSeek uses the official balance API
 * with TaskWraith's encrypted Pi key. Cerebras and Meta combine TaskWraith's
 * own usage journal with optional non-secret billing readings entered in
 * Settings; no provider credential or raw response crosses IPC.
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
    billing: DeepSeekApiUsageBilling | undefined,
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
      return deepSeekSnapshot(
        cached.observation,
        cached.observationFetchedAt,
        spend,
        billing,
        now()
      )
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
    let fxRates: unknown = {}
    let apiUsageBilling: ApiUsageBillingSettings = {}
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
    try {
      fxRates = dependencies.getFxRates()
    } catch {
      fxRates = {}
    }
    try {
      apiUsageBilling = dependencies.getApiUsageBilling() ?? {}
    } catch {
      apiUsageBilling = {}
    }

    const deepSeekSpend = summarizeSpend(usageRecords, providerRates, 'deepseek', readAt)
    const cerebrasSpend = summarizeSpend(usageRecords, providerRates, 'cerebras', readAt)
    const metaSpend = summarizeSpend(usageRecords, providerRates, 'meta', readAt)
    const metaAnchorMs = apiUsageBilling.meta?.anchorUpdatedAt
      ? Date.parse(apiUsageBilling.meta.anchorUpdatedAt)
      : null
    const metaSpendSinceAnchorUsd = summarizeSpendSince(
      usageRecords,
      providerRates,
      'meta',
      metaAnchorMs !== null && Number.isFinite(metaAnchorMs) ? metaAnchorMs : null,
      readAt
    )
    const deepSeekKey = typeof keys.deepseek === 'string' ? keys.deepseek.trim() : ''
    const cerebrasKey = typeof keys.cerebras === 'string' ? keys.cerebras.trim() : ''
    activeDeepSeekKey = deepSeekKey || null
    if (!deepSeekKey) deepSeekCache = null

    const [deepSeek, museConfigured] = await Promise.all([
      deepSeekKey
        ? readDeepSeek(deepSeekKey, deepSeekSpend, apiUsageBilling.deepseek, readAt)
        : Promise.resolve(
            emptySnapshot(
              'deepseek',
              readAt,
              hasApiUsageBillingProvider(apiUsageBilling, 'deepseek'),
              hasApiUsageBillingProvider(apiUsageBilling, 'deepseek')
                ? 'Store a DeepSeek key in the Pi provider card to read the official balance.'
                : undefined
            )
          ),
      Promise.resolve()
        .then(() => dependencies.getMuseConfigured())
        .then(Boolean)
        .catch(() => false)
    ])

    return [
      deepSeek,
      cerebrasKey ||
      cerebrasSpend.runs > 0 ||
      hasApiUsageBillingProvider(apiUsageBilling, 'cerebras')
        ? cerebrasSnapshot(cerebrasSpend, apiUsageBilling.cerebras, readAt)
        : emptySnapshot('cerebras', readAt, false),
      museConfigured || metaSpend.runs > 0 || hasApiUsageBillingProvider(apiUsageBilling, 'meta')
        ? metaSnapshot(
            metaSpend,
            resolveMuseMonthlySpendCapUsd(dependencies.getMuseMonthlySpendCapUsd()),
            apiUsageBilling.meta,
            metaSpendSinceAnchorUsd,
            fxRates,
            readAt
          )
        : emptySnapshot('meta', readAt, false)
    ]
  }
}
