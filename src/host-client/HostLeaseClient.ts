/**
 * Client side of the Host lease (Host-lifetime programme, S1a).
 *
 * One `HostLeaseClient` per process, on one `HostProjectionClient` the process
 * keeps open for its lifetime: Electron main uses a dedicated lease socket,
 * the TUI its single long-lived client. The owner asks once, after its first
 * `connect()`; from then on the lease follows the connection, and every later
 * welcome (a reconnect, perhaps to a replaced Host) acquires it again until
 * the owner releases, declines or disposes. It is renewed on this module's
 * own timer, never inside a request path, so a wedged consumer stops
 * renewing and a busy one does not. A paired-phone gateway or a broker's
 * per-request socket declines instead.
 *
 * Against a Host that predates the protocol (`unknown_request_kind` on a
 * connection it keeps open) the client enters `legacy` mode: no renew timer,
 * no lapse expectations, and the owner can say "restart the Host to upgrade".
 * Legacy describes the Host on the far end of ONE connection, so the next
 * welcome (a reconnect, possibly to a replaced Host) clears it.
 *
 * Electron-free; the TUI imports this module too.
 */

import { EventEmitter } from 'node:events'

import {
  HostProjectionTransportError,
  type HostLeaseAcquired,
  type HostProjectionClient
} from './HostProjectionClient'

export type HostLeaseClientMode = 'lease' | 'legacy'

export interface HostLeaseClientTimers {
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface HostLeaseClientOptions {
  readonly client: HostProjectionClient
  readonly log?: (line: string) => void
  /** Injectable for tests; the default `setInterval` is unref'd. */
  readonly timers?: HostLeaseClientTimers
}

export interface HostLeaseClientEvents {
  held: [lease: HostLeaseAcquired]
  renewed: [expiresInMs: number]
  /** The Host no longer knows the lease (it lapsed); a re-acquire follows at once. */
  lapsed: [leaseId: string]
  legacy: []
  released: []
  /** A renewal or re-acquire failed for a reason other than a lapse. */
  failed: [error: Error]
}

function isTransportCode(error: unknown, code: HostProjectionTransportError['code']): boolean {
  return error instanceof HostProjectionTransportError && error.code === code
}

function unrefInterval(handle: unknown): void {
  const timer = handle as { unref?: () => void } | null
  timer?.unref?.()
}

const DEFAULT_TIMERS: HostLeaseClientTimers = {
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms)
    unrefInterval(handle)
    return handle
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
}

/** Decline a lease on a socket that must never hold the Host (broker, gateway). */
export async function declineHostLease(
  client: HostProjectionClient
): Promise<'declined' | 'legacy'> {
  try {
    await client.declineHostLease()
    return 'declined'
  } catch (error) {
    if (isTransportCode(error, 'unknown_request_kind')) return 'legacy'
    throw error
  }
}

export class HostLeaseClient extends EventEmitter<HostLeaseClientEvents> {
  private readonly client: HostProjectionClient
  private readonly log: (line: string) => void
  private readonly timers: HostLeaseClientTimers
  private modeValue: HostLeaseClientMode = 'lease'
  private leaseIdValue: string | null = null
  private timer: unknown = null
  private renewing: Promise<void> | null = null
  private acquiring: Promise<'held' | 'legacy'> | null = null
  /** The owner asked for a lease and has not released or declined it since. */
  private wanted = false
  /** Bumped by every welcome and disconnect: which socket an answer belongs to. */
  private connection = 0
  private disposed = false
  private readonly onDisconnected = (): void => {
    // The lease died with the socket; the next welcome takes a fresh one.
    this.connection += 1
    this.clearTimer()
    this.leaseIdValue = null
  }
  private readonly onWelcome = (): void => {
    // A fresh connection, perhaps to a replaced Host: whatever the previous
    // one said about lease support is no longer known, and an acquire still
    // in flight was asked of a socket that is gone.
    this.connection += 1
    this.clearTimer()
    this.leaseIdValue = null
    this.modeValue = 'lease'
    this.acquiring = null
    if (this.wanted) {
      void this.acquire().catch((error: unknown) => {
        this.emit('failed', error instanceof Error ? error : new Error(String(error)))
      })
    }
  }

  constructor(options: HostLeaseClientOptions) {
    super()
    this.client = options.client
    this.log = options.log ?? (() => undefined)
    this.timers = options.timers ?? DEFAULT_TIMERS
    this.client.on('disconnected', this.onDisconnected)
    this.client.on('welcome', this.onWelcome)
  }

  get mode(): HostLeaseClientMode {
    return this.modeValue
  }

  get leaseId(): string | null {
    return this.leaseIdValue
  }

  get held(): boolean {
    return this.leaseIdValue !== null
  }

