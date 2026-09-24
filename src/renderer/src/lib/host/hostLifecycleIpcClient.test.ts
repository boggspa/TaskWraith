import { describe, expect, it, vi } from 'vitest'

import type {
  HostLifecycleActionResult,
  HostLifecycleInspectResult,
  HostLifecycleSnapshot,
  HostLifecycleStatusResult
} from '../../../../shared/hostLifecycle'
import type { HostStatusProjection } from '../../../../shared/hostProtocol'
import { HostLifecycleIpcClient, type HostLifecycleBridge } from './hostLifecycleIpcClient'

function snapshot(overrides: Partial<HostLifecycleSnapshot> = {}): HostLifecycleSnapshot {
  return {
    revision: 2,
    phase: 'running',
    desired: 'running',
    reason: 'user-start',
    changedAt: '2026-08-12T12:00:00.000Z',
    ...overrides
  }
}

const HOST_STARTED_AT = '2026-09-23T12:00:00.000Z'

function hostStatus(): HostStatusProjection {
  return {
    pid: 4242,
    startedAt: HOST_STARTED_AT,
    uptimeMs: 11_520_000,
    hostId: 'host-1',
    payloadVersion: `sha256:${'ab'.repeat(32)}`,
    profilePath: '/Users/example/Library/Application Support/TaskWraith',
    persist: false,
    lifetime: { phase: 'held', holders: 2, implicitHolders: 1, declined: 3 },
    liveWork: { runs: 0 },
    clients: [
      {
        clientClass: 'desktop',
        clientId: 'taskwraith-desktop-lease',
        connectedForMs: 60_000,
        lease: 'explicit',
        capabilities: ['bootstrap', 'health']
      }
    ]
  }
}

function bridge(overrides: Partial<HostLifecycleBridge> = {}): HostLifecycleBridge {
  return {
    hostLifecycleStatus: vi.fn(
      async (): Promise<HostLifecycleStatusResult> => ({ ok: true, snapshot: snapshot() })
    ),
    hostLifecycleSet: vi.fn(
      async (): Promise<HostLifecycleActionResult> => ({ ok: true, snapshot: snapshot() })
    ),
    onHostLifecycleChanged: vi.fn(() => () => undefined),
    ...overrides
  }
}

