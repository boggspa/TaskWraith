/**
 * Independent Threads M4 slice 14b (design §24.3; tests owed, items 3 and 4):
 * the production server's boot order around transaction recovery.
 *
 * - `startOnce` builds the composition, then AWAITS
 *   `composition.recoverTransactions()` before `recoverQueuedStarts`, the
 *   public window seed, projection reconciliation and the listener (a
 *   recording `createComposition` / `createListener`). A report writes one
 *   stderr line; null writes none.
 * - `ThreadCatalogueHostRecovery` is constructed after recovery (R1-M1,
 *   §12.2): a real catalogue is too heavy here, so a source probe of
 *   `startOnce` pins the order and throws if either subject is gone.
 * - A rejected recovery fails `start()`; the listener is never created and
 *   nothing after recovery runs.
 * - The server passes the lease path as the composition's `profilePath`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import ts from 'typescript'

import type { HostStandaloneCompositionInput } from '../host-runtime/HostStandaloneComposition'
import type { HostTransactionRecoveryAction } from '../host-runtime/HostTransactionManifest'
import type { HostTransactionRecoveryReport } from '../host-runtime/HostTransactionRecovery'
import { MainSourceProbe } from '../main/mainSourceProbe.testutil'
import { HostNodeInteractionRegistry } from './HostNodeInteractionRegistry'
import { HostNodeProductionServer } from './HostNodeProductionServer'

const TIMEOUT = 5_000
const NOW = '2026-09-26T10:00:00.000Z'
const LEASE_PATH = '/profile'

const REPORT: HostTransactionRecoveryReport = {
  decisions: new Map<string, HostTransactionRecoveryAction>([
    [
      'cmd-a',
      {
        action: 'complete_at_position',
        row: 'D3',
        position: { generation: 6, cursor: 4 },
        markPublished: true
      }
    ],
    ['cmd-b', { action: 'reset_and_complete', row: 'D1' }],
    ['cmd-c', { action: 'none' }]
  ]),
  counts: { complete_at_position: 1, reset_and_complete: 1, none: 1 },
  reset: { generation: 7, cursor: 1 },
  anchorsReleased: ['cmd-a', 'cmd-b'],
  artifactsRemoved: ['cmd-x.record.json'],
  indeterminate: new Map()
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * The production server harness, cut down as in the txnPersist suite: an
 * injected lease (no catalogue is built), a stub store and domain, and a
 * composition stub whose boot steps record their order.
 */
function harness(
  options: {
    recoverTransactions?: () => Promise<HostTransactionRecoveryReport | null>
  } = {}
) {
  const order: string[] = []
  let compositionInput: HostStandaloneCompositionInput | undefined
  const lease = {
    path: LEASE_PATH,
    assertHeld: vi.fn(() => undefined),
    release: vi.fn(() => true)
  }
  const seeded = deferred<{ kind: 'abandoned'; report: null; reason: string }>()
  const composition = {
    authority: {},
    session: {},
    perf: {
      snapshot: vi.fn(() => ({})),
      spans: {},
      snapshotFile: null,
      identity: { process: 'host' as const, instanceId: 'host', generation: 0, pid: process.pid }
    },
    previousExitClean: false,
    recoverTransactions: vi.fn(async () => {
      order.push('recover.transactions')
      return options.recoverTransactions ? options.recoverTransactions() : null
    }),
    recoverQueuedStarts: vi.fn(async () => {
      order.push('queued.recovery')
    }),
    startPublicWindowSeed: vi.fn(() => {
      order.push('seed.start')
      return { seeded: seeded.promise }
    }),
    startProjectionReconciliation: vi.fn(async () => {
      order.push('reconcile.start')
    }),
    reconcileProjection: vi.fn(async () => undefined),
    subscribeDeltas: vi.fn(() => () => {}),
    shutdown: vi.fn(async () => {
      order.push('composition.shutdown')
    })
  }
  const domain = {
    setupExecutor: { execute: vi.fn() },
    snapshotDonor: vi.fn(() => ({})),
    evaluateAuthority: vi.fn(() => ({ decision: 'deny', reason: 'test' })),
    executeCommand: vi.fn(),
    acknowledgeQueuedComposerSend: vi.fn(),
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
    runAdmissionOccupancy: vi.fn(() => ({ inflight: 0, queued: 0 })),
    shutdown: vi.fn(async () => {
      order.push('domain.shutdown')
    })
  }
  const listener = {
    socketPath: '/tmp/twh2-501-test/taskwraith-host-v2.sock',
    discoveryPath: '/profile/taskwraith-host-v2.json',
    startedAt: NOW,
    start: vi.fn(async () => {
      order.push('listener.start')
    }),
    stop: vi.fn(async () => {
      order.push('listener.stop')
    })
  }
  const createListener = vi.fn(() => {
    order.push('listener.create')
    return listener
  })
  const server = new HostNodeProductionServer({
    profilePath: LEASE_PATH,
    mode: 'production',
    environment: {},
    domainOptions: {} as never,
    signalTarget: { once: () => undefined, removeListener: () => undefined },
    acquireLease: () => lease,
    resolveIdentity: () => ({ installId: 'a'.repeat(48), hostId: 'host', hostVersion: '1.0' }),
    createStore: () => ({}) as never,
    createDomain: () => domain as never,
    createComposition: (input) => {
      order.push('composition')
      compositionInput = input
      return composition as never
    },
    createListener
  })
  return {
    server,
    order,
    composition,
    listener,
    createListener,
    seeded,
    compositionInput: () => compositionInput
  }
}

