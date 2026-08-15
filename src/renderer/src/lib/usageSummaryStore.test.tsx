import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ModelUsageAggregate } from './usageAggregateTypes'
import { UsageSummaryStore, UsageSummaryStoreContext, useUsageSummary } from './usageSummaryStore'

function quotaEntry(
  remainingPercent: number,
  fetchedAt = '2026-08-15T12:00:00.000Z'
): ModelUsageAggregate {
  return {
    provider: 'antigravity',
    model: 'usage limits',
    planName: 'Antigravity Pro',
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    windows: [
      {
        id: 'agy-gemini-weekly',
        label: 'Gemini Weekly',
        runs: 0,
        totalTokens: 0,
        limitLabel: `${remainingPercent}% remaining`,
        trackingOnly: false,
        usedPercent: 100 - remainingPercent,
        remainingPercent
      }
    ],
    quotaSource: 'agy-usage-tui',
    quotaFetchedAt: fetchedAt,
    quotaConfigured: true,
    quotaStale: false
  }
}

describe('UsageSummaryStore', () => {
  it('keeps App as a non-subscribing publisher instead of a quota-state owner', () => {
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

    expect(appSource).toContain('usageSummaryStore.publish(ordered')
    expect(appSource).not.toContain('setUsageSummary')
    expect(appSource).not.toMatch(/useState<ModelUsageAggregate\[\]>/)
  })

  it('does not notify consumers for a fetch-timestamp-only heartbeat', () => {
    const store = new UsageSummaryStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const initial = [quotaEntry(42)]

    expect(store.publish(initial)).toBe(true)
    listener.mockClear()
    expect(store.publish([quotaEntry(42, '2026-08-15T12:01:30.000Z')])).toBe(false)
    expect(store.getSnapshot()).toBe(initial)
    expect(listener).not.toHaveBeenCalled()
  })

  it('notifies narrow consumers when rendered quota telemetry changes', () => {
    const store = new UsageSummaryStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.publish([quotaEntry(42)])
    listener.mockClear()

    expect(store.publish([quotaEntry(30)])).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
    expect(store.getSnapshot()[0]?.windows?.[0]?.remainingPercent).toBe(30)
  })

  it('lets an explicit refresh publish fresh transport metadata', () => {
    const store = new UsageSummaryStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.publish([quotaEntry(42)])
    listener.mockClear()

    const refreshed = [quotaEntry(42, '2026-08-15T12:05:00.000Z')]
    expect(store.publish(refreshed, { force: true })).toBe(true)
    expect(store.getSnapshot()).toBe(refreshed)
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('useUsageSummary', () => {
  it('reads the App-owned store when provided and retains direct-prop compatibility', () => {
    const store = new UsageSummaryStore()
    store.publish([quotaEntry(42)])

    function Probe({ fallback }: { fallback: ModelUsageAggregate[] }): React.JSX.Element {
      const summary = useUsageSummary(fallback)
      return <span>{summary[0]?.windows?.[0]?.remainingPercent ?? 'empty'}</span>
    }

    expect(
      renderToStaticMarkup(
        <UsageSummaryStoreContext.Provider value={store}>
          <Probe fallback={[quotaEntry(99)]} />
        </UsageSummaryStoreContext.Provider>
      )
    ).toContain('42')
    expect(renderToStaticMarkup(<Probe fallback={[quotaEntry(99)]} />)).toContain('99')
  })
})
