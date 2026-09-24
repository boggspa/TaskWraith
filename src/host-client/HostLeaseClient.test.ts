import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HostAuthority } from '../host-runtime/HostAuthority'
import { HOST_LEASE_DEFAULT_TIMING, HostLeaseRegistry } from '../host-runtime/HostLeaseRegistry'
import { HostLocalServer } from '../host-runtime/HostLocalServer'
import { HostSession } from '../host-runtime/HostSession'
import { HostLeaseClient, declineHostLease, type HostLeaseClientTimers } from './HostLeaseClient'
import {
  HostProjectionClient,
  HostProjectionTransportError,
  type HostLeaseAcquired
} from './HostProjectionClient'

/** A controllable stand-in for the slice of HostProjectionClient the lease uses. */
class FakeLeaseTransport extends EventEmitter {
  connected = true
  readonly calls: string[] = []
  acquireHostLease = vi.fn(async (): Promise<HostLeaseAcquired> => {
    this.calls.push('acquire')
    return { leaseId: 'lease-1', heartbeatMs: 5_000, ttlMs: 20_000, hostNowMs: 0 }
  })
  renewHostLease = vi.fn(async (leaseId: string) => {
    this.calls.push(`renew:${leaseId}`)
    return { leaseId, expiresInMs: 20_000, hostNowMs: 1 }
  })
  releaseHostLease = vi.fn(async (leaseId: string) => {
    this.calls.push(`release:${leaseId}`)
  })
  declineHostLease = vi.fn(async () => {
    this.calls.push('decline')
  })
  releaseHostLeaseSync = vi.fn((leaseId: string) => {
    this.calls.push(`release-sync:${leaseId}`)
    return true
  })
  close = vi.fn(() => {
    this.calls.push('close')
    this.connected = false
  })
}

