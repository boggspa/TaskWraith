/**
 * Host-side client lease registry (Host-lifetime programme, S1a).
 *
 * A lease belongs to exactly one authenticated socket, never to a session,
 * actor or client id: several main-process sockets share one Desktop session,
 * so a session-keyed lease would double-count, and `HostSession` never evicts
 * a binding, so a lease that survived its socket would grow the Host for its
 * lifetime. Each socket is in one of four states — `implicit` (authenticated
 * and never spoke `host.lease`; an old client, counted as a holder for the
 * transition releases), `explicit` (acquired, must renew), `declined` (said
 * so, or released, or lapsed) or `none` (unknown / unauthenticated).
 *
 * The Host's own clock is authoritative. The registry ticks once a second (at
 * the heartbeat, when a diagnostic override shortens that below a second) on
 * `process.hrtime.bigint()` and accumulates AWAKE time only: a gap between two
 * ticks longer than `suspendGapMs`, or a wall-clock delta that outruns the
 * monotonic delta by more than that, is a suspend (or a stalled Host), and
 * that tick resets every deadline once instead of judging anyone. An explicit
 * lease therefore lapses only after `ttlMs` of awake time passed since its
 * last beat — three heartbeats missed while the Host itself was ticking and
 * the fourth deadline gone. Wall-clock time never expires anything; the
 * `hostNowMs` on the wire is for display only.
 *
 * Deadlines never fire early. A beat, a close or an arm that lands between two
 * ticks is stamped at its own awake instant (the last tick's total plus the
 * elapsed part of this one), not at the last tick's value, and every deadline
 * is judged only on a tick: it fires on the first tick at or after it, so at
 * most one tick late and never before, however late the timer itself runs.
 *
 * Lifetime: with no holder the Host arms `graceMs` of awake time (from
 * listener start too — a Host nobody attaches to is a ghost from birth); any
 * holder cancels it. At grace expiry an idle Host asks its owner to stop; a
 * busy one enters `draining`, where the owner refuses new run-starting work,
 * in-flight runs finish, and the stop follows within one tick of the last run
 * ending or at the busy cap, whichever is first. A holder that interrupts a
 * drain and is gone again within one grace (a status poll, a socket that
 * declines a moment later) has not taken the Host back: the drain resumes at
 * once, busy cap still counted from its first start, so a poller can never
 * keep a wedged run's Host alive by resetting the cap. The holder that left
 * still gets the grace an idle Host gives its last holder: a resumed drain
 * never ends `drained` sooner than one grace after it left, so a client that
 * came back during a drain and then dropped once can reconnect. `persist`
 * disables the grace exit only — nothing else in this module.
 *
 * Only an owner that can act on an exit gets a bounded lifetime: a registry
 * built without `onExit` (the in-process Host inside Electron main, the
 * diagnostic Host, a bare listener in a test) still tracks and lapses leases
 * for `host.status`, but never arms a grace, so its lifetime stays its
 * embedder's.
 */

import { randomUUID } from 'node:crypto'

import type { HostClientLeaseState, HostLifetimePhase } from '../shared/hostProtocol'

export const HOST_LEASE_HEARTBEAT_MS = 5_000
/** Four heartbeats: lapse after three missed while awake and the fourth deadline passed. */
export const HOST_LEASE_TTL_MS = 20_000
export const HOST_LEASE_TICK_MS = 1_000
export const HOST_LEASE_SUSPEND_GAP_MS = 5_000
export const HOST_LAST_LEASE_GRACE_MS = 45_000
export const HOST_LEASE_BUSY_CAP_MS = 1_800_000
export const HOST_LEASE_MIN_HEARTBEAT_MS = 100
export const HOST_LEASE_MIN_GRACE_MS = 500

/**
 * Diagnostic-only timing override: `heartbeat:<ms>,ttl:<ms>,grace:<ms>`. Each
 * value is bounded below (heartbeat >= 100, ttl >= 2 x heartbeat, grace >=
 * 500) and can only SHORTEN the defaults, never extend them. Meant for the
 * subprocess suites; the production server logs whatever it resolves, and the
 * production launchers strip it (`withoutHostLeaseTestKnobs`).
 */
