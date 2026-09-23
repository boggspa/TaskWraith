import { describe, expect, it } from 'vitest'

import {
  HOST_LAST_LEASE_GRACE_MS,
  HOST_LEASE_BUSY_CAP_MS,
  HOST_LEASE_DEFAULT_TIMING,
  HOST_LEASE_DISABLED_ENV,
  HOST_LEASE_HEARTBEAT_MS,
  HOST_LEASE_TIMING_ENV,
  HOST_LEASE_TTL_MS,
  HOST_PERSIST_ENV,
  HostLeaseRegistry,
  isHostLeaseProtocolDisabled,
  isHostPersistEnabled,
  resolveHostLeaseTiming,
  type HostLeaseExitReason,
  type HostLeaseRegistryOptions,
  type HostLeaseTickInfo
} from './HostLeaseRegistry'

const TICK_MS = HOST_LEASE_DEFAULT_TIMING.tickMs

/**
 * A registry on a stepped clock. `advance(ms)` moves the monotonic clock and
 * ticks once, so "one tick per second" is literal; `sleep(ms)` moves BOTH
 * clocks without ticking, which is what a suspended machine looks like from
 * inside the Host; `skew(ms)` moves only the wall clock, the Linux shape where
 * CLOCK_MONOTONIC stops during suspend.
 */
function harness(options: Omit<HostLeaseRegistryOptions, 'ports' | 'log'> = {}) {
  let monoNs = 0n
  let wallSkewMs = 0
  let leaseSequence = 0
  const exits: HostLeaseExitReason[] = []
  const logs: string[] = []
  const ticks: HostLeaseTickInfo[] = []
  let scheduled: { intervalMs: number; cancelled: boolean } | null = null
  const registry = new HostLeaseRegistry({
    ...options,
    onExit: options.onExit ?? ((reason) => exits.push(reason)),
    log: (line) => logs.push(line),
    ports: {
      monotonicNowNs: () => monoNs,
      wallNowMs: () => Number(monoNs / 1_000_000n) + wallSkewMs,
      schedule: (_tick, intervalMs) => {
        scheduled = { intervalMs, cancelled: false }
        return () => {
          if (scheduled) scheduled.cancelled = true
        }
      },
      leaseId: () => {
        leaseSequence += 1
        return `lease-${leaseSequence}`
      }
    }
  })
  registry.subscribeTick((info) => ticks.push(info))
  const advance = (ms: number) => {
    monoNs += BigInt(ms) * 1_000_000n
    registry.tick()
  }
  const advanceTicks = (count: number, stepMs = TICK_MS) => {
    for (let index = 0; index < count; index += 1) advance(stepMs)
  }
  return {
    registry,
    exits,
    logs,
    ticks,
    advance,
    advanceTicks,
    sleep: (ms: number) => {
      monoNs += BigInt(ms) * 1_000_000n
    },
    skew: (ms: number) => {
      wallSkewMs += ms
    },
    scheduled: () => scheduled
  }
}