function fakeTimers() {
  const armed: Array<{ callback: () => void; ms: number; cleared: boolean }> = []
  const timers: HostLeaseClientTimers = {
    setInterval: (callback, ms) => {
      const handle = { callback, ms, cleared: false }
      armed.push(handle)
      return handle
    },
    clearInterval: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    }
  }
  const live = () => armed.filter((handle) => !handle.cleared)
  return {
    timers,
    armed,
    live,
    /** Run the one live renew timer, as the heartbeat would. */
    fire: async () => {
      const [handle] = live()
      if (!handle) throw new Error('no renew timer is armed')
      handle.callback()
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

function leaseClient(transport = new FakeLeaseTransport()) {
  const clock = fakeTimers()
  const client = new HostLeaseClient({
    client: transport as unknown as HostProjectionClient,
    timers: clock.timers
  })
  const events: string[] = []
  for (const event of ['held', 'renewed', 'lapsed', 'legacy', 'released', 'failed'] as const) {
    client.on(event, () => events.push(event))
  }
  return { client, transport, clock, events }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('HostLeaseClient', () => {
  it('acquires, then renews on its own heartbeat timer at the cadence the Host asked for', async () => {
    const { client, transport, clock, events } = leaseClient()
    await expect(client.acquire()).resolves.toBe('held')
    expect(client.held).toBe(true)
    expect(client.leaseId).toBe('lease-1')
    expect(clock.live()).toHaveLength(1)
    expect(clock.live()[0].ms).toBe(5_000)
    expect(transport.renewHostLease).not.toHaveBeenCalled()
    await clock.fire()
    await clock.fire()
    expect(transport.calls).toEqual(['acquire', 'renew:lease-1', 'renew:lease-1'])
    expect(events).toEqual(['held', 'renewed', 'renewed'])
  })

  it('enters legacy on unknown_request_kind without a timer or a throw, and the next welcome clears it', async () => {
    const { client, transport, clock, events } = leaseClient()
    transport.acquireHostLease.mockRejectedValueOnce(
      new HostProjectionTransportError('unknown_request_kind')
    )
    await expect(client.acquire()).resolves.toBe('legacy')
    expect(client.mode).toBe('legacy')
    expect(client.held).toBe(false)
    expect(clock.armed).toHaveLength(0)
    expect(events).toEqual(['legacy'])
    // Sticky for this connection: no second question to an old Host.
    await expect(client.acquire()).resolves.toBe('legacy')
    expect(transport.acquireHostLease).toHaveBeenCalledTimes(1)
    // A reconnect may reach a replaced, newer Host: the welcome asks again.
    transport.emit('welcome', {})
    expect(client.mode).toBe('lease')
    expect(transport.acquireHostLease).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(client.held).toBe(true))
    expect(events).toEqual(['legacy', 'held'])
  })

  it('takes the lease again on every later welcome until the owner releases, declines or disposes', async () => {
    const { client, transport, clock, events } = leaseClient()
    // A welcome before the owner ever asked acquires nothing.
    transport.emit('welcome', {})
    expect(transport.acquireHostLease).not.toHaveBeenCalled()
    await client.acquire()
    transport.emit('disconnected', null)
    expect(client.held).toBe(false)
    transport.acquireHostLease.mockResolvedValueOnce({
      leaseId: 'lease-2',
      heartbeatMs: 4_000,
      ttlMs: 16_000,
      hostNowMs: 0
    })
    transport.emit('welcome', {})
    await vi.waitFor(() => expect(client.leaseId).toBe('lease-2'))
    expect(clock.live().map((handle) => handle.ms)).toEqual([4_000])
    expect(events).toEqual(['held', 'held'])

    await client.release()
    transport.emit('welcome', {})
    const declining = leaseClient()
    await declining.client.acquire()
    await declining.client.decline()
    declining.transport.emit('welcome', {})
    const syncReleased = leaseClient()
    await syncReleased.client.acquire()
    syncReleased.client.releaseSync()
    // The owner may connect the same client again; that is not a new ask.
    syncReleased.transport.emit('welcome', {})
    const disposed = leaseClient()
    await disposed.client.acquire()
    disposed.client.dispose()
    disposed.transport.emit('welcome', {})
    await new Promise((resolve) => setImmediate(resolve))
    expect(transport.acquireHostLease).toHaveBeenCalledTimes(2)
    expect(declining.transport.acquireHostLease).toHaveBeenCalledTimes(1)
    expect(syncReleased.transport.acquireHostLease).toHaveBeenCalledTimes(1)
    expect(disposed.transport.acquireHostLease).toHaveBeenCalledTimes(1)
  })

  it('lets no answer from a connection that has gone, or one landing after dispose, hold or renew', async () => {
    const { client, transport, clock, events } = leaseClient()
    const stale = deferred<HostLeaseAcquired>()
    transport.acquireHostLease.mockImplementationOnce(() => stale.promise)
    const first = client.acquire()
    transport.emit('disconnected', null)
    transport.acquireHostLease.mockResolvedValueOnce({
      leaseId: 'lease-current',
      heartbeatMs: 5_000,
      ttlMs: 20_000,
      hostNowMs: 0
    })
    transport.emit('welcome', {})
    await vi.waitFor(() => expect(client.leaseId).toBe('lease-current'))
    stale.resolve({ leaseId: 'lease-stale', heartbeatMs: 1_000, ttlMs: 4_000, hostNowMs: 0 })
    await first
    expect(client.leaseId).toBe('lease-current')
    expect(clock.live().map((handle) => handle.ms)).toEqual([5_000])
    expect(events).toEqual(['held'])

    // Nor may an old connection's refusal turn the new one into legacy.
    const old = leaseClient()
    const refusal = deferred<HostLeaseAcquired>()
    old.transport.acquireHostLease.mockImplementationOnce(() => refusal.promise)
    const asking = old.client.acquire()
    old.transport.emit('disconnected', null)
    old.transport.emit('welcome', {})
    await vi.waitFor(() => expect(old.client.held).toBe(true))
    refusal.reject(new HostProjectionTransportError('unknown_request_kind'))
    await expect(asking).rejects.toMatchObject({ code: 'unknown_request_kind' })
    expect(old.client.mode).toBe('lease')
    expect(old.events).toEqual(['held'])

    const late = leaseClient()
    const answer = deferred<HostLeaseAcquired>()
    late.transport.acquireHostLease.mockImplementationOnce(() => answer.promise)
    const acquiring = late.client.acquire()
    late.client.dispose()
    answer.resolve({ leaseId: 'lease-late', heartbeatMs: 5_000, ttlMs: 20_000, hostNowMs: 0 })
    await acquiring
    expect(late.clock.armed).toHaveLength(0)
    expect(late.events).toEqual([])
  })

  it('rethrows any other acquire failure', async () => {
    const { client, transport } = leaseClient()
    transport.acquireHostLease.mockRejectedValueOnce(
      new HostProjectionTransportError('shutting_down')
    )
    await expect(client.acquire()).rejects.toMatchObject({ code: 'shutting_down' })
    expect(client.mode).toBe('lease')
    expect(client.held).toBe(false)
  })

  it('re-acquires at once when the Host answers a renewal with invalid_payload (a lapse)', async () => {
    const { client, transport, clock, events } = leaseClient()
    await client.acquire()
    transport.renewHostLease.mockRejectedValueOnce(
      new HostProjectionTransportError('invalid_payload')
    )
    transport.acquireHostLease.mockResolvedValueOnce({
      leaseId: 'lease-2',
      heartbeatMs: 5_000,
      ttlMs: 20_000,
      hostNowMs: 30_000
    })
    await clock.fire()
    await vi.waitFor(() => expect(client.leaseId).toBe('lease-2'))
    expect(events).toEqual(['held', 'lapsed', 'held'])
    expect(clock.live()).toHaveLength(1)
  })

  it('reports a renewal failure on a live socket and keeps renewing', async () => {
    const { client, transport, clock, events } = leaseClient()
    await client.acquire()
    transport.renewHostLease.mockRejectedValueOnce(
      new HostProjectionTransportError('host_unavailable')
    )
    await clock.fire()
    expect(events).toEqual(['held', 'failed'])
    expect(client.held).toBe(true)
    await clock.fire()
    expect(events).toEqual(['held', 'failed', 'renewed'])
  })

  it('coalesces renewNow with a renewal already in flight', async () => {
    const { client, transport } = leaseClient()
    await client.acquire()
    const pending = deferred<{ leaseId: string; expiresInMs: number; hostNowMs: number }>()
    transport.renewHostLease.mockImplementationOnce(() => pending.promise)
    const first = client.renewNow()
    const second = client.renewNow()
    expect(second).toBe(first)
    pending.resolve({ leaseId: 'lease-1', expiresInMs: 20_000, hostNowMs: 2 })
    await first
    expect(transport.renewHostLease).toHaveBeenCalledTimes(1)
  })

  it('releaseSync writes exactly one release frame, then closes the client', async () => {
    const { client, transport, clock, events } = leaseClient()
    await client.acquire()
    expect(client.releaseSync()).toBe(true)
    expect(transport.calls).toEqual(['acquire', 'release-sync:lease-1', 'close'])
    expect(transport.releaseHostLeaseSync).toHaveBeenCalledTimes(1)
    expect(clock.live()).toHaveLength(0)
    expect(client.held).toBe(false)
    expect(events).toEqual(['held', 'released'])
  })

  it('releaseSync without a lease writes nothing but still closes', () => {
    const { client, transport, events } = leaseClient()
    expect(client.releaseSync()).toBe(false)
    expect(transport.calls).toEqual(['close'])
    expect(events).toEqual([])
  })

  it('waits for an acquire in flight before releasing, so a late answer cannot re-hold', async () => {
    const { client, transport, clock } = leaseClient()
    const pending = deferred<HostLeaseAcquired>()
    transport.acquireHostLease.mockImplementationOnce(() => pending.promise)
    const acquiring = client.acquire()
    const releasing = client.release()
    pending.resolve({ leaseId: 'lease-late', heartbeatMs: 5_000, ttlMs: 20_000, hostNowMs: 0 })
    await acquiring
    await releasing
    expect(transport.releaseHostLease).toHaveBeenCalledWith('lease-late')
    expect(client.held).toBe(false)
    expect(clock.live()).toHaveLength(0)
  })

  it('never re-acquires on a renewal answered after an explicit release', async () => {
    const { client, transport } = leaseClient()
    await client.acquire()
    const renewal = deferred<{ leaseId: string; expiresInMs: number; hostNowMs: number }>()
    transport.renewHostLease.mockImplementationOnce(() => renewal.promise)
    const renewing = client.renewNow()
    await client.release()
    renewal.reject(new HostProjectionTransportError('invalid_payload'))
    await renewing
    expect(transport.acquireHostLease).toHaveBeenCalledTimes(1)
    expect(client.held).toBe(false)
  })

  it('treats a lease the Host already dropped as released', async () => {
    const { client, transport, events } = leaseClient()
    await client.acquire()
    transport.releaseHostLease.mockRejectedValueOnce(
      new HostProjectionTransportError('invalid_payload')
    )
    await expect(client.release()).resolves.toBeUndefined()
    expect(events).toEqual(['held', 'released'])
  })

  it('drops the lease and the timer when the socket drops', async () => {
    const { client, transport, clock } = leaseClient()
    await client.acquire()
    transport.emit('disconnected', null)
    expect(client.held).toBe(false)
    expect(clock.live()).toHaveLength(0)
  })

  it('declines for a socket that must never hold the Host, and reads an old Host as legacy', async () => {
    const { client, transport, events } = leaseClient()
    await expect(client.decline()).resolves.toBe('declined')
    expect(transport.calls).toEqual(['decline'])
    const old = new FakeLeaseTransport()
    old.declineHostLease.mockRejectedValue(new HostProjectionTransportError('unknown_request_kind'))
    await expect(declineHostLease(old as unknown as HostProjectionClient)).resolves.toBe('legacy')
    const oldLease = leaseClient(old)
    await expect(oldLease.client.decline()).resolves.toBe('legacy')
    expect(oldLease.client.mode).toBe('legacy')
    expect(oldLease.events).toEqual(['legacy'])
    expect(events).toEqual([])
  })

  it('stops listening to the client once disposed', async () => {
    const { client, transport } = leaseClient()
    client.dispose()
    expect(transport.listenerCount('welcome')).toBe(0)
    expect(transport.listenerCount('disconnected')).toBe(0)
    await expect(client.acquire()).rejects.toThrow('disposed')
  })
})

describe('HostLeaseClient against a real Host socket', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function realHost(options: { leaseProtocol?: 'disabled' } = {}) {
    const profile = mkdtempSync(join(tmpdir(), 'host-lease-client-'))
    let monoNs = 0n
    const leases = new HostLeaseRegistry({
      onExit: () => undefined,
      ports: {
        monotonicNowNs: () => monoNs,
        wallNowMs: () => Number(monoNs / 1_000_000n),
        schedule: () => () => {}
      }
    })
    const server = new HostLocalServer({
      userDataPath: profile,
      hostId: 'lease-client-host',
      hostVersion: 'node-host-v1',
      session: new HostSession({
        host: { hostId: 'lease-client-host', hostVersion: 'node-host-v1' },
        runtime: { getPosition: () => ({ generation: 1, cursor: 0 }) },
        hostCapabilityOffer: ['bootstrap', 'health']
      }),
      authority: {
        health: vi.fn().mockResolvedValue({
          ok: true,
          value: { hostStatus: 'ok', connectionPhase: 'live', supervised: false, freshness: 'live' }
        })
      } as unknown as HostAuthority,
      ...(options.leaseProtocol ? { leaseProtocol: options.leaseProtocol } : { leases })
    })
    await server.start()
    cleanups.push(async () => {
      await server.stop()
      rmSync(profile, { recursive: true, force: true })
    })
    const projection = new HostProjectionClient({
      userDataPath: profile,
      client: { clientId: 'tui-lease-test', clientClass: 'tui', clientVersion: '1.0.0' },
      capabilities: ['bootstrap', 'health'],
      connectTimeoutMs: 2_000,
      requestTimeoutMs: 2_000
    })
    cleanups.push(() => projection.close())
    await projection.connect()
    const advance = (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += HOST_LEASE_DEFAULT_TIMING.tickMs) {
        monoNs += BigInt(HOST_LEASE_DEFAULT_TIMING.tickMs) * 1_000_000n
        leases.tick()
      }
    }
    return { server, projection, advance }
  }

  it('holds, renews, lapses, re-acquires and releases a lease on one socket', async () => {
    const { server, projection, advance } = await realHost()
    const lease = new HostLeaseClient({ client: projection, timers: fakeTimers().timers })
    expect(server.leaseSummary()).toMatchObject({ implicitHolders: 1, explicitHolders: 0 })
    await expect(lease.acquire()).resolves.toBe('held')
    const first = lease.leaseId
    expect(server.leaseSummary()).toMatchObject({ implicitHolders: 0, explicitHolders: 1 })
    await lease.renewNow()
    expect(lease.leaseId).toBe(first)

    advance(HOST_LEASE_DEFAULT_TIMING.ttlMs)
    expect(server.leaseSummary()).toMatchObject({ explicitHolders: 0, phase: 'grace' })
    await lease.renewNow()
    await vi.waitFor(() => expect(lease.leaseId).not.toBeNull())
    expect(lease.leaseId).not.toBe(first)
    expect(server.leaseSummary()).toMatchObject({ explicitHolders: 1, phase: 'held' })

    await lease.release()
    expect(server.leaseSummary()).toMatchObject({ explicitHolders: 0, declined: 1, holders: 0 })
    await expect(lease.acquire()).resolves.toBe('held')
    expect(lease.releaseSync()).toBe(true)
    await vi.waitFor(() => expect(server.clientCount()).toBe(0))
    expect(server.leaseSummary()).toMatchObject({ holders: 0, declined: 0 })
  })

  it('reports legacy against a Host that answers the lease kinds as a pre-lease Host does', async () => {
    const { projection } = await realHost({ leaseProtocol: 'disabled' })
    const lease = new HostLeaseClient({ client: projection, timers: fakeTimers().timers })
    await expect(lease.acquire()).resolves.toBe('legacy')
    expect(lease.mode).toBe('legacy')
    // The old Host kept the connection: everything else still works.
    await expect(projection.getHealth()).resolves.toMatchObject({ type: 'host.health' })
    await expect(projection.getHostStatus()).rejects.toMatchObject({
      code: 'unknown_request_kind'
    })
  })
})