/** Every stderr write during `run`, as text. */
async function capturingStderr<T>(run: () => Promise<T>): Promise<{ result: T; writes: string[] }> {
  const writes: string[] = []
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: string | Uint8Array
  ) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write)
  try {
    const result = await run()
    return { result, writes }
  } finally {
    spy.mockRestore()
  }
}

const recoveryLines = (writes: string[]): string[] =>
  writes.filter((text) => text.includes('taskwraith-host:') && /recover/i.test(text))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('HostNodeProductionServer.startOnce: boot recovery order (M4 slice 14b, §24.3)', () => {
  it(
    'awaits recoverTransactions right after the composition, before queued-start recovery, the seed, reconciliation and the listener',
    async () => {
      const h = harness({ recoverTransactions: async () => null })
      await h.server.start()
      try {
        const at = (step: string): number => {
          const index = h.order.indexOf(step)
          expect(index, `${step} in ${JSON.stringify(h.order)}`).toBeGreaterThanOrEqual(0)
          return index
        }
        expect(h.composition.recoverTransactions).toHaveBeenCalledTimes(1)
        expect(at('recover.transactions')).toBe(at('composition') + 1)
        expect(at('queued.recovery')).toBe(at('recover.transactions') + 1)
        for (const later of [
          'seed.start',
          'reconcile.start',
          'listener.create',
          'listener.start'
        ]) {
          expect(at(later), later).toBeGreaterThan(at('queued.recovery'))
        }
        expect(at('listener.create')).toBeGreaterThan(at('reconcile.start'))
        expect(at('listener.create')).toBeGreaterThan(at('seed.start'))
        expect(at('listener.start')).toBe(at('listener.create') + 1)
        expect(h.order.at(-1)).toBe('listener.start')
        expect(h.server.phase).toBe('running')
      } finally {
        h.seeded.resolve({ kind: 'abandoned', report: null, reason: 'test' })
        await h.server.stop()
      }
    },
    TIMEOUT
  )

  it(
    'recovery is awaited, not merely started: while it is pending nothing after it runs and no listener exists',
    async () => {
      const gate = deferred<HostTransactionRecoveryReport | null>()
      const h = harness({ recoverTransactions: () => gate.promise })
      const starting = h.server.start()
      let started = false
      void starting.then(() => {
        started = true
      })
      // Bounded: two macrotasks are more than the synchronous steps need.
      await macrotask()
      await macrotask()

      expect(h.composition.recoverTransactions).toHaveBeenCalledTimes(1)
      expect(h.order).toContain('recover.transactions')
      expect(h.composition.recoverQueuedStarts).not.toHaveBeenCalled()
      expect(h.composition.startPublicWindowSeed).not.toHaveBeenCalled()
      expect(h.composition.startProjectionReconciliation).not.toHaveBeenCalled()
      expect(h.createListener).not.toHaveBeenCalled()
      expect(started).toBe(false)
      expect(h.server.phase).toBe('starting')

      gate.resolve(null)
      await starting
      try {
        expect(started).toBe(true)
        expect(h.composition.recoverQueuedStarts).toHaveBeenCalledTimes(1)
        expect(h.createListener).toHaveBeenCalledTimes(1)
        expect(h.listener.start).toHaveBeenCalledTimes(1)
      } finally {
        h.seeded.resolve({ kind: 'abandoned', report: null, reason: 'test' })
        await h.server.stop()
      }
    },
    TIMEOUT
  )

  it(
    'a report writes one stderr line naming the recovery; null writes none',
    async () => {
      const withReport = harness({ recoverTransactions: async () => REPORT })
      const reported = await capturingStderr(() => withReport.server.start())
      try {
        const lines = recoveryLines(reported.writes)
        expect(lines).toHaveLength(1)
        expect(lines[0]!.endsWith('\n')).toBe(true)
        expect(lines[0]!.slice(0, -1)).not.toContain('\n')
        // Counts, the reset, anchors released and artifacts removed are all on it.
        expect(lines[0]).toContain('complete_at_position')
        expect(lines[0]).toContain('reset_and_complete')
        expect(lines[0]).toMatch(/7/)
        expect(lines[0]).toMatch(/anchor/i)
        expect(lines[0]).toMatch(/artifact/i)
      } finally {
        withReport.seeded.resolve({ kind: 'abandoned', report: null, reason: 'test' })
        await withReport.server.stop()
      }

      const withNull = harness({ recoverTransactions: async () => null })
      const quiet = await capturingStderr(() => withNull.server.start())
      try {
        expect(recoveryLines(quiet.writes)).toEqual([])
      } finally {
        withNull.seeded.resolve({ kind: 'abandoned', report: null, reason: 'test' })
        await withNull.server.stop()
      }
    },
    TIMEOUT
  )

  it(
    'passes the lease path as the composition’s profilePath',
    async () => {
      const h = harness({ recoverTransactions: async () => null })
      await h.server.start()
      try {
        expect(h.compositionInput()?.profilePath).toBe(LEASE_PATH)
      } finally {
        h.seeded.resolve({ kind: 'abandoned', report: null, reason: 'test' })
        await h.server.stop()
      }
    },
    TIMEOUT
  )

  it(
    'a rejected recovery fails start(): the listener is never created and nothing after recovery runs',
    async () => {
      const failure = new Error('injected recovery failure')
      const h = harness({ recoverTransactions: async () => Promise.reject(failure) })
      const captured = await capturingStderr(async () => {
        await expect(h.server.start()).rejects.toBe(failure)
      })
      expect(recoveryLines(captured.writes)).toEqual([])

      expect(h.server.phase).toBe('failed')
      expect(h.createListener).not.toHaveBeenCalled()
      expect(h.listener.start).not.toHaveBeenCalled()
      expect(h.composition.recoverQueuedStarts).not.toHaveBeenCalled()
      expect(h.composition.startPublicWindowSeed).not.toHaveBeenCalled()
      expect(h.composition.startProjectionReconciliation).not.toHaveBeenCalled()
      // Cleanup still releases what was built before recovery.
      expect(h.composition.shutdown).toHaveBeenCalledTimes(1)
      expect(h.order).toContain('composition.shutdown')
      await expect(h.server.waitForShutdown()).rejects.toBe(failure)
    },
    TIMEOUT
  )
})

