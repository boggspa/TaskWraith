import { describe, expect, it } from 'vitest'
import {
  buildDevinUsageSnapshot,
  DEVIN_DAILY_WINDOW_SECONDS,
  DEVIN_PLAN_INFO_SQL,
  DEVIN_WEEKLY_WINDOW_SECONDS,
  devinStateDbCandidates,
  isDevinPlanInfoBlob,
  loadDevinUsageSnapshot,
  parseDevinPlanInfoBlob
} from './DevinUsage'

const NOW_ISO = '2026-09-03T15:00:00.000Z'
const NOW_MS = Date.parse(NOW_ISO)

function fullPlanInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planName: 'Core',
    hideDailyQuota: false,
    hideWeeklyQuota: false,
    startTimestamp: Date.parse('2026-09-01T00:00:00.000Z'),
    endTimestamp: Date.parse('2026-10-01T00:00:00.000Z'),
    quotaUsage: {
      dailyRemainingPercent: 40,
      dailyResetAtUnix: Math.floor(Date.parse('2026-09-04T00:00:00.000Z') / 1000),
      weeklyRemainingPercent: 80,
      weeklyResetAtUnix: Math.floor(Date.parse('2026-09-07T01:00:00.000Z') / 1000)
    },
    ...overrides
  }
}

describe('parseDevinPlanInfoBlob', () => {
  it('maps cached plan info into daily and weekly windows with inverted percents and resets', () => {
    const parsed = parseDevinPlanInfoBlob(fullPlanInfo())
    expect(parsed.planName).toBe('Core')
    expect(parsed.windows).toEqual([
      {
        id: 'devin-daily',
        label: 'Daily quota (Core)',
        limitLabel: 'Today',
        usedPercent: 60, // 100 - 40 remaining
        resetAt: '2026-09-04T00:00:00.000Z',
        limitWindowSeconds: DEVIN_DAILY_WINDOW_SECONDS
      },
      {
        id: 'devin-weekly',
        label: 'Weekly quota (Core)',
        limitLabel: 'This week',
        usedPercent: 20, // 100 - 80 remaining
        resetAt: '2026-09-07T01:00:00.000Z',
        limitWindowSeconds: DEVIN_WEEKLY_WINDOW_SECONDS
      }
    ])
    expect(DEVIN_DAILY_WINDOW_SECONDS).toBe(86400)
    expect(DEVIN_WEEKLY_WINDOW_SECONDS).toBe(604800)
  })

  it('inverts remaining percent at both ends: 0 remaining is fully used, 100 remaining is unused', () => {
    const parsed = parseDevinPlanInfoBlob(
      fullPlanInfo({
        quotaUsage: { dailyRemainingPercent: 0, weeklyRemainingPercent: 100 }
      })
    )
    const daily = parsed.windows.find((window) => window.id === 'devin-daily')
    const weekly = parsed.windows.find((window) => window.id === 'devin-weekly')
    expect(daily?.usedPercent).toBe(100)
    expect(weekly?.usedPercent).toBe(0)
  })

  it('emits no daily window when hideDailyQuota is true, and no weekly window when hideWeeklyQuota is true', () => {
    const dailyHidden = parseDevinPlanInfoBlob(fullPlanInfo({ hideDailyQuota: true }))
    expect(dailyHidden.windows.map((window) => window.id)).toEqual(['devin-weekly'])

    const weeklyHidden = parseDevinPlanInfoBlob(fullPlanInfo({ hideWeeklyQuota: true }))
    expect(weeklyHidden.windows.map((window) => window.id)).toEqual(['devin-daily'])

    const bothHidden = parseDevinPlanInfoBlob(
      fullPlanInfo({ hideDailyQuota: true, hideWeeklyQuota: true })
    )
    expect(bothHidden.windows).toEqual([])
    // The plan name still parses — a hidden tier is configured, not absent.
    expect(bothHidden.planName).toBe('Core')
  })

  it('falls back to message/flow-action counters when quotaUsage is absent', () => {
    const parsed = parseDevinPlanInfoBlob(
      fullPlanInfo({
        quotaUsage: undefined,
        usage: { messages: 100, usedMessages: 25, flowActions: 40, usedFlowActions: 10 }
      })
    )
    const daily = parsed.windows.find((window) => window.id === 'devin-daily')
    const weekly = parsed.windows.find((window) => window.id === 'devin-weekly')
    expect(daily?.usedPercent).toBe(25)
    expect(weekly?.usedPercent).toBe(25)
    // No per-window resets in the fallback path — the plan end timestamp is used.
    expect(daily?.resetAt).toBe('2026-10-01T00:00:00.000Z')
    expect(weekly?.resetAt).toBe('2026-10-01T00:00:00.000Z')
  })

  it('prefers quotaUsage over the usage counters when both are present', () => {
    const parsed = parseDevinPlanInfoBlob(
      fullPlanInfo({
        usage: { messages: 100, usedMessages: 99, flowActions: 100, usedFlowActions: 99 }
      })
    )
    expect(parsed.windows.find((window) => window.id === 'devin-daily')?.usedPercent).toBe(60)
    expect(parsed.windows.find((window) => window.id === 'devin-weekly')?.usedPercent).toBe(20)
  })

  it('unwraps an AuthStatus-shaped row that nests planInfo', () => {
    const parsed = parseDevinPlanInfoBlob({
      apiKey: 'must-not-leak',
      planInfo: fullPlanInfo()
    })
    expect(parsed.windows.map((window) => window.id)).toEqual(['devin-daily', 'devin-weekly'])
    expect(JSON.stringify(parsed)).not.toContain('must-not-leak')
  })

  it('ignores rows with no plan-info shape and garbage numbers', () => {
    expect(parseDevinPlanInfoBlob(null).windows).toEqual([])
    expect(parseDevinPlanInfoBlob('text').windows).toEqual([])
    expect(parseDevinPlanInfoBlob({ apiKey: 'x', userStatusProtoBinaryBase64: 'y' }).windows).toEqual(
      []
    )
    expect(
      parseDevinPlanInfoBlob(
        fullPlanInfo({ quotaUsage: { dailyRemainingPercent: 'soon', weeklyRemainingPercent: NaN } })
      ).windows
    ).toEqual([])
  })
})

