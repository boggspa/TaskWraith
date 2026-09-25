/**
 * Independent Threads M4 slice 12b (design §22.1, §22.4; tests §22.5 items 4
 * and 5): the production server's `TASKWRAITH_HOST_TXN_PERSIST` gate and its
 * catalogue ticket for the transactional persist.
 *
 * - The flag is read ONCE in `startOnce`, from the injected environment, and
 *   only the exact token `1` wires `threadRecordTransaction` into the
 *   standalone composition; the wiring carries the lease path and the real
 *   commit port.
 * - `HostMainComposition` never wires the transaction: pinned at construction
 *   (a persist through it begins with no class, even with the flag set in the
 *   process environment) and at the source (its authority's ports never name
 *   the transaction).
 * - `beginTicket`: an `untracked` publisher ticket is failed `unchanged` and
 *   yields null (§13 MF-1); a tracked one finishes through `finishProjection`
 *   and the mirror and fails through `publisher.fail`; no publisher configured
 *   gives a no-op ticket.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostAuthenticatedClientIdentity,
  type HostCapability,
  type HostCommand
} from '../shared/hostProtocol'
import type { ThreadCatalogueProjection } from '../shared/threadCatalogueTypes'
import type { HostAuthorityCallContext } from '../host-runtime/HostAuthority'
import { TASKWRAITH_HOST_TXN_PERSIST_ENV } from '../host-runtime/HostCommandExecutionClass'
import type { HostDeferredAllowPipeline } from '../host-runtime/HostDeferredAllowPipeline'
import {
  createHostMainComposition,
  type HostMainCompositionInput
} from '../host-runtime/HostMainComposition'
import { HostRuntimeBootstrap } from '../host-runtime/HostRuntimeBootstrap'
import type { HostStandaloneCompositionInput } from '../host-runtime/HostStandaloneComposition'
import type { HostThreadRecordCommitPort } from '../host-runtime/HostThreadRecordTransaction'
import { MainSourceProbe } from '../main/mainSourceProbe.testutil'
import { HostNodeInteractionRegistry } from './HostNodeInteractionRegistry'
import {
  HostNodeProductionServer,
  hostNodeThreadRecordCatalogueTicket
} from './HostNodeProductionServer'

const NOW = '2026-09-25T10:00:00.000Z'
const LEASE_PATH = '/profile'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

/**
 * The production server harness, cut down from HostNodeProductionServer.test.ts
 * to what the transaction gate touches: an injected lease (so no catalogue
 * publisher is built), a stub store, a stub domain and a composition stub that
 * records the input it was composed with.
 */
/**
 * What the server requires of the store before it will wire the transaction:
 * the two members `createHostThreadRecordCommitPort` closes over.
 */
const COMMITTING_STORE = {
  threadRecordState: () => null,
  admitCommittedThreadRecord: () => undefined
}

function harness(
  environment: Readonly<NodeJS.ProcessEnv>,
  options: { store?: Record<string, unknown> } = {}
) {
  const order: string[] = []
  let compositionInput: HostStandaloneCompositionInput | undefined
  const lease = {
    path: LEASE_PATH,
    assertHeld: vi.fn(() => order.push('lease.assert')),
    release: vi.fn(() => true)
  }
  const composition = {
    authority: {},
    session: {},
    perf: {
      snapshot: vi.fn(() => ({})),
      spans: {},
      snapshotFile: null,
      identity: { process: 'host' as const, instanceId: 'host', generation: 0, pid: process.pid }
    },
    recoverQueuedStarts: vi.fn(async () => undefined),
    startProjectionReconciliation: vi.fn(async () => undefined),
    reconcileProjection: vi.fn(async () => undefined),
    subscribeDeltas: vi.fn(() => () => {}),
    shutdown: vi.fn(async () => undefined)
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
    shutdown: vi.fn(async () => undefined)
  }
  const listener = {
    socketPath: '/tmp/twh2-501-test/taskwraith-host-v2.sock',
    discoveryPath: '/profile/taskwraith-host-v2.json',
    startedAt: NOW,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined)
  }
  const server = new HostNodeProductionServer({
    profilePath: LEASE_PATH,
    mode: 'production',
    environment,
    domainOptions: {} as never,
    signalTarget: { once: () => undefined, removeListener: () => undefined },
    acquireLease: () => lease,
    resolveIdentity: () => ({ installId: 'a'.repeat(48), hostId: 'host', hostVersion: '1.0' }),
    createStore: () => (options.store ?? COMMITTING_STORE) as never,
    createDomain: () => domain as never,
    createComposition: (input) => {
      compositionInput = input
      return composition as never
    },
    createListener: () => listener
  })
  return {
    server,
    lease,
    compositionInput: () => compositionInput
  }
}

