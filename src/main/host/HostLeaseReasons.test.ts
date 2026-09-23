import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HostLeaseClientTimers } from '../../host-client/HostLeaseClient'
import {
  HostProjectionClient,
  HostProjectionTransportError,
  type HostLeaseAcquired
} from '../../host-client/HostProjectionClient'
import type { HostAuthority } from '../../host-runtime/HostAuthority'
import { HostLeaseRegistry } from '../../host-runtime/HostLeaseRegistry'
import { HostLocalServer } from '../../host-runtime/HostLocalServer'
import { HostSession } from '../../host-runtime/HostSession'
import {
  TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
  type HostCapability,
  type HostStatusProjection
} from '../../shared/hostProtocol'
import {
  DESKTOP_HOST_LEASE_CLIENT_ID,
  DESKTOP_HOST_LEASE_MAX_RETRIES,
  DesktopHostLease,
  HostLeaseReasons,
  hostLeaseReasonKind,
  isHostLeaseReason,
  startDesktopHostLease,
  type DesktopHostLeaseRetryHandle
} from './HostLeaseReasons'

const STATUS: HostStatusProjection = {
  pid: 4242,
  startedAt: '2026-09-23T10:00:00.000Z',
  uptimeMs: 1_000,
  hostId: 'host-install-1',
  profilePath: '/profile',
  persist: false,
  lifetime: { phase: 'held', holders: 1, implicitHolders: 0, declined: 1 },
  liveWork: { runs: 0 },
  clients: []
}

/** Main's lease socket, controllable: the slice of HostProjectionClient the lease uses. */
class FakeLeaseSocket extends EventEmitter {
  connected = false
  refuseConnect = false
  readonly calls: string[] = []
  private issued = 0
  connect = vi.fn(async () => {
    this.calls.push('connect')
    if (this.refuseConnect) throw new Error('connect ECONNREFUSED')
    this.connected = true
    this.emit('welcome', {})
    return {}
  })
  acquireHostLease = vi.fn(async (): Promise<HostLeaseAcquired> => {
    this.issued += 1
    this.calls.push(`acquire:lease-${this.issued}`)
    return { leaseId: `lease-${this.issued}`, heartbeatMs: 5_000, ttlMs: 20_000, hostNowMs: 0 }
  })
  renewHostLease = vi.fn(async (leaseId: string) => {
    this.calls.push(`renew:${leaseId}`)
    return { leaseId, expiresInMs: 20_000, hostNowMs: 1 }
  })
  releaseHostLease = vi.fn(async (leaseId: string) => {
    this.calls.push(`release:${leaseId}`)
  })
  releaseHostLeaseSync = vi.fn((leaseId: string) => {
    this.calls.push(`release-sync:${leaseId}`)
    // A closed socket cannot carry the frame.
    return this.connected
  })
  supports = vi.fn((capability: string) => this.connected && capability === 'health')
  getHostStatus = vi.fn(async () => STATUS)
  close = vi.fn(() => {
    this.calls.push('close')
    this.connected = false
  })
  /** The next renewal reaches the Host and fails with `error`. */
  failNextRenewal(error: Error): void {
    this.renewHostLease.mockImplementationOnce(async (leaseId: string) => {
      this.calls.push(`renew:${leaseId}`)
      throw error
    })
  }
  /** The Host closed the socket (it exited, or was replaced). */
  drop(): void {
    this.connected = false
    this.emit('disconnected', null)
  }
}

function heartbeat() {
  const armed: Array<{ callback: () => void; cleared: boolean }> = []
  const timers: HostLeaseClientTimers = {
    setInterval: (callback) => {
      const handle = { callback, cleared: false }
      armed.push(handle)
      return handle
    },
    clearInterval: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    }
  }
  return {
    timers,
    /** One heartbeat of the live renew timer. */
    beat: async () => {
      const live = armed.filter((handle) => !handle.cleared)
      if (live.length !== 1) throw new Error(`expected one renew timer, found ${live.length}`)
      live[0].callback()
      await settle()
    }
  }
}

