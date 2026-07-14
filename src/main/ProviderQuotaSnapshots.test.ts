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

  it('uses the reported duration when Codex temporarily returns weekly usage as primary', () => {
    const snapshot = normalizeCodexUsagePayload({
      plan_type: 'pro',
      rate_limit: {
        primary_window: {
          used_percent: 35,
          limit_window_seconds: 604_800,
          reset_after_seconds: 518_400,
          reset_at: 1_783_910_400
        }
      },
      additional_rate_limits: [
        {
          limit_name: 'GPT-5.3-Codex-Spark',
          rate_limit: {
            primary_window: {
              used_percent: 6,
              limit_window_seconds: 18_000,
              reset_after_seconds: 18_000,
              reset_at: 1_783_910_400
            }
          }
        }
      ]
    })

    expect(snapshot.windows).toMatchObject([
      {
        id: 'primary-weekly',
        label: 'Weekly',
        windowKind: 'weekly',
        usedPercent: 35,
        limitWindowSeconds: 604_800
      },
      {
        id: 'additional-0-5h',
        label: 'GPT-5.3-Codex-Spark 5h',
        windowKind: 'session',
        usedPercent: 6,
        limitWindowSeconds: 18_000
      }
    ])
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

  it('normalizes Kimi weekly usage when the live response omits remaining', () => {
    const snapshot = normalizeKimiUsageSnapshot({
      usage: {
        limit: '100',
        used: '100',
        resetTime: '2026-07-13T14:03:53.641349Z'
      },
      limits: [
        {
          window: {
            duration: 300,
            timeUnit: 'TIME_UNIT_MINUTE'
          },
          detail: {
            limit: '100',
            used: '60',
            remaining: '40',
            resetTime: '2026-07-12T16:03:53.641349Z'
          }
        }
      ]
    })

    expect(snapshot.windows?.find((windowEntry) => windowEntry.label === '5H')).toMatchObject({
      limitLabel: '40 / 100 remaining',
      usedPercent: 60,
      remainingPercent: 40
    })
    expect(snapshot.windows?.find((windowEntry) => windowEntry.label === 'Weekly')).toMatchObject({
      limitLabel: '0 / 100 remaining',
      usedPercent: 100,
      remainingPercent: 0,
      resetAt: '2026-07-13T14:03:53.641Z'
    })
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

    it('finds Fable in the limits[] weekly_scoped entry (current live shape)', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        five_hour: { utilization: 28, resets_at: '2026-07-02T03:10:00Z' },
        seven_day: { utilization: 5, resets_at: '2026-07-07T08:00:00Z' },
        limits: [
          {
            group: 'weekly',
            kind: 'weekly_all',
            percent: 5,
            resets_at: '2026-07-07T08:00:00.000000+00:00'
          },
          {
            group: 'weekly',
            kind: 'weekly_scoped',
            percent: 8,
            resets_at: '2026-07-07T07:59:59.516637+00:00',
            scope: { label: 'Fable' }
          }
        ]
      })
      expect(snapshot.windows?.map((w) => w.label)).toEqual(['Session', 'Weekly', 'Fable'])
      const fable = snapshot.windows?.find((w) => w.label === 'Fable')
      expect(fable).toMatchObject({
        id: 'claude-weekly-fable',
        usedPercent: 8,
        remainingPercent: 92
      })
      expect(fable?.resetAt).toBe('2026-07-07T07:59:59.516Z')
    })

    it('prefers the live scoped limits entry over a stale legacy seven_day_sonnet field', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        seven_day_sonnet: { utilization: 88 },
        limits: [
          {
            group: 'weekly',
            kind: 'weekly_scoped',
            percent: 0,
            resets_at: '2026-07-07T06:59:59Z',
            scope: { label: 'Fable' }
          }
        ]
      })
      expect(snapshot.windows?.find((w) => w.label === 'Fable')?.usedPercent).toBe(0)
    })

    it('treats a bare weekly_scoped entry with no scope as the Fable window', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        limits: [
          { group: 'weekly', kind: 'weekly_scoped', percent: 12, resets_at: '2026-07-07T07:00:00Z' }
        ]
      })
      expect(snapshot.windows?.find((w) => w.label === 'Fable')?.usedPercent).toBe(12)
    })

    it('matches string scopes and kind-embedded family names in limits[]', () => {
      // String scope routing must hold where the bare-weekly_scoped fallback
      // CANNOT rescue it: a string 'opus' scope lands on Opus, never Fable.
      const byScope = normalizeClaudeUsageSnapshot({
        limits: [{ group: 'weekly', kind: 'weekly_scoped', percent: 31, scope: 'opus' }]
      })
      expect(byScope.windows?.find((w) => w.label === 'Opus')?.usedPercent).toBe(31)
      expect(byScope.windows?.find((w) => w.label === 'Fable')).toBeUndefined()
      const byKind = normalizeClaudeUsageSnapshot({
        limits: [{ group: 'weekly', kind: 'weekly_fable', percent: 9 }]
      })
      expect(byKind.windows?.find((w) => w.label === 'Fable')?.usedPercent).toBe(9)
    })

    it('prefers a direct seven_day_fable field over the scoped limits entry', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        seven_day_fable: { utilization: 40 },
        limits: [{ group: 'weekly', kind: 'weekly_scoped', percent: 8, scope: { label: 'Fable' } }]
      })
      expect(snapshot.windows?.find((w) => w.label === 'Fable')?.usedPercent).toBe(40)
    })

    it('prefers a direct opus field over the opus-scoped limits entry', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        models: { opus: { weekly: { utilization: 55 } } },
        limits: [{ group: 'weekly', kind: 'weekly_scoped', percent: 31, scope: { label: 'Opus' } }]
      })
      expect(snapshot.windows?.find((w) => w.label === 'Opus')?.usedPercent).toBe(55)
    })

    it('never lets a foreign or bare scoped entry shadow the explicit Fable entry', () => {
      // An unknown-family bucket ordered FIRST must not be claimed as Fable.
      const foreignFirst = normalizeClaudeUsageSnapshot({
        limits: [
          { group: 'weekly', kind: 'weekly_scoped', percent: 31, scope: { label: 'OAuth apps' } },
          { group: 'weekly', kind: 'weekly_scoped', percent: 8, scope: { label: 'Fable' } }
        ]
      })
      expect(foreignFirst.windows?.find((w) => w.label === 'Fable')?.usedPercent).toBe(8)
      // A scope-less entry ordered first loses to the explicitly-scoped one.
      const bareFirst = normalizeClaudeUsageSnapshot({
        limits: [
          { group: 'weekly', kind: 'weekly_scoped', percent: 55 },
          { group: 'weekly', kind: 'weekly_scoped', percent: 8, scope: { label: 'Fable' } }
        ]
      })
      expect(bareFirst.windows?.find((w) => w.label === 'Fable')?.usedPercent).toBe(8)
      // An entry scoped to an unknown family alone is never claimed as Fable.
      const unknownOnly = normalizeClaudeUsageSnapshot({
        limits: [{ group: 'weekly', kind: 'weekly_scoped', percent: 90, scope: { label: 'Nova' } }]
      })
      expect(unknownOnly.windows?.find((w) => w.label === 'Fable')).toBeUndefined()
    })

    it('builds Session and Weekly from aggregate limits[] entries when top-level fields vanish', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        limits: [
          {
            group: 'five_hour',
            kind: 'five_hour_all',
            percent: 28,
            resets_at: '2026-07-02T03:10:00Z'
          },
          { group: 'weekly', kind: 'weekly_all', percent: 5, resets_at: '2026-07-07T08:00:00Z' },
          { group: 'weekly', kind: 'weekly_scoped', percent: 8, scope: { label: 'Fable' } }
        ]
      })
      expect(snapshot.windows?.map((w) => w.label)).toEqual(['Session', 'Weekly', 'Fable'])
      expect(snapshot.windows?.find((w) => w.label === 'Session')).toMatchObject({
        usedPercent: 28,
        resetAt: '2026-07-02T03:10:00.000Z'
      })
      expect(snapshot.windows?.find((w) => w.label === 'Weekly')?.usedPercent).toBe(5)
    })

    it('maps an Opus-scoped limits entry to the Opus meter, not Fable', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        limits: [
          {
            group: 'weekly',
            kind: 'weekly_scoped',
            percent: 31,
            resets_at: '2026-07-07T07:00:00Z',
            scope: { label: 'Opus' }
          }
        ]
      })
      expect(snapshot.windows?.find((w) => w.label === 'Opus')?.usedPercent).toBe(31)
      expect(snapshot.windows?.find((w) => w.label === 'Fable')).toBeUndefined()
    })

    it('routes coexisting Fable and Opus scoped entries to their own meters', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        limits: [
          { group: 'weekly', kind: 'weekly_scoped', percent: 8, scope: { label: 'Fable' } },
          { group: 'weekly', kind: 'weekly_scoped', percent: 31, scope: { label: 'Opus' } }
        ]
      })
      expect(snapshot.windows?.find((w) => w.label === 'Fable')?.usedPercent).toBe(8)
      expect(snapshot.windows?.find((w) => w.label === 'Opus')?.usedPercent).toBe(31)
    })

    it('never maps weekly_all or non-weekly limits entries to a family meter', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        limits: [
          { group: 'weekly', kind: 'weekly_all', percent: 49 },
          { group: 'five_hour', kind: 'weekly_scoped', percent: 66 }
        ]
      })
      expect(snapshot.windows?.find((w) => w.label === 'Fable')).toBeUndefined()
      expect(snapshot.windows?.find((w) => w.label === 'Opus')).toBeUndefined()
    })

    it('shows a zero-percent Fable scoped entry (unused Fable still renders)', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        limits: [{ group: 'weekly', kind: 'weekly_scoped', percent: 0, scope: { label: 'Fable' } }]
      })
      expect(snapshot.windows?.find((w) => w.label === 'Fable')).toMatchObject({
        usedPercent: 0,
        remainingPercent: 100
      })
    })

    it('reads the live endpoint\'s "resets_at" reset field on Session/Weekly windows', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        five_hour: { utilization: 28, resets_at: '2026-07-02T03:10:00Z' },
        seven_day: { utilization: 5, resets_at: '2026-07-07T08:00:00Z' }
      })
      expect(snapshot.windows?.find((w) => w.label === 'Session')?.resetAt).toBe(
        '2026-07-02T03:10:00.000Z'
      )
      expect(snapshot.windows?.find((w) => w.label === 'Weekly')?.resetAt).toBe(
        '2026-07-07T08:00:00.000Z'
      )
    })

    it('stamps rollover cadence on every Claude window (pace tick + stale projection)', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        five_hour: { utilization: 28, resets_at: '2026-07-02T03:10:00Z' },
        seven_day: { utilization: 5, resets_at: '2026-07-07T08:00:00Z' },
        limits: [{ group: 'weekly', kind: 'weekly_scoped', percent: 8, scope: { label: 'Fable' } }]
      })
      const byLabel = (label: string): number | undefined =>
        snapshot.windows?.find((w) => w.label === label)?.limitWindowSeconds
      expect(byLabel('Session')).toBe(5 * 60 * 60)
      expect(byLabel('Weekly')).toBe(7 * 24 * 60 * 60)
      expect(byLabel('Fable')).toBe(7 * 24 * 60 * 60)
    })

    it('normalizes the real captured live payload (2026-07-01, Max 20x) exactly', () => {
      // Trimmed verbatim from a live api.anthropic.com/api/oauth/usage
      // response: every legacy direct family field is null (plus decoy
      // fields), Fable exists ONLY as a scoped limits[] entry whose scope
      // nests the name under scope.model.display_name, and the session
      // aggregate uses group "session" (not "five_hour").
      const snapshot = normalizeClaudeUsageSnapshot({
        five_hour: { utilization: 63, resets_at: '2026-07-02T02:10:00.567283+00:00' },
        seven_day: { utilization: 12, resets_at: '2026-07-07T07:00:00.567305+00:00' },
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
        seven_day_cowork: null,
        tangelo: null,
        extra_usage: { is_enabled: false },
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 63,
            severity: 'normal',
            resets_at: '2026-07-02T02:10:00.567283+00:00',
            scope: null,
            is_active: true
          },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 12,
            severity: 'normal',
            resets_at: '2026-07-07T07:00:00.567305+00:00',
            scope: null,
            is_active: false
          },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 21,
            severity: 'normal',
            resets_at: '2026-07-07T07:00:00.567531+00:00',
            scope: { model: { id: null, display_name: 'Fable' }, surface: null },
            is_active: false
          }
        ]
      })
      expect(
        snapshot.windows?.map((w) => ({ id: w.id, usedPercent: w.usedPercent, resetAt: w.resetAt }))
      ).toEqual([
        { id: 'claude-5h', usedPercent: 63, resetAt: '2026-07-02T02:10:00.567Z' },
        { id: 'claude-weekly', usedPercent: 12, resetAt: '2026-07-07T07:00:00.567Z' },
        { id: 'claude-weekly-fable', usedPercent: 21, resetAt: '2026-07-07T07:00:00.567Z' }
      ])
    })

    it('builds Session from the live "session"-group limits entry when five_hour vanishes', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 63,
            resets_at: '2026-07-02T02:10:00Z',
            scope: null
          },
          { kind: 'weekly_all', group: 'weekly', percent: 12, scope: null }
        ]
      })
      expect(snapshot.windows?.find((w) => w.label === 'Session')?.usedPercent).toBe(63)
      expect(snapshot.windows?.find((w) => w.label === 'Weekly')?.usedPercent).toBe(12)
    })

    it('tolerates malformed limits[] entries without throwing', () => {
      const snapshot = normalizeClaudeUsageSnapshot({
        limits: [null, 'garbage', { group: 'weekly', kind: 'weekly_scoped' }, {}]
      })
      expect(snapshot.windows?.find((w) => w.label === 'Fable')).toBeUndefined()
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
