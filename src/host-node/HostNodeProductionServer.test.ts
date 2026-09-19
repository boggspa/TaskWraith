import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  IN_PROCESS_DESKTOP_HOST_ID,
  ProfileWriterLivePeerError,
  readHostProfileWriterFence,
  writeHostProfileWriterFence
} from '../host-runtime/HostProfileWriterFence'
import { HOST_PERF_SNAPSHOT_PATH_ENV, HostNodeProductionServer } from './HostNodeProductionServer'
import {
  TASKWRAITH_HOST_QUEUED_START_ENV,
  type HostNodeDomainPortsOptions
} from './HostNodeDomainPorts'
import type { HostStandaloneCompositionInput } from '../host-runtime/HostStandaloneComposition'
import { HostNodeInteractionRegistry } from './HostNodeInteractionRegistry'
import { ThreadCatalogueHostRunWindow } from './ThreadCatalogueHostRunWindow'
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

function harness(
  overrides: Record<string, unknown> = {},
  harnessOptions: { compositionBootEpoch?: string } = {}
) {
  const order: string[] = []
  let eventPublish: (() => void) | null = null
  let authenticatedShutdown: (() => Promise<void> | void) | undefined
  let capabilityOffer: readonly string[] = []
  let projectionDirty: (() => void) | null = null
  let interactionTimeoutMs: number | undefined
  let domainProfilePath: string | undefined
  let domainPermissionConsentAuthority: unknown
  let listenerPayloadVersion: string | undefined
  let listenerInput: Record<string, unknown> | undefined
  let composedGitReadProvider:
    | ((context: unknown, request: unknown) => Promise<unknown> | unknown)
    | undefined
  let composedPerf: unknown
  let domainWorkSpanRecorder: unknown
  let composedResolveReceiptSpanChatId: unknown
  let domainHostQueuedStartEnabled: HostNodeDomainPortsOptions['hostQueuedStartEnabled']
  let domainQueuedStartOnStarting: HostNodeDomainPortsOptions['queuedStartOnStarting']
  let domainQueuedStartOnStarted: HostNodeDomainPortsOptions['queuedStartOnStarted']
  let domainQueuedStartOnDispatchSettled: HostNodeDomainPortsOptions['queuedStartOnDispatchSettled']
  let compositionQueuedComposerSend: HostStandaloneCompositionInput['queuedComposerSend']
  let compositionQueuedStartStartingBind: HostStandaloneCompositionInput['queuedStartStartingBind']
  let compositionQueuedStartStartedBind: HostStandaloneCompositionInput['queuedStartStartedBind']
  let compositionQueuedStartDispatchSettledBind: HostStandaloneCompositionInput['queuedStartDispatchSettledBind']
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
    // Mirrors the real HostStandaloneCompositionPerf surface. The production
    // server reads perf.identity to thread the boot epoch to the listener, so
    // a mock without it would not just fail — it would fail everywhere at
    // once and hide which behaviour actually broke.
    perf: {
      snapshot: vi.fn(() => ({})),
      spans: {},
      snapshotFile: null,
      identity: {
        process: 'host' as const,
        instanceId: 'host',
        generation: 0,
        pid: process.pid,
        ...(harnessOptions.compositionBootEpoch === undefined
          ? {}
          : { bootEpoch: harnessOptions.compositionBootEpoch })
      }
    },
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
    acknowledgeQueuedComposerSend: vi.fn(async () => ({
      status: 'succeeded' as const,
      resultSummary: 'run_queued'
    })),
    providerStatuses: vi.fn(async () => []),
    providerOffers: vi.fn(),
    providerAuthFlows: vi.fn(async () => []),
    providerAuthStatus: vi.fn(),
    threadHistory: vi.fn(),
    historySince: vi.fn(),
    supportsWorkspaceGit: false,
    supportsEnsembleSeatControl: false,
    gitRead: vi.fn(),
    registry: {
      supportsApprovals: false,
      supportsQuestions: false,
      providerIds: [],
      refreshOffers: vi.fn(async () => undefined)
    },
    interactions: new HostNodeInteractionRegistry(),
    shutdown: vi.fn(async () => {
      order.push('domain.shutdown')
    })
  }
  const signalListeners = new Map<string, () => void>()
  const server = new HostNodeProductionServer({
    profilePath: '/profile',
    mode: 'production',
    payloadVersion: `sha256:${'d'.repeat(64)}`,
    createThreadCatalogue: () =>
      ({
        ready: Promise.resolve(),
        query: async (q: { method: string }) =>
          q.method === 'changes'
            ? { reset: false, changes: [], position: { incarnation: 'test', sequence: 0 } }
            : q.method === 'list'
              ? { entries: [], next: null, coverage: 'complete', repairPending: [] }
              : true,
        dispose: async () => undefined
      }) as never,
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
      domainWorkSpanRecorder = input.workSpanRecorder
      domainHostQueuedStartEnabled = input.hostQueuedStartEnabled
      domainQueuedStartOnStarting = input.queuedStartOnStarting
      domainQueuedStartOnStarted = input.queuedStartOnStarted
      domainQueuedStartOnDispatchSettled = input.queuedStartOnDispatchSettled
      return domain as never
    },
    createComposition: (input) => {
      order.push('composition')
      capabilityOffer = input.hostCapabilityOffer
      composedGitReadProvider = input.gitReadProvider as typeof composedGitReadProvider
      composedPerf = input.perf
      composedResolveReceiptSpanChatId = input.resolveReceiptSpanChatId
      compositionQueuedComposerSend = input.queuedComposerSend
      compositionQueuedStartStartingBind = input.queuedStartStartingBind
      compositionQueuedStartStartedBind = input.queuedStartStartedBind
      compositionQueuedStartDispatchSettledBind = input.queuedStartDispatchSettledBind
      return composition as never
    },
    createListener: (input) => {
      order.push('listener')
      authenticatedShutdown = input.onAuthenticatedShutdown
      listenerPayloadVersion = input.payloadVersion
      listenerInput = input as unknown as Record<string, unknown>
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
    compositionPerf: () => composedPerf,
    domainWorkSpanRecorder: () => domainWorkSpanRecorder,
    composedResolveReceiptSpanChatId: () => composedResolveReceiptSpanChatId,
    domainProfilePath: () => domainProfilePath,
    domainPermissionConsentAuthority: () => domainPermissionConsentAuthority,
    listenerPayloadVersion: () => listenerPayloadVersion,
    listenerInput: () => listenerInput,
    authenticatedShutdown: () => authenticatedShutdown,
    eventPublish: () => eventPublish?.(),
    projectionDirty: () => projectionDirty?.(),
    interactionTimeoutMs: () => interactionTimeoutMs,
    domainHostQueuedStartEnabled: () => domainHostQueuedStartEnabled,
    domainQueuedStartOnStarting: () => domainQueuedStartOnStarting,
    domainQueuedStartOnStarted: () => domainQueuedStartOnStarted,
    domainQueuedStartOnDispatchSettled: () => domainQueuedStartOnDispatchSettled,
    compositionQueuedComposerSend: () => compositionQueuedComposerSend,
    compositionQueuedStartStartingBind: () => compositionQueuedStartStartingBind,
    compositionQueuedStartStartedBind: () => compositionQueuedStartStartedBind,
    compositionQueuedStartDispatchSettledBind: () => compositionQueuedStartDispatchSettledBind
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
    expect(h.listenerPayloadVersion()).toBe(`sha256:${'d'.repeat(64)}`)
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

  it('prewarms dynamic provider catalogs before composing the first projection', async () => {
    const h = harness()
    const refreshOffers = vi.fn(async (providerId: string) => {
      h.order.push(`offers:${providerId}`)
    })
    const registry = h.domain.registry as unknown as {
      providerIds: readonly string[]
      refreshOffers: (providerId: string) => Promise<unknown>
    }
    registry.providerIds = ['ollama', 'antigravity']
    registry.refreshOffers = refreshOffers

    await h.server.start()

    expect(refreshOffers).toHaveBeenCalledWith('ollama')
    expect(refreshOffers).toHaveBeenCalledWith('antigravity')
    expect(h.order.indexOf('offers:antigravity')).toBeLessThan(h.order.indexOf('composition'))
    await h.server.stop()
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

  it('shares one Host recorder between domain persist and composition receipts', async () => {
    const h = harness()
    await h.server.start()
    const perf = h.compositionPerf() as { instrumentation?: { spans?: unknown } }
    expect(h.domainWorkSpanRecorder()).toBe(perf.instrumentation?.spans)
    const resolve = h.composedResolveReceiptSpanChatId()
    if (typeof resolve !== 'function') {
      throw new Error('resolveReceiptSpanChatId was not wired')
    }
    const pending = h.domain.interactions.register({
      id: 'appr-1',
      kind: 'approval',
      providerId: 'codex',
      runId: 'run-1',
      threadId: 'thread-light',
      title: 'Shell',
      summary: 'run ls',
      createdAt: '2026-09-10T00:00:00.000Z'
    })
    pending.catch(() => undefined)
    expect(resolve({ target: { kind: 'approval', id: 'appr-1' } })).toBe('thread-light')
    expect(resolve({ target: { kind: 'thread', id: 'thread-1' } })).toBeUndefined()
    await h.domain.interactions.shutdown()
    await h.server.stop()
  })

  it('arms the Host perf snapshot file only when the environment names a destination', async () => {
    const instrumentation = expect.objectContaining({
      spans: expect.objectContaining({ record: expect.any(Function) })
    })
    const absent = harness({ environment: {} })
    await absent.server.start()
    expect(absent.compositionPerf()).toEqual({ instrumentation })
    expect(
      (absent.compositionPerf() as { snapshotFile?: unknown } | undefined)?.snapshotFile
    ).toBeUndefined()
    await absent.server.stop()

    const blank = harness({ environment: { [HOST_PERF_SNAPSHOT_PATH_ENV]: '   ' } })
    await blank.server.start()
    expect(blank.compositionPerf()).toEqual({ instrumentation })
    expect(
      (blank.compositionPerf() as { snapshotFile?: unknown } | undefined)?.snapshotFile
    ).toBeUndefined()
    await blank.server.stop()

    const relative = harness({
      environment: { [HOST_PERF_SNAPSHOT_PATH_ENV]: 'perf/host-snapshot.json' }
    })
    await relative.server.start()
    expect(relative.compositionPerf()).toEqual({
      instrumentation,
      snapshotFile: { path: join('/profile', 'perf', 'host-snapshot.json') }
    })
    await relative.server.stop()

    const absolute = harness({
      environment: { [HOST_PERF_SNAPSHOT_PATH_ENV]: join(tmpdir(), 'host-snapshot.json') }
    })
    await absolute.server.start()
    expect(absolute.compositionPerf()).toEqual({
      instrumentation,
      snapshotFile: { path: join(tmpdir(), 'host-snapshot.json') }
    })
    await absolute.server.stop()
  })

  // The perf snapshot writer and the welcome must name the SAME incarnation.
  // If the server minted or forwarded a second value, a collector reading the
  // file and a client reading the welcome would disagree about which Host they
  // are attached to — worse than neither having an epoch, because both look
  // authoritative.
  it('threads the composition boot epoch to the listener, from the same identity the writer stamps', async () => {
    const epoch = 'f'.repeat(64)
    const h = harness({}, { compositionBootEpoch: epoch })
    await h.server.start()
    expect(h.listenerInput()?.bootEpoch).toBe(epoch)
    await h.server.stop()
  })

  it('omits bootEpoch from the listener when the composition minted none', async () => {
    const h = harness()
    await h.server.start()
    // Absent, not undefined: HostLocalServer refuses a present-but-invalid
    // epoch, and an explicitly-undefined key would still read as "supplied"
    // to any future exact-shape assertion on the listener input.
    expect(Object.prototype.hasOwnProperty.call(h.listenerInput() ?? {}, 'bootEpoch')).toBe(false)
    await h.server.stop()
  })

  it('passes one injected-environment queued-start gate to Domain and composition without mutating process.env', async () => {
    const previous = process.env[TASKWRAITH_HOST_QUEUED_START_ENV]
    const on = harness({
      environment: { [TASKWRAITH_HOST_QUEUED_START_ENV]: '1' }
    })
    await on.server.start()
    expect(process.env[TASKWRAITH_HOST_QUEUED_START_ENV]).toBe(previous)
    expect(on.domainHostQueuedStartEnabled()).toBe(true)
    expect(on.domainQueuedStartOnStarting()).toBeTypeOf('function')
    expect(on.domainQueuedStartOnStarted()).toBeTypeOf('function')
    expect(on.domainQueuedStartOnDispatchSettled()).toBeTypeOf('function')
    expect(on.compositionQueuedComposerSend()).toBeTypeOf('function')
    expect(on.compositionQueuedStartStartingBind()).toBeTypeOf('function')
    expect(on.compositionQueuedStartStartedBind()).toBeTypeOf('function')
    expect(on.compositionQueuedStartDispatchSettledBind()).toBeTypeOf('function')

    const starting = vi.fn()
    const started = vi.fn()
    const settled = vi.fn()
    on.compositionQueuedStartStartingBind()?.(starting)
    on.compositionQueuedStartStartedBind()?.(started)
    on.compositionQueuedStartDispatchSettledBind()?.(settled)
    const view = {
      commandId: 'cmd-started',
      threadId: 'thread-1',
      fingerprint: 'fp',
      phase: 'started' as const,
      startedEvidence: true,
      terminalOutcome: null,
      cancelLatched: false,
      dispatched: true,
      providerRunBegan: true,
      providerWorkEnded: false
    }
    const startingView = {
      ...view,
      phase: 'starting' as const,
      startedEvidence: false
    }
    on.domainQueuedStartOnStarting()?.(startingView)
    expect(starting).toHaveBeenCalledTimes(1)
    expect(starting).toHaveBeenCalledWith(startingView)
    on.domainQueuedStartOnStarted()?.(view)
    expect(started).toHaveBeenCalledTimes(1)
    expect(started).toHaveBeenCalledWith(view)
    const result = { status: 'succeeded' as const, resultSummary: 'run_started' }
    await on.domainQueuedStartOnDispatchSettled()?.('cmd-started', 'thread-1', result)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledWith('cmd-started', result)

    const context = {
      actor: { actorId: 'tui-1', clientId: 'tui-1', clientClass: 'tui' as const },
      client: { clientId: 'tui-1', clientClass: 'tui' as const, clientVersion: '1.0.0' }
    }
    const send = {
      type: 'host.command' as const,
      commandId: 'cmd-started',
      name: 'composer.send' as const
    }
    await on.compositionQueuedComposerSend()?.(send as never, context as never)
    expect(on.domain.acknowledgeQueuedComposerSend).toHaveBeenCalledWith(context, send, {
      id: 'tui-1'
    })
    await on.server.stop()
  })

  it('refreshes the exact queued-start run before dispatching successful settlement', async () => {
    const refreshFor = vi
      .spyOn(ThreadCatalogueHostRunWindow.prototype, 'refreshFor')
      .mockResolvedValue(true)
    const h = harness({
      profilePath: profile(),
      acquireLease: undefined,
      environment: { [TASKWRAITH_HOST_QUEUED_START_ENV]: '1' }
    })
    let started = false
    try {
      await h.server.start()
      started = true
      const settled = vi.fn()
      h.compositionQueuedStartDispatchSettledBind()?.(settled)
      const succeeded = { status: 'succeeded' as const, resultSummary: 'run_started' }

      await h.domainQueuedStartOnDispatchSettled()?.('cmd-refresh', 'thread-refresh', succeeded)

      expect(refreshFor).toHaveBeenCalledTimes(1)
      expect(refreshFor).toHaveBeenCalledWith('thread-refresh', 'cmd-refresh')
      expect(settled).toHaveBeenCalledWith('cmd-refresh', succeeded)

      const failed = { status: 'failed' as const, errorCode: 'run_not_started' }
      await h.domainQueuedStartOnDispatchSettled()?.('cmd-failed', 'thread-failed', failed)
      expect(refreshFor).toHaveBeenCalledTimes(1)
      expect(settled).toHaveBeenCalledWith('cmd-failed', failed)
    } finally {
      if (started) await h.server.stop()
      refreshFor.mockRestore()
    }
  })

  it('omits queued-start callbacks and ports when the injected environment is off', async () => {
    const previous = process.env[TASKWRAITH_HOST_QUEUED_START_ENV]
    const off = harness({
      environment: { [TASKWRAITH_HOST_QUEUED_START_ENV]: 'true' }
    })
    await off.server.start()
    expect(process.env[TASKWRAITH_HOST_QUEUED_START_ENV]).toBe(previous)
    expect(off.domainHostQueuedStartEnabled()).toBe(false)
    expect(off.domainQueuedStartOnStarting()).toBeUndefined()
    expect(off.domainQueuedStartOnStarted()).toBeUndefined()
    expect(off.domainQueuedStartOnDispatchSettled()).toBeUndefined()
    expect(off.compositionQueuedComposerSend()).toBeUndefined()
    expect(off.compositionQueuedStartStartingBind()).toBeUndefined()
    expect(off.compositionQueuedStartStartedBind()).toBeUndefined()
    expect(off.compositionQueuedStartDispatchSettledBind()).toBeUndefined()
    await off.server.stop()

    const empty = harness({ environment: {} })
    await empty.server.start()
    expect(empty.domainHostQueuedStartEnabled()).toBe(false)
    expect(empty.compositionQueuedComposerSend()).toBeUndefined()
    expect(empty.domainQueuedStartOnStarting()).toBeUndefined()
    expect(empty.domainQueuedStartOnStarted()).toBeUndefined()
    await empty.server.stop()
  })

  it('production cleanup awaits domain shutdown before composition, and composition drains publication before flush', () => {
    const serverSrc = readFileSync(join(__dirname, 'HostNodeProductionServer.ts'), 'utf8')
    const cleanupStart = serverSrc.indexOf('private async cleanup(): Promise<void> {')
    const cleanup = serverSrc.slice(
      cleanupStart,
      serverSrc.indexOf('private installSignals', cleanupStart)
    )
    expect(cleanup.indexOf('await this.domain?.shutdown()')).toBeGreaterThan(-1)
    expect(cleanup.indexOf('await this.domain?.shutdown()')).toBeLessThan(
      cleanup.indexOf('await this.composition?.shutdown()')
    )
    expect(cleanup.indexOf('await this.composition?.shutdown()')).toBeLessThan(
      cleanup.indexOf('this.hostRunWindow?.dispose()')
    )

    const compositionSrc = readFileSync(
      join(__dirname, '../host-runtime/HostStandaloneComposition.ts'),
      'utf8'
    )
    const shutdownStart = compositionSrc.indexOf('const shutdown = async (): Promise<void> => {')
    const shutdown = compositionSrc.slice(
      shutdownStart,
      compositionSrc.indexOf('const authority = new AppStoreHostAuthority')
    )
    expect(shutdown.indexOf('await drainQueuedStartPublication()')).toBeGreaterThan(-1)
    expect(shutdown.indexOf('await drainQueuedStartPublication()')).toBeLessThan(
      shutdown.indexOf('runtime.flush()')
    )
  })
})