export const HOST_LEASE_TIMING_ENV = 'TASKWRAITH_HOST_LEASE_TIMING'
/** `1` disables the last-lease grace exit only. */
export const HOST_PERSIST_ENV = 'TASKWRAITH_HOST_PERSIST'
/**
 * Test-only: `1` makes the production Host answer `host.lease` and
 * `host.status` exactly as a pre-lease Host does (`unknown_request_kind`) and
 * run without a lease lifetime, so a subprocess suite can stand up a "legacy"
 * Host from the current build. Honoured only while a valid
 * `TASKWRAITH_HOST_LEASE_TIMING` override is in force, and stripped by the
 * production launchers like it.
 */
export const HOST_LEASE_DISABLED_ENV = 'TASKWRAITH_HOST_LEASE_DISABLED'

/** The two test-only knobs; `TASKWRAITH_HOST_PERSIST` is the user's and is not one. */
export const HOST_LEASE_TEST_ONLY_ENV = [HOST_LEASE_TIMING_ENV, HOST_LEASE_DISABLED_ENV] as const

/**
 * A copy of `environment` without the test-only lease knobs, for a production
 * launcher to hand the Host it spawns. A stray export in the shell that
 * starts the app must never cut a real Host's grace to half a second, or run
 * it with no lease lifetime at all. `TASKWRAITH_HOST_PERSIST` passes through.
 */
export function withoutHostLeaseTestKnobs(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment }
  for (const key of HOST_LEASE_TEST_ONLY_ENV) delete result[key]
  return result
}

export interface HostLeaseTiming {
  readonly heartbeatMs: number
  readonly ttlMs: number
  readonly graceMs: number
  readonly tickMs: number
  readonly suspendGapMs: number
  readonly busyCapMs: number
}

export const HOST_LEASE_DEFAULT_TIMING: HostLeaseTiming = Object.freeze({
  heartbeatMs: HOST_LEASE_HEARTBEAT_MS,
  ttlMs: HOST_LEASE_TTL_MS,
  graceMs: HOST_LAST_LEASE_GRACE_MS,
  tickMs: HOST_LEASE_TICK_MS,
  suspendGapMs: HOST_LEASE_SUSPEND_GAP_MS,
  busyCapMs: HOST_LEASE_BUSY_CAP_MS
})

export type HostLeaseTimingResolution =
  | { readonly source: 'default'; readonly timing: HostLeaseTiming }
  | { readonly source: 'environment'; readonly timing: HostLeaseTiming; readonly raw: string }
  | {
      readonly source: 'rejected'
      readonly timing: HostLeaseTiming
      readonly raw: string
      readonly reason: string
    }

export type HostLeaseExitReason = 'idle' | 'drained' | 'busy_cap'

export interface HostLeaseRegistryPorts {
  /** Monotonic nanoseconds; defaults to `process.hrtime.bigint`. */
  readonly monotonicNowNs?: () => bigint
  /** Wall clock ms; defaults to `Date.now`. Used only to detect a suspend. */
  readonly wallNowMs?: () => number
  /** Periodic scheduler; defaults to an unref'd `setInterval`. Returns cancel. */
  readonly schedule?: (tick: () => void, intervalMs: number) => () => void
  /** Lease id mint; defaults to `randomUUID`. */
  readonly leaseId?: () => string
}

export interface HostLeaseRegistryOptions {
  readonly timing?: HostLeaseTiming
  readonly persist?: boolean
  /** Number of live runs; anything above zero holds the exit at grace. */
  readonly liveWork?: () => number
  /**
   * The owner's stop. Called at most once, after which the registry is
   * `stopping`. Absent means the lifetime is unbounded: no grace is armed.
   */
  readonly onExit?: (reason: HostLeaseExitReason) => void
  readonly log?: (line: string) => void
  readonly ports?: HostLeaseRegistryPorts
}

export interface HostLeaseAcquireResult {
  readonly leaseId: string
  readonly heartbeatMs: number
  readonly ttlMs: number
  readonly hostNowMs: number
}

export interface HostLeaseRenewResult {
  readonly leaseId: string
  readonly expiresInMs: number
  readonly hostNowMs: number
}