/**
 * `startOnce` is a class method, which `MainSourceProbe.fn` does not locate.
 * Throws when the class or the method is gone, so a rename cannot leave the
 * order claim asserting nothing.
 */
function methodBody(probe: MainSourceProbe, className: string, methodName: string): ts.Node {
  let found: ts.Node | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === methodName &&
          member.body
        ) {
          found = member.body
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(probe.source)
  if (!found) {
    throw new Error(
      `${probe.source.fileName} declares no method \`${className}.${methodName}\`. It was renamed, ` +
        'moved or deleted — update this test to the claim that replaced it rather than deleting the assertion.'
    )
  }
  return found
}

describe('HostNodeProductionServer.startOnce: source order (M4 slice 14b, R1-M1 §12.2)', () => {
  const probe = new MainSourceProbe(
    'HostNodeProductionServer.ts',
    new URL('./HostNodeProductionServer.ts', import.meta.url)
  )
  const startOnce = methodBody(probe, 'HostNodeProductionServer', 'startOnce')

  it(
    'recoverTransactions is awaited once inside startOnce, after the composition is built',
    () => {
      const recoveries = probe.callsTo(startOnce, 'recoverTransactions')
      expect(recoveries).toHaveLength(1)
      const recovery = recoveries[0]!
      expect(ts.isAwaitExpression(recovery.parent), 'recoverTransactions() must be awaited').toBe(
        true
      )
      expect(probe.text(recovery.expression)).toContain('composition')
      // The composition is assigned before recovery is called on it.
      const assignments = probe.assignmentsTo(startOnce, 'this.composition')
      expect(assignments).toHaveLength(1)
      expect(assignments[0]).toContain('createComposition')
      let compositionAssignedAt = -1
      const visit = (node: ts.Node): void => {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          probe.text(node.left).replace(/\s+/g, '') === 'this.composition'
        ) {
          compositionAssignedAt = node.getStart(probe.source)
        }
        ts.forEachChild(node, visit)
      }
      visit(startOnce)
      expect(compositionAssignedAt).toBeGreaterThanOrEqual(0)
      expect(recovery.getStart(probe.source)).toBeGreaterThan(compositionAssignedAt)
    },
    TIMEOUT
  )

  it(
    'ThreadCatalogueHostRecovery is constructed after recoverTransactions and before recoverQueuedStarts',
    () => {
      const constructions = probe.construction('ThreadCatalogueHostRecovery', startOnce)
      expect(constructions).toHaveLength(1)
      const constructedAt = constructions[0]!.getStart(probe.source)

      const recoveries = probe.callsTo(startOnce, 'recoverTransactions')
      expect(recoveries).toHaveLength(1)
      expect(constructedAt).toBeGreaterThan(recoveries[0]!.getStart(probe.source))

      const queued = probe.callsTo(startOnce, 'recoverQueuedStarts')
      expect(queued).toHaveLength(1)
      expect(constructedAt).toBeLessThan(queued[0]!.getStart(probe.source))
    },
    TIMEOUT
  )

  it(
    'the rest of the boot follows recovery in source order: queued starts, the seed, reconciliation, then the listener',
    () => {
      const startOf = (name: string): number => {
        const calls = probe.callsTo(startOnce, name)
        expect(calls, name).toHaveLength(1)
        return calls[0]!.getStart(probe.source)
      }
      const recovery = startOf('recoverTransactions')
      const queued = startOf('recoverQueuedStarts')
      const seed = startOf('startPublicWindowSeed')
      const reconcile = startOf('startProjectionReconciliation')
      // The mirror has a `start()` too: only the listener's counts here.
      const listenerStarts = probe
        .callsTo(startOnce, 'start')
        .filter((call) => probe.text(call.expression).replace(/\s+/g, '') === 'this.listener.start')
      expect(listenerStarts).toHaveLength(1)
      const listenerStart = listenerStarts[0]!.getStart(probe.source)
      expect(queued).toBeGreaterThan(recovery)
      expect(seed).toBeGreaterThan(queued)
      expect(reconcile).toBeGreaterThan(queued)
      expect(listenerStart).toBeGreaterThan(seed)
      expect(listenerStart).toBeGreaterThan(reconcile)
    },
    TIMEOUT
  )
})
