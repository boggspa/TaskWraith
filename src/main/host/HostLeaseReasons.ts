/**
 * Why Electron main holds its lease on the Host, and the lease itself
 * (Host-lifetime programme D2/D6).
 *
 * The Host exits one grace after its last holder goes. Main holds ONE lease,
 * on a socket of its own that it keeps open for its lifetime and renews on its
 * own timer, and it holds it while at least one reason does. The socket binds
 * a fixed client id of its own (`taskwraith-desktop-lease`), never the shared
 * Desktop identity: a distinct id is a distinct Host session binding, so this
 * narrow socket cannot narrow the Desktop grant every other main consumer
 * shares, and a fixed id never grows the Host's session maps the way a
 * per-launch id would. Main's broker sockets and the paired-phone gateway
 * decline; only this socket counts.
 *
 * Phase 1 has one reason, `app`: held from app start until quit, where
 * `releaseSync()` writes the release before the lifecycle detaches. Later
 * phases add `window`, `work` and `pin:<deviceKey>` (a paired phone pinned to
 * keep the Host) to the same set; the lease follows the set, so they need no
 * change here beyond holding and releasing their reason.
 *
 * Losing the lease is repaired, bounded. A lapse on a live socket (main was
 * stalled past the Host's TTL) is re-acquired by the lease client on that same
 * socket. A renewal that fails for any other reason, or a socket the Host
 * closed (it exited: main stalled past TTL plus grace, or it was replaced),
 * asks the lifecycle to `ensure('lease-reacquire')` — which re-verifies the
 * running Host and relaunches it if it exited, and never starts one the user
 * stopped or one whose start failed — then connects and acquires again, with
 * backoff. After too many failures in a row it parks until the lifecycle
 * reports the Host running again or the machine resumes.
 */

import {
  HOST_LEASE_REASON_KINDS,
  type HostLeaseReasonKind,
  type HostLifecycleLeaseProjection
} from '../../shared/hostLifecycle'
import type { HostStatusProjection } from '../../shared/hostProtocol'
import { HostLeaseClient, type HostLeaseClientTimers } from '../../host-client/HostLeaseClient'
import { HostProjectionClient } from '../../host-client/HostProjectionClient'

/** A reason main holds its Host lease. Phase 1 uses `app` only. */
export type HostLeaseReason = 'app' | 'window' | 'work' | `pin:${string}`

const PIN_REASON = /^pin:[A-Za-z0-9._:-]{1,256}$/

export function isHostLeaseReason(value: unknown): value is HostLeaseReason {
  return (
    value === 'app' ||
    value === 'window' ||
    value === 'work' ||
    (typeof value === 'string' && PIN_REASON.test(value))
  )
}

/** The kind a reason is reported as outside main: a pin never carries its device key. */
export function hostLeaseReasonKind(reason: HostLeaseReason): HostLeaseReasonKind {
  return reason.startsWith('pin:') ? 'pin' : (reason as Exclude<HostLeaseReasonKind, 'pin'>)
}

/**
 * The set of reasons main holds its lease for. Listeners hear only the edges
 * the lease acts on: the set became non-empty (`true`) or empty (`false`).
 */
export class HostLeaseReasons {
  private readonly held = new Set<HostLeaseReason>()
  private readonly listeners = new Set<(holding: boolean) => void>()

  /** Hold for `reason`. Returns whether it was newly held. */
  hold(reason: HostLeaseReason): boolean {
    if (!isHostLeaseReason(reason)) throw new Error('Unknown Host lease reason.')
    if (this.held.has(reason)) return false
    this.held.add(reason)
    if (this.held.size === 1) this.notify(true)
    return true
  }

  /** Stop holding for `reason`. Returns whether it was held. */
  release(reason: HostLeaseReason): boolean {
    if (!this.held.delete(reason)) return false
    if (this.held.size === 0) this.notify(false)
    return true
  }

  has(reason: HostLeaseReason): boolean {
    return this.held.has(reason)
  }

  get holding(): boolean {
    return this.held.size > 0
  }

  /** The held reasons as kinds, deduplicated, in contract order. */
  kinds(): HostLeaseReasonKind[] {
    const kinds = new Set([...this.held].map(hostLeaseReasonKind))
    return HOST_LEASE_REASON_KINDS.filter((kind) => kinds.has(kind))
  }

  subscribe(listener: (holding: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(holding: boolean): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(holding)
      } catch {
        // A listener that throws must not stop the others hearing the edge.
      }
    }
  }
}

/** Main's lease socket identity: fixed per process kind, never the Desktop actor. */
export const DESKTOP_HOST_LEASE_CLIENT_ID = 'taskwraith-desktop-lease'

/** Consecutive failed re-acquires before the lease parks until the Host is reported running. */
export const DESKTOP_HOST_LEASE_MAX_RETRIES = 8
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 30_000

