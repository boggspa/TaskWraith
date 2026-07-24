/**
 * apiSpendAggregation — View B ("API spend") data builder for the
 * sidebar Model Usage card.
 *
 * The Model Usage card's default view (View A) shows PLAN-subsidised
 * quota meters. View B is for users running on API keys / SDK credits
 * who want to see actual SPEND. TaskWraith never stores a per-record
 * cost (see `AppStore.recordUsage` — `UsageRecord` carries token
 * counts only), so spend here is the SAME projected API-equivalent the
 * rest of the app shows: each run's input/output tokens are priced
 * through the per-model rate table (`providerRateEstimate`), summed per
 * provider over a rolling window, then converted to the user's display
 * currency (`formatCost`, which also applies the conservative-
 * overestimate bias). If a future record ever carries an explicit
 * `cost_usd` (mirroring the welcome dashboard's defensive read) it is
 * preferred over the estimate for that record.
 *
 * Pure + dependency-injected: `now`, the records, the rate table, and
 * the currency settings are all parameters, so window bucketing and the
 * cost math are exhaustively unit-testable without an IPC harness or a
 * fake clock.
 *
 * Window semantics: a record counts toward a window when its timestamp
 * is `>= now - windowMs` (inclusive lower bound) and `<= now` (future-
 * dated / clock-skew records are dropped). This matches the inclusive
 * `>=` cutoffs used by `UsageHeatmap.buildHeatmapGrid` and the welcome
 * dashboard so the three surfaces agree on what "last 24h / 7d / 30d"
 * means. The 30-day window is a strict 30 * 24h, NOT a calendar month.
 */

import type { ProviderId, UsageRecord } from '../../../main/store/types'
import { estimateUsageRecordCostUsd, usageRecordInputTokens, type RendererProviderRates } from './providerRateEstimate'
import { usageRecordRunCount } from '../../../shared/externalUsageBuckets'
import { formatCost, type DisplayCurrency } from './formatCost'

/** Rolling window keys for the per-provider spend rows. */
export type ApiSpendWindowKey = 'day' | 'week' | 'month'

const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_DAY_MS = 24 * ONE_HOUR_MS

/** Window length in milliseconds for each row. Exported so the
 * renderer's row labels and any tests share one source of truth. */
export const API_SPEND_WINDOW_MS: Record<ApiSpendWindowKey, number> = {
  day: ONE_DAY_MS,
  week: 7 * ONE_DAY_MS,
  month: 30 * ONE_DAY_MS
}

/** Canonical render order for the windows (shortest → longest). */
export const API_SPEND_WINDOW_ORDER: ApiSpendWindowKey[] = ['day', 'week', 'month']

/**
 * Providers that can surface in View B. Token/cost-bearing providers
 * only — Ollama is local/free and uses a separate RAM aggregation
 * (`ollamaMemoryAggregation`). Grok token runs are priced via the rate
 * table (subscription credits stay on the plan-side meter).
 */
export const API_SPEND_PROVIDER_ORDER: ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  // The AntiGravity Gemini API key lane genuinely bills per token, so this is
  // the one provider whose spend view reflects an actual billing basis rather
  // than a projected API-equivalent (still an estimate — we never see the
  // invoice). agy-lane records price as projected-equivalent like the rest.
  'antigravity'
]

/** Aggregated token + cost totals for one provider over one window. */
export interface ApiSpendWindowTotals {
  /** Input (prompt) tokens summed across runs in this window. */
  tokensIn: number
  /** Output (completion) tokens summed across runs in this window. */
  tokensOut: number
  /** `tokensIn + tokensOut` — convenience for the row's token chip. */
  totalTokens: number
  /** Number of runs that contributed to this window. */
  runs: number
  /**
   * Raw projected spend in USD, BEFORE currency conversion / bias.
   * Kept alongside the formatted string so callers can sort or sum
   * without re-parsing a localized currency string.
   */
  costUsd: number
  /**
   * Spend formatted in the user's display currency (e.g. `£1.23`),
   * with the conservative-overestimate bias applied. Empty string when
   * the projected cost rounds to nothing — callers render a neutral
   * placeholder (e.g. "—") rather than a misleading `£0.00`.
   */
  costDisplay: string
}

/** Per-provider spend across all three rolling windows. */
export interface ApiSpendProviderTotals {
  provider: ProviderId
  day: ApiSpendWindowTotals
  week: ApiSpendWindowTotals
  month: ApiSpendWindowTotals
}