/** An environment that counts every read of the transaction flag. */
function countingEnvironment(value: string | undefined): {
  environment: Readonly<NodeJS.ProcessEnv>
  reads: () => number
} {
  let reads = 0
  const target: NodeJS.ProcessEnv =
    value === undefined ? {} : { [TASKWRAITH_HOST_TXN_PERSIST_ENV]: value }
  const environment = new Proxy(target, {
    get(object, property, receiver) {
      if (property === TASKWRAITH_HOST_TXN_PERSIST_ENV) reads += 1
      return Reflect.get(object, property, receiver)
    }
  })
  return { environment, reads: () => reads }
}

function projection(threadId: string): ThreadCatalogueProjection {
  return {
    summary: { chatId: threadId } as ThreadCatalogueProjection['summary'],
    recovery: {} as ThreadCatalogueProjection['recovery'],
    revision: 1
  }
}

const COMMIT_PORT_MEMBERS: readonly (keyof HostThreadRecordCommitPort)[] = [
  'current',
  'identity',
  'beginTicket',
  'rename',
  'committed',
  'discard',
  'abandon'
]

describe('HostNodeProductionServer: TASKWRAITH_HOST_TXN_PERSIST (M4 slice 12b)', () => {
  it('reads the flag once from the injected environment, never from process.env', async () => {
    const previous = process.env[TASKWRAITH_HOST_TXN_PERSIST_ENV]
    const counted = countingEnvironment('1')
    const h = harness(counted.environment)
    await h.server.start()
    try {
      expect(counted.reads()).toBe(1)
      expect(process.env[TASKWRAITH_HOST_TXN_PERSIST_ENV]).toBe(previous)
      expect(h.compositionInput()?.threadRecordTransaction).toBeDefined()
    } finally {
      await h.server.stop()
    }
    // Shutdown reads nothing either.
    expect(counted.reads()).toBe(1)
  })

  it('"1" wires threadRecordTransaction with the lease path and the real commit port', async () => {
    const h = harness({ [TASKWRAITH_HOST_TXN_PERSIST_ENV]: '1' })
    await h.server.start()
    try {
      const wired = h.compositionInput()?.threadRecordTransaction
      expect(wired).toBeDefined()
      expect(wired?.profilePath).toBe(LEASE_PATH)
      expect(COMMIT_PORT_MEMBERS.length).toBeGreaterThan(0)
      for (const member of COMMIT_PORT_MEMBERS) {
        expect(wired?.records[member], member).toBeTypeOf('function')
      }
    } finally {
      await h.server.stop()
    }
  })

  it.each([['0'], ['true'], ['on'], [''], [' 1'], [undefined]])(
    'any value but "1" (%j) leaves the transaction unwired',
    async (value) => {
      const counted = countingEnvironment(value)
      const h = harness(counted.environment)
      await h.server.start()
      try {
        expect(h.compositionInput()).toBeDefined()
        expect(h.compositionInput()?.threadRecordTransaction).toBeUndefined()
        expect(counted.reads()).toBe(1)
      } finally {
        await h.server.stop()
      }
    }
  )

  it('"1" over a store that cannot commit a transaction leaves it unwired (landed guard, beyond §22.4)', async () => {
    const h = harness({ [TASKWRAITH_HOST_TXN_PERSIST_ENV]: '1' }, { store: {} })
    await h.server.start()
    try {
      expect(h.compositionInput()).toBeDefined()
      expect(h.compositionInput()?.threadRecordTransaction).toBeUndefined()
    } finally {
      await h.server.stop()
    }
  })

  it('with no publisher configured, the wired beginTicket yields a no-op ticket', async () => {
    const h = harness({ [TASKWRAITH_HOST_TXN_PERSIST_ENV]: '1' })
    await h.server.start()
    try {
      const records = h.compositionInput()?.threadRecordTransaction?.records
      expect(records).toBeDefined()
      const ticket = await records!.beginTicket('thread-1', projection('thread-1'))
      expect(ticket).not.toBeNull()
      expect(() => ticket!.finish()).not.toThrow()
      expect(() => ticket!.fail()).not.toThrow()
    } finally {
      await h.server.stop()
    }
  })
})