export interface DesktopHostLeaseRetryHandle {
  cancel(): void
}

export interface DesktopHostLeaseOptions {
  readonly reasons: HostLeaseReasons
  /** Main's lease socket (`createDesktopHostLeaseClient` in production). */
  readonly client: HostProjectionClient
  /**
   * Bring the Host back if it exited (`HostLifecycleController.ensure`).
   * Resolves whether a Host should now be reachable; false parks the lease.
   */
  readonly ensureHost: () => Promise<boolean>
  /** Called whenever the lease is held (or the Host predates leases): the spawner's boot hold may go. */
  readonly onHeld?: () => void
  readonly timers?: HostLeaseClientTimers
  readonly scheduleRetry?: (callback: () => void, delayMs: number) => DesktopHostLeaseRetryHandle
  readonly log?: (line: string) => void
}

function defaultScheduleRetry(callback: () => void, delayMs: number): DesktopHostLeaseRetryHandle {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The dedicated lease socket: bootstrap only, plus `health` for `host.status` when offered. */
export function createDesktopHostLeaseClient(input: {
  readonly userDataPath: string
  readonly appVersion: string
}): HostProjectionClient {
  return new HostProjectionClient({
    userDataPath: input.userDataPath,
    client: {
      clientId: DESKTOP_HOST_LEASE_CLIENT_ID,
      clientClass: 'desktop',
      clientVersion: input.appVersion
    },
    capabilities: ['bootstrap'],
    optionalCapabilities: ['health']
  })
}

export class DesktopHostLease {
  private readonly reasons: HostLeaseReasons
  private readonly client: HostProjectionClient
  private readonly lease: HostLeaseClient
  private readonly ensureHost: () => Promise<boolean>
  private readonly onHeld: () => void
  private readonly scheduleRetry: (
    callback: () => void,
    delayMs: number
  ) => DesktopHostLeaseRetryHandle
  private readonly log: (line: string) => void
  private unsubscribe: (() => void) | null = null
  private attaching: Promise<void> | null = null
  private retry: DesktopHostLeaseRetryHandle | null = null
  private failures = 0
  private parked = false
  private closed = false

  constructor(options: DesktopHostLeaseOptions) {
    this.reasons = options.reasons
    this.client = options.client
    this.ensureHost = options.ensureHost
    this.onHeld = options.onHeld ?? (() => undefined)
    this.scheduleRetry = options.scheduleRetry ?? defaultScheduleRetry
    this.log = options.log ?? (() => undefined)
    this.lease = new HostLeaseClient({
      client: options.client,
      log: this.log,
      ...(options.timers ? { timers: options.timers } : {})
    })
    this.lease.on('held', () => this.heldNow())
    this.lease.on('legacy', () => this.heldNow())
    this.lease.on('failed', (error) => this.recover(`renewal failed: ${describe(error)}`, true))
    this.client.on('disconnected', () => this.recover('the Host closed the lease socket', false))
  }

  /** Begin following the reasons: the lease is taken whenever one is held. */
  start(): void {
    if (this.closed || this.unsubscribe) return
    this.unsubscribe = this.reasons.subscribe((holding) => {
      if (holding) void this.attach()
      else void this.releaseLease()
    })
    if (this.reasons.holding) void this.attach()
  }

  /** The lifecycle reports the Host running (start, restart, relaunch): take the lease there. */
  onHostRunning(): void {
    if (this.closed) return
    this.parked = false
    this.failures = 0
    if (this.reasons.holding && !this.lease.held && this.lease.mode !== 'legacy') {
      void this.attach()
    }
  }

  /** Renew at once (the machine resumed); repair the lease when it is not held. */
  async renewNow(): Promise<void> {
    if (this.closed || !this.reasons.holding) return
    if (this.lease.held) {
      await this.lease.renewNow().catch(() => undefined)
      return
    }
    if (this.lease.mode === 'legacy' && this.client.connected) return
    this.parked = false
    this.failures = 0
    this.recover('the lease is not held after a resume', false)
  }

  /**
   * App quit: write the release frame, then close the socket, synchronously.
   * Nothing is re-acquired afterwards. Returns whether the frame was written.
   */
  releaseSync(): boolean {
    this.closed = true
    this.retry?.cancel()
    this.retry = null
    this.unsubscribe?.()
    this.unsubscribe = null
    const wrote = this.lease.releaseSync()
    this.lease.dispose()
    return wrote
  }

  /** What the lease looks like to Settings and the inspect channel. */
  projection(): HostLifecycleLeaseProjection {
    return { mode: this.lease.mode, held: this.lease.held, reasons: this.reasons.kinds() }
  }

  /** The Host's own `host.status`, read over the lease socket; null when it cannot be. */
  async readHostStatus(): Promise<HostStatusProjection | null> {
    if (this.closed || !this.client.connected || !this.client.supports('health')) return null
    try {
      return await this.client.getHostStatus()
    } catch {
      return null
    }
  }

  get held(): boolean {
    return this.lease.held
  }

  private heldNow(): void {
    this.failures = 0
    try {
      this.onHeld()
    } catch (error) {
      this.log(`[host-lease] releasing the boot hold failed: ${describe(error)}`)
    }
  }

  private attach(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.attaching) return this.attaching
    const work = (async () => {
      if (!this.client.connected) await this.client.connect()
      if (this.closed || !this.reasons.holding) return
      await this.lease.acquire()
    })()
      .catch((error: unknown) => {
        this.recover(`could not take the lease: ${describe(error)}`, true)
      })
      .finally(() => {
        if (this.attaching === work) this.attaching = null
      })
    this.attaching = work
    return work
  }

  private async releaseLease(): Promise<void> {
    this.retry?.cancel()
    this.retry = null
    try {
      await this.lease.release()
    } catch (error) {
      this.log(`[host-lease] release failed: ${describe(error)}`)
    }
    if (!this.reasons.holding) this.client.close()
  }

  /**
   * The lease is not held and should be: drop the socket if asked, then after
   * a backoff ask the lifecycle to make sure the Host is up and attach again.
   */
  private recover(why: string, dropSocket: boolean): void {
    if (this.closed || !this.reasons.holding) return
    if (dropSocket) this.client.close()
    if (this.parked || this.retry) return
    if (this.failures >= DESKTOP_HOST_LEASE_MAX_RETRIES) {
      this.parked = true
      this.log(
        `[host-lease] ${why}; parked after ${this.failures} attempts until the Host is reported running`
      )
      return
    }
    const delayMs =
      this.failures === 0 ? 0 : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1))
    this.failures += 1
    this.log(`[host-lease] ${why}; re-acquiring in ${delayMs} ms`)
    this.retry = this.scheduleRetry(() => {
      this.retry = null
      void this.reacquire()
    }, delayMs)
  }

  private async reacquire(): Promise<void> {
    if (this.closed || !this.reasons.holding) return
    let reachable = false
    try {
      reachable = await this.ensureHost()
    } catch (error) {
      this.log(`[host-lease] ensuring the Host failed: ${describe(error)}`)
    }
    if (this.closed) return
    if (!reachable) {
      // Stopped by the user, a failed start, or shutting down: nothing here
      // may start it. The next running transition takes the lease again.
      this.parked = true
      this.log('[host-lease] the Host is not running; waiting for it to be started')
      return
    }
    await this.attach()
  }
}

