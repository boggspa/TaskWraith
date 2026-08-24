import { describe, expect, it, vi } from 'vitest'

import { HostNodeProductionServer } from './HostNodeProductionServer'

function harness(overrides: Record<string, unknown> = {}) {
  const order: string[] = []
  let eventPublish: (() => void) | null = null
  const lease = {
    path: '/profile',
    assertHeld: vi.fn(() => order.push('lease.assert')),
    release: vi.fn(() => {
      order.push('lease.release')
      return true
    })
  }
  const listener = {
    start: vi.fn(async () => order.push('listener.start')),
    stop: vi.fn(async () => order.push('listener.stop'))
  }
  const composition = {
    authority: {},
    session: {},
    startProjectionReconciliation: vi.fn(async () => order.push('reconcile.start')),
    reconcileProjection: vi.fn(async () => order.push('reconcile.now')),
    subscribeDeltas: vi.fn(() => () => {}),
    shutdown: vi.fn(async () => order.push('composition.shutdown'))
  }
  const domain = {
    setupExecutor: { execute: vi.fn() },
    snapshotDonor: vi.fn(() => ({})),
    evaluateAuthority: vi.fn(() => ({ decision: 'deny', reason: 'test' })),
    executeCommand: vi.fn(),
    providerStatuses: vi.fn(async () => []),
    providerOffers: vi.fn(),
    providerAuthFlows: vi.fn(async () => []),
    providerAuthStatus: vi.fn(),
    threadHistory: vi.fn(),
    historySince: vi.fn(),
    shutdown: vi.fn(async () => order.push('domain.shutdown'))
  }
  const signalListeners = new Map<string, () => void>()
  const server = new HostNodeProductionServer({
    profilePath: '/profile',
    mode: 'production',
    domainOptions: {} as never,
    signalTarget: {
      once: (signal, listener_) => {
        signalListeners.set(signal, listener_)
      },
      removeListener: (signal) => signalListeners.delete(signal)
    },
    acquireLease: () => {
      order.push('lease.acquire')
      return lease
    },
    resolveIdentity: () => {
      order.push('identity')
      return { installId: 'a'.repeat(48), hostId: 'host', hostVersion: '1.0' }
    },
    createStore: () => {
      order.push('store')
      return {} as never
    },
    createDomain: (input) => {
      order.push('domain')
      eventPublish = () => input.events.publish({} as never, {} as never)
      return domain as never
    },
    createComposition: () => {
      order.push('composition')
      return composition as never
    },
    createListener: () => {
      order.push('listener')
      return listener
    },
    ...overrides
  })
  return {
    server,
    order,
    lease,
    listener,
    composition,
    domain,
    signalListeners,
    eventPublish: () => eventPublish?.()
  }
}

describe('HostNodeProductionServer', () => {
  it('constructs lease-first, then reconciles before starting the authenticated listener, and cleans in exact order', async () => {
    const h = harness()
    await h.server.start()
    expect(h.order).toEqual([
      'lease.acquire',
      'lease.assert',
      'identity',
      'store',
      'domain',
      'composition',
      'reconcile.start',
      'listener',
      'listener.start'
    ])
    await h.server.stop()
    expect(h.order.slice(-4)).toEqual([
      'listener.stop',
      'domain.shutdown',
      'composition.shutdown',
      'lease.release'
    ])
    await expect(h.server.stop()).resolves.toBeUndefined()
  })

  it('fails a second profile owner before identity/store/domain creation', async () => {
    const h = harness({
      acquireLease: () => {
        throw new Error('profile busy')
      }
    })
    await expect(h.server.start()).rejects.toThrow('profile busy')
    expect(h.order).toEqual([])
  })

  it('cleans and releases after listener start failure, but retains the lease after unproven cleanup', async () => {
    const failing = harness()
    failing.listener.start.mockRejectedValueOnce(new Error('listen failed'))
    await expect(failing.server.start()).rejects.toThrow('listen failed')
    expect(failing.lease.release).toHaveBeenCalledOnce()

    const unsafe = harness()
    unsafe.listener.start.mockRejectedValueOnce(new Error('listen failed'))
    unsafe.listener.stop.mockRejectedValueOnce(new Error('stop failed'))
    await expect(unsafe.server.start()).rejects.toThrow('listener cleanup failed')
    expect(unsafe.lease.release).not.toHaveBeenCalled()
  })

  it('handles SIGTERM without parent-death behavior and coalesces domain event reconciliation', async () => {
    const h = harness()
    await h.server.start()
    expect(h.signalListeners.has('SIGTERM')).toBe(true)
    expect(h.signalListeners.has('SIGINT')).toBe(true)
    expect(h.signalListeners.has('SIGHUP')).toBe(false)
    h.eventPublish()
    h.eventPublish()
    await new Promise((resolve) => queueMicrotask(resolve))
    expect(h.composition.reconcileProjection).toHaveBeenCalledTimes(1)
    h.signalListeners.get('SIGTERM')?.()
    await h.server.waitForShutdown()
    expect(h.server.phase).toBe('stopped')
  })

  it('awaits asynchronous domain shutdown before releasing the exact profile lease', async () => {
    const h = harness()
    await h.server.start()
    let finish!: () => void
    h.domain.shutdown.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            h.order.push('domain.shutdown.settled')
            resolve()
          }
        })
    )
    const stopping = h.server.stop()
    await vi.waitFor(() => expect(h.domain.shutdown).toHaveBeenCalledOnce())
    expect(h.lease.release).not.toHaveBeenCalled()
    finish()
    await stopping
    expect(h.order.indexOf('domain.shutdown.settled')).toBeLessThan(
      h.order.indexOf('lease.release')
    )
  })
})