describe('resolveHostLeaseTiming', () => {
  it('uses the D14 defaults when the variable is unset or blank', () => {
    expect(resolveHostLeaseTiming({})).toEqual({
      source: 'default',
      timing: HOST_LEASE_DEFAULT_TIMING
    })
    expect(resolveHostLeaseTiming({ [HOST_LEASE_TIMING_ENV]: '  ' }).source).toBe('default')
    expect(HOST_LEASE_DEFAULT_TIMING).toEqual({
      heartbeatMs: 5_000,
      ttlMs: 20_000,
      graceMs: 45_000,
      tickMs: 1_000,
      suspendGapMs: 5_000,
      busyCapMs: 1_800_000
    })
  })

  it('accepts a shortening override and ticks no slower than the heartbeat', () => {
    expect(
      resolveHostLeaseTiming({ [HOST_LEASE_TIMING_ENV]: 'heartbeat:200,ttl:800,grace:1500' })
    ).toEqual({
      source: 'environment',
      raw: 'heartbeat:200,ttl:800,grace:1500',
      timing: {
        heartbeatMs: 200,
        ttlMs: 800,
        graceMs: 1500,
        tickMs: 200,
        suspendGapMs: 5_000,
        busyCapMs: HOST_LEASE_BUSY_CAP_MS
      }
    })
  })

  it('rejects an override that extends, under-bounds, or misspells the timing', () => {
    for (const [raw, reason] of [
      [`heartbeat:${HOST_LEASE_HEARTBEAT_MS + 1},ttl:${HOST_LEASE_TTL_MS},grace:1500`, /shorten/],
      [`heartbeat:1000,ttl:2000,grace:${HOST_LAST_LEASE_GRACE_MS + 1}`, /shorten/],
      ['heartbeat:99,ttl:800,grace:1500', /heartbeat must be at least 100/],
      ['heartbeat:500,ttl:800,grace:1500', /twice the heartbeat/],
      ['heartbeat:200,ttl:800,grace:499', /grace must be at least 500/],
      ['heartbeat:200,ttl:800', /all required/],
      ['heartbeat:200,ttl:800,grace:1500,busy:1', /unrecognised segment/],
      ['heartbeat:200,heartbeat:200,ttl:800,grace:1500', /duplicate/]
    ] as const) {
      const resolved = resolveHostLeaseTiming({ [HOST_LEASE_TIMING_ENV]: raw })
      expect(resolved.source, raw).toBe('rejected')
      if (resolved.source !== 'rejected') continue
      expect(resolved.reason, raw).toMatch(reason)
      expect(resolved.timing).toBe(HOST_LEASE_DEFAULT_TIMING)
    }
  })

  it('honours TASKWRAITH_HOST_LEASE_DISABLED only under a valid timing override', () => {
    const timing = { [HOST_LEASE_TIMING_ENV]: 'heartbeat:200,ttl:800,grace:1500' }
    expect(isHostLeaseProtocolDisabled({})).toBe(false)
    expect(isHostLeaseProtocolDisabled({ [HOST_LEASE_DISABLED_ENV]: '1' })).toBe(false)
    expect(
      isHostLeaseProtocolDisabled({
        [HOST_LEASE_DISABLED_ENV]: '1',
        [HOST_LEASE_TIMING_ENV]: 'heartbeat:200,ttl:800,grace:99'
      })
    ).toBe(false)
    expect(isHostLeaseProtocolDisabled({ ...timing, [HOST_LEASE_DISABLED_ENV]: 'true' })).toBe(
      false
    )
    expect(isHostLeaseProtocolDisabled({ ...timing })).toBe(false)
    expect(isHostLeaseProtocolDisabled({ ...timing, [HOST_LEASE_DISABLED_ENV]: '1' })).toBe(true)
  })

  it('reads TASKWRAITH_HOST_PERSIST as exactly 1', () => {
    expect(isHostPersistEnabled({})).toBe(false)
    expect(isHostPersistEnabled({ [HOST_PERSIST_ENV]: '1' })).toBe(true)
    expect(isHostPersistEnabled({ [HOST_PERSIST_ENV]: ' 1 ' })).toBe(true)
    expect(isHostPersistEnabled({ [HOST_PERSIST_ENV]: 'true' })).toBe(false)
    expect(isHostPersistEnabled({ [HOST_PERSIST_ENV]: '0' })).toBe(false)
  })
})