/** The lifecycle surface the lease needs: re-verify on loss, and hear running transitions. */
export interface DesktopHostLeaseLifecycle {
  ensure(reason: 'lease-reacquire'): Promise<{ readonly ok: boolean }>
  subscribe(listener: (snapshot: { readonly phase: string }) => void): () => void
}

export interface DesktopHostLeaseWiring {
  readonly reasons: HostLeaseReasons
  readonly lease: DesktopHostLease
  /** App quit: release synchronously, before the lifecycle detaches. */
  releaseSync(): boolean
  /** The inspect channel's live reads (`HostLifecycleInspectPort`). */
  readHostStatus(): Promise<HostStatusProjection | null>
  leaseProjection(): HostLifecycleLeaseProjection | null
}

/**
 * Production wiring for Electron main's lease on an external Host: the lease
 * socket, the lifecycle's `ensure('lease-reacquire')` as the repair path, the
 * spawner's boot hold for this profile released once the lease is held, and a
 * lifecycle subscription so every running transition (start, restart,
 * relaunch) takes the lease. Reasons start empty; the caller holds `app`.
 */
export function startDesktopHostLease(input: {
  readonly profilePath: string
  readonly appVersion: string
  readonly lifecycle: DesktopHostLeaseLifecycle
  readonly releaseBootHold: (profilePath: string) => void
  readonly log?: (line: string) => void
}): DesktopHostLeaseWiring {
  const reasons = new HostLeaseReasons()
  const lease = new DesktopHostLease({
    reasons,
    client: createDesktopHostLeaseClient({
      userDataPath: input.profilePath,
      appVersion: input.appVersion
    }),
    ensureHost: async () => (await input.lifecycle.ensure('lease-reacquire')).ok,
    onHeld: () => input.releaseBootHold(input.profilePath),
    ...(input.log ? { log: input.log } : {})
  })
  const unsubscribe = input.lifecycle.subscribe((snapshot) => {
    if (snapshot.phase === 'running') lease.onHostRunning()
  })
  lease.start()
  return {
    reasons,
    lease,
    releaseSync: () => {
      unsubscribe()
      return lease.releaseSync()
    },
    readHostStatus: () => lease.readHostStatus(),
    leaseProjection: () => lease.projection()
  }
}
