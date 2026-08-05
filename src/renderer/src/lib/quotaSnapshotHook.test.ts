import { describe, expect, it } from 'vitest'
import type { QuotaSnapshotHookSnapshot } from '../../../shared/quotaSnapshotHook'
import {
  buildQuotaSnapshotHookAggregates,
  mergeQuotaSnapshotHookSnapshots
} from './quotaSnapshotHook'

describe('buildQuotaSnapshotHookAggregates', () => {
  it('preserves display-only quota, monetary, plan, and freshness fields', () => {
    const snapshots: QuotaSnapshotHookSnapshot[] = [
      {
        provider: 'deepseek',
        source: 'limit-counter-sanitized-cache',
        configured: true,
        fetchedAt: '2026-08-02T01:54:22.000Z',
        stale: false,
        planType: 'API Credits',
        windows: [
          {
            id: 'deepseek-credit-used',
            label: 'Credit used',
            usedPercent: 9.2,
            remainingPercent: 90.8,
            limitLabel: '$0.92 of $10.00',
            valueText: '$0.92',
            unit: 'USD',
            windowKind: 'custom'
          }
        ],
        balances: [
          {
            id: 'deepseek-total-available',
            label: 'Total available',
            amount: 9.08,
            unit: 'USD',
            subtitle: 'Official API'
          }
        ]
      }
    ]

    expect(buildQuotaSnapshotHookAggregates(snapshots)).toEqual([
      expect.objectContaining({
        provider: 'deepseek',
        model: 'usage limits',
        planName: 'API Credits',
        quotaSource: 'limit-counter-sanitized-cache',
        quotaConfigured: true,
        quotaStale: false,
        windows: [
          expect.objectContaining({
            label: 'Credit used',
            valueText: '$0.92',
            unit: 'USD',
            usedPercent: 9.2,
            remainingPercent: 90.8
          })
        ],
        balances: [
          expect.objectContaining({
            label: 'Total available',
            amount: 9.08,
            unit: 'USD'
          })
        ]
      })
    ])
  })
})

describe('mergeQuotaSnapshotHookSnapshots', () => {
  const MERGE_NOW = Date.parse('2026-08-05T12:00:00.000Z')

  function hookSnapshot(
    provider: QuotaSnapshotHookSnapshot['provider'],
    overrides: Partial<QuotaSnapshotHookSnapshot> = {}
  ): QuotaSnapshotHookSnapshot {
    return {
      provider,
      source: 'limit-counter-sanitized-cache',
      configured: true,
      fetchedAt: '2026-08-05T11:55:00.000Z',
      stale: false,
      windows: [
        {
          id: `${provider}-credit-used`,
          label: 'Credit used',
          usedPercent: 25,
          remainingPercent: 75,
          limitLabel: '$2.50 of $10.00',
          valueText: '$2.50',
          unit: 'USD'
        }
      ],
      balances: [],
      ...overrides
    }
  }

  it('keeps every last-known meter when a read misses the UI deadline (null)', () => {
    const previous = [
      hookSnapshot('antigravity'),
      hookSnapshot('deepseek'),
      hookSnapshot('cerebras')
    ]

    const merged = mergeQuotaSnapshotHookSnapshots(previous, null, MERGE_NOW)

    expect(merged.map((snapshot) => snapshot.provider)).toEqual([
      'antigravity',
      'deepseek',
      'cerebras'
    ])
    // A five-minute-old reading served from cache is not stale.
    expect(merged.map((snapshot) => snapshot.stale)).toEqual([false, false, false])
  })

  it('keeps every last-known meter when a helper hiccup produces an empty read', () => {
    const previous = [hookSnapshot('deepseek'), hookSnapshot('cerebras')]

    const merged = mergeQuotaSnapshotHookSnapshots(previous, [], MERGE_NOW)

    expect(merged.map((snapshot) => snapshot.provider)).toEqual(['deepseek', 'cerebras'])
  })

  it('fills providers missing from a partial read from the cache, in canonical order', () => {
    // Limit Counter rewrites entries per provider while it refetches, so one
    // provider can be temporarily absent while the others read fine.
    const previous = [
      hookSnapshot('antigravity', { fetchedAt: '2026-08-05T11:40:00.000Z' }),
      hookSnapshot('deepseek')
    ]
    const fresh = [hookSnapshot('cerebras'), hookSnapshot('antigravity')]

    const merged = mergeQuotaSnapshotHookSnapshots(previous, fresh, MERGE_NOW)

    expect(merged.map((snapshot) => snapshot.provider)).toEqual([
      'antigravity',
      'deepseek',
      'cerebras'
    ])
    // The fresh antigravity read replaced the cached one.
    expect(merged[0]!.fetchedAt).toBe('2026-08-05T11:55:00.000Z')
  })

  it('lets a fresh reading replace the cache even when its numbers went down', () => {
    // Measured truth wins per provider — a cycle reset legitimately drops the
    // figures, so the merge must never keep the larger cached reading.
    const previous = [
      hookSnapshot('deepseek', {
        windows: [
          {
            id: 'deepseek-credit-used',
            label: 'Credit used',
            usedPercent: 92,
            remainingPercent: 8,
            limitLabel: '$9.20 of $10.00',
            valueText: '$9.20',
            unit: 'USD'
          }
        ]
      })
    ]
    const fresh = [hookSnapshot('deepseek')]

    const merged = mergeQuotaSnapshotHookSnapshots(previous, fresh, MERGE_NOW)

    expect(merged).toHaveLength(1)
    expect(merged[0]!.windows[0]!.valueText).toBe('$2.50')
    expect(merged[0]!.windows[0]!.usedPercent).toBe(25)
  })

  it('re-derives staleness for readings served from the cache', () => {
    // The parser stamped stale:false when the reading was fresh; serving it
    // through a long outage must not keep presenting it as current.
    const previous = [hookSnapshot('deepseek', { fetchedAt: '2026-08-05T11:25:00.000Z' })]

    const merged = mergeQuotaSnapshotHookSnapshots(previous, [], MERGE_NOW)

    expect(merged).toHaveLength(1)
    expect(merged[0]!.stale).toBe(true)
  })
})
