import { describe, it, expect } from 'vitest'
import {
  parseCursorUsageResponse,
  buildCursorUsageSnapshot,
  loadCursorUsageSnapshot,
  cursorStateDbCandidates,
  CURSOR_STATE_DB_RELATIVE
} from './CursorUsage'

const FULL_PAYLOAD = {
  // 2030-01-01T00:00:00Z in ms (string form, as Cursor sometimes sends).
  billingCycleEnd: '1893456000000',
  planUsage: {
    totalPercentUsed: 42,
    autoPercentUsed: 17.5,
    apiPercentUsed: 0
  },
  spendLimitUsage: {
    individualLimit: 2000, // $20.00 cents
    individualRemaining: 1550 // $15.50 cents
  }
}

describe('parseCursorUsageResponse', () => {
  it('maps the three plan windows with reset + clamped percents', () => {
    const { windows } = parseCursorUsageResponse(FULL_PAYLOAD)
    expect(windows.map((w) => w.label)).toEqual(['Included in Pro', 'Auto + Composer', 'API'])
    expect(windows[0].usedPercent).toBe(42)
    expect(windows[1].usedPercent).toBe(17.5)
    expect(windows[2].usedPercent).toBe(0) // 0% is a valid window, not skipped
    expect(windows[0].resetAt).toBe('2030-01-01T00:00:00.000Z')
    expect(windows.every((w) => w.limitLabel === 'This cycle')).toBe(true)
    expect(windows.every((w) => w.limitWindowSeconds === 30 * 24 * 60 * 60)).toBe(true)
  })

  it('derives the On-Demand Spend balance only when individualLimit > 0', () => {
    const { balances } = parseCursorUsageResponse(FULL_PAYLOAD)
    expect(balances).toHaveLength(1)
    const balance = balances[0]
    expect(balance.label).toBe('On-Demand Spend')
    expect(balance.amount).toBeCloseTo(15.5) // remaining / 100
    expect(balance.unit).toBe('USD')
    // used = limit - remaining = 2000 - 1550 = 450 cents = $4.50
    expect(balance.subtitle).toBe('$4.50 of $20.00 on-demand used')
    expect(balance.resetAt).toBe('2030-01-01T00:00:00.000Z')
  })

  it('omits the spend balance when there is no individual limit', () => {
    const { balances } = parseCursorUsageResponse({
      planUsage: { totalPercentUsed: 10 },
      spendLimitUsage: { individualLimit: 0, individualRemaining: 0 }
    })
    expect(balances).toHaveLength(0)
  })

  it('skips non-finite percents but keeps the finite ones', () => {
    const { windows } = parseCursorUsageResponse({
      planUsage: { totalPercentUsed: 'nope', autoPercentUsed: 33 }
    })
    expect(windows.map((w) => w.label)).toEqual(['Auto + Composer'])
    expect(windows[0].usedPercent).toBe(33)
  })

  it('emits a single 0% placeholder when planUsage has no usable percents', () => {
    const { windows } = parseCursorUsageResponse({ planUsage: {} })
    expect(windows).toHaveLength(1)
    expect(windows[0].label).toBe('Included in Pro')
    expect(windows[0].usedPercent).toBe(0)
  })

  it('clamps an over-limit percent to 100', () => {
    const { windows } = parseCursorUsageResponse({ planUsage: { totalPercentUsed: 137 } })
    expect(windows[0].usedPercent).toBe(100)
  })

  it('returns empty for null / non-object payloads', () => {
    expect(parseCursorUsageResponse(null)).toEqual({ windows: [], balances: [] })
    expect(parseCursorUsageResponse('garbage')).toEqual({ windows: [], balances: [] })
    expect(parseCursorUsageResponse(42)).toEqual({ windows: [], balances: [] })
  })

  it('omits resetAt when billingCycleEnd is missing or invalid', () => {
    const { windows } = parseCursorUsageResponse({ planUsage: { totalPercentUsed: 5 } })
    expect(windows[0].resetAt).toBeUndefined()
  })
})