describe('HostLeaseRegistry', () => {
  describe('per-socket leases', () => {
    it('counts a lease-less authenticated socket as an implicit holder until it closes', () => {
      const h = harness()
      h.registry.start()
      expect(h.registry.summary()).toMatchObject({ phase: 'grace', holders: 0 })
      h.registry.authenticated(1)
      expect(h.registry.stateOf(1)).toBe('implicit')
      expect(h.registry.summary()).toMatchObject({
        phase: 'held',
        holders: 1,
        implicitHolders: 1,
        explicitHolders: 0
      })
      h.registry.closed(1)
      expect(h.registry.stateOf(1)).toBe('none')
      expect(h.registry.summary()).toMatchObject({ phase: 'grace', holders: 0, implicitHolders: 0 })
    })

    it('acquires, renews and releases on the socket that asked, and refuses foreign lease ids', () => {
      const h = harness()
      h.registry.start()
      h.registry.authenticated(1)
      h.registry.authenticated(2)
      expect(h.registry.acquire(3)).toBeNull()
      const acquired = h.registry.acquire(1)
      expect(acquired).toEqual({
        leaseId: 'lease-1',
        heartbeatMs: HOST_LEASE_HEARTBEAT_MS,
        ttlMs: HOST_LEASE_TTL_MS,
        hostNowMs: 0
      })
      expect(h.registry.stateOf(1)).toBe('explicit')
      expect(h.registry.summary()).toMatchObject({
        holders: 2,
        explicitHolders: 1,
        implicitHolders: 1
      })
      // Re-acquiring on the same socket is idempotent: the same lease, beat refreshed.
      expect(h.registry.acquire(1)?.leaseId).toBe('lease-1')
      expect(h.registry.renew(2, 'lease-1')).toBeNull()
      expect(h.registry.renew(1, 'lease-9')).toBeNull()
      expect(h.registry.renew(1, 'lease-1')).toEqual({
        leaseId: 'lease-1',
        expiresInMs: HOST_LEASE_TTL_MS,
        hostNowMs: 0
      })
      expect(h.registry.release(2, 'lease-1')).toBe(false)
      expect(h.registry.release(1, 'lease-1')).toBe(true)
      expect(h.registry.stateOf(1)).toBe('declined')
      expect(h.registry.release(1, 'lease-1')).toBe(false)
      expect(h.registry.summary()).toMatchObject({ holders: 1, declined: 1 })
    })

    it('lets a socket decline and stops counting it', () => {
      const h = harness()
      h.registry.start()
      h.registry.authenticated(1)
      expect(h.registry.decline(1)).toBe(true)
      expect(h.registry.stateOf(1)).toBe('declined')
      expect(h.registry.summary()).toMatchObject({ phase: 'grace', holders: 0, declined: 1 })
      expect(h.registry.decline(7)).toBe(false)
    })

    it('releases a socket lease on close', () => {
      const h = harness()
      h.registry.start()
      h.registry.authenticated(1)
      h.registry.acquire(1)
      h.registry.closed(1)
      expect(h.registry.summary()).toMatchObject({ phase: 'grace', holders: 0, explicitHolders: 0 })
    })

    it('answers nothing after stop', () => {
      const h = harness()
      h.registry.start()
      h.registry.authenticated(1)
      h.registry.stop()
      expect(h.registry.lifetimePhase).toBe('stopping')
      expect(h.scheduled()?.cancelled).toBe(true)
      expect(h.registry.acquire(1)).toBeNull()
      expect(h.registry.renew(1, 'lease-1')).toBeNull()
      h.advanceTicks(200)
      expect(h.exits).toEqual([])
    })
  })

  describe('the Host clock decides', () => {
    it('lapses an explicit lease after exactly three missed beats while awake', () => {
      const h = harness()
      h.registry.start()
      h.registry.authenticated(1)
      h.registry.acquire(1)
      // Beats due at 5, 10 and 15 s never arrive; the fourth deadline is 20 s.
      h.advanceTicks(19)
      expect(h.registry.stateOf(1)).toBe('explicit')
      expect(h.registry.summary().phase).toBe('held')
      h.advance(TICK_MS)
      expect(h.registry.stateOf(1)).toBe('declined')
      expect(h.registry.renew(1, 'lease-1')).toBeNull()
      expect(h.registry.summary()).toMatchObject({ phase: 'grace', holders: 0 })
      expect(h.logs).toEqual(expect.arrayContaining([expect.stringContaining('lease lapsed')]))
    })

    it('keeps a lease whose beat lands inside the fourth window', () => {
      const h = harness()
      h.registry.start()
      h.registry.authenticated(1)
      h.registry.acquire(1)
      h.advanceTicks(19)
      expect(h.registry.renew(1, 'lease-1')).not.toBeNull()
      h.advanceTicks(19)
      expect(h.registry.stateOf(1)).toBe('explicit')
      h.advance(TICK_MS)
      expect(h.registry.stateOf(1)).toBe('declined')
    })

    it('does not lapse across a simulated ten-minute tick gap and resets the grace', () => {
      const h = harness()
      h.registry.start()
      h.registry.authenticated(1)
      h.registry.acquire(1)
      h.advanceTicks(15)
      // The machine sleeps: no ticks run, and on macOS the monotonic clock keeps counting.
      h.sleep(10 * 60_000)
      h.advance(TICK_MS)
      expect(h.registry.stateOf(1)).toBe('explicit')
      expect(h.ticks.at(-1)?.suspendObserved).toBe(true)
      expect(h.logs).toEqual(expect.arrayContaining([expect.stringContaining('suspend-observed')]))
      // Jeopardy: a full TTL again from the wake tick before anything lapses.
      h.advanceTicks(19)
      expect(h.registry.stateOf(1)).toBe('explicit')
      h.advance(TICK_MS)
      expect(h.registry.stateOf(1)).toBe('declined')
    })

    it('treats the wall clock outrunning the monotonic clock as a suspend too', () => {
      // Linux: CLOCK_MONOTONIC stops during suspend, so the tick gap looks
      // ordinary and only the wall-versus-monotonic skew shows the sleep.
      const h = harness()
      h.registry.start()
      h.registry.authenticated(1)
      h.registry.acquire(1)
      h.advanceTicks(19)
      h.skew(10 * 60_000)
      h.advance(TICK_MS)
      expect(h.ticks.at(-1)?.suspendObserved).toBe(true)
      expect(h.registry.stateOf(1)).toBe('explicit')
      h.advanceTicks(19)
      expect(h.registry.stateOf(1)).toBe('explicit')
      h.advance(TICK_MS)
      expect(h.registry.stateOf(1)).toBe('declined')
    })

    it('counts awake time only: a suspended interval adds nothing to the Host clock', () => {
      const h = harness()
      h.registry.start()
      h.advanceTicks(15)
      expect(h.ticks.at(-1)?.awakeMs).toBe(15_000)
      h.sleep(10 * 60_000)
      h.advance(TICK_MS)
      // The wake tick is judged a suspend and contributes nothing, not ten minutes.
      expect(h.ticks.at(-1)).toMatchObject({ awakeMs: 15_000, suspendObserved: true })
      h.advanceTicks(3)
      expect(h.ticks.at(-1)?.awakeMs).toBe(18_000)
      // Linux shape: the monotonic delta is ordinary, the wall clock ran ahead.
      h.skew(10 * 60_000)
      h.advance(TICK_MS)
      expect(h.ticks.at(-1)).toMatchObject({ awakeMs: 18_000, suspendObserved: true })
      expect(h.exits).toEqual([])
    })

    it('resets an armed grace once on a suspend instead of firing it on wake', () => {
      const h = harness()
      h.registry.start()
      h.advanceTicks(40)
      expect(h.registry.summary().graceRemainingMs).toBe(HOST_LAST_LEASE_GRACE_MS - 40_000)
      h.sleep(60 * 60_000)
      h.advance(TICK_MS)
      expect(h.exits).toEqual([])
      expect(h.registry.summary()).toMatchObject({
        phase: 'grace',
        graceRemainingMs: HOST_LAST_LEASE_GRACE_MS
      })
      h.advanceTicks(45)
      expect(h.exits).toEqual(['idle'])
    })
  })

  describe('last-lease grace', () => {
    it('arms the grace at start with no holder and exits idle when it expires', () => {
      const h = harness()
      h.registry.start()
      expect(h.registry.summary()).toMatchObject({
        phase: 'grace',
        graceRemainingMs: HOST_LAST_LEASE_GRACE_MS
      })
      h.advanceTicks(44)
      expect(h.exits).toEqual([])
      h.advance(TICK_MS)
      expect(h.exits).toEqual(['idle'])
      expect(h.registry.lifetimePhase).toBe('stopping')
      expect(h.scheduled()?.cancelled).toBe(true)
      // Exactly once.
      h.advanceTicks(5)
      expect(h.exits).toEqual(['idle'])
    })

    it('exits after the last lease lapses, counting awake ticks only', () => {
      const h = harness()
      h.registry.start()
      h.registry.authenticated(1)
      h.registry.acquire(1)
      h.advanceTicks(20)
      expect(h.registry.summary().phase).toBe('grace')
      h.advanceTicks(44)
      expect(h.exits).toEqual([])
      h.advance(TICK_MS)
      expect(h.exits).toEqual(['idle'])
    })

    it('cancels the grace when a new holder arrives', () => {
      const h = harness()
      h.registry.start()
      h.advanceTicks(30)
      h.registry.authenticated(1)
      expect(h.registry.summary()).toMatchObject({ phase: 'held', holders: 1 })
      expect(h.registry.summary().graceRemainingMs).toBeUndefined()
      h.advanceTicks(100)
      expect(h.exits).toEqual([])
      // Fresh grace from the moment it is alone again, not the remainder.
      h.registry.closed(1)
      expect(h.registry.summary().graceRemainingMs).toBe(HOST_LAST_LEASE_GRACE_MS)
    })

    it('never exits at grace while a run is live: it drains, then exits within one tick of idle', () => {
      let live = 2
      const h = harness({ liveWork: () => live })
      h.registry.start()
      h.advanceTicks(45)
      expect(h.exits).toEqual([])
      expect(h.registry.summary()).toMatchObject({ phase: 'draining', holders: 0 })
      h.advanceTicks(600)
      expect(h.exits).toEqual([])
      live = 0
      h.advance(TICK_MS)
      expect(h.exits).toEqual(['drained'])
    })

    it('forces the exit at the busy cap while work stays live', () => {
      const h = harness({ liveWork: () => 1 })
      h.registry.start()
      h.advanceTicks(45)
      expect(h.registry.lifetimePhase).toBe('draining')
      h.advanceTicks(HOST_LEASE_BUSY_CAP_MS / TICK_MS - 1)
      expect(h.exits).toEqual([])
      h.advance(TICK_MS)
      expect(h.exits).toEqual(['busy_cap'])
    })

    it('lets a returning holder cancel a drain, and drains afresh once it leaves', () => {
      const h = harness({ liveWork: () => 1 })
      h.registry.start()
      h.advanceTicks(45)
      expect(h.registry.lifetimePhase).toBe('draining')
      h.registry.authenticated(5)
      const lease = h.registry.acquire(5)
      expect(h.registry.lifetimePhase).toBe('held')
      // Well past the busy cap, renewing on the heartbeat: held, never capped.
      for (let beat = 0; beat < HOST_LEASE_BUSY_CAP_MS / HOST_LEASE_HEARTBEAT_MS + 10; beat += 1) {
        h.advanceTicks(HOST_LEASE_HEARTBEAT_MS / TICK_MS)
        expect(h.registry.renew(5, lease!.leaseId)).not.toBeNull()
      }
      expect(h.exits).toEqual([])
      expect(h.registry.lifetimePhase).toBe('held')
      h.registry.closed(5)
      expect(h.registry.summary()).toMatchObject({
        phase: 'grace',
        graceRemainingMs: HOST_LAST_LEASE_GRACE_MS
      })
      h.advanceTicks(45)
      expect(h.registry.lifetimePhase).toBe('draining')
      expect(h.exits).toEqual([])
    })

    it('treats a throwing live-work probe as busy rather than idle', () => {
      const h = harness({
        liveWork: () => {
          throw new Error('probe broke')
        }
      })
      h.registry.start()
      h.advanceTicks(45)
      expect(h.exits).toEqual([])
      expect(h.registry.lifetimePhase).toBe('draining')
      expect(h.registry.liveRuns()).toBe(1)
    })

    it('never arms a grace without an exit handler: the embedder owns that lifetime', () => {
      let monoNs = 0n
      const registry = new HostLeaseRegistry({
        liveWork: () => 0,
        ports: {
          monotonicNowNs: () => monoNs,
          wallNowMs: () => Number(monoNs / 1_000_000n),
          schedule: () => () => {}
        }
      })
      registry.start()
      registry.authenticated(1)
      const lease = registry.acquire(1)
      expect(lease).not.toBeNull()
      registry.closed(1)
      for (let tick = 0; tick < 10 * (HOST_LAST_LEASE_GRACE_MS / TICK_MS); tick += 1) {
        monoNs += BigInt(TICK_MS) * 1_000_000n
        registry.tick()
      }
      expect(registry.summary()).toMatchObject({ phase: 'held', holders: 0, persist: false })
      // Still answering, not stopping: a late client can hold and lapse as usual.
      registry.authenticated(2)
      expect(registry.acquire(2)).not.toBeNull()
      for (let tick = 0; tick < HOST_LEASE_TTL_MS / TICK_MS; tick += 1) {
        monoNs += BigInt(TICK_MS) * 1_000_000n
        registry.tick()
      }
      expect(registry.stateOf(2)).toBe('declined')
      expect(registry.lifetimePhase).toBe('held')
    })

    it('persist disables the grace exit only', () => {
      const h = harness({ persist: true })
      h.registry.start()
      expect(h.registry.summary()).toMatchObject({ phase: 'held', holders: 0, persist: true })
      h.registry.authenticated(1)
      h.registry.acquire(1)
      h.advanceTicks(20)
      // The lease still lapses on the Host clock; only the exit is off.
      expect(h.registry.stateOf(1)).toBe('declined')
      h.advanceTicks(10 * (HOST_LAST_LEASE_GRACE_MS / TICK_MS))
      expect(h.exits).toEqual([])
      expect(h.registry.summary()).toMatchObject({ phase: 'held', holders: 0 })
      h.registry.stop()
      expect(h.registry.lifetimePhase).toBe('stopping')
    })
  })

  describe('scheduling and clocks', () => {
    it('schedules its tick at the timing interval and reports Host monotonic time', () => {
      const h = harness()
      h.registry.start()
      expect(h.scheduled()).toEqual({ intervalMs: TICK_MS, cancelled: false })
      h.sleep(2_500)
      expect(h.registry.nowMs()).toBe(2_500)
      h.registry.authenticated(1)
      expect(h.registry.acquire(1)?.hostNowMs).toBe(2_500)
    })

    it('refuses an invalid timing', () => {
      expect(
        () => new HostLeaseRegistry({ timing: { ...HOST_LEASE_DEFAULT_TIMING, graceMs: 0 } })
      ).toThrow('Host lease timing graceMs is invalid.')
      expect(
        () =>
          new HostLeaseRegistry({
            timing: { ...HOST_LEASE_DEFAULT_TIMING, ttlMs: 100, heartbeatMs: 200 }
          })
      ).toThrow('ttl must not be shorter than the heartbeat')
    })

    it('publishes awake ticks to subscribers and survives a throwing listener', () => {
      const h = harness()
      h.registry.subscribeTick(() => {
        throw new Error('listener broke')
      })
      h.registry.start()
      h.advanceTicks(3)
      expect(h.ticks.map((tick) => tick.awakeMs)).toEqual([1_000, 2_000, 3_000])
      expect(h.ticks.map((tick) => tick.awakeTicks)).toEqual([1, 2, 3])
      expect(h.logs).toEqual(expect.arrayContaining([expect.stringContaining('listener failed')]))
    })
  })
})