describe('isDevinPlanInfoBlob', () => {
  it('accepts plan-bearing rows and rejects credential-only rows', () => {
    expect(isDevinPlanInfoBlob(fullPlanInfo())).toBe(true)
    expect(isDevinPlanInfoBlob({ apiKey: 'x' })).toBe(false)
  })
})

describe('loadDevinUsageSnapshot', () => {
  it('returns unconfigured off macOS without touching the DB', async () => {
    let reads = 0
    const snapshot = await loadDevinUsageSnapshot({
      platform: 'linux',
      readPlanInfoRows: async () => {
        reads += 1
        return [JSON.stringify(fullPlanInfo())]
      },
      now: () => NOW_MS
    })
    expect(reads).toBe(0)
    expect(snapshot.configured).toBe(false)
    expect(snapshot.windows).toEqual([])
    expect(snapshot.error).toContain('macOS')
  })

  it('returns unconfigured when no plan-info rows exist', async () => {
    const snapshot = await loadDevinUsageSnapshot({
      platform: 'darwin',
      readPlanInfoRows: async () => [],
      now: () => NOW_MS
    })
    expect(snapshot.configured).toBe(false)
    expect(snapshot.fetchedAt).toBe(NOW_ISO)
  })

  it('builds a configured snapshot from the first usable row on macOS', async () => {
    const snapshot = await loadDevinUsageSnapshot({
      platform: 'darwin',
      readPlanInfoRows: async () => [
        'not json',
        JSON.stringify({ apiKey: 'x' }), // credential-only row: skipped
        JSON.stringify(fullPlanInfo())
      ],
      now: () => NOW_MS
    })
    expect(snapshot.configured).toBe(true)
    expect(snapshot.provider).toBe('devin')
    expect(snapshot.planType).toBe('Core')
    expect(snapshot.windows.map((window) => window.id)).toEqual(['devin-daily', 'devin-weekly'])
    expect(snapshot.fetchedAt).toBe(NOW_ISO)
  })

  it('reports configured-with-error when rows exist but none carry plan info', async () => {
    const snapshot = await loadDevinUsageSnapshot({
      platform: 'darwin',
      readPlanInfoRows: async () => ['{}', '[]'],
      now: () => NOW_MS
    })
    expect(snapshot.configured).toBe(true)
    expect(snapshot.windows).toEqual([])
    expect(snapshot.error).toContain('plan info')
  })

  it('never throws on a failing DB read', async () => {
    const snapshot = await loadDevinUsageSnapshot({
      platform: 'darwin',
      readPlanInfoRows: async () => {
        throw new Error('database is locked')
      },
      now: () => NOW_MS
    })
    expect(snapshot.configured).toBe(false)
    expect(snapshot.error).toBe('database is locked')
  })
})