describe('hostNodeThreadRecordCatalogueTicket (M4 slice 12b, §22.4)', () => {
  function tracked(chatId: string) {
    return {
      chatId,
      writer: 'host' as const,
      writerId: 'writer-1',
      operationId: 'op-1',
      operationOrdinal: 1,
      sequence: 1,
      epoch: { global: 'g1', chat: 'c1' }
    }
  }

  function fakes(ticketOf: (chatId: string) => ReturnType<typeof tracked> & { untracked?: true }) {
    const publisher = {
      begin: vi.fn((chatId: string) => ticketOf(chatId)),
      finishProjection: vi.fn(() => 'witness-1'),
      fail: vi.fn()
    }
    const mirror = { observe: vi.fn() }
    return { publisher, mirror }
  }

  it('an untracked ticket is failed unchanged and yields null', async () => {
    const { publisher, mirror } = fakes((chatId) => ({ ...tracked(chatId), untracked: true }))
    const beginTicket = hostNodeThreadRecordCatalogueTicket(publisher as never, mirror as never)

    const ticket = await beginTicket('thread-u', projection('thread-u'))

    expect(ticket).toBeNull()
    expect(publisher.begin).toHaveBeenCalledTimes(1)
    expect(publisher.begin).toHaveBeenCalledWith('thread-u')
    expect(publisher.fail).toHaveBeenCalledTimes(1)
    expect(publisher.fail.mock.calls[0]).toEqual([
      expect.objectContaining({ chatId: 'thread-u', untracked: true }),
      'unchanged'
    ])
    expect(publisher.finishProjection).not.toHaveBeenCalled()
    expect(mirror.observe).not.toHaveBeenCalled()
  })

  it('a tracked ticket finishes through finishProjection and the mirror, and fails through publisher.fail', async () => {
    const { publisher, mirror } = fakes((chatId) => tracked(chatId))
    const beginTicket = hostNodeThreadRecordCatalogueTicket(publisher as never, mirror as never)
    const view = projection('thread-t')

    const ticket = await beginTicket('thread-t', view)
    expect(ticket).not.toBeNull()
    expect(publisher.fail).not.toHaveBeenCalled()

    ticket!.finish()
    expect(publisher.finishProjection).toHaveBeenCalledTimes(1)
    expect(publisher.finishProjection.mock.calls[0]).toEqual([
      expect.objectContaining({ chatId: 'thread-t' }),
      view
    ])
    expect(mirror.observe).toHaveBeenCalledTimes(1)
    expect(mirror.observe).toHaveBeenCalledWith(view, 'witness-1')
    expect(publisher.fail).not.toHaveBeenCalled()

    const second = await beginTicket('thread-t', view)
    second!.fail()
    expect(publisher.fail).toHaveBeenCalledTimes(1)
    expect(publisher.fail.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ chatId: 'thread-t' })
    )
    expect(publisher.fail.mock.calls[0]![1]).toBeUndefined()
    expect(publisher.finishProjection).toHaveBeenCalledTimes(1)
  })

  it('with no publisher, gives a no-op ticket', async () => {
    const beginTicket = hostNodeThreadRecordCatalogueTicket(null, null)
    const ticket = await beginTicket('thread-n', projection('thread-n'))
    expect(ticket).not.toBeNull()
    expect(() => ticket!.finish()).not.toThrow()
    expect(() => ticket!.fail()).not.toThrow()
  })
})

