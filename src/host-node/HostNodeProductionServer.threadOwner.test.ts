/**
 * The production Host builds its `thread.owner` service from its own
 * readings: the thread log authority switch once, from the injected
 * environment; the transactional persist switch as the Host already read it;
 * the welcome's boot epoch as the grants' incarnation; and the store's and
 * the domain's own facts for the Host's full copy and its runs.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { THREAD_LOG_AUTHORITY_ENV } from '../host-shared/thread-log/ThreadLogAuthoritySwitch'
import { TASKWRAITH_HOST_TXN_PERSIST_ENV } from '../host-runtime/HostCommandExecutionClass'
import type { HostLocalServerOptions } from '../host-runtime/HostLocalServer'
import type { HostThreadOwnerService } from '../host-runtime/HostThreadOwnerService'
import { HostNodeInteractionRegistry } from './HostNodeInteractionRegistry'
import { HostNodeProductionServer } from './HostNodeProductionServer'

const TEMPORARY_PREFIX = 'host-node-thread-owner-'
const BOOT_EPOCH = 'f'.repeat(64)

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  if (
    directory === temporary ||
    path.dirname(directory) !== temporary ||
    !path.basename(directory).startsWith(TEMPORARY_PREFIX) ||
    path.basename(directory).length <= TEMPORARY_PREFIX.length
  ) {
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  }
  rmSync(directory, { recursive: true, force: true })
}

const profiles: string[] = []
afterEach(() => {
  for (const profile of profiles.splice(0)) removeTemporaryDirectory(profile)
})

/** An environment that counts each read of the two switches. */
function counted(environment: Record<string, string>) {
  const reads = { authority: 0, transactional: 0 }
  const proxy = new Proxy(environment, {
    get(target, property, receiver) {
      if (property === THREAD_LOG_AUTHORITY_ENV) reads.authority += 1
      if (property === TASKWRAITH_HOST_TXN_PERSIST_ENV) reads.transactional += 1
      return Reflect.get(target, property, receiver)
    }
  })
  return { environment: proxy as NodeJS.ProcessEnv, reads }
}

/**
 * The production server with an injected lease, store, domain, composition
 * and listener, as `HostNodeProductionServer.txnPersist.test.ts` cuts it
 * down; the listener records the input it is built with.
 */
function harness(environment: NodeJS.ProcessEnv) {
  const profile = mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  profiles.push(profile)
  let listenerInput: HostLocalServerOptions | undefined
  const revisions = new Map<string, number>()
  const hostRuns = new Set<string>()
  const store = {
    threadRecordState: vi.fn((threadId: string) =>
      revisions.has(threadId) ? { revision: revisions.get(threadId)!, identity: {}, key: '' } : null
    ),
    admitCommittedThreadRecord: () => undefined
  }
  const composition = {
    authority: {},
    session: {},
    perf: {
      snapshot: vi.fn(() => ({})),
      spans: {},
      snapshotFile: null,
      identity: {
        process: 'host' as const,
        instanceId: 'host',
        generation: 0,
        pid: process.pid,
        bootEpoch: BOOT_EPOCH
      }
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
    hasRuntimeWorkForThread: vi.fn((threadId: string) => hostRuns.has(threadId)),
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
  const server = new HostNodeProductionServer({
    profilePath: profile,
    mode: 'production',
    environment,
    domainOptions: {} as never,
    signalTarget: { once: () => undefined, removeListener: () => undefined },
    acquireLease: () => ({ path: profile, assertHeld: () => undefined, release: () => true }),
    resolveIdentity: () => ({ installId: 'a'.repeat(48), hostId: 'host', hostVersion: '1.0' }),
    createStore: () => store as never,
    createDomain: () => domain as never,
    createComposition: () => composition as never,
    createListener: (input) => {
      listenerInput = input
      return {
        socketPath: path.join(profile, 'host.sock'),
        discoveryPath: path.join(profile, 'host.json'),
        startedAt: '2026-10-05T10:00:00.000Z',
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined)
      } as never
    }
  })
  return {
    server,
    revisions,
    hostRuns,
    owners: () => listenerInput?.threadOwners as HostThreadOwnerService | undefined
  }
}

const claim = (threadId: string, revision: number, claimId = 1) => ({
  action: 'claim' as const,
  threadId,
  writerId: 'desk-1',
  claimId,
  baseRevision: revision,
  headRevision: revision
})

describe('HostNodeProductionServer: thread.owner', () => {
  it('hands its listener a service that takes no claims while the switch is off', async () => {
    const { environment, reads } = counted({})
    const h = harness(environment)
    await h.server.start()
    try {
      expect(h.owners()?.mode).toBe('off')
      expect(await h.owners()!.answer(1, claim('thread-1', 3))).toMatchObject({
        reply: { granted: false, reason: 'disabled' }
      })
      expect(reads.authority).toBe(1)
    } finally {
      await h.server.stop()
    }
  })

  it('on, grants from the store’s full copy and the domain’s runs, under the welcome’s epoch', async () => {
    const { environment, reads } = counted({ [THREAD_LOG_AUTHORITY_ENV]: '1' })
    const h = harness(environment)
    await h.server.start()
    try {
      const owners = h.owners()!
      expect(owners.mode).toBe('on')
      h.revisions.set('thread-1', 3)
      h.revisions.set('thread-2', 8)
      h.hostRuns.add('thread-2')
      expect(await owners.answer(1, claim('thread-1', 3))).toMatchObject({
        reply: { granted: true, epoch: { host: BOOT_EPOCH, grant: 1 } }
      })
      expect(await owners.answer(1, claim('thread-2', 8, 2))).toMatchObject({
        reply: { granted: false, reason: 'host_run_active', revision: 8 }
      })
      expect(await owners.answer(1, claim('thread-3', 0, 3))).toMatchObject({
        reply: { granted: false, reason: 'host_behind', revision: null }
      })
      // Each switch was read once, at start.
      expect(reads).toEqual({ authority: 1, transactional: 1 })
    } finally {
      await h.server.stop()
    }
  })

  it('on, takes no claims on a Host started with transactional persists', async () => {
    const { environment, reads } = counted({
      [THREAD_LOG_AUTHORITY_ENV]: '1',
      [TASKWRAITH_HOST_TXN_PERSIST_ENV]: '1'
    })
    const h = harness(environment)
    await h.server.start()
    try {
      expect(h.owners()?.mode).toBe('off-txn-persist')
      expect(reads).toEqual({ authority: 1, transactional: 1 })
    } finally {
      await h.server.stop()
    }
  })
})