describe('module constants and helpers', () => {
  it('queries the plan-info key families ahead of the AuthStatus fallback', () => {
    expect(DEVIN_PLAN_INFO_SQL).toContain('reactSettings.cachedPlanInfoData:user-')
    expect(DEVIN_PLAN_INFO_SQL).toContain('%PlanInfo%')
    expect(DEVIN_PLAN_INFO_SQL).toContain('%AuthStatus%')
  })

  it('offers the live DB before its backup', () => {
    const candidates = devinStateDbCandidates('/Users/test')
    expect(candidates).toEqual([
      '/Users/test/Library/Application Support/Devin/User/globalStorage/state.vscdb',
      '/Users/test/Library/Application Support/Devin/User/globalStorage/state.vscdb.backup'
    ])
  })

  it('builds a snapshot with plan type and no balances', () => {
    const snapshot = buildDevinUsageSnapshot(fullPlanInfo(), NOW_ISO)
    expect(snapshot.balances).toEqual([])
    expect(snapshot.planType).toBe('Core')
    expect(snapshot.source).toBe('devin-state-vscdb')
  })
})

describe('Devin free-plan detection', () => {
  // Field names and values transcribed from the real
  // `windsurf.reactSettings.cachedPlanInfoData:user-*` row on 2026-09-03.
  const devinFreeBlob = {
    planName: 'Free',
    billingStrategy: 'quota',
    isDevinUser: true,
    isFreeOrTrial: true,
    isDevinFree: true,
    teamsTier: 19,
    dailyRemainingPercent: 52,
    weeklyRemainingPercent: 0,
    dailyResetAtUnix: 1787472000,
    weeklyResetAtUnix: 1787472000,
    hideDailyQuota: false,
    hideWeeklyQuota: false
  }

  it('reads the free tier off a Devin-owned plan blob', () => {
    expect(parseDevinPlanInfoBlob(devinFreeBlob).freePlan).toBe(true)
    expect(buildDevinUsageSnapshot(devinFreeBlob, '2026-09-03T00:00:00.000Z').freePlan).toBe(true)
  })

  it('reports a paid Devin plan as not free', () => {
    const paid = { ...devinFreeBlob, planName: 'Core', isDevinFree: false, isFreeOrTrial: false }
    expect(parseDevinPlanInfoBlob(paid).freePlan).toBe(false)
  })

  it('ignores the co-resident Windsurf plan row entirely', () => {
    // The same state DB caches `windsurf.settings.cachedPlanInfo`, which said
    // `Pro` while the Devin row said `Free`. It carries neither Devin flag, so
    // it must not decide the gate in EITHER direction.
    const windsurf = {
      planName: 'Pro',
      billingStrategy: 'quota',
      usage: { messages: -1, usedMessages: 0 },
      quotaUsage: { dailyRemainingPercent: 0, weeklyRemainingPercent: 0 },
      teamsTier: 16
    }
    const parsed = parseDevinPlanInfoBlob(windsurf)
    expect(parsed.planName).toBe('Pro')
    expect(parsed.freePlan).toBeUndefined()
    expect(buildDevinUsageSnapshot(windsurf, '2026-09-03T00:00:00.000Z').freePlan).toBeUndefined()
  })

  it('accepts a Free plan name only alongside the Devin discriminator', () => {
    expect(parseDevinPlanInfoBlob({ planName: 'Free', isDevinUser: true }).freePlan).toBe(true)
    expect(parseDevinPlanInfoBlob({ planName: 'Free' }).freePlan).toBeUndefined()
  })

  it('leaves freePlan absent when there is no plan shape at all', () => {
    expect(parseDevinPlanInfoBlob({ nothing: true }).freePlan).toBeUndefined()
    expect(parseDevinPlanInfoBlob(null).freePlan).toBeUndefined()
  })
})

