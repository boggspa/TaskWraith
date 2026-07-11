import type { UsageRecord } from './store/types'

/** One day's token total + the provider that contributed the most that day
 * (drives the bar color on remote clients). `provider` is null on empty days. */
export interface DailyTokenBucket {
  tokens: number
  provider: string | null
}

/** A 90-day (default) daily token series projected to remote clients for the
 * Inspector "TaskWraith Tokens" / "External Tokens" bar charts. Buckets run
 * oldest → newest; `startLabel`/`endLabel` are short axis labels ("18 Mar"). */
export interface DailyTokenSeries {
  totalTokens: number
  startLabel: string
  endLabel: string
  buckets: DailyTokenBucket[]
}

// Tie-break order for the per-day dominant provider, matching the renderer's
// TokenUsageChart so a bar's color is identical on desktop and phone.
const PROVIDER_DOMINANCE_ORDER = [
  'codex',
  'claude',
  'gemini',
  'kimi',
  'grok',
  'cursor',
  'ollama'
]

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

const pad2 = (value: number): string => String(value).padStart(2, '0')
const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
const dayLabel = (date: Date): string => `${date.getDate()} ${MONTHS[date.getMonth()]}`

/**
 * Bucket raw usage records into a per-day token series for the last `dayCount`
 * days. Mirrors the renderer's `buildTokenUsageChartData` (local day boundaries,
 * `reset_hint` records skipped, tokens = totalTokens || input+output) so the
 * phone charts match the desktop. Works for both TaskWraith (`getUsage`) and
 * external (`getExternalUsage`) records — they share the `UsageRecord` shape.
 */
export function buildDailyTokenSeries(
  records: UsageRecord[],
  now: number = Date.now(),
  dayCount = 90
): DailyTokenSeries {
  const days = Math.max(1, Math.min(180, Math.round(dayCount)))
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  const start = new Date(end)
  start.setDate(start.getDate() - (days - 1))
  start.setHours(0, 0, 0, 0)

  const buckets = Array.from({ length: days }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return { key: dayKey(date), tokens: 0, providerTotals: new Map<string, number>() }
  })
  const byDay = new Map(buckets.map((bucket) => [bucket.key, bucket]))
  const startMs = start.getTime()
  const endMs = end.getTime()

  for (const record of records) {
    if (record.usageKind === 'reset_hint') continue
    if (!Number.isFinite(record.timestamp)) continue
    if (record.timestamp < startMs || record.timestamp > endMs) continue
    const tokens = Math.max(
      0,
      Number(
        record.totalTokens ||
          (record.inputTokens ?? 0) +
            (record.cacheReadInputTokens ?? 0) +
            (record.cacheCreationInputTokens ?? 0) +
            (record.outputTokens ?? 0) ||
          0
      )
    )
    if (tokens <= 0) continue
    const bucket = byDay.get(dayKey(new Date(record.timestamp)))
    if (!bucket) continue
    bucket.tokens += tokens
    const provider = record.provider ?? 'unknown'
    bucket.providerTotals.set(provider, (bucket.providerTotals.get(provider) ?? 0) + tokens)
  }

  let totalTokens = 0
  const outBuckets: DailyTokenBucket[] = buckets.map((bucket) => {
    totalTokens += bucket.tokens
    let dominant: string | null = null
    let dominantTokens = -1
    for (const provider of PROVIDER_DOMINANCE_ORDER) {
      const providerTokens = bucket.providerTotals.get(provider) ?? 0
      if (providerTokens > dominantTokens) {
        dominantTokens = providerTokens
        dominant = providerTokens > 0 ? provider : null
      }
    }
    // Providers outside the known order (e.g. "unknown") still color the bar if
    // they dominate and no ranked provider contributed.
    if (!dominant) {
      for (const [provider, providerTokens] of bucket.providerTotals) {
        if (providerTokens > dominantTokens) {
          dominantTokens = providerTokens
          dominant = provider
        }
      }
    }
    return { tokens: bucket.tokens, provider: dominant }
  })

  return {
    totalTokens,
    startLabel: dayLabel(start),
    endLabel: dayLabel(end),
    buckets: outBuckets
  }
}