describe('HostMainComposition never wires the transaction (M4 slice 12b, §22.1)', () => {
  const ACTOR: HostActorIdentity = {
    actorId: 'actor-m',
    clientId: 'client-m',
    clientClass: 'desktop'
  }
  const CLIENT: HostAuthenticatedClientIdentity = {
    clientId: 'client-m',
    clientClass: 'desktop',
    clientVersion: '1.9.9'
  }
  const CONTEXT: HostAuthorityCallContext = { actor: ACTOR, client: CLIENT }
  const CAPABILITIES: readonly HostCapability[] = [
    'bootstrap',
    'snapshot',
    'deltas',
    'commands',
    'receipts',
    'health',
    'recovery'
  ]

  function persist(commandId: string): HostCommand {
    return {
      type: 'host.command',
      protocolVersion: HOST_PROTOCOL_VERSION,
      commandId,
      idempotencyKey: `${commandId}-key`,
      actor: ACTOR,
      name: 'thread.record.persist',
      target: { threadId: 'thread-main' },
      arguments: {
        transferId: 'transfer-1',
        sha256: 'a'.repeat(64),
        byteLength: 1,
        expectedRevision: 0
      },
      issuedAt: NOW
    }
  }

  it('a persist through the in-process composition begins with no class, even with the flag set in the process environment', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'host-main-txn-'))
    roots.push(userDataPath)
    const executor = vi.fn(async () => ({
      status: 'succeeded' as const,
      resultSummary: 'legacy-persisted'
    }))
    const previous = process.env[TASKWRAITH_HOST_TXN_PERSIST_ENV]
    process.env[TASKWRAITH_HOST_TXN_PERSIST_ENV] = '1'
    let hostDataDir: string
    try {
      const input: HostMainCompositionInput = {
        userDataPath,
        commandExecutor: executor,
        snapshotDonor: () => ({
          health: {
            hostStatus: 'ok',
            connectionPhase: 'live',
            supervised: true,
            freshness: 'live'
          },
          workspaces: [],
          threads: [],
          runs: [],
          missions: [],
          rounds: [],
          participants: [],
          providers: [],
          questions: [],
          approvals: [],
          schedules: [],
          usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
          artifacts: [],
          warnings: []
        }),
        authorityEvaluator: () => ({ decision: 'allowed' }),
        healthProvider: () => ({
          hostStatus: 'ok',
          connectionPhase: 'live',
          supervised: true,
          freshness: 'live'
        }),
        host: { hostId: 'host-main', hostVersion: '1.9.9' },
        hostCapabilityOffer: CAPABILITIES,
        pipeline: { execute: vi.fn() } as unknown as HostDeferredAllowPipeline,
        now: () => NOW
      }
      const composition = createHostMainComposition(input)
      hostDataDir = composition.hostDataDir
      try {
        const result = await composition.authority.command(CONTEXT, persist('main-persist'))
        expect(result).toMatchObject({
          ok: true,
          value: { status: 'succeeded', resultSummary: 'legacy-persisted' }
        })
      } finally {
        await composition.shutdown()
      }
    } finally {
      if (previous === undefined) delete process.env[TASKWRAITH_HOST_TXN_PERSIST_ENV]
      else process.env[TASKWRAITH_HOST_TXN_PERSIST_ENV] = previous
    }
    expect(executor).toHaveBeenCalledTimes(1)
    const reopened = new HostRuntimeBootstrap({ hostDataDir })
    const found = reopened.receiptStore.getByCommandId('main-persist', ACTOR)
    expect(found.kind).toBe('found')
    if (found.kind !== 'found') return
    expect(found.receipt.status).toBe('succeeded')
    expect(found.receipt).not.toHaveProperty('commandClass')
  })

  it('its authority’s ports never name the transaction', () => {
    const probe = new MainSourceProbe(
      'HostMainComposition.ts',
      new URL('../host-runtime/HostMainComposition.ts', import.meta.url)
    )
    const constructions = probe.construction('AppStoreHostAuthority')
    expect(constructions).toHaveLength(1)
    const options = probe.argText(constructions[0]!, 0)
    expect(options).toContain('ports:')
    expect(options).not.toContain('threadRecordTransaction')
    expect(probe.source.text).toContain('AppStoreHostAuthority')
    expect(probe.source.text).not.toContain('HostThreadRecordTransaction')
    expect(probe.source.text).not.toContain(TASKWRAITH_HOST_TXN_PERSIST_ENV)
  })
})
