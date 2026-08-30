import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  IN_PROCESS_DESKTOP_HOST_ID,
  ProfileWriterLivePeerError,
  readHostProfileWriterFence,
  writeHostProfileWriterFence
} from '../host-runtime/HostProfileWriterFence'
import { HostNodeProductionServer } from './HostNodeProductionServer'
import { HostNodeInteractionRegistry } from './HostNodeInteractionRegistry'
import { HostPermissionConsentAuthority } from '../host-runtime/HostPermissionConsent'

const profiles: string[] = []

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), 'host-node-writer-fence-'))
  profiles.push(path)
  return path
}

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

function harness(overrides: Record<string, unknown> = {}) {
  const order: string[] = []
  let eventPublish: (() => void) | null = null
  let authenticatedShutdown: (() => Promise<void> | void) | undefined
  let capabilityOffer: readonly string[] = []
  let projectionDirty: (() => void) | null = null
  let interactionTimeoutMs: number | undefined
  let domainProfilePath: string | undefined
  let domainPermissionConsentAuthority: unknown
  let composedGitReadProvider:
    | ((context: unknown, request: unknown) => Promise<unknown> | unknown)
    | undefined
  const lease = {
    path: '/profile',
    assertHeld: vi.fn(() => order.push('lease.assert')),
    release: vi.fn(() => {
      order.push('lease.release')
      return true
    })
  }
  const listener = {
    start: vi.fn(async () => {
      order.push('listener.start')
    }),
    stop: vi.fn(async () => {
      order.push('listener.stop')
    })
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
    supportsWorkspaceGit: false,
    supportsEnsembleSeatControl: false,
    gitRead: vi.fn(),
    registry: { supportsApprovals: false, supportsQuestions: false },
    interactions: new HostNodeInteractionRegistry(),
    shutdown: vi.fn(async () => {
      order.push('domain.shutdown')
    })
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
      domainProfilePath = input.profilePath
      domainPermissionConsentAuthority = input.permissionConsentAuthority
      eventPublish = () => input.events.publish({} as never, {} as never)
      projectionDirty = input.onProjectionDirty ?? null
      interactionTimeoutMs = input.interactionTimeoutMs
      return domain as never
    },
    createComposition: (input) => {
      order.push('composition')
      capabilityOffer = input.hostCapabilityOffer
      composedGitReadProvider = input.gitReadProvider as typeof composedGitReadProvider
      return composition as never
    },
    createListener: (input) => {
      order.push('listener')
      authenticatedShutdown = input.onAuthenticatedShutdown
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
    capabilityOffer: () => capabilityOffer,
    gitReadProvider: () => composedGitReadProvider,
    domainProfilePath: () => domainProfilePath,
    domainPermissionConsentAuthority: () => domainPermissionConsentAuthority,
    authenticatedShutdown: () => authenticatedShutdown,
    eventPublish: () => eventPublish?.(),
    projectionDirty: () => projectionDirty?.(),
    interactionTimeoutMs: () => interactionTimeoutMs
  }
}

