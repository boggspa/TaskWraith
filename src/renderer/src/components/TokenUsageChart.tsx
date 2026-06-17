import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ProviderId, UsageRecord } from '../../../main/store/types'
import {
  formatTokenCount,
  HEATMAP_PROVIDER_COLOR_HEX,
  type HeatmapProviderFilter
} from '../lib/UsageHeatmap'
import './TokenUsageChart.css'

type TokenUsageSource = 'taskwraith' | 'external'

interface TokenUsageDay {
  dayKey: string
  dayLabel: string
  tokens: number
  dominantProvider: ProviderId | null
}

interface TokenUsageChartData {
  days: TokenUsageDay[]
  maxTokens: number
  totalTokens: number
}

interface TokenUsageChartProps {
  title: string
  source?: TokenUsageSource
  records?: UsageRecord[]
  dayCount?: number
  refreshKey?: number
  showProviderFilter?: boolean
  className?: string
}

const tokenUsageChartCache = new Map<TokenUsageSource, UsageRecord[]>()

const TOKEN_PROVIDER_FILTERS: Array<{ id: HeatmapProviderFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'grok', label: 'Grok' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'ollama', label: 'Ollama' }
]

const PROVIDER_ORDER: ProviderId[] = [
  'codex',
  'claude',
  'gemini',
  'kimi',
  'grok',
  'cursor',
  'ollama'
]

const pad2 = (value: number): string => String(value).padStart(2, '0')