  /**
   * Acquire on the connected client and start renewing; every later welcome
   * acquires again until `release`, `decline` or `dispose`. Resolves `legacy`
   * (and never throws for it) when the Host predates the lease protocol.
   * Concurrent calls share one request; a release or decline issued while it
   * is in flight waits for it, so it can never be undone by a late answer.
   */
  acquire(): Promise<'held' | 'legacy'> {
    this.wanted = true
    if (this.acquiring) return this.acquiring
    const attempt = this.acquireOnce().finally(() => {
      if (this.acquiring === attempt) this.acquiring = null
    })
    this.acquiring = attempt
    return attempt
  }

  private async acquireOnce(): Promise<'held' | 'legacy'> {
    if (this.disposed) throw new Error('HostLeaseClient is disposed.')
    if (this.modeValue === 'legacy') return 'legacy'
    const connection = this.connection
    let lease: HostLeaseAcquired
    try {
      lease = await this.client.acquireHostLease()
    } catch (error) {
      if (isTransportCode(error, 'unknown_request_kind') && connection === this.connection) {
        this.modeValue = 'legacy'
        this.clearTimer()
        this.log('[host-lease-client] Host predates lease support; legacy mode')
        this.emit('legacy')
        return 'legacy'
      }
      throw error
    }
    // Disposed, or answered on a connection that has since gone: the owner's
    // close (or the Host's TTL) ends that lease, and nothing here may renew
    // it or let it stand in for the current connection's.
    if (this.disposed || connection !== this.connection) return 'held'
    this.leaseIdValue = lease.leaseId
    this.armTimer(lease.heartbeatMs)
    this.emit('held', lease)
    return 'held'
  }

  /** Renew immediately (a resume hook, or a test). Coalesces with a renewal in flight. */
  renewNow(): Promise<void> {
    if (this.renewing) return this.renewing
    const renewal = this.renewOnce().finally(() => {
      this.renewing = null
    })
    this.renewing = renewal
    return renewal
  }

  async release(): Promise<void> {
    this.wanted = false
    await this.settleAcquire()
    this.clearTimer()
    const leaseId = this.leaseIdValue
    this.leaseIdValue = null
    if (leaseId === null) return
    try {
      await this.client.releaseHostLease(leaseId)
    } catch (error) {
      // A lease the Host already dropped, or a socket already gone, is the
      // released state by another road.
      if (!isTransportCode(error, 'invalid_payload') && this.client.connected) throw error
    } finally {
      this.emit('released')
    }
  }

  /**
   * Synchronous release for a teardown that cannot await: writes one release
   * frame, then closes the client. Returns whether the frame was written.
   */
  releaseSync(): boolean {
    this.wanted = false
    this.clearTimer()
    const leaseId = this.leaseIdValue
    this.leaseIdValue = null
    const wrote = leaseId === null ? false : this.client.releaseHostLeaseSync(leaseId)
    this.client.close()
    if (leaseId !== null) this.emit('released')
    return wrote
  }

  /** Declare this socket a non-holder for its lifetime. */
  async decline(): Promise<'declined' | 'legacy'> {
    this.wanted = false
    await this.settleAcquire()
    this.clearTimer()
    this.leaseIdValue = null
    const outcome = await declineHostLease(this.client)
    if (outcome === 'legacy' && this.modeValue !== 'legacy') {
      this.modeValue = 'legacy'
      this.emit('legacy')
    }
    return outcome
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.client.off('disconnected', this.onDisconnected)
    this.client.off('welcome', this.onWelcome)
  }

  private async settleAcquire(): Promise<void> {
    const pending = this.acquiring
    if (pending) await pending.catch(() => undefined)
  }

  private armTimer(heartbeatMs: number): void {
    this.clearTimer()
    this.timer = this.timers.setInterval(() => {
      void this.renewNow().catch(() => undefined)
    }, heartbeatMs)
  }

  private clearTimer(): void {
    if (this.timer === null) return
    this.timers.clearInterval(this.timer)
    this.timer = null
  }

  private async renewOnce(): Promise<void> {
    const leaseId = this.leaseIdValue
    if (leaseId === null || this.disposed) return
    try {
      const renewed = await this.client.renewHostLease(leaseId)
      if (this.leaseIdValue === leaseId) this.emit('renewed', renewed.expiresInMs)
      return
    } catch (error) {
      // Released, replaced, disconnected or disposed while the renewal was in
      // flight: the answer is about a lease this client no longer holds, and
      // re-acquiring on it would undo an explicit release.
      if (this.disposed || this.leaseIdValue !== leaseId) return
      if (isTransportCode(error, 'invalid_payload')) {
        // The Host lapsed this lease (we were silent for its TTL of awake
        // time); the socket is still open, so take a fresh one right away.
        this.leaseIdValue = null
        this.clearTimer()
        this.log('[host-lease-client] lease lapsed on the Host; re-acquiring')
        this.emit('lapsed', leaseId)
        try {
          await this.acquire()
        } catch (reacquireError) {
          this.emit('failed', reacquireError as Error)
        }
        return
      }
      if (!this.client.connected) {
        this.clearTimer()
        this.leaseIdValue = null
        return
      }
      this.emit('failed', error as Error)
    }
  }
}
