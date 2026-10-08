import { describe, expect, it, vi } from 'vitest'
import {
  MUSE_SUBSCRIPTION_CLI_FAILURE_BACKOFF_MS,
  MUSE_SUBSCRIPTION_CLI_FRESH_TTL_MS,
  createMuseSubscriptionCliLane,
  museSubscriptionReadingHasMeters,
  parsePersistedMuseSubscriptionReading,
  type MuseSubscriptionCliPersistence
} from './MuseSubscriptionCliLane'
import type { MuseSubscriptionUsageReading } from './MuseSubscriptionUsage'

const T0 = Date.parse('2026-10-08T01:00:00.000Z')

function reading(
  overrides: Partial<MuseSubscriptionUsageReading> = {},
  at = T0
): MuseSubscriptionUsageReading {
  return {
    planName: 'Muse Code High Usage',
    hasSubscription: true,
    current: {
      usedPercent: 47,
      resetAtText: '4:18 PM',
      resetAt: '2026-10-08T16:18:00.000Z',
      limitWindowSeconds: null
    },
    weekly: {
      usedPercent: 17,
      resetAtText: 'Oct 12 1:00 AM',
      resetAt: '2026-10-12T01:00:00.000Z',
      limitWindowSeconds: 604_800
    },
    session: {
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turns: 0,
      subagents: 0
    },
    refreshedAt: new Date(at).toISOString(),
    ...overrides
  }
}

function meterless(at = T0): MuseSubscriptionUsageReading {
  return reading(
    {
      planName: null,
      hasSubscription: false,
      current: { usedPercent: null, resetAtText: null, resetAt: null, limitWindowSeconds: null },
      weekly: { usedPercent: null, resetAtText: null, resetAt: null, limitWindowSeconds: null }
    },
    at
  )
}