describe('HostNodeProductionServer', () => {
  it('keeps Full Access capability off unless an ephemeral authority is explicitly composed', async () => {
    const absent = harness()
    await absent.server.start()
    expect(absent.domainPermissionConsentAuthority()).toBeUndefined()
    await absent.server.stop()

    const authority = new HostPermissionConsentAuthority(Buffer.alloc(32, 7))
    const dispose = vi.spyOn(authority, 'dispose')
    const present = harness({ createPermissionConsentAuthority: () => authority })
    await present.server.start()
    expect(present.domainPermissionConsentAuthority()).toBe(authority)
    await present.server.stop()
    expect(dispose).toHaveBeenCalledOnce()
  })

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

  it('injects the canonical lease path into the domain over caller-supplied options', async () => {
    const h = harness({
      domainOptions: { profilePath: '/caller-controlled' } as never
    })
    await h.server.start()
    expect(h.domainProfilePath()).toBe('/profile')
    await h.server.stop()
  })

  it('offers lifecycle only from production and routes authenticated shutdown through full cleanup', async () => {
    const h = harness()
    await h.server.start()
    expect(h.capabilityOffer()).toContain('host-lifecycle')
    const shutdown = h.authenticatedShutdown()
    expect(shutdown).toBeTypeOf('function')
    await shutdown?.()
    await h.server.waitForShutdown()
    expect(h.server.phase).toBe('stopped')
    expect(h.order.slice(-4)).toEqual([
      'listener.stop',
      'domain.shutdown',
      'composition.shutdown',
      'lease.release'
    ])
  })

  it('derives approvals/questions capability from constructed domain flags', async () => {
    const h = harness()
    await h.server.start()
    expect(h.capabilityOffer()).not.toContain('approvals')
    expect(h.capabilityOffer()).not.toContain('questions')
    await h.server.stop()

    const h2 = harness({
      createDomain: () => {
        return {
          ...h.domain,
          registry: { supportsApprovals: true, supportsQuestions: true }
        } as never
      }
    })
    await h2.server.start()
    expect(h2.capabilityOffer()).toContain('approvals')
    expect(h2.capabilityOffer()).toContain('questions')
  })

  it('offers workspace-git only from a constructed domain with a Git read service', async () => {
    const unavailable = harness()
    await unavailable.server.start()
    expect(unavailable.capabilityOffer()).not.toContain('workspace-git')
    expect(unavailable.gitReadProvider()).toBeUndefined()
    await unavailable.server.stop()

    const available = harness()
    available.domain.supportsWorkspaceGit = true
    available.domain.gitRead.mockResolvedValue({
      scope: 'status',
      branch: 'main',
      head: 'a'.repeat(40),
      files: [],
      truncated: false
    })
    await available.server.start()
    expect(available.capabilityOffer()).toContain('workspace-git')
    const provider = available.gitReadProvider()
    expect(provider).toBeTypeOf('function')
    const context = {
      actor: { actorId: 'tui-1', clientId: 'tui-1', clientClass: 'tui' as const },
      client: { clientId: 'tui-1', clientClass: 'tui' as const, clientVersion: '1.0.0' }
    }
    await expect(
      provider?.(context, { workspaceId: 'workspace-1', scope: 'status' })
    ).resolves.toMatchObject({ scope: 'status' })
    expect(available.domain.gitRead).toHaveBeenCalledWith(context, {
      workspaceId: 'workspace-1',
      scope: 'status'
    })
    await available.server.stop()
  })

  it('offers ensemble only when the constructed domain serves seat control', async () => {
    const unavailable = harness()
    await unavailable.server.start()
    expect(unavailable.capabilityOffer()).not.toContain('ensemble')
    await unavailable.server.stop()

    const available = harness()
    available.domain.supportsEnsembleSeatControl = true
    await available.server.start()
    expect(available.capabilityOffer()).toContain('ensemble')
    await available.server.stop()
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
    expect(unsafe.domain.shutdown).toHaveBeenCalledOnce()
    expect(unsafe.composition.shutdown).toHaveBeenCalledOnce()
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
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
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

  it('builds domain resources only after lease/identity/store and disposes after runtime before release', async () => {
    const h = harness({
      domainOptions: undefined,
      createDomainResources: async () => {
        h.order.push('resources')
        return {
          domainOptions: {} as never,
          dispose: () => {
            h.order.push('resources.dispose')
            return true
          }
        }
      }
    })
    await h.server.start()
    expect(h.order.indexOf('resources')).toBeGreaterThan(h.order.indexOf('store'))
    expect(h.order.indexOf('resources')).toBeGreaterThan(h.order.indexOf('identity'))
    await h.server.stop()
    expect(h.order.indexOf('composition.shutdown')).toBeLessThan(
      h.order.indexOf('resources.dispose')
    )
    expect(h.order.indexOf('resources.dispose')).toBeLessThan(h.order.indexOf('lease.release'))
  })

  it('stops during resource assembly without constructing domain/runtime and still disposes/releases', async () => {
    let resolveResources!: (value: { domainOptions: never; dispose: () => boolean }) => void
    const h = harness({
      domainOptions: undefined,
      createDomainResources: () =>
        new Promise((resolve) => {
          resolveResources = resolve
        })
    })
    const starting = h.server.start()
    await vi.waitFor(() => expect(h.order).toContain('store'))
    const stopping = h.server.stop()
    resolveResources({
      domainOptions: {} as never,
      dispose: () => {
        h.order.push('resources.dispose')
        return true
      }
    })
    await starting
    await stopping
    expect(h.order).not.toContain('domain')
    expect(h.order).not.toContain('composition')
    expect(h.order).toContain('resources.dispose')
    expect(h.lease.release).toHaveBeenCalledOnce()
  })

  it('permits a retry after transient listener cleanup failure while retaining the lease', async () => {
    const h = harness()
    await h.server.start()
    h.listener.stop.mockRejectedValueOnce(new Error('transient stop'))
    await expect(h.server.stop()).rejects.toThrow('listener cleanup failed')
    expect(h.lease.release).not.toHaveBeenCalled()
    await expect(h.server.start()).rejects.toThrow('one-shot')
    await expect(h.server.stop()).resolves.toBeUndefined()
    expect(h.lease.release).toHaveBeenCalledOnce()
  })

  it('rejects a second start after terminal lifecycle state', async () => {
    const h = harness()
    await h.server.start()
    await h.server.stop()
    await expect(h.server.start()).rejects.toThrow('one-shot')
  })

  it('keeps shutdown pending and restores SIGTERM retry after transient cleanup failure', async () => {
    const h = harness()
    await h.server.start()
    h.listener.stop.mockRejectedValueOnce(new Error('transient stop'))
    const waiting = h.server.waitForShutdown()
    h.signalListeners.get('SIGTERM')?.()
    await vi.waitFor(() => expect(h.listener.stop).toHaveBeenCalledOnce())
    expect(h.lease.release).not.toHaveBeenCalled()
    expect(h.signalListeners.has('SIGTERM')).toBe(true)
    let settled = false
    void waiting.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    h.signalListeners.get('SIGTERM')?.()
    await waiting
    expect(h.lease.release).toHaveBeenCalledOnce()
  })

  it('classifies concurrent stop plus startup resource failure as terminal startup failure', async () => {
    let rejectResources!: (error: Error) => void
    const h = harness({
      domainOptions: undefined,
      createDomainResources: () =>
        new Promise((_, reject) => {
          rejectResources = reject
        })
    })
    const starting = h.server.start()
    await vi.waitFor(() => expect(h.order).toContain('store'))
    const stopping = h.server.stop()
    rejectResources(new Error('resource startup failed'))
    await expect(starting).rejects.toThrow('resource startup failed')
    await expect(stopping).rejects.toThrow('resource startup failed')
    expect(h.server.phase).toBe('failed')
    expect(h.signalListeners.has('SIGTERM')).toBe(false)
  })

  it('disposes a malformed resource result before releasing its lease', async () => {
    const dispose = vi.fn(() => true)
    const h = harness({
      domainOptions: undefined,
      createDomainResources: async () => ({ domainOptions: undefined as never, dispose })
    })
    await expect(h.server.start()).rejects.toThrow('domain resources are unavailable')
    expect(dispose).toHaveBeenCalledOnce()
    expect(h.lease.release).toHaveBeenCalledOnce()
  })

  it('constructs the domain with a finite production interaction timeout', async () => {
    const h = harness()
    await h.server.start()
    // The production server passes a finite timeout to the domain's registry.
    // The default is 5 minutes (300_000 ms); the registry must not be undefined.
    expect(h.interactionTimeoutMs()).toBe(300_000)
    expect(h.server.phase).toBe('running')
    await h.server.stop()
  })

  it('wires onProjectionDirty to the real composition reconciler', async () => {
    const h = harness()
    await h.server.start()
    // The server captures onProjectionDirty from the domain input and wires it
    // to composition.reconcileProjection after the composition exists.
    h.projectionDirty()
    await Promise.resolve()
    expect(h.composition.reconcileProjection).toHaveBeenCalled()
    await h.server.stop()
  })

  it('refuses default acquire when a live in-process Desktop owns the profile', async () => {
    const profilePath = profile()
    writeHostProfileWriterFence(profilePath, {
      state: 'host-owned',
      ownership: {
        hostId: IN_PROCESS_DESKTOP_HOST_ID,
        generation: 0,
        cutoverId: 'legacy-in-process',
        pid: process.pid
      }
    })
    const h = harness({ profilePath, acquireLease: undefined })
    await expect(h.server.start()).rejects.toThrow(ProfileWriterLivePeerError)
    expect(h.order).toEqual([])
  })

  it('writes the durable writer fence after a default production acquire', async () => {
    const profilePath = profile()
    const h = harness({ profilePath, acquireLease: undefined })
    await h.server.start()
    expect(readHostProfileWriterFence(profilePath)).toMatchObject({
      state: 'host-owned',
      ownership: {
        hostId: 'host',
        generation: 0,
        cutoverId: 'host-node-production',
        pid: process.pid
      }
    })
    await h.server.stop()
  })
})
