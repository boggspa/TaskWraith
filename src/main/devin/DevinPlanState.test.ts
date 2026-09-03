import { describe, expect, it } from 'vitest'
import { createDevinPlanStateResolver } from './DevinPlanState'

const DEVIN_FREE_ROW = JSON.stringify({
  planName: 'Free',
  isDevinUser: true,
  isDevinFree: true,
  dailyRemainingPercent: 52,
  weeklyRemainingPercent: 0
})
const DEVIN_PAID_ROW = JSON.stringify({
  planName: 'Core',
  isDevinUser: true,
  isDevinFree: false,
  dailyRemainingPercent: 90
})

function harness(rows: string[] | (() => Promise<string[]>), opts: { ttlMs?: number } = {}) {
  let clock = 1_000
  let reads = 0
  const readPlanInfoRows = async () => {
    reads += 1
    return typeof rows === 'function' ? rows() : rows
  }
  const resolver = createDevinPlanStateResolver({
    readPlanInfoRows,
    now: () => clock,
    platform: 'darwin',
    ttlMs: opts.ttlMs ?? 60_000
  })
  return {
    resolver,
    reads: () => reads,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

describe('Devin plan state cache', () => {
  it('reports the free plan from the state DB', async () => {
    const h = harness([DEVIN_FREE_ROW])
    await expect(h.resolver.resolve()).resolves.toBe(true)
  })

  it('reports a paid plan as not free', async () => {
    const h = harness([DEVIN_PAID_ROW])
    await expect(h.resolver.resolve()).resolves.toBe(false)
  })

  it('reuses the cached answer inside the TTL', async () => {
    const h = harness([DEVIN_FREE_ROW])
    await h.resolver.resolve()
    await h.resolver.resolve()
    h.advance(59_000)
    await h.resolver.resolve()
    expect(h.reads()).toBe(1)
  })

  it('re-reads once the TTL lapses', async () => {
    const h = harness([DEVIN_FREE_ROW])
    await h.resolver.resolve()
    h.advance(61_000)
    await h.resolver.resolve()
    expect(h.reads()).toBe(2)
  })

  it('collapses concurrent callers onto one read', async () => {
    const h = harness([DEVIN_FREE_ROW])
    const [a, b, c] = await Promise.all([
      h.resolver.resolve(),
      h.resolver.resolve(),
      h.resolver.resolve()
    ])
    expect([a, b, c]).toEqual([true, true, true])
    expect(h.reads()).toBe(1)
  })

  it('fails open to undefined when the DB read throws', async () => {
    const h = harness(async () => {
      throw new Error('database is locked')
    })
    await expect(h.resolver.resolve()).resolves.toBeUndefined()
  })

  it('fails open when no Devin-owned plan row exists', async () => {
    const h = harness([JSON.stringify({ planName: 'Pro', usage: { messages: -1 } })])
    await expect(h.resolver.resolve()).resolves.toBeUndefined()
  })

  it('caches the failed answer instead of re-reading every call', async () => {
    const h = harness(async () => {
      throw new Error('database is locked')
    })
    await h.resolver.resolve()
    await h.resolver.resolve()
    expect(h.reads()).toBe(1)
  })

  it('re-reads after an explicit invalidate', async () => {
    const h = harness([DEVIN_FREE_ROW])
    await h.resolver.resolve()
    h.resolver.invalidate()
    await h.resolver.resolve()
    expect(h.reads()).toBe(2)
  })
})