/** Currency-related inputs for the cost conversion + bias. */
export interface ApiSpendCurrencyOptions {
  currency?: DisplayCurrency
  /** Conservative-overestimate bias percent (0–25). See `formatCost`. */
  overestimatePercent?: number
  /** Optional locale override forwarded to `Intl.NumberFormat`. */
  locale?: string
}

/** A mutable accumulator used while walking records. */
interface SpendAccumulator {
  tokensIn: number
  tokensOut: number
  runs: number
  costUsd: number
}

const emptyAccumulator = (): SpendAccumulator => ({
  tokensIn: 0,
  tokensOut: 0,
  runs: 0,
  costUsd: 0
})

const toNonNegative = (value: unknown): number => {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : 0
}

/**
 * Resolve the USD cost of a single record. Prefers an explicit
 * `cost_usd` if a provider ever writes one (the welcome dashboard reads
 * the same defensive field), otherwise projects from the rate table.
 * Returns `0` when neither yields a positive figure.
 */
function recordCostUsd(record: UsageRecord, rates: RendererProviderRates): number {
  const explicit = Number(
    (record as unknown as Record<string, unknown>).explicitCostUsd ??
      (record as unknown as Record<string, unknown>).cost_usd ??
      0
  )
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return estimateUsageRecordCostUsd(rates, record)
}

/** Materialise an accumulator into the public window totals shape,
 * formatting the cost in the requested currency. */
function finalizeWindow(
  acc: SpendAccumulator,
  currency: DisplayCurrency,
  overestimatePercent: number,
  locale: string | undefined
): ApiSpendWindowTotals {
  return {
    tokensIn: acc.tokensIn,
    tokensOut: acc.tokensOut,
    totalTokens: acc.tokensIn + acc.tokensOut,
    runs: acc.runs,
    costUsd: acc.costUsd,
    costDisplay: formatCost(acc.costUsd, currency, locale, overestimatePercent)
  }
}

/**
 * Build per-provider API-spend totals for the day / 7-day / 30-day
 * rolling windows.
 *
 * @param records  Usage records from `window.api.getUsage()`.
 * @param rates    Per-model rate table (`fetchProviderRates`).
 * @param options  Display currency + overestimate bias + locale.
 * @param now      Reference epoch ms. Injected for deterministic tests;
 *                 defaults to `Date.now()`.
 * @returns        One {@link ApiSpendProviderTotals} entry per provider
 *                 in {@link API_SPEND_PROVIDER_ORDER} that has any
 *                 activity in the 30-day window. Providers with no
 *                 in-window runs are omitted so the card doesn't render
 *                 a wall of empty sections; an empty array means "no API
 *                 spend in the last 30 days" and the caller shows an
 *                 empty state.
 */
export function buildApiSpendByProvider(
  records: UsageRecord[],
  rates: RendererProviderRates,
  options: ApiSpendCurrencyOptions = {},
  now: number = Date.now()
): ApiSpendProviderTotals[] {
  const currency: DisplayCurrency = options.currency ?? 'USD'
  const overestimatePercent = Number.isFinite(options.overestimatePercent)
    ? (options.overestimatePercent as number)
    : 0
  const locale = options.locale

  const dayCutoff = now - API_SPEND_WINDOW_MS.day
  const weekCutoff = now - API_SPEND_WINDOW_MS.week
  const monthCutoff = now - API_SPEND_WINDOW_MS.month

  // One accumulator triplet per provider in the allowed roster. Using a
  // plain object keyed by provider keeps lookups O(1) without growing a
  // Map with junk keys for unknown providers.
  const buckets = new Map<ProviderId, Record<ApiSpendWindowKey, SpendAccumulator>>()
  const allowed = new Set<ProviderId>(API_SPEND_PROVIDER_ORDER)

  for (const record of records) {
    if (!record) continue
    if (record.usageKind === 'reset_hint') continue
    const provider = record.provider
    if (!provider || !allowed.has(provider)) continue
    const timestamp = Number(record.timestamp)
    if (!Number.isFinite(timestamp)) continue
    // Drop future-dated records (clock skew) and anything older than the
    // widest window — they can never land in any row.
    if (timestamp > now || timestamp < monthCutoff) continue

    let triplet = buckets.get(provider)
    if (!triplet) {
      triplet = { day: emptyAccumulator(), week: emptyAccumulator(), month: emptyAccumulator() }
      buckets.set(provider, triplet)
    }

    const tokensIn = usageRecordInputTokens(record)
    const tokensOut = toNonNegative(record.outputTokens)
    const costUsd = recordCostUsd(record, rates)

    // External records may be time-bucket aggregates standing for many runs.
    const runCount = usageRecordRunCount(record)
    const apply = (acc: SpendAccumulator) => {
      acc.tokensIn += tokensIn
      acc.tokensOut += tokensOut
      acc.runs += runCount
      acc.costUsd += costUsd
    }

    // 30-day window always applies (we already filtered to it). The
    // 7-day and 1-day windows are strict subsets, so a boundary record
    // at exactly the cutoff counts inclusively (>=).
    apply(triplet.month)
    if (timestamp >= weekCutoff) apply(triplet.week)
    if (timestamp >= dayCutoff) apply(triplet.day)
  }

  const result: ApiSpendProviderTotals[] = []
  for (const provider of API_SPEND_PROVIDER_ORDER) {
    const triplet = buckets.get(provider)
    if (!triplet) continue
    result.push({
      provider,
      day: finalizeWindow(triplet.day, currency, overestimatePercent, locale),
      week: finalizeWindow(triplet.week, currency, overestimatePercent, locale),
      month: finalizeWindow(triplet.month, currency, overestimatePercent, locale)
    })
  }
  return result
}

