import { describe, expect, it } from 'vitest'
import {
  normalizeClaudeUsageSnapshot,
  normalizeCodexUsagePayload,
  normalizeKimiUsageSnapshot,
  projectStaleSnapshotForward
} from './ProviderQuotaSnapshots'

describe('ProviderQuotaSnapshots', () => {
  it('preserves Codex aggregate and additional Spark windows', () => {
    const snapshot = normalizeCodexUsagePayload(
      {
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 18_000,
            reset_after_seconds: 3_600,
            reset_at: 1_893_456_000
          },
          secondary_window: {
            used_percent: 33,
            limit_window_seconds: 604_800,
            reset_after_seconds: 7_200,
            reset_at: 1_893_542_400
          }
        },
        additional_rate_limits: [
          {
            limit_name: 'GPT-5.3-Codex-Spark',
            rate_limit: {
              primary_window: {
                used_percent: 0,
                limit_window_seconds: 18_000,
                reset_after_seconds: 1_800,
                reset_at: 1_893_459_600
              },
              secondary_window: {
                used_percent: 1,
                limit_window_seconds: 604_800,
                reset_after_seconds: 86_400,
                reset_at: 1_893_628_800
              }
            }
          }
        ]
      },
      { accountId: 'account-1234567890', importedAt: '2026-05-26T00:00:00.000Z' }
    )

    expect(snapshot.windows?.map((windowEntry) => windowEntry.label)).toEqual([
      'Session',
      'Weekly',
      'GPT-5.3-Codex-Spark 5h',
      'GPT-5.3-Codex-Spark Weekly'
    ])
    expect(snapshot.windows?.[2].usedPercent).toBe(0)
    expect(snapshot.accountId).toBe('accoun...7890')
  })

  it('suppresses stale Codex aggregate windows when named limits have reset', () => {
    // The aggregate's reset is genuinely in the PAST (60s ago), yet the backend
    // still reports 100% used — that's actually-stale data (the bucket has
    // already rolled over). The named limit shows a fresh roll-over (0% used,
    // reset 7 days out), so the function correctly suppresses the stale
    // aggregate. (Pre-1.0.6 this test used hardcoded 2030 timestamps; the
    // suppression also fired for legitimately-saturated current windows, which
    // hid the Codex Session/5h meter the moment it hit 100% — see the
    // companion "preserves a saturated aggregate ..." test below.)
    const nowSec = Math.floor(Date.now() / 1000)
    const snapshot = normalizeCodexUsagePayload({
      rate_limit: {
        secondary_window: {
          used_percent: 100,
          limit_window_seconds: 604_800,
          reset_after_seconds: 0,
          reset_at: nowSec - 60
        }
      },
      additional_rate_limits: [
        {
          limit_name: 'GPT-5.5',
          rate_limit: {
            secondary_window: {
              used_percent: 0,
              limit_window_seconds: 604_800,
              reset_after_seconds: 604_800,
              reset_at: nowSec + 604_800
            }
          }
        }
      ]
    })

    expect(snapshot.windows?.map((windowEntry) => windowEntry.label)).toEqual(['GPT-5.5 Weekly'])
  })

  it('preserves a saturated Codex aggregate window when its reset is still in the future', () => {
    // The user-reported bug: Session/5h vanished the moment it hit 100% used.
    // Saturated current window — aggregate at 100% with reset still ~30 min
    // away — must keep showing even though a same-bucket Spark sibling has low
    // usage and a slightly-later reset (very common: Spark was first used
    // later in the cycle so its clock trails Session's by a few hours, easily
    // clearing the structural 30-min threshold). The stale-detector only
    // suppresses when the aggregate's reset has already PASSED.
    const nowSec = Math.floor(Date.now() / 1000)
    const snapshot = normalizeCodexUsagePayload({
      rate_limit: {
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 18_000,
          reset_after_seconds: 1_800,
          reset_at: nowSec + 1_800
        }
      },
      additional_rate_limits: [
        {
          limit_name: 'GPT-5.3-Codex-Spark',
          rate_limit: {
            primary_window: {
              used_percent: 5,
              limit_window_seconds: 18_000,
              reset_after_seconds: 18_000,
              reset_at: nowSec + 18_000
            }
          }
        }
      ]
    })

    const labels = snapshot.windows?.map((windowEntry) => windowEntry.label)
    expect(labels).toContain('Session')
    expect(labels).toContain('GPT-5.3-Codex-Spark 5h')
  })

  it('renders Claude Fable utilization even without a reset timestamp', () => {
    const snapshot = normalizeClaudeUsageSnapshot(
      {
        five_hour: { utilization: 15, reset_at: '2026-05-26T04:39:00Z' },
        seven_day: { utilization: 97, reset_at: '2026-05-26T07:59:00Z' },
        seven_day_fable: { utilization: 3 }
      },
      { subscriptionType: 'max_5x' }
    )

    expect(snapshot.windows?.map((windowEntry) => windowEntry.label)).toEqual([
      'Session',
      'Weekly',
      'Fable'
    ])
    expect(snapshot.windows?.find((windowEntry) => windowEntry.label === 'Fable')).toMatchObject({
      id: 'claude-weekly-fable',
      usedPercent: 3,
      remainingPercent: 97,
      resetAt: undefined
    })
  })

  it('normalizes Kimi zero-usage 5H and Weekly windows as used percent', () => {
    const snapshot = normalizeKimiUsageSnapshot({
      usage: {
        limit: '2000',
        remaining: '2000',
        resetTime: '2026-05-26T21:56:00Z'
      },
      limits: [
        {
          window: {
            duration: 300,
            timeUnit: 'TIME_UNIT_MINUTE'
          },
          detail: {
            limit: '200',
            remaining: '200',
            resetTime: '2026-05-26T00:56:00Z'
          }
        }
      ]
    })

    expect(snapshot.windows?.map((windowEntry) => windowEntry.label)).toEqual(['5H', 'Weekly'])
    expect(snapshot.windows?.map((windowEntry) => windowEntry.usedPercent)).toEqual([0, 0])
    expect(snapshot.windows?.map((windowEntry) => windowEntry.remainingPercent)).toEqual([100, 100])
  })

  describe('Claude per-family weekly probe (fable/opus shape drift)', () => {
    it('finds Fable under nested seven_day.fable', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        seven_day: { utilization: 80, fable: { utilization: 12 } }
      })
      const labels = snapshot.windows?.map((w) => w.label) || []
      expect(labels).toContain('Fable')
      expect(snapshot.windows?.find((w) => w.label === 'Fable')?.usedPercent).toBe(12)
    })

    it('finds Opus under models.opus.weekly', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        seven_day: { utilization: 50 },
        models: { opus: { weekly: { utilization: 27 } } }
      })
      const labels = snapshot.windows?.map((w) => w.label) || []
      expect(labels).toContain('Opus')
      expect(snapshot.windows?.find((w) => w.label === 'Opus')?.usedPercent).toBe(27)
    })

    it('maps legacy Sonnet snake case to the renamed Fable meter', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        seven_day_sonnet: { utilization: 3 }
      })
      expect(snapshot.windows?.find((w) => w.label === 'Fable')).toMatchObject({
        id: 'claude-weekly-fable',
        usedPercent: 3
      })
    })
  })

  describe('projectStaleSnapshotForward', () => {
    it('advances reset timestamps past their original window when they are stale', () => {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const input = {
        provider: 'kimi',
        windows: [
          {
            id: 'kimi-5h',
            label: '5H',
            usedPercent: 30,
            remainingPercent: 70,
            limitWindowSeconds: 5 * 60 * 60, // 5 hours
            resetAt: oneDayAgo,
            runs: 0,
            totalTokens: 0,
            trackingOnly: false,
            limitLabel: '70% remaining'
          }
        ]
      }
      const projected = projectStaleSnapshotForward(input)
      expect(projected.projected).toBe(true)
      const window = projected.windows[0]
      expect(window.usedPercent).toBe(0)
      expect(window.remainingPercent).toBe(100)
      const nextReset = Date.parse(window.resetAt)
      // Next reset should be in the future
      expect(nextReset).toBeGreaterThan(Date.now())
      // And should land within one window-duration of "now" (we
      // project forward by whole windows until we cross the present).
      expect(nextReset - Date.now()).toBeLessThanOrEqual(5 * 60 * 60 * 1000)
    })

    it('preserves last-known usage instead of asserting 0% when the snapshot is too stale to trust', () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      const input = {
        provider: 'codex',
        fetchedAt: eightDaysAgo,
        windows: [
          {
            id: 'codex-weekly',
            label: 'Weekly',
            usedPercent: 99,
            remainingPercent: 1,
            limitWindowSeconds: 7 * 24 * 60 * 60,
            resetAt: eightDaysAgo,
            runs: 0,
            totalTokens: 0,
            trackingOnly: false,
            limitLabel: '1% remaining'
          }
        ]
      }
      const projected = projectStaleSnapshotForward(input)
      expect(projected.projected).toBe(true)
      const window = projected.windows[0]
      // Clock advanced for a sane display...
      expect(Date.parse(window.resetAt)).toBeGreaterThan(Date.now())
      // ...but usage is NOT falsely zeroed — last-known 99% is preserved.
      expect(window.usedPercent).toBe(99)
      expect(window.remainingPercent).toBe(1)
    })

    it('leaves windows untouched if resetAt is still in the future', () => {
      const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
      const input = {
        provider: 'kimi',
        windows: [
          {
            id: 'kimi-5h',
            label: '5H',
            usedPercent: 30,
            remainingPercent: 70,
            limitWindowSeconds: 5 * 60 * 60,
            resetAt: twoHoursFromNow,
            runs: 0,
            totalTokens: 0,
            trackingOnly: false,
            limitLabel: '70% remaining'
          }
        ]
      }
      const projected = projectStaleSnapshotForward(input)
      // No projection should happen → no `projected: true` flag
      expect(projected.projected).toBeUndefined()
      expect(projected.windows[0].usedPercent).toBe(30)
      expect(projected.windows[0].resetAt).toBe(twoHoursFromNow)
    })

    it('renames cached Claude Sonnet quota windows to Fable', () => {
      const input = {
        provider: 'claude',
        windows: [
          {
            id: 'claude-weekly-sonnet',
            label: 'Sonnet',
            usedPercent: 18,
            remainingPercent: 82,
            runs: 0,
            totalTokens: 0,
            trackingOnly: false,
            limitLabel: '82% remaining'
          }
        ]
      }

      const projected = projectStaleSnapshotForward(input)
      expect(projected.projected).toBeUndefined()
      expect(projected.windows[0]).toMatchObject({
        id: 'claude-weekly-fable',
        label: 'Fable',
        usedPercent: 18,
        remainingPercent: 82
      })
    })

    it('leaves windows without limitWindowSeconds alone (unknown rollover cadence)', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const input = {
        provider: 'codex',
        windows: [
          {
            id: 'codex-weekly',
            label: 'Weekly',
            usedPercent: 35,
            remainingPercent: 65,
            // No limitWindowSeconds — we don't know the rollover cadence
            resetAt: yesterday,
            runs: 0,
            totalTokens: 0,
            trackingOnly: false,
            limitLabel: '65% remaining'
          }
        ]
      }
      const projected = projectStaleSnapshotForward(input)
      expect(projected.projected).toBeUndefined()
      expect(projected.windows[0].usedPercent).toBe(35)
      expect(projected.windows[0].resetAt).toBe(yesterday)
    })

    it('handles missing snapshot / empty windows safely', () => {
      expect(projectStaleSnapshotForward(null)).toBeNull()
      expect(projectStaleSnapshotForward({ windows: [] }).projected).toBeUndefined()
      expect(projectStaleSnapshotForward({})).toEqual({})
    })
  })
})