function memoryPersistence(initial: string | null = null): MuseSubscriptionCliPersistence & {
  text: string | null
} {
  const store = {
    text: initial,
    read: async () => store.text,
    write: async (text: string) => {
      store.text = text
    }
  }
  return store
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

describe('createMuseSubscriptionCliLane', () => {
  it('read() answers synchronously and kicks a single background probe', async () => {
    let clock = T0
    const probe = vi.fn(async () => reading({}, clock))
    const lane = createMuseSubscriptionCliLane({ probe, isEligible: () => true, now: () => clock })

    expect(lane.read()).toBeNull()
    expect(lane.read()).toBeNull()
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(lane.read()?.planName).toBe('Muse Code High Usage')

    // Inside the TTL every read is served from the observed reading.
    clock += MUSE_SUBSCRIPTION_CLI_FRESH_TTL_MS - 1
    lane.read()
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)

    // Past the TTL the next read re-probes once.
    clock += 2
    lane.read()
    lane.read()
    await flush()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('never probes while ineligible (signed out / no binary) and reports null', async () => {
    const probe = vi.fn(async () => reading())
    const lane = createMuseSubscriptionCliLane({ probe, isEligible: () => false, now: () => T0 })
    await expect(lane.maybeRefresh({ force: true })).resolves.toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('keeps the last observed reading through a meter-less probe and backs off', async () => {
    let clock = T0
    const outcomes = [reading({}, clock), meterless(clock + 1)]
    const probe = vi.fn(async () => outcomes.shift() ?? meterless(clock))
    const log = vi.fn()
    const lane = createMuseSubscriptionCliLane({
      probe,
      isEligible: () => true,
      now: () => clock,
      log
    })

    await lane.maybeRefresh({ force: true })
    expect(lane.read()?.weekly.usedPercent).toBe(17)

    clock += MUSE_SUBSCRIPTION_CLI_FRESH_TTL_MS + 1
    await expect(lane.maybeRefresh()).resolves.toMatchObject({ weekly: { usedPercent: 17 } })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no subscription meters'))

    // Backoff: a stale reading does not re-probe until the failure window ends.
    clock += MUSE_SUBSCRIPTION_CLI_FAILURE_BACKOFF_MS - 1
    await lane.maybeRefresh()
    expect(probe).toHaveBeenCalledTimes(2)
    clock += 2
    await lane.maybeRefresh()
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('treats a throwing probe as a failure without losing the held reading', async () => {
    let clock = T0
    let shouldThrow = false
    const probe = vi.fn(async () => {
      if (shouldThrow) throw new Error('pty unavailable')
      return reading({}, clock)
    })
    const lane = createMuseSubscriptionCliLane({ probe, isEligible: () => true, now: () => clock })
    await lane.maybeRefresh({ force: true })
    shouldThrow = true
    clock += MUSE_SUBSCRIPTION_CLI_FRESH_TTL_MS + 1
    await expect(lane.maybeRefresh()).resolves.toMatchObject({ current: { usedPercent: 47 } })
  })

  it('is single-flight: concurrent refreshes share one probe', async () => {
    let resolveProbe: ((value: MuseSubscriptionUsageReading) => void) | null = null
    const probe = vi.fn(
      () =>
        new Promise<MuseSubscriptionUsageReading>((resolve) => {
          resolveProbe = resolve
        })
    )
    const lane = createMuseSubscriptionCliLane({ probe, isEligible: () => true, now: () => T0 })
    const first = lane.maybeRefresh({ force: true })
    const second = lane.maybeRefresh({ force: true })
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)
    resolveProbe!(reading())
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(a?.planName).toBe('Muse Code High Usage')
  })

  it('persists an observed reading and restores it on hydrate', async () => {
    const persistence = memoryPersistence()
    const probe = vi.fn(async () => reading())
    const lane = createMuseSubscriptionCliLane({
      probe,
      isEligible: () => true,
      now: () => T0,
      persistence
    })
    await lane.maybeRefresh({ force: true })
    expect(persistence.text).toContain('"schemaVersion": 1')
    expect(persistence.text).toContain('Muse Code High Usage')
    // Nothing secret: the persisted shape is the display reading alone.
    expect(persistence.text).not.toMatch(/api_key|cookie|authorization|bearer/i)

    const restored = createMuseSubscriptionCliLane({
      probe: vi.fn(async () => meterless()),
      isEligible: () => true,
      now: () => T0 + 1_000,
      persistence: memoryPersistence(persistence.text)
    })
    await restored.hydrate()
    expect(restored.read()?.weekly.usedPercent).toBe(17)
    // Restored at T0 is inside the TTL at T0+1s, so no probe is spawned.
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('re-probes a restored reading once it is older than the TTL', async () => {
    const persistence = memoryPersistence(
      JSON.stringify({ schemaVersion: 1, reading: reading({}, T0) })
    )
    const probe = vi.fn(async () => reading({ planName: 'Fresh' }, T0 + 20 * 60_000))
    const lane = createMuseSubscriptionCliLane({
      probe,
      isEligible: () => true,
      now: () => T0 + 20 * 60_000,
      persistence
    })
    await lane.hydrate()
    expect(lane.read()?.planName).toBe('Muse Code High Usage')
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(lane.read()?.planName).toBe('Fresh')
  })
})

describe('parsePersistedMuseSubscriptionReading', () => {
  it('rejects malformed, meter-less, or undated snapshots and re-validates fields', () => {
    expect(parsePersistedMuseSubscriptionReading(null)).toBeNull()
    expect(parsePersistedMuseSubscriptionReading('not json')).toBeNull()
    expect(parsePersistedMuseSubscriptionReading(JSON.stringify({ schemaVersion: 2 }))).toBeNull()
    expect(
      parsePersistedMuseSubscriptionReading(
        JSON.stringify({ schemaVersion: 1, reading: meterless() })
      )
    ).toBeNull()
    const undated = reading()
    expect(
      parsePersistedMuseSubscriptionReading(
        JSON.stringify({ schemaVersion: 1, reading: { ...undated, refreshedAt: 'yesterday' } })
      )
    ).toBeNull()
    const tampered = JSON.stringify({
      schemaVersion: 1,
      reading: {
        ...reading(),
        current: { usedPercent: 250, resetAtText: '', resetAt: 'nope', limitWindowSeconds: 5 },
        session: { inputTokens: -4, turns: 1.5 }
      }
    })
    const parsed = parsePersistedMuseSubscriptionReading(tampered)
    expect(parsed).not.toBeNull()
    expect(parsed?.current).toEqual({
      usedPercent: null,
      resetAtText: null,
      resetAt: null,
      limitWindowSeconds: null
    })
    expect(parsed?.weekly.limitWindowSeconds).toBe(604_800)
    expect(parsed?.session.inputTokens).toBeNull()
    expect(parsed?.session.turns).toBeNull()
  })

  it('museSubscriptionReadingHasMeters needs a subscription with at least one percent', () => {
    expect(museSubscriptionReadingHasMeters(reading())).toBe(true)
    expect(museSubscriptionReadingHasMeters(meterless())).toBe(false)
    expect(
      museSubscriptionReadingHasMeters(
        reading({
          current: {
            usedPercent: null,
            resetAtText: null,
            resetAt: null,
            limitWindowSeconds: null
          },
          weekly: { usedPercent: 0, resetAtText: null, resetAt: null, limitWindowSeconds: null }
        })
      )
    ).toBe(true)
    expect(museSubscriptionReadingHasMeters(null)).toBe(false)
  })
})