export interface HostLeaseSummary {
  readonly phase: HostLifetimePhase
  readonly graceRemainingMs?: number
  /** explicit + implicit */
  readonly holders: number
  readonly explicitHolders: number
  readonly implicitHolders: number
  readonly declined: number
  readonly persist: boolean
}

export interface HostLeaseTickInfo {
  readonly awakeMs: number
  readonly awakeTicks: number
  readonly suspendObserved: boolean
}

interface ConnectionRecord {
  state: HostClientLeaseState
  leaseId: string | null
  lastBeatAwakeMs: number
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isHostPersistEnabled(
  environment: Readonly<Record<string, string | undefined>>
): boolean {
  return environment[HOST_PERSIST_ENV]?.trim() === '1'
}

export function isHostLeaseProtocolDisabled(
  environment: Readonly<Record<string, string | undefined>>
): boolean {
  if (environment[HOST_LEASE_DISABLED_ENV]?.trim() !== '1') return false
  return resolveHostLeaseTiming(environment).source === 'environment'
}

export function resolveHostLeaseTiming(
  environment: Readonly<Record<string, string | undefined>>
): HostLeaseTimingResolution {
  const raw = environment[HOST_LEASE_TIMING_ENV]?.trim()
  if (!raw) return { source: 'default', timing: HOST_LEASE_DEFAULT_TIMING }
  const rejected = (reason: string): HostLeaseTimingResolution => ({
    source: 'rejected',
    timing: HOST_LEASE_DEFAULT_TIMING,
    raw,
    reason
  })
  const values = new Map<string, number>()
  for (const part of raw.split(',')) {
    const match = /^(heartbeat|ttl|grace):(\d{1,9})$/.exec(part.trim())
    if (!match) return rejected(`unrecognised segment ${JSON.stringify(part.trim())}`)
    if (values.has(match[1])) return rejected(`duplicate key ${match[1]}`)
    values.set(match[1], Number(match[2]))
  }
  const heartbeatMs = values.get('heartbeat')
  const ttlMs = values.get('ttl')
  const graceMs = values.get('grace')
  if (heartbeatMs === undefined || ttlMs === undefined || graceMs === undefined) {
    return rejected('heartbeat, ttl and grace are all required')
  }
  if (heartbeatMs < HOST_LEASE_MIN_HEARTBEAT_MS) {
    return rejected(`heartbeat must be at least ${HOST_LEASE_MIN_HEARTBEAT_MS} ms`)
  }
  if (ttlMs < 2 * heartbeatMs) return rejected('ttl must be at least twice the heartbeat')
  if (graceMs < HOST_LEASE_MIN_GRACE_MS) {
    return rejected(`grace must be at least ${HOST_LEASE_MIN_GRACE_MS} ms`)
  }
  if (
    heartbeatMs > HOST_LEASE_HEARTBEAT_MS ||
    ttlMs > HOST_LEASE_TTL_MS ||
    graceMs > HOST_LAST_LEASE_GRACE_MS
  ) {
    return rejected('the override may only shorten the default timing')
  }
  return {
    source: 'environment',
    raw,
    timing: {
      heartbeatMs,
      ttlMs,
      graceMs,
      tickMs: Math.min(HOST_LEASE_TICK_MS, heartbeatMs),
      suspendGapMs: HOST_LEASE_SUSPEND_GAP_MS,
      busyCapMs: HOST_LEASE_BUSY_CAP_MS
    }
  }
}

function defaultSchedule(tick: () => void, intervalMs: number): () => void {
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

export class HostLeaseRegistry {
  readonly timing: HostLeaseTiming
  private readonly persist: boolean
  private readonly liveWork: () => number
  private readonly onExit: ((reason: HostLeaseExitReason) => void) | null
  private readonly log: (line: string) => void
  private readonly monotonicNowNs: () => bigint
  private readonly wallNowMs: () => number
  private readonly schedule: (tick: () => void, intervalMs: number) => () => void
  private readonly mintLeaseId: () => string
  private readonly startNs: bigint
  private readonly connections = new Map<number, ConnectionRecord>()
  private readonly tickListeners = new Set<(info: HostLeaseTickInfo) => void>()
  private cancelSchedule: (() => void) | null = null
  private started = false
  private phase: HostLifetimePhase = 'held'
  private awakeMs = 0
  private awakeTicks = 0
  private lastTick: { readonly mono: number; readonly wall: number } | null = null
  private graceStartAwakeMs: number | null = null
  private drainStartAwakeMs: number | null = null
  /** A drain a holder interrupted: its busy-cap start, and when the holder came. */
  private interruptedDrain: { anchorAwakeMs: number; heldSinceAwakeMs: number } | null = null
  /** A resumed drain may not end `drained` before this: one grace after its holder left. */
  private drainedNotBeforeAwakeMs: number | null = null
  private exited = false

  constructor(options: HostLeaseRegistryOptions = {}) {
    const timing = options.timing ?? HOST_LEASE_DEFAULT_TIMING
    for (const [key, value] of Object.entries(timing)) {
      if (!isPositiveInt(value)) throw new Error(`Host lease timing ${key} is invalid.`)
    }
    if (timing.ttlMs < timing.heartbeatMs) {
      throw new Error('Host lease ttl must not be shorter than the heartbeat.')
    }
    this.timing = timing
    this.persist = options.persist === true
    this.liveWork = options.liveWork ?? (() => 0)
    this.onExit = options.onExit ?? null
    this.log = options.log ?? (() => undefined)
    this.monotonicNowNs = options.ports?.monotonicNowNs ?? (() => process.hrtime.bigint())
    this.wallNowMs = options.ports?.wallNowMs ?? (() => Date.now())
    this.schedule = options.ports?.schedule ?? defaultSchedule
    this.mintLeaseId = options.ports?.leaseId ?? randomUUID
    this.startNs = this.monotonicNowNs()
  }

  /** Monotonic milliseconds since the registry was built (Host time, display only). */
  nowMs(): number {
    return Number((this.monotonicNowNs() - this.startNs) / 1_000_000n)
  }

  /**
   * Awake time at this instant: the last tick's total plus the elapsed part of
   * the current tick. Stamping an event with the last tick's total instead
   * would date it up to a whole tick early and fire its deadline that early.
   * The partial is capped at the suspend gap: a longer one is a suspend the
   * next tick has yet to detect, and until then the sleep must not count as
   * awake time (that tick resets every deadline, but a visit's length is
   * judged the moment the visitor leaves).
   */
  private awakeNowMs(): number {
    if (!this.lastTick) return this.awakeMs
    return this.awakeMs + Math.min(this.nowMs() - this.lastTick.mono, this.timing.suspendGapMs)
  }

  get lifetimePhase(): HostLifetimePhase {
    return this.phase
  }

  /** Begin ticking. A bounded registry with no holder arms its grace immediately. */
  start(): void {
    if (this.started || this.phase === 'stopping') return
    this.started = true
    this.lastTick = { mono: this.nowMs(), wall: this.wallNowMs() }
    this.cancelSchedule = this.schedule(() => this.tick(), this.timing.tickMs)
    this.evaluateHolders()
  }

  /** Stop ticking; the registry answers nothing afterwards. Idempotent. */
  stop(): void {
    this.cancelSchedule?.()
    this.cancelSchedule = null
    this.phase = 'stopping'
  }

  subscribeTick(listener: (info: HostLeaseTickInfo) => void): () => void {
    this.tickListeners.add(listener)
    return () => {
      this.tickListeners.delete(listener)
    }
  }

  /** An authenticated socket that has not spoken `host.lease` is an implicit holder. */
  authenticated(connectionId: number): void {
    if (this.phase === 'stopping' || this.connections.has(connectionId)) return
    this.connections.set(connectionId, {
      state: 'implicit',
      leaseId: null,
      lastBeatAwakeMs: this.awakeMs
    })
    this.evaluateHolders()
  }

  /** The socket closed: whatever it held is released at once. */
  closed(connectionId: number): void {
    if (!this.connections.delete(connectionId)) return
    this.evaluateHolders()
  }

  acquire(connectionId: number): HostLeaseAcquireResult | null {
    const record = this.connections.get(connectionId)
    if (!record || this.phase === 'stopping') return null
    if (record.state !== 'explicit' || record.leaseId === null) {
      record.state = 'explicit'
      record.leaseId = this.mintLeaseId()
    }
    record.lastBeatAwakeMs = this.awakeNowMs()
    this.evaluateHolders()
    return {
      leaseId: record.leaseId,
      heartbeatMs: this.timing.heartbeatMs,
      ttlMs: this.timing.ttlMs,
      hostNowMs: this.nowMs()
    }
  }

  /** A stale or foreign lease id answers null (the wire's `invalid_payload`). */
  renew(connectionId: number, leaseId: string): HostLeaseRenewResult | null {
    const record = this.connections.get(connectionId)
    if (!record || this.phase === 'stopping') return null
    if (record.state !== 'explicit' || record.leaseId !== leaseId) return null
    record.lastBeatAwakeMs = this.awakeNowMs()
    return { leaseId, expiresInMs: this.timing.ttlMs, hostNowMs: this.nowMs() }
  }

  release(connectionId: number, leaseId: string): boolean {
    const record = this.connections.get(connectionId)
    if (!record || record.state !== 'explicit' || record.leaseId !== leaseId) return false
    record.state = 'declined'
    record.leaseId = null
    this.evaluateHolders()
    return true
  }

  decline(connectionId: number): boolean {
    const record = this.connections.get(connectionId)
    if (!record) return false
    record.state = 'declined'
    record.leaseId = null
    this.evaluateHolders()
    return true
  }

  stateOf(connectionId: number): HostClientLeaseState {
    return this.connections.get(connectionId)?.state ?? 'none'
  }

  summary(): HostLeaseSummary {
    let explicitHolders = 0
    let implicitHolders = 0
    let declined = 0
    for (const record of this.connections.values()) {
      if (record.state === 'explicit') explicitHolders += 1
      else if (record.state === 'implicit') implicitHolders += 1
      else if (record.state === 'declined') declined += 1
    }
    const graceRemainingMs =
      this.phase === 'grace' && this.graceStartAwakeMs !== null
        ? Math.max(0, this.timing.graceMs - (this.awakeNowMs() - this.graceStartAwakeMs))
        : undefined
    return {
      phase: this.phase,
      ...(graceRemainingMs === undefined ? {} : { graceRemainingMs }),
      holders: explicitHolders + implicitHolders,
      explicitHolders,
      implicitHolders,
      declined,
      persist: this.persist
    }
  }

  /**
   * One Host tick. Public so a test can step it with an injected clock; the
   * scheduler calls it on the real one.
   */
  tick(): void {
    if (this.phase === 'stopping' || !this.started) return
    const mono = this.nowMs()
    const wall = this.wallNowMs()
    let suspendObserved = false
    if (this.lastTick) {
      const monoDelta = mono - this.lastTick.mono
      const wallDelta = wall - this.lastTick.wall
      suspendObserved =
        monoDelta > this.timing.suspendGapMs || wallDelta - monoDelta > this.timing.suspendGapMs
      if (!suspendObserved) this.awakeMs += Math.max(0, monoDelta)
    }
    this.lastTick = { mono, wall }
    this.awakeTicks += 1

    if (suspendObserved) {
      // Jeopardy, not eviction: every deadline is reset once so a client that
      // wakes with the Host gets a full window to beat again.
      for (const record of this.connections.values()) {
        if (record.state === 'explicit') record.lastBeatAwakeMs = this.awakeMs
      }
      if (this.graceStartAwakeMs !== null) this.graceStartAwakeMs = this.awakeMs
      if (this.drainStartAwakeMs !== null) this.drainStartAwakeMs = this.awakeMs
      if (this.interruptedDrain) this.interruptedDrain.anchorAwakeMs = this.awakeMs
      if (this.drainedNotBeforeAwakeMs !== null) {
        this.drainedNotBeforeAwakeMs = this.awakeMs + this.timing.graceMs
      }
      this.log(
        `[host-lease] suspend-observed: deadlines reset (phase=${this.phase}, awake=${this.awakeMs}ms)`
      )
    } else {
      this.lapseExplicitLeases()
      this.evaluateHolders()
      this.evaluateLifetime()
    }

    const info: HostLeaseTickInfo = {
      awakeMs: this.awakeMs,
      awakeTicks: this.awakeTicks,
      suspendObserved
    }
    for (const listener of this.tickListeners) {
      try {
        listener(info)
      } catch (error) {
        this.log(`[host-lease] tick listener failed: ${String(error)}`)
      }
    }
  }

  private lapseExplicitLeases(): void {
    for (const [connectionId, record] of this.connections) {
      if (record.state !== 'explicit') continue
      if (this.awakeMs - record.lastBeatAwakeMs < this.timing.ttlMs) continue
      record.state = 'declined'
      record.leaseId = null
      this.log(
        `[host-lease] lease lapsed on connection ${connectionId}: ${this.timing.ttlMs}ms awake without a beat`
      )
    }
  }

  private holderCount(): number {
    let holders = 0
    for (const record of this.connections.values()) {
      if (record.state === 'explicit' || record.state === 'implicit') holders += 1
    }
    return holders
  }

  private evaluateHolders(): void {
    if (this.phase === 'stopping' || !this.started) return
    const holders = this.holderCount()
    const now = this.awakeNowMs()
    if (holders > 0) {
      if (this.phase === 'draining' && this.drainStartAwakeMs !== null) {
        // Remembered, not forgotten: see the rule for a brief holder below.
        this.interruptedDrain = { anchorAwakeMs: this.drainStartAwakeMs, heldSinceAwakeMs: now }
      }
      if (this.phase === 'grace' || this.phase === 'draining') {
        this.log(`[host-lease] ${this.phase} cancelled: ${holders} holder(s)`)
        this.phase = 'held'
        this.graceStartAwakeMs = null
        this.drainStartAwakeMs = null
        this.drainedNotBeforeAwakeMs = null
      }
      return
    }
    // No exit handler, nothing to arm: the embedder owns this lifetime.
    if (this.phase === 'held' && !this.persist && this.onExit !== null) {
      const interrupted = this.interruptedDrain
      this.interruptedDrain = null
      if (interrupted && now - interrupted.heldSinceAwakeMs < this.timing.graceMs) {
        // Gone again within one grace: a poll or a socket that declined, not a
        // client taking the Host back. The drain resumes, and its busy cap
        // keeps counting from the drain's first start. But the client may only
        // have dropped: it gets a full grace to come back before an idle drain
        // may end, as it would from an idle Host.
        this.phase = 'draining'
        this.drainStartAwakeMs = interrupted.anchorAwakeMs
        this.drainedNotBeforeAwakeMs = now + this.timing.graceMs
        this.log('[host-lease] no holder again within the grace: draining resumes')
        return
      }
      this.phase = 'grace'
      this.graceStartAwakeMs = now
      this.log(`[host-lease] no holder: grace armed for ${this.timing.graceMs}ms awake`)
    }
  }

  private evaluateLifetime(): void {
    if (this.phase === 'grace' && this.graceStartAwakeMs !== null) {
      if (this.awakeMs - this.graceStartAwakeMs < this.timing.graceMs) return
      const live = this.liveRuns()
      if (live > 0) {
        this.phase = 'draining'
        this.drainStartAwakeMs = this.awakeMs
        this.log(
          `[host-lease] grace expired with ${live} live run(s): draining (cap ${this.timing.busyCapMs}ms)`
        )
        return
      }
      this.exit('idle')
      return
    }
    if (this.phase === 'draining' && this.drainStartAwakeMs !== null) {
      if (this.liveRuns() === 0) {
        const notBefore = this.drainedNotBeforeAwakeMs
        if (notBefore !== null && this.awakeMs < notBefore) return
        this.exit('drained')
        return
      }
      if (this.awakeMs - this.drainStartAwakeMs >= this.timing.busyCapMs) this.exit('busy_cap')
    }
  }

  /** Live runs as the owner's probe reports them; a throwing probe reads as busy. */
  liveRuns(): number {
    try {
      const count = this.liveWork()
      return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
    } catch (error) {
      // A probe that throws is a bug, not proof of idleness; hold the exit and
      // let the busy cap bound the damage rather than cancelling provider work.
      this.log(`[host-lease] live-work probe failed; treating the Host as busy: ${String(error)}`)
      return 1
    }
  }

  private exit(reason: HostLeaseExitReason): void {
    if (this.exited) return
    this.exited = true
    this.log(`[host-lease] exit requested: ${reason}`)
    this.stop()
    try {
      this.onExit?.(reason)
    } catch (error) {
      this.log(`[host-lease] exit handler failed: ${String(error)}`)
    }
  }
}
