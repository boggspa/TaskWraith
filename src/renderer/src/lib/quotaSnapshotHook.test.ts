import { describe, expect, it } from 'vitest'
import type { QuotaSnapshotHookSnapshot } from '../../../shared/quotaSnapshotHook'
import { buildQuotaSnapshotHookAggregates } from './quotaSnapshotHook'

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
