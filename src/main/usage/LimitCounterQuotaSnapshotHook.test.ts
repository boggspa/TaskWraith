import { describe, expect, it, vi } from 'vitest'
import {
  fetchLimitCounterQuotaSnapshotHook,
  limitCounterQuotaSnapshotPlistPath,
  parseLimitCounterQuotaSnapshotHook
} from './LimitCounterQuotaSnapshotHook'

const NOW = Date.parse('2026-08-02T02:00:00.000Z')

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

function snapshot(
  providerID: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    providerID,
    displayName: providerID,
    planName: 'Test plan',
    fetchedAt: '2026-08-02T01:54:22Z',
    fetchState: 'success',
    windows: [],
    balances: [],
    ...overrides
  }
}

describe('parseLimitCounterQuotaSnapshotHook', () => {
  it('projects only the allowlisted display fields from the sanitized helper cache', () => {
    const result = parseLimitCounterQuotaSnapshotHook(
      encode([
        snapshot('antigravity', {
          accessToken: 'must-not-cross-the-hook',
          windows: [
            {
              id: 'agy-5h',
              label: 'Gemini 5H',
              windowKind: 'session',
              used: 0.19409,
              total: 100,
              resetDate: '2026-08-02T03:05:08Z',
              unit: '%',
              subtitle: 'Official Antigravity quota - 99.8% remaining',
              rawResponse: { authorization: 'must-not-cross-either' }
            }
          ]
        }),
        snapshot('deepseek', {
          planName: 'API Credits',
          windows: [
            {
              id: 'deepseek-credit',
              label: 'Credit used',
              windowKind: 'custom',
              used: 0.92,
              total: 10,
              unit: 'USD',
              subtitle: 'Configured top-ups minus official remaining balance'
            }
          ],
          balances: [
            {
              id: 'deepseek-total',
              label: 'Total available',
              amount: 9.08,
              unit: 'USD',
              subtitle: 'Official API'
            }
          ]
        }),
        snapshot('not-a-meter', {
          windows: [{ label: 'Secret', used: 1, total: 1, unit: '%' }]
        })
      ]),
      NOW
    )

    expect(result).toEqual([
      expect.objectContaining({
        provider: 'antigravity',
        planType: 'Test plan',
        stale: false,
        windows: [
          expect.objectContaining({
            label: 'Gemini 5H',
            usedPercent: expect.closeTo(0.19409),
            remainingPercent: expect.closeTo(99.80591),
            limitLabel: 'Official Antigravity quota - 99.8% remaining',
            limitWindowSeconds: 18_000
          })
        ]
      }),
      expect.objectContaining({
        provider: 'deepseek',
        planType: 'API Credits',
        windows: [
          expect.objectContaining({
            label: 'Credit used',
            valueText: '$0.92',
            limitLabel: '$0.92 of $10.00',
            usedPercent: expect.closeTo(9.2)
          })
        ],
        balances: [expect.objectContaining({ label: 'Total available', amount: 9.08, unit: 'USD' })]
      })
    ])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('accessToken')
    expect(serialized).not.toContain('authorization')
    expect(serialized).not.toContain('must-not-cross')
    expect(serialized).not.toContain('rawResponse')
  })

  it('keeps the newest snapshot per provider and marks old readings stale', () => {
    const result = parseLimitCounterQuotaSnapshotHook(
      encode([
        snapshot('cerebras', {
          fetchedAt: '2026-08-01T00:00:00Z',
          planName: 'Old',
          windows: [{ label: 'Credit used', used: 1, total: 10, unit: 'USD' }]
        }),
        snapshot('cerebras', {
          fetchedAt: '2026-08-01T01:00:00Z',
          planName: 'Newer',
          windows: [{ label: 'Credit used', used: 2, total: 10, unit: 'USD' }]
        })
      ]),
      NOW
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ provider: 'cerebras', planType: 'Newer', stale: true })
    expect(result[0].windows[0]).toMatchObject({ valueText: '$2.00', usedPercent: 20 })
  })

  it('fails closed for malformed, oversized-shape, and non-success data', () => {
    expect(parseLimitCounterQuotaSnapshotHook('not base64', NOW)).toEqual([])
    expect(parseLimitCounterQuotaSnapshotHook(encode({}), NOW)).toEqual([])
    expect(
      parseLimitCounterQuotaSnapshotHook(
        encode([
          snapshot('deepseek', {
            fetchState: 'failed',
            windows: [{ label: 'Credit used', used: 9, total: 10, unit: 'USD' }]
          }),
          snapshot('cerebras', {
            windows: [{ label: 'Credit used', used: -1, total: 10, unit: 'USD' }]
          }),
          snapshot('antigravity', {
            windows: [{ label: 'This billing period', used: null, total: 10, unit: 'GBP' }]
          })
        ]),
        NOW
      )
    ).toEqual([])
  })
})

describe('fetchLimitCounterQuotaSnapshotHook', () => {
  it('reads the fixed app-group snapshot through plutil without exposing a path option to IPC', async () => {
    const runPlutil = vi.fn(async () =>
      encode([
        snapshot('cerebras', {
          planName: 'Pay as you go',
          windows: [{ label: 'Credit used', used: 1.36, total: 10, unit: 'USD' }]
        })
      ])
    )

    await expect(
      fetchLimitCounterQuotaSnapshotHook({
        platform: 'darwin',
        homeDirectory: '/Users/tester',
        now: () => NOW,
        runPlutil
      })
    ).resolves.toMatchObject([
      {
        provider: 'cerebras',
        windows: [{ valueText: '$1.36', limitLabel: '$1.36 of $10.00' }]
      }
    ])
    expect(runPlutil).toHaveBeenCalledWith(limitCounterQuotaSnapshotPlistPath('/Users/tester'))
  })

  it('is unavailable off macOS and converts helper failures to an empty snapshot list', async () => {
    const runPlutil = vi.fn(async () => {
      throw new Error('missing')
    })
    await expect(
      fetchLimitCounterQuotaSnapshotHook({ platform: 'linux', runPlutil })
    ).resolves.toEqual([])
    expect(runPlutil).not.toHaveBeenCalled()
    await expect(
      fetchLimitCounterQuotaSnapshotHook({ platform: 'darwin', runPlutil })
    ).resolves.toEqual([])
  })
})
