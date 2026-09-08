import type { ModelUsageProviderId, UsageWindowAggregate } from './usageAggregateTypes'

export const QUOTA_PERIODS = [
  { id: 'fiveHour', label: '5H' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthlyAndApi', label: 'Monthly + API' }
] as const

export type QuotaPeriod = (typeof QUOTA_PERIODS)[number]['id']

/** Collapse overlapping words, e.g. MiMo Token Plan + Plan Quota. */
export function quotaPeriodRowLabel(providerName: string, label: string): string {
  const providerWords = providerName.trim().split(/\s+/)
  const labelWords = label.trim() ? label.trim().split(/\s+/) : []
  for (let count = Math.min(providerWords.length, labelWords.length); count > 0; count -= 1) {
    if (
      providerWords.slice(-count).join(' ').toLowerCase() ===
      labelWords.slice(0, count).join(' ').toLowerCase()
    ) {
      return [...providerWords, ...labelWords.slice(count)].join(' ')
    }
  }
  return [...providerWords, ...labelWords].join(' ')
}

/** Display grouping follows Limit Counter's period view. Keep the original
 * window intact: grouping must not change its amount, reset, pace or ticks. */
export function quotaPeriodForWindow(
  provider: ModelUsageProviderId,
  window: UsageWindowAggregate
): QuotaPeriod {
  const text = `${window.label} ${window.id}`.toLowerCase().replace(/[-_]/g, ' ')
  if (/\b5\s*(h|hour)\b/.test(text)) return 'fiveHour'
  if (/week|\b7\s*(d|day)\b|seven day/.test(text)) return 'weekly'
  if (/daily|\b24\s*(h|hour)\b/.test(text)) return 'daily'
  if (/month|\b30\s*d\b/.test(text)) return 'monthlyAndApi'

  switch (window.windowKind?.toLowerCase()) {
    case 'session':
      return 'fiveHour'
    case 'daily':
      return 'daily'
    case 'weekly':
      return 'weekly'
    case 'monthly':
    case 'yearly':
    case 'sliding':
    case 'project':
      return 'monthlyAndApi'
  }

  // Older TaskWraith snapshots predate windowKind; retain their branded and
  // provider-specific period aliases without assigning them to other providers.
  if (/session/.test(text)) return 'fiveHour'
  if ((provider === 'meta' || provider === 'muse') && /current usage/.test(text)) return 'fiveHour'
  if (provider === 'claude' && /fable|sonnet/.test(text)) return 'weekly'
  if (provider === 'codex' && /luna|gpt reserve/.test(text)) return 'weekly'

  const seconds = window.limitWindowSeconds
  if (seconds != null && Number.isFinite(seconds)) {
    if (seconds >= 14_400 && seconds <= 21_600) return 'fiveHour'
    if (seconds >= 82_800 && seconds <= 93_600) return 'daily'
    if (seconds >= 561_600 && seconds <= 648_000) return 'weekly'
  }
  return provider === 'gemini' && window.windowKind === 'custom' ? 'daily' : 'monthlyAndApi'
}