const dayKeyForDate = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`

const dayLabelForDate = (date: Date): string =>
  date.toLocaleDateString([], { day: 'numeric', month: 'short' })

export function buildTokenUsageChartData(
  records: UsageRecord[],
  now: Date = new Date(),
  dayCount = 90
): TokenUsageChartData {
  const daysToRender = Math.max(1, Math.min(180, Math.round(dayCount)))
  const endOfDay = new Date(now)
  endOfDay.setHours(23, 59, 59, 999)
  const startOfWindow = new Date(endOfDay)
  startOfWindow.setDate(startOfWindow.getDate() - (daysToRender - 1))
  startOfWindow.setHours(0, 0, 0, 0)

  const buckets = Array.from({ length: daysToRender }, (_, index) => {
    const date = new Date(startOfWindow)
    date.setDate(startOfWindow.getDate() + index)
    return {
      dayKey: dayKeyForDate(date),
      dayLabel: dayLabelForDate(date),
      tokens: 0,
      providerTotals: new Map<ProviderId, number>()
    }
  })
  const byDay = new Map(buckets.map((bucket) => [bucket.dayKey, bucket]))

  const startMs = startOfWindow.getTime()
  const endMs = endOfDay.getTime()
  for (const record of records) {
    if (record.usageKind === 'reset_hint') continue
    if (!Number.isFinite(record.timestamp)) continue
    if (record.timestamp < startMs || record.timestamp > endMs) continue
    const tokens = Math.max(
      0,
      Number(record.totalTokens || record.inputTokens + record.outputTokens || 0)
    )
    if (tokens <= 0) continue
    const day = byDay.get(dayKeyForDate(new Date(record.timestamp)))
    if (!day) continue
    day.tokens += tokens
    if (record.provider) {
      day.providerTotals.set(record.provider, (day.providerTotals.get(record.provider) ?? 0) + tokens)
    }
  }

  let maxTokens = 0
  let totalTokens = 0
  const days = buckets.map((bucket) => {
    maxTokens = Math.max(maxTokens, bucket.tokens)
    totalTokens += bucket.tokens
    let dominantProvider: ProviderId | null = null
    let dominantTokens = -1
    for (const provider of PROVIDER_ORDER) {
      const providerTokens = bucket.providerTotals.get(provider) ?? 0
      if (providerTokens > dominantTokens) {
        dominantTokens = providerTokens
        dominantProvider = providerTokens > 0 ? provider : null
      }
    }
    return {
      dayKey: bucket.dayKey,
      dayLabel: bucket.dayLabel,
      tokens: bucket.tokens,
      dominantProvider
    }
  })

  return { days, maxTokens, totalTokens }
}

export function buildProviderFilteredTokenUsageChartData(
  records: UsageRecord[],
  now: Date = new Date(),
  dayCount = 90,
  providerFilter: HeatmapProviderFilter = 'all'
): TokenUsageChartData {
  const allProviderData = buildTokenUsageChartData(records, now, dayCount)
  if (providerFilter === 'all') return allProviderData

  const filteredData = buildTokenUsageChartData(
    records.filter((record) => record.provider === providerFilter),
    now,
    dayCount
  )
  return {
    ...filteredData,
    totalTokens: allProviderData.totalTokens
  }
}

export function TokenUsageChart({
  title,
  source = 'taskwraith',
  records,
  dayCount = 90,
  refreshKey = 0,
  showProviderFilter = false,
  className
}: TokenUsageChartProps) {
  const [fetchedRecords, setFetchedRecords] = useState<UsageRecord[]>(
    () => tokenUsageChartCache.get(source) ?? []
  )
  const [loading, setLoading] = useState(false)
  const [providerFilter, setProviderFilter] = useState<HeatmapProviderFilter>('all')

  useEffect(() => {
    if (records) {
      tokenUsageChartCache.set(source, records)
      setFetchedRecords(records)
      return
    }

    let cancelled = false
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return
      setLoading(true)
      const loader =
        source === 'external' && typeof window.api.getExternalUsage === 'function'
          ? window.api.getExternalUsage
          : window.api.getUsage
      loader()
        .then((latest) => {
          tokenUsageChartCache.set(source, latest)
          if (!cancelled) setFetchedRecords(latest)
        })
        .catch(() => {
          if (!cancelled) setFetchedRecords(tokenUsageChartCache.get(source) ?? [])
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    })

    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
    }
  }, [records, refreshKey, source])

  const chartRecords = records ?? fetchedRecords
  const data = useMemo(
    () =>
      showProviderFilter
        ? buildProviderFilteredTokenUsageChartData(
            chartRecords,
            new Date(),
            dayCount,
            providerFilter
          )
        : buildTokenUsageChartData(chartRecords, new Date(), dayCount),
    [chartRecords, dayCount, providerFilter, showProviderFilter]
  )
  const rootClassName = [
    'token-usage-chart',
    showProviderFilter ? 'token-usage-chart--with-provider-filter' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')
  const windowLabel = `${data.days.length}D`

  return (
    <div
      className={rootClassName}
      aria-label={`${title} ${windowLabel} token usage chart`}
      aria-busy={loading}
    >
      <div className="token-usage-chart-header">
        <span className="token-usage-chart-title">{title}</span>
        {showProviderFilter && (
          <div
            className="usage-heatmap-provider-filter token-usage-chart-provider-filter"
            aria-label={`${title} provider filter`}
          >
            {TOKEN_PROVIDER_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                aria-pressed={providerFilter === filter.id}
                className={`usage-heatmap-provider-filter-tab provider-${filter.id}`}
                data-active={providerFilter === filter.id ? 'true' : undefined}
                onClick={() => setProviderFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        )}
        <span className="token-usage-chart-total">
          {windowLabel} <strong>{formatTokenCount(data.totalTokens)}</strong> tokens
        </span>
      </div>
      {data.maxTokens > 0 ? (
        <svg
          className="token-usage-chart-svg"
          viewBox={`0 0 ${data.days.length} 100`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${data.days.length}-day token usage bars`}
        >
          {data.days.map((day, index) => {
            const height = (day.tokens / data.maxTokens) * 96
            const barStyle: CSSProperties | undefined = day.dominantProvider
              ? { fill: HEATMAP_PROVIDER_COLOR_HEX[day.dominantProvider] }
              : undefined
            return (
              <rect
                key={day.dayKey}
                x={index + 0.12}
                y={100 - height}
                width={0.76}
                height={Math.max(1.5, height)}
                className="token-usage-chart-bar is-active"
                style={barStyle}
              >
                <title>
                  {day.dayLabel} · {formatTokenCount(day.tokens)} tokens
                  {day.dominantProvider ? ` · ${day.dominantProvider}` : ''}
                </title>
              </rect>
            )
          })}
        </svg>
      ) : (
        <div className="token-usage-chart-empty">No token activity in this window.</div>
      )}
      <div className="token-usage-chart-axis">
        <span>{data.days[0]?.dayLabel}</span>
        <span>{data.days[data.days.length - 1]?.dayLabel}</span>
      </div>
    </div>
  )
}