function retryQueue() {
  const scheduled: Array<{ callback: () => void; delayMs: number; state: string }> = []
  return {
    schedule: (callback: () => void, delayMs: number): DesktopHostLeaseRetryHandle => {
      const entry = { callback, delayMs, state: 'pending' }
      scheduled.push(entry)
      return {
        cancel: () => {
          if (entry.state === 'pending') entry.state = 'cancelled'
        }
      }
    },
    delays: () => scheduled.map((entry) => entry.delayMs),
    pending: () => scheduled.filter((entry) => entry.state === 'pending').length,
    /** Run the one pending retry, as its timer would. */
    run: async () => {
      const pending = scheduled.filter((entry) => entry.state === 'pending')
      if (pending.length !== 1)
        throw new Error(`expected one pending retry, found ${pending.length}`)
      pending[0].state = 'ran'
      pending[0].callback()
      await settle()
    }
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

function desktopLease(
  options: {
    readonly ensureHost?: () => Promise<boolean>
    readonly onHeld?: () => void
  } = {}
) {
  const socket = new FakeLeaseSocket()
  const reasons = new HostLeaseReasons()
  const clock = heartbeat()
  const retries = retryQueue()
  const ensureHost = vi.fn(options.ensureHost ?? (async () => true))
  const onHeld = vi.fn(options.onHeld ?? (() => undefined))
  const lines: string[] = []
  const lease = new DesktopHostLease({
    reasons,
    client: socket as unknown as HostProjectionClient,
    ensureHost,
    onHeld,
    timers: clock.timers,
    scheduleRetry: retries.schedule,
    log: (line) => lines.push(line)
  })
  return { socket, reasons, clock, retries, ensureHost, onHeld, lines, lease }
}

describe('HostLeaseReasons', () => {
  it('tells its listeners only the edges: the first reason held, the last one gone', () => {
    const reasons = new HostLeaseReasons()
    const edges: boolean[] = []
    reasons.subscribe((holding) => edges.push(holding))
    expect(reasons.hold('app')).toBe(true)
    expect(reasons.hold('app')).toBe(false)
    expect(reasons.hold('window')).toBe(true)
    expect(reasons.release('app')).toBe(true)
    expect(reasons.release('app')).toBe(false)
    expect(edges).toEqual([true])
    expect(reasons.release('window')).toBe(true)
    expect(edges).toEqual([true, false])
    expect(reasons.holding).toBe(false)
  })

  it('keeps notifying the others when one listener throws', () => {
    const reasons = new HostLeaseReasons()
    const heard = vi.fn()
    reasons.subscribe(() => {
      throw new Error('listener failed')
    })
    reasons.subscribe(heard)
    reasons.hold('app')
    expect(heard).toHaveBeenCalledWith(true)
  })

  it('reports kinds in contract order, and a pin never with its device key', () => {
    const reasons = new HostLeaseReasons()
    reasons.hold('pin:device-b')
    reasons.hold('work')
    reasons.hold('pin:device-a')
    reasons.hold('app')
    expect(reasons.kinds()).toEqual(['app', 'work', 'pin'])
    expect(hostLeaseReasonKind('pin:device-a')).toBe('pin')
    expect(hostLeaseReasonKind('window')).toBe('window')
  })

  it('refuses a reason it does not know', () => {
    for (const reason of ['app', 'window', 'work', 'pin:AB12.cd_34:ef-5']) {
      expect(isHostLeaseReason(reason)).toBe(true)
    }
    for (const reason of ['pin:', 'pin:has space', 'phone', 'APP', '', 7, null]) {
      expect(isHostLeaseReason(reason)).toBe(false)
    }
    expect(() => new HostLeaseReasons().hold('phone' as never)).toThrow(
      'Unknown Host lease reason.'
    )
  })
})

describe('DesktopHostLease', () => {
  it("takes the lease when the first reason is held, and lets the spawner's boot hold go once it is", async () => {
    const { socket, reasons, lease, onHeld } = desktopLease()
    lease.start()
    await settle()
    expect(socket.connect).not.toHaveBeenCalled()
    reasons.hold('app')
    await settle()
    expect(socket.calls).toEqual(['connect', 'acquire:lease-1'])
    expect(onHeld).toHaveBeenCalledTimes(1)
    expect(lease.held).toBe(true)
    expect(lease.projection()).toEqual({ mode: 'lease', held: true, reasons: ['app'] })
    // A running transition while it is held takes nothing more.
    lease.onHostRunning()
    await settle()
    expect(socket.calls).toEqual(['connect', 'acquire:lease-1'])
  })

  it('counts a Host that predates leases as held for the boot hold, and never asks it again', async () => {
    const { socket, reasons, lease, onHeld, retries } = desktopLease()
    socket.acquireHostLease.mockRejectedValueOnce(
      new HostProjectionTransportError('unknown_request_kind')
    )
    lease.start()
    reasons.hold('app')
    await settle()
    expect(onHeld).toHaveBeenCalledTimes(1)
    expect(lease.projection()).toEqual({ mode: 'legacy', held: false, reasons: ['app'] })
    lease.onHostRunning()
    await lease.renewNow()
    await settle()
    expect(socket.acquireHostLease).toHaveBeenCalledTimes(1)
    expect(retries.pending()).toBe(0)
  })

  it('releases the lease and closes its socket when the last reason goes, and never repairs it', async () => {
    const { socket, reasons, lease, retries, ensureHost } = desktopLease()
    lease.start()
    reasons.hold('app')
    await settle()
    reasons.release('app')
    await settle()
    expect(socket.calls).toEqual(['connect', 'acquire:lease-1', 'release:lease-1', 'close'])
    socket.drop()
    await settle()
    expect(retries.pending()).toBe(0)
    expect(ensureHost).not.toHaveBeenCalled()
  })

  it('re-acquires a lapsed lease on the same socket, without asking the lifecycle', async () => {
    const { socket, reasons, lease, clock, ensureHost, retries } = desktopLease()
    lease.start()
    reasons.hold('app')
    await settle()
    // Main was stalled past the Host's TTL: the Host no longer knows the lease.
    socket.failNextRenewal(new HostProjectionTransportError('invalid_payload'))
    await clock.beat()
    expect(socket.calls).toEqual(['connect', 'acquire:lease-1', 'renew:lease-1', 'acquire:lease-2'])
    expect(lease.held).toBe(true)
    expect(ensureHost).not.toHaveBeenCalled()
    expect(retries.pending()).toBe(0)
  })

  it('repairs a failed renewal: drops the socket, has the lifecycle ensure the Host, and takes a fresh lease', async () => {
    const { socket, reasons, lease, clock, ensureHost, retries, onHeld } = desktopLease()
    lease.start()
    reasons.hold('app')
    await settle()
    socket.failNextRenewal(new Error('Timed out waiting for the Host.'))
    await clock.beat()
    expect(socket.calls.slice(-2)).toEqual(['renew:lease-1', 'close'])
    expect(ensureHost).not.toHaveBeenCalled()
    expect(retries.delays()).toEqual([0])
    await retries.run()
    expect(ensureHost).toHaveBeenCalledTimes(1)
    expect(socket.calls.slice(-2)).toEqual(['connect', 'acquire:lease-2'])
    expect(lease.held).toBe(true)
    expect(onHeld).toHaveBeenCalledTimes(2)
  })

  it('repairs a socket the Host closed: the lifecycle brings the Host back, then the lease is taken again', async () => {
    const order: string[] = []
    const { socket, reasons, lease, retries } = desktopLease({
      ensureHost: async () => {
        order.push('ensure')
        return true
      }
    })
    lease.start()
    reasons.hold('app')
    await settle()
    socket.drop()
    await settle()
    expect(lease.held).toBe(false)
    await retries.run()
    order.push(...socket.calls.slice(2))
    expect(order).toEqual(['ensure', 'connect', 'acquire:lease-2'])
    expect(lease.held).toBe(true)
  })

  it('parks while the lifecycle will not bring the Host back, and resumes when it is reported running', async () => {
    let running = false
    const { socket, reasons, lease, retries, lines } = desktopLease({
      ensureHost: async () => running
    })
    lease.start()
    reasons.hold('app')
    await settle()
    socket.drop()
    await retries.run()
    // Stopped by the user or a failed start: nothing here may start it.
    expect(socket.connect).toHaveBeenCalledTimes(1)
    expect(retries.pending()).toBe(0)
    expect(lines.join('\n')).toContain('the Host is not running; waiting for it to be started')
    running = true
    lease.onHostRunning()
    await settle()
    expect(socket.calls.slice(-2)).toEqual(['connect', 'acquire:lease-2'])
    expect(lease.held).toBe(true)
  })

  it('backs off between failed repairs and parks after too many in a row', async () => {
    const { socket, reasons, lease, retries, ensureHost, lines } = desktopLease()
    lease.start()
    reasons.hold('app')
    await settle()
    socket.refuseConnect = true
    socket.drop()
    for (let attempt = 0; attempt < DESKTOP_HOST_LEASE_MAX_RETRIES; attempt += 1) {
      await retries.run()
    }
    expect(retries.delays()).toEqual([0, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
    expect(ensureHost).toHaveBeenCalledTimes(DESKTOP_HOST_LEASE_MAX_RETRIES)
    expect(retries.pending()).toBe(0)
    expect(lines.at(-1)).toContain(`parked after ${DESKTOP_HOST_LEASE_MAX_RETRIES} attempts`)
    // The Host reported running again: a fresh round.
    socket.refuseConnect = false
    lease.onHostRunning()
    await settle()
    expect(lease.held).toBe(true)
  })

  it('renews at once when the machine resumes, and repairs a lease it no longer holds', async () => {
    let running = false
    const { socket, reasons, lease, retries } = desktopLease({ ensureHost: async () => running })
    lease.start()
    reasons.hold('app')
    await settle()
    await lease.renewNow()
    expect(socket.calls.at(-1)).toBe('renew:lease-1')

    socket.drop()
    await retries.run()
    expect(retries.pending()).toBe(0)
    running = true
    await lease.renewNow()
    await retries.run()
    expect(socket.calls.slice(-2)).toEqual(['connect', 'acquire:lease-2'])
    expect(lease.held).toBe(true)
  })

  it('releases synchronously at quit, the frame before the close, and never takes the lease again', async () => {
    const { socket, reasons, lease, retries, ensureHost } = desktopLease()
    lease.start()
    reasons.hold('app')
    await settle()
    expect(lease.releaseSync()).toBe(true)
    expect(socket.calls.slice(2)).toEqual(['release-sync:lease-1', 'close'])
    socket.drop()
    reasons.release('app')
    reasons.hold('app')
    lease.onHostRunning()
    await lease.renewNow()
    await settle()
    expect(socket.connect).toHaveBeenCalledTimes(1)
    expect(retries.pending()).toBe(0)
    expect(ensureHost).not.toHaveBeenCalled()
  })

  it("reads the Host's status over its own socket, and null when it cannot", async () => {
    const { socket, reasons, lease } = desktopLease()
    await expect(lease.readHostStatus()).resolves.toBeNull()
    lease.start()
    reasons.hold('app')
    await settle()
    await expect(lease.readHostStatus()).resolves.toEqual(STATUS)
    socket.getHostStatus.mockRejectedValueOnce(new Error('host_unavailable'))
    await expect(lease.readHostStatus()).resolves.toBeNull()
    socket.supports.mockReturnValue(false)
    await expect(lease.readHostStatus()).resolves.toBeNull()
    expect(socket.getHostStatus).toHaveBeenCalledTimes(2)
  })

  it('logs a boot-hold release that throws, and keeps the lease', async () => {
    const { reasons, lease, lines } = desktopLease({
      onHeld: () => {
        throw new Error('hold already gone')
      }
    })
    lease.start()
    reasons.hold('app')
    await settle()
    expect(lease.held).toBe(true)
    expect(lines).toContain('[host-lease] releasing the boot hold failed: hold already gone')
  })
})

/** The real listener and lease registry, as HostLeaseClient.test's harness builds them. */
describe('startDesktopHostLease on a real Host listener', () => {
  const cleanups: Array<() => unknown> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  const OFFER: HostCapability[] = ['bootstrap', 'snapshot', 'deltas', 'health', 'commands']

  async function realHost() {
    const profile = mkdtempSync(join(tmpdir(), 'desktop-host-lease-'))
    const leases = new HostLeaseRegistry({
      onExit: () => undefined,
      ports: {
        monotonicNowNs: () => 0n,
        wallNowMs: () => 0,
        schedule: () => () => {}
      }
    })
    const server = new HostLocalServer({
      userDataPath: profile,
      hostId: 'desktop-lease-host',
      hostVersion: 'node-host-v1',
      session: new HostSession({
        host: { hostId: 'desktop-lease-host', hostVersion: 'node-host-v1' },
        runtime: { getPosition: () => ({ generation: 1, cursor: 0 }) },
        hostCapabilityOffer: OFFER
      }),
      authority: {
        health: vi.fn().mockResolvedValue({
          ok: true,
          value: { hostStatus: 'ok', connectionPhase: 'live', supervised: false, freshness: 'live' }
        })
      } as unknown as HostAuthority,
      leases
    })
    await server.start()
    cleanups.push(async () => {
      await server.stop()
      rmSync(profile, { recursive: true, force: true })
    })
    return { profile, server }
  }

  function desktopSocket(profile: string): HostProjectionClient {
    const client = new HostProjectionClient({
      userDataPath: profile,
      client: {
        clientId: TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
        clientClass: 'desktop',
        clientVersion: '1.0.0'
      },
      capabilities: ['bootstrap', 'snapshot', 'deltas', 'health'],
      connectTimeoutMs: 2_000,
      requestTimeoutMs: 2_000
    })
    cleanups.push(() => client.close())
    return client
  }

  it('holds the Host under its own client id, and never narrows the shared Desktop grant', async () => {
    const { profile, server } = await realHost()
    // The broker's Desktop socket binds the wide grant first.
    const first = desktopSocket(profile)
    await first.connect()

    let listener: ((snapshot: { phase: string }) => void) | null = null
    const lifecycle = {
      ensure: vi.fn(async () => ({ ok: false })),
      subscribe: vi.fn((next: (snapshot: { phase: string }) => void) => {
        listener = next
        return () => {
          listener = null
        }
      })
    }
    const releaseBootHold = vi.fn()
    const wiring = startDesktopHostLease({
      profilePath: profile,
      appVersion: '1.0.0',
      lifecycle,
      releaseBootHold
    })
    cleanups.push(() => wiring.releaseSync())
    expect(listener).not.toBeNull()
    wiring.reasons.hold('app')
    await vi.waitFor(() => expect(wiring.lease.held).toBe(true))
    expect(releaseBootHold).toHaveBeenCalledWith(profile)
    expect(server.leaseSummary()).toMatchObject({ explicitHolders: 1 })

    const status = await wiring.readHostStatus()
    expect(status?.clients).toContainEqual(
      expect.objectContaining({
        clientId: DESKTOP_HOST_LEASE_CLIENT_ID,
        lease: 'explicit',
        capabilities: ['bootstrap', 'health']
      })
    )
    expect(wiring.leaseProjection()).toEqual({ mode: 'lease', held: true, reasons: ['app'] })

    // A Desktop socket that binds after the narrow lease socket keeps the
    // whole grant: a shared id would have narrowed every later Desktop socket.
    const later = desktopSocket(profile)
    await later.connect()
    expect(later.supports('snapshot')).toBe(true)
    expect(later.supports('deltas')).toBe(true)

    // A running transition takes nothing more; quit releases and unsubscribes.
    listener!({ phase: 'running' })
    expect(wiring.releaseSync()).toBe(true)
    expect(listener).toBeNull()
    await vi.waitFor(() => expect(server.leaseSummary()).toMatchObject({ explicitHolders: 0 }))
  })

  it('asks the lifecycle to ensure the Host when the Host closes its socket', async () => {
    const { profile, server } = await realHost()
    const lifecycle = {
      ensure: vi.fn(async () => ({ ok: false })),
      subscribe: vi.fn(() => () => undefined)
    }
    const wiring = startDesktopHostLease({
      profilePath: profile,
      appVersion: '1.0.0',
      lifecycle,
      releaseBootHold: () => undefined
    })
    cleanups.push(() => wiring.releaseSync())
    wiring.reasons.hold('app')
    await vi.waitFor(() => expect(wiring.lease.held).toBe(true))
    await server.stop()
    await vi.waitFor(() => expect(lifecycle.ensure).toHaveBeenCalledWith('lease-reacquire'))
    expect(wiring.lease.held).toBe(false)
  })
})