/**
 * Calendar month-to-date spend meter for a user-set monthly budget cap.
 *
 * Deliberately NOT the rolling 30-day window above: a budget resets when the
 * provider's billing month does, so the meter counts from the 1st of the
 * current LOCAL month and labels when it resets. Soft/advisory by design —
 * TaskWraith never sees the real invoice, so the meter warns and the actual
 * hard stop belongs in the provider's own billing console (for the AntiGravity
 * Gemini API lane: a Google Cloud billing budget).
 */
export interface CalendarMonthSpendMeter {
  /** Estimated month-to-date spend in USD (pre-bias, pre-conversion). */
  spentUsd: number
  /** Month-to-date spend in display currency (bias applied); '' when ~0. */
  spentDisplay: string
  /** The user's cap in USD, or null when no cap is configured. */
  capUsd: number | null
  /** Cap in display currency (no bias — the cap is user-authored). */
  capDisplay: string
  /** spentUsd / capUsd clamped to 0..1; 0 when no cap. */
  fraction: number
  /** e.g. "1 Aug" — first day of the next calendar month. */
  resetLabel: string
  /** Runs contributing to the month-to-date figure. */
  runs: number
}

export function buildProviderCalendarMonthSpend(
  records: UsageRecord[],
  rates: RendererProviderRates,
  provider: ProviderId,
  capUsd: number | null | undefined,
  options: ApiSpendCurrencyOptions = {},
  now: number = Date.now()
): CalendarMonthSpendMeter {
  const currency: DisplayCurrency = options.currency ?? 'USD'
  const overestimatePercent = Number.isFinite(options.overestimatePercent)
    ? (options.overestimatePercent as number)
    : 0
  const locale = options.locale

  const reference = new Date(now)
  const monthStart = new Date(reference.getFullYear(), reference.getMonth(), 1).getTime()
  const nextMonthFirst = new Date(reference.getFullYear(), reference.getMonth() + 1, 1)

  let spentUsd = 0
  let runs = 0
  for (const record of records) {
    if (!record || record.usageKind === 'reset_hint') continue
    if (record.provider !== provider) continue
    const timestamp = Number(record.timestamp)
    if (!Number.isFinite(timestamp) || timestamp > now || timestamp < monthStart) continue
    const costUsd = recordCostUsd(record, rates)
    if (costUsd > 0) spentUsd += costUsd
    runs += usageRecordRunCount(record)
  }

  const cap = Number.isFinite(capUsd) && (capUsd as number) > 0 ? (capUsd as number) : null
  return {
    spentUsd,
    spentDisplay: formatCost(spentUsd, currency, locale, overestimatePercent),
    capUsd: cap,
    capDisplay: cap === null ? '' : formatCost(cap, currency, locale, 0),
    fraction: cap === null ? 0 : Math.min(1, Math.max(0, spentUsd / cap)),
    resetLabel: nextMonthFirst.toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
    runs
  }
}