describe('buildCursorUsageSnapshot', () => {
  it('wraps the parse into a configured snapshot', () => {
    const snap = buildCursorUsageSnapshot(
      FULL_PAYLOAD,
      '2026-05-29T00:00:00.000Z',
      'pro_plus'
    )
    expect(snap.provider).toBe('cursor')
    expect(snap.configured).toBe(true)
    expect(snap.source).toBe('cursor-dashboard-usage')
    expect(snap.fetchedAt).toBe('2026-05-29T00:00:00.000Z')
    expect(snap.windows).toHaveLength(3)
    expect(snap.balances).toHaveLength(1)
    expect(snap.planType).toBe('pro_plus')
  })
})

describe('cursorStateDbCandidates', () => {
  it('returns the live DB then the .backup, under the right relative path', () => {
    const [live, backup] = cursorStateDbCandidates('/Users/me')
    expect(live).toBe(`/Users/me/${CURSOR_STATE_DB_RELATIVE}`)
    expect(backup).toBe(`${live}.backup`)
  })

  it('tolerates a trailing slash on the home dir', () => {
    const [live] = cursorStateDbCandidates('/Users/me/')
    expect(live).toBe(`/Users/me/${CURSOR_STATE_DB_RELATIVE}`)
  })
})

describe('loadCursorUsageSnapshot', () => {
  const fixedNow = () => Date.parse('2026-05-29T12:00:00.000Z')

  it('returns configured:false with a sign-in hint when no token', async () => {
    const snap = await loadCursorUsageSnapshot({
      readAccessToken: async () => null,
      fetchUsageRpc: async () => {
        throw new Error('should not be called')
      },
      now: fixedNow
    })
    expect(snap.configured).toBe(false)
    expect(snap.error).toMatch(/sign-in/i)
    expect(snap.windows).toHaveLength(0)
    expect(snap.fetchedAt).toBe('2026-05-29T12:00:00.000Z')
  })

  it('returns configured:true with the error when the RPC fails', async () => {
    const snap = await loadCursorUsageSnapshot({
      readAccessToken: async () => 'tok',
      fetchUsageRpc: async () => {
        throw new Error('HTTP 401')
      },
      now: fixedNow
    })
    expect(snap.configured).toBe(true)
    expect(snap.error).toBe('HTTP 401')
    expect(snap.windows).toHaveLength(0)
  })

  it('builds a full snapshot when token + RPC succeed', async () => {
    const snap = await loadCursorUsageSnapshot({
      readAccessToken: async () => 'tok',
      readPlanType: async () => 'pro_plus',
      fetchUsageRpc: async () => FULL_PAYLOAD,
      now: fixedNow
    })
    expect(snap.configured).toBe(true)
    expect(snap.error).toBeUndefined()
    expect(snap.windows).toHaveLength(3)
    expect(snap.balances).toHaveLength(1)
    expect(snap.planType).toBe('pro_plus')
  })

  it('keeps usage available when local membership metadata is unreadable', async () => {
    const snap = await loadCursorUsageSnapshot({
      readAccessToken: async () => 'tok',
      readPlanType: async () => {
        throw new Error('sqlite locked')
      },
      fetchUsageRpc: async () => FULL_PAYLOAD,
      now: fixedNow
    })

    expect(snap.windows).toHaveLength(3)
    expect(snap.planType).toBeUndefined()
  })

  it('treats a thrown token read as no token (never crashes)', async () => {
    const snap = await loadCursorUsageSnapshot({
      readAccessToken: async () => {
        throw new Error('sqlite locked')
      },
      fetchUsageRpc: async () => FULL_PAYLOAD,
      now: fixedNow
    })
    expect(snap.configured).toBe(false)
    expect(snap.windows).toHaveLength(0)
  })
})