describe('HostLifecycleIpcClient', () => {
  it('returns a detached validated status snapshot', async () => {
    const source = snapshot()
    const client = new HostLifecycleIpcClient(
      bridge({
        hostLifecycleStatus: vi.fn(
          async (): Promise<HostLifecycleStatusResult> => ({ ok: true, snapshot: source })
        )
      })
    )

    const result = await client.status()
    expect(result).toEqual(source)
    expect(result).not.toBe(source)
  })

  it('surfaces a denied status and rejects malformed responses', async () => {
    const denied = new HostLifecycleIpcClient(
      bridge({
        hostLifecycleStatus: vi.fn(
          async (): Promise<HostLifecycleStatusResult> => ({ ok: false, error: 'main only' })
        )
      })
    )
    await expect(denied.status()).rejects.toThrow('main only')

    const malformed = new HostLifecycleIpcClient(
      bridge({ hostLifecycleStatus: vi.fn(async () => ({ ok: true }) as never) })
    )
    await expect(malformed.status()).rejects.toThrow(/malformed/)
  })

  it('sends only the requested action and preserves controller failures as values', async () => {
    const hostLifecycleSet = vi.fn(
      async (): Promise<HostLifecycleActionResult> => ({
        ok: false,
        error: 'socket bind failed',
        snapshot: snapshot({ phase: 'failed', reason: 'start-failed', error: 'socket bind failed' })
      })
    )
    const client = new HostLifecycleIpcClient(bridge({ hostLifecycleSet }))

    await expect(client.set('start')).resolves.toMatchObject({
      ok: false,
      error: 'socket bind failed',
      snapshot: { phase: 'failed' }
    })
    expect(hostLifecycleSet).toHaveBeenCalledWith({ action: 'start' })
  })

  it('sends a restart as exactly the restart action', async () => {
    const restarted = snapshot({ revision: 9, reason: 'user-restart' })
    const hostLifecycleSet = vi.fn(
      async (): Promise<HostLifecycleActionResult> => ({ ok: true, snapshot: restarted })
    )
    const client = new HostLifecycleIpcClient(bridge({ hostLifecycleSet }))

    await expect(client.set('restart')).resolves.toEqual({ ok: true, snapshot: restarted })
    expect(hostLifecycleSet).toHaveBeenCalledTimes(1)
    expect(hostLifecycleSet).toHaveBeenCalledWith({ action: 'restart' })
  })

  it('returns a detached inspection carrying the Host status and this app lease', async () => {
    const source = {
      ok: true as const,
      snapshot: snapshot({ host: { pid: 4242, hostId: 'host-1', startedAt: HOST_STARTED_AT } }),
      host: { ...hostStatus(), unknownFutureField: 'dropped' } as HostStatusProjection,
      lease: { mode: 'lease' as const, held: true, reasons: ['app' as const] }
    }
    const hostLifecycleInspect = vi.fn(async (): Promise<HostLifecycleInspectResult> => source)
    const client = new HostLifecycleIpcClient(bridge({ hostLifecycleInspect }))

    const result = await client.inspect()

    expect(hostLifecycleInspect).toHaveBeenCalledTimes(1)
    expect(result.snapshot).toEqual(source.snapshot)
    expect(result.host).toEqual(hostStatus())
    expect(result.host).not.toHaveProperty('unknownFutureField')
    expect(result.lease).toEqual({ mode: 'lease', held: true, reasons: ['app'] })
    // Detached: nothing the caller holds aliases the bridge's objects.
    expect(result.snapshot).not.toBe(source.snapshot)
    expect(result.host).not.toBe(source.host)
    expect(result.host?.clients[0]).not.toBe(source.host.clients[0])
    expect(result.lease).not.toBe(source.lease)
    expect(result.lease?.reasons).not.toBe(source.lease.reasons)
  })

  it('passes an unread Host status and an absent lease through as null', async () => {
    const client = new HostLifecycleIpcClient(
      bridge({
        hostLifecycleInspect: vi.fn(
          async (): Promise<HostLifecycleInspectResult> => ({
            ok: true,
            snapshot: snapshot(),
            host: null,
            lease: null
          })
        )
      })
    )

    await expect(client.inspect()).resolves.toEqual({
      snapshot: snapshot(),
      host: null,
      lease: null
    })
  })

  it('reports a preload without the inspect channel and keeps status working', async () => {
    const client = new HostLifecycleIpcClient(bridge())

    await expect(client.inspect()).rejects.toThrow('Host inspect is unavailable in this build.')
    await expect(client.status()).resolves.toEqual(snapshot())
  })

  it('surfaces a denied inspect and rejects malformed answers', async () => {
    const denied = new HostLifecycleIpcClient(
      bridge({
        hostLifecycleInspect: vi.fn(
          async (): Promise<HostLifecycleInspectResult> => ({ ok: false, error: 'main only' })
        )
      })
    )
    await expect(denied.inspect()).rejects.toThrow('main only')

    for (const malformed of [
      { ok: true, snapshot: snapshot(), host: { ...hostStatus(), pid: 0 }, lease: null },
      {
        ok: true,
        snapshot: snapshot(),
        host: null,
        lease: { mode: 'daemon', held: true, reasons: [] }
      },
      { ok: true, snapshot: snapshot(), lease: null }
    ]) {
      const client = new HostLifecycleIpcClient(
        bridge({ hostLifecycleInspect: vi.fn(async () => malformed as never) })
      )
      await expect(client.inspect()).rejects.toThrow(/malformed/)
    }
  })

  it('validates lifecycle events and returns the bridge unsubscribe', () => {
    let emit: ((value: HostLifecycleSnapshot) => void) | undefined
    const unsubscribe = vi.fn()
    const client = new HostLifecycleIpcClient(
      bridge({
        onHostLifecycleChanged: vi.fn((listener) => {
          emit = listener
          return unsubscribe
        })
      })
    )
    const listener = vi.fn()
    const dispose = client.subscribe(listener)

    emit?.(snapshot({ revision: 3 }))
    emit?.({ ...snapshot(), phase: 'daemonized' } as never)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ revision: 3 }))
    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('is safe to construct during server rendering without a window bridge', async () => {
    const client = new HostLifecycleIpcClient()
    expect(() => client.subscribe(() => undefined)).not.toThrow()
    await expect(client.status()).rejects.toThrow(/outside TaskWraith Desktop|unavailable/)
  })
})
