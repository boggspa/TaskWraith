/**
 * Usage Credits — the headline credit balance per provider, rendered as a
 * stack under the period meters (Limit Counter's "Usage Credits" card).
 *
 * The quota aggregate already carries every balance a provider reports
 * (`ModelUsageAggregate.balances`); this module only decides WHICH one leads
 * for a provider and how it reads as a single value. It is pure: no React, no
 * IPC, no clock, so both the sidebar card and Settings can share it.
 */
import type {
  ModelUsageAggregate,
  ModelUsageProviderId,
  UsageBalanceAggregate
} from './usageAggregateTypes'

/**
 * Which balance leads when a provider reports several. Mirrors Limit
 * Counter's priority order, then TaskWraith's own labels (Claude's
 * "Extra Usage" remainder and Cursor's on-demand remainder) so a provider
 * that reports only those still gets a row. Matched trimmed + lowercased.
 */
export const USAGE_CREDIT_LABEL_PRIORITY: readonly string[] = [
  'usage credits',
  'credits remaining',
  'credit remaining',
  'total available',
  'remaining balance',
  'current balance',
  'available balance',
  'prepaid remaining',
  'extra usage balance',
  'extra usage',
  'on-demand spend'
]

export interface UsageCreditRow {
  provider: ModelUsageProviderId
  /** Set for a secondary provider account; the row reads "Provider · Label". */
  accountId?: string
  accountLabel?: string
  /** The leading balance, or null for a placeholder row that reads "—". */
  balance: UsageBalanceAggregate | null
  /** Display value: "$12.34", "0 credits", "1.5K credits", or "—". */
  valueText: string
  /** Tooltip: "<label> · <subtitle>", or the reason there is no value. */
  detail: string
  /** True when a balance was found — the row takes the provider accent. */
  hasValue: boolean
}

/** Explains a "—" row for providers that report usage but no balance. */
export const USAGE_CREDIT_PLACEHOLDER_REASON: Partial<Record<ModelUsageProviderId, string>> = {
  claude: 'Prepaid credit balance is not reported by the Claude usage endpoint.',
  grok: 'Grok reports subscription credits as a used percentage, not a balance.'
}

const DEFAULT_PLACEHOLDER_REASON = 'Credit balance not reported'

function normaliseLabel(label: string): string {
  return label.trim().toLowerCase()
}

/** The balance that leads for a provider, by label priority; null when none match. */
export function selectUsageCreditBalance(
  balances: readonly UsageBalanceAggregate[] | undefined
): UsageBalanceAggregate | null {
  if (!balances || balances.length === 0) return null
  for (const wanted of USAGE_CREDIT_LABEL_PRIORITY) {
    const match = balances.find(
      (balance) => normaliseLabel(balance.label) === wanted && Number.isFinite(balance.amount)
    )
    if (match) return match
  }
  return null
}

function compactNumber(amount: number): string {
  const abs = Math.abs(amount)
  if (abs >= 1_000_000) return `${trimTrailingZeros((amount / 1_000_000).toFixed(1))}M`
  if (abs >= 1_000) return `${trimTrailingZeros((amount / 1_000).toFixed(1))}K`
  return amount.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function trimTrailingZeros(value: string): string {
  return value.replace(/\.0$/, '')
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', GBP: '£', EUR: '€' }

/**
 * Format a balance as one value. ISO currencies render with their symbol
 * (two decimals, four when the amount is a sub-cent sliver so it does not
 * read as zero); "credits" renders compactly; a unit-less amount is a plain
 * number; any other unit is appended verbatim.
 */
export function formatUsageCreditValue(amount: number, unit: string, locale?: string): string {
  if (!Number.isFinite(amount)) return '—'
  const cleanUnit = unit.trim()
  if (!cleanUnit) return amount.toLocaleString(locale, { maximumFractionDigits: 6 })
  if (/^[a-z]{3}$/i.test(cleanUnit)) {
    const currency = cleanUnit.toUpperCase()
    const fractionDigits = amount !== 0 && Math.abs(amount) < 0.01 ? 4 : 2
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits
      }).format(amount)
    } catch {
      const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `
      return `${symbol}${amount.toFixed(fractionDigits)}`
    }
  }
  if (/^credits?$/i.test(cleanUnit)) {
    return `${compactNumber(amount)} credits`
  }
  return `${compactNumber(amount)} ${cleanUnit}`
}

export interface BuildUsageCreditRowsOptions {
  /** Providers that get a "—" row when no balance was found for them. */
  placeholderProviders?: readonly ModelUsageProviderId[]
  locale?: string
}

/**
 * One row per provider, in the order the entries arrive (callers pass the
 * expanded-card provider order). The first entry carrying a leading balance
 * wins for its provider; a provider in `placeholderProviders` with no balance
 * still gets a "—" row carrying the reason, as Limit Counter does for Claude
 * and Grok.
 */
export function buildUsageCreditRows(
  entries: readonly ModelUsageAggregate[],
  options: BuildUsageCreditRowsOptions = {}
): UsageCreditRow[] {
  // One row per provider, or per provider ACCOUNT when the entry belongs to
  // a secondary sign-in — two Claude accounts are two balances, not one.
  const rowKey = (entry: Pick<ModelUsageAggregate, 'provider' | 'accountId'>): string =>
    entry.accountId ? `${entry.provider}#${entry.accountId}` : entry.provider
  const rows = new Map<string, UsageCreditRow>()
  for (const entry of entries) {
    const balance = selectUsageCreditBalance(entry.balances)
    const existing = rows.get(rowKey(entry))
    if (existing?.hasValue) continue
    if (balance) {
      rows.set(rowKey(entry), {
        provider: entry.provider,
        ...(entry.accountId
          ? { accountId: entry.accountId, accountLabel: entry.accountLabel }
          : {}),
        balance,
        valueText: formatUsageCreditValue(balance.amount, balance.unit, options.locale),
        detail: [balance.label, balance.subtitle].filter(Boolean).join(' · '),
        hasValue: true
      })
    }
  }
  for (const provider of options.placeholderProviders ?? []) {
    if (rows.has(provider)) continue
    rows.set(provider, {
      provider,
      balance: null,
      valueText: '—',
      detail: USAGE_CREDIT_PLACEHOLDER_REASON[provider] ?? DEFAULT_PLACEHOLDER_REASON,
      hasValue: false
    })
  }
  const order = new Map<string, number>()
  entries.forEach((entry, index) => {
    if (!order.has(rowKey(entry))) order.set(rowKey(entry), index)
  })
  for (const provider of options.placeholderProviders ?? []) {
    if (order.has(provider)) continue
    // A primary placeholder sits just ahead of that provider's account rows
    // (if any), otherwise after everything that reported a balance.
    const firstOfProvider = entries.findIndex((entry) => entry.provider === provider)
    order.set(provider, firstOfProvider >= 0 ? firstOfProvider - 0.5 : entries.length + order.size)
  }
  return [...rows.values()].sort(
    (left, right) => (order.get(rowKey(left)) ?? 0) - (order.get(rowKey(right)) ?? 0)
  )
}
