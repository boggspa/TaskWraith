/**
 * Independent Threads M4 slice 13a (design §23.2, tests 1–7): fence
 * participation through the standalone composition and its authority, over
 * real stores and the in-process `prepareHostThreadRecord`.
 *
 * With the transaction wired, every observer holds the commit gate's observer
 * mode: legacy windows (the projection FIFO), controls across both their
 * captures, client snapshots and reconciler passes. A transaction's commit
 * (the records port's `rename`) is the committer. The two never overlap:
 * 1. a legacy `thread.select` does not capture while a commit is held;
 * 2. a commit waits for a held `run.cancel` to finish;
 * 3. a client snapshot waits for a held commit, and a commit for a held
 *    snapshot;
 * 4. a reconciler pass that calls `snapshot` completes with a committer
 *    queued at the gate;
 * 5. a continuation that outlived its window is fenced anew;
 * 6. once shutdown has closed the gate, windows still run and shutdown
 *    completes;
 * 7. flag off: no fence, and commands and snapshots complete as before.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostAuthenticatedClientIdentity,
  type HostCommand
} from '../shared/hostProtocol'
import {
  AppStoreHostAuthority,
  createHostStandaloneAuthorityActivationPermit,
  type AppStoreHostAuthorityPorts,
  type AppStoreHostAuthoritySnapshotDonorFamilies,
  type AppStoreHostAuthorityThreadRecordTransaction
} from './AppStoreHostAuthority'
import type { HostAuthorityCallContext } from './HostAuthority'
import type { HostCommitFence } from './HostCommitFence'
import { HostProfileDomainStore } from './HostProfileDomainStore'
import { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
import { createHostScopeLedger } from './HostScopeLedger'
import {
  createHostStandaloneComposition,
  type HostStandaloneComposition,
  type HostStandaloneCompositionInput
} from './HostStandaloneComposition'
import { prepareHostThreadRecord } from './HostThreadRecordPrepare'
import {
  createHostThreadRecordCommitPort,
  type HostThreadRecordCommitPort
} from './HostThreadRecordTransaction'
import { publishHostThreadRecordTransfer } from './HostThreadRecordTransfer'

const NOW_MS = 1_760_000_000_000
const NOW_ISO = new Date(NOW_MS).toISOString()
const BOOT_EPOCH = 'd'.repeat(64)
const THREAD_ID = 'thread-1'

const ACTOR: HostActorIdentity = {
  actorId: 'actor-1',
  clientId: 'client-1',
  clientClass: 'desktop'
}
const CLIENT: HostAuthenticatedClientIdentity = {
  clientId: 'client-1',
  clientClass: 'desktop',
  clientVersion: '1.0.0'
}
const CONTEXT: HostAuthorityCallContext = { actor: ACTOR, client: CLIENT }

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolves 'pending' when the promise has not settled within a short grace period. */
async function settledWithin<T>(promise: Promise<T>, ms = 40): Promise<T | 'pending'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

const roots: string[] = []
const compositions: HostStandaloneComposition[] = []
afterEach(async () => {
  while (compositions.length > 0) {
    const composition = compositions.pop()!
    await composition.shutdown().catch(() => undefined)
  }
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

type LooseRecord = Record<string, unknown>

function baseRecord(overrides: LooseRecord = {}): LooseRecord {
  return {
    appChatId: THREAD_ID,
    scope: 'global',
    title: 'Base',
    archived: false,
    createdAt: 10,
    messages: [
      { id: 'm1', role: 'user', content: 'hello there', timestamp: '2026-09-01T00:00:00.000Z' },
      { id: 'm2', role: 'assistant', content: 'general', timestamp: '2026-09-01T00:00:01.000Z' }
    ],
    runs: [
      {
        runId: `run-${THREAD_ID}`,
        provider: 'codex',
        status: 'success',
        startedAt: '2026-09-01T00:00:00.000Z',
        endedAt: '2026-09-01T00:00:01.000Z'
      }
    ],
    updatedAt: 20,
    ...overrides
  }
}

function families(): AppStoreHostAuthoritySnapshotDonorFamilies {
  return {
    health: { hostStatus: 'ok', connectionPhase: 'live', supervised: false, freshness: 'live' },
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
    usage: { availability: 'unavailable' },
    artifacts: [],
    warnings: []
  }
}

type Descriptor = { transferId: string; sha256: string; byteLength: number }

interface Harness {
  profilePath: string
  chatPath: string
  store: HostProfileDomainStore
  /** Every step the harness observed, in order. */
  log: string[]
  /** The records port, with its commit observed and holdable after the rename. */
  records: HostThreadRecordCommitPort
  renameHold: { current: Deferred | null }
  renames: string[]
  /** The executor, holdable per command name. */
  executorHold: Map<string, Deferred>
  /** Runs inside the executor (so inside the window's async context), once. */
  executorHook: { current: (() => void) | null }
  executorCalls: HostCommand[]
  /** The snapshot donor, holdable and observable. */
  donorHold: { current: Deferred | null }
  donorCalls: number
  donorHook: { current: (() => Promise<void>) | null }
  tickets: number
  prepared: number
  base: Omit<HostStandaloneCompositionInput, 'threadRecordTransaction'>
  publish(record: LooseRecord, transferId: string): Descriptor
  seed(): void
  /** Compose with the transaction wired (flag on) or not (flag off). */
  compose(flag: 'on' | 'off'): HostStandaloneComposition
}

function harness(): Harness {
  const profilePath = mkdtempSync(join(tmpdir(), 'host-standalone-fence-'))
  roots.push(profilePath)
  const runtimePath = join(profilePath, 'host-data')
  const store = new HostProfileDomainStore({
    profilePath,
    authority: { assertProfileAuthority: () => undefined },
    now: () => NOW_MS
  })
  const h: Harness = {
    profilePath,
    chatPath: join(profilePath, 'chats', `${THREAD_ID}.json`),
    store,
    log: [],
    records: undefined as unknown as HostThreadRecordCommitPort,
    renameHold: { current: null },
    renames: [],
    executorHold: new Map(),
    executorHook: { current: null },
    executorCalls: [],
    donorHold: { current: null },
    donorCalls: 0,
    donorHook: { current: null },
    tickets: 0,
    prepared: 0,
    base: undefined as unknown as Harness['base'],
    publish: (record, transferId) =>
      publishHostThreadRecordTransfer({ profilePath, transferId, record }),
    seed: () => {
      store.persistThreadRecord({ threadId: THREAD_ID, record: baseRecord(), expectedRevision: 0 })
    },
    compose: (flag) => {
      const composition = createHostStandaloneComposition({
        ...h.base,
        ...(flag === 'on'
          ? {
              threadRecordTransaction: {
                profilePath,
                records: h.records,
                prepare: async (input) => {
                  h.prepared += 1
                  h.log.push(`prepare:${input.descriptor.transferId}`)
                  return prepareHostThreadRecord(input)
                }
              }
            }
          : {})
      })
      compositions.push(composition)
      return composition
    }
  }
  const real = createHostThreadRecordCommitPort({
    store,
    profilePath,
    beginTicket: async () => {
      h.tickets += 1
      return { finish: () => undefined, fail: () => undefined }
    }
  })
  h.records = {
    ...real,
    // The first step under the committer hold, and the artifact's move.
    commitRename: (artifactPath, threadId, expectedKey) => {
      h.log.push('commit:rename')
      const outcome = real.commitRename(artifactPath, threadId, expectedKey)
      if (outcome === 'renamed') h.renames.push(threadId)
      return outcome
    },
    // Still under the hold, after the rename: the seam a held commit waits at.
    syncChatsDirectory: async (threadId) => {
      h.log.push('commit:sync:start')
      if (h.renameHold.current) await h.renameHold.current.promise
      await real.syncChatsDirectory(threadId)
      h.log.push('commit:sync:done')
    }
  }
  h.base = {
    runtimePath,
    lease: { assertHeld: () => undefined },
    host: { hostId: 'standalone-host', hostVersion: '1.0.0' },
    hostCapabilityOffer: ['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts', 'health'],
    bootEpochFactory: () => BOOT_EPOCH,
    now: () => NOW_ISO,
    snapshotDonor: async () => {
      h.donorCalls += 1
      h.log.push('donor:start')
      if (h.donorHold.current) await h.donorHold.current.promise
      if (h.donorHook.current) {
        const hook = h.donorHook.current
        h.donorHook.current = null
        await hook()
      }
      h.log.push('donor:done')
      return families()
    },
    authorityEvaluator: () => ({ decision: 'allowed' }),
    commandExecutor: async (command) => {
      h.executorCalls.push(command)
      h.log.push(`executor:${command.name}:start`)
      if (h.executorHook.current) {
        const hook = h.executorHook.current
        h.executorHook.current = null
        hook()
      }
      const hold = h.executorHold.get(command.name)
      if (hold) await hold.promise
      h.log.push(`executor:${command.name}:done`)
      return { status: 'succeeded', resultSummary: `${command.name}-done` }
    },
    healthProvider: () => ({
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: false,
      freshness: 'live'
    })
  }
  return h
}

function command(
  commandId: string,
  name: HostCommand['name'],
  args: Record<string, unknown> = {}
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId,
    idempotencyKey: `${commandId}-key`,
    actor: ACTOR,
    name,
    target: { threadId: THREAD_ID },
    arguments: args,
    issuedAt: NOW_ISO
  }
}

function persist(commandId: string, descriptor: Descriptor, expectedRevision: number): HostCommand {
  return command(commandId, 'thread.record.persist', { ...descriptor, expectedRevision })
}

/** Start a persist whose commit will hold inside the gate, after its rename; resolves once held. */
async function holdCommit(
  h: Harness,
  composition: HostStandaloneComposition,
  commandId: string,
  revision: number
): Promise<{ running: ReturnType<typeof composition.authority.command>; release: () => void }> {
  const descriptor = h.publish(
    baseRecord({ persistenceRevision: revision, title: `Stamped ${revision}` }),
    `transfer-${commandId}`
  )
  h.renameHold.current = deferred()
  const hold = h.renameHold.current
  const running = composition.authority.command(
    CONTEXT,
    persist(commandId, descriptor, revision - 1)
  )
  await vi.waitFor(() => expect(h.log).toContain('commit:sync:start'))
  return {
    running,
    release: () => {
      h.renameHold.current = null
      hold.resolve()
    }
  }
}

/** Publish a transfer and issue its persist; the commit proceeds unheld. */
function issuePersist(
  h: Harness,
  composition: HostStandaloneComposition,
  commandId: string,
  revision: number
): ReturnType<typeof composition.authority.command> {
  const descriptor = h.publish(
    baseRecord({ persistenceRevision: revision, title: `Stamped ${revision}` }),
    `transfer-${commandId}`
  )
  return composition.authority.command(CONTEXT, persist(commandId, descriptor, revision - 1))
}

function succeeded(result: Awaited<ReturnType<HostStandaloneComposition['authority']['command']>>) {
  expect(result).toMatchObject({ ok: true, value: { status: 'succeeded' } })
}

describe('HostStandaloneComposition: fence participation (M4 slice 13a)', () => {
  it('1. a legacy thread.select does not capture while a transaction holds its commit', async () => {
    const h = harness()
    h.seed()
    const composition = h.compose('on')
    const commit = await holdCommit(h, composition, 'p-held', 1)
    const donorCallsBefore = h.donorCalls

    const selecting = composition.authority.command(CONTEXT, command('s-1', 'thread.select'))
    await pause(40)
    // Neither the before-capture nor the executor ran under the held commit.
    expect(h.donorCalls).toBe(donorCallsBefore)
    expect(h.executorCalls).toEqual([])
    expect(await settledWithin(selecting)).toBe('pending')

    commit.release()
    succeeded(await commit.running)
    succeeded(await selecting)
    expect(h.executorCalls.map((c) => c.commandId)).toEqual(['s-1'])
    expect(h.donorCalls).toBeGreaterThan(donorCallsBefore)
    // The commit finished before the window's first capture.
    expect(h.log.length).toBeGreaterThan(0)
    expect(h.log.indexOf('commit:sync:done')).toBeLessThan(h.log.indexOf('donor:start'))
    expect(h.renames).toEqual([THREAD_ID])
    expect(h.store.threadRecordState(THREAD_ID)?.revision).toBe(1)
  })

  it('2. a control holds the observer across both captures: a commit waits for a held run.cancel', async () => {
    const h = harness()
    h.seed()
    const composition = h.compose('on')
    const hold = deferred()
    h.executorHold.set('run.cancel', hold)
    const cancelling = composition.authority.command(CONTEXT, command('c-1', 'run.cancel'))
    await vi.waitFor(() => expect(h.log).toContain('executor:run.cancel:start'))
    // One capture so far: the control is between its before and after captures.
    expect(h.donorCalls).toBe(1)

    const persisting = issuePersist(h, composition, 'p-1', 1)
    await vi.waitFor(() => expect(h.prepared).toBe(1))
    await pause(40)
    // Prepared, but not committed: the commit is queued behind the control.
    expect(h.log).toContain('prepare:transfer-p-1')
    expect(h.log).not.toContain('commit:rename')
    expect(h.renames).toEqual([])
    expect(await settledWithin(persisting)).toBe('pending')

    hold.resolve()
    succeeded(await cancelling)
    succeeded(await persisting)
    expect(h.renames).toEqual([THREAD_ID])
    // The after-capture finished before the commit's first gate-held step.
    expect(h.log.length).toBeGreaterThan(0)
    const afterCapture = h.log.lastIndexOf('donor:done')
    expect(afterCapture).toBeGreaterThan(h.log.indexOf('executor:run.cancel:done'))
    expect(afterCapture).toBeLessThan(h.log.indexOf('commit:rename'))
  })

  it('3a. a client snapshot waits for a held commit', async () => {
    const h = harness()
    h.seed()
    const composition = h.compose('on')
    const commit = await holdCommit(h, composition, 'p-held', 1)
    const donorCallsBefore = h.donorCalls

    const snapshotting = composition.authority.snapshot(CONTEXT)
    await pause(40)
    expect(h.donorCalls).toBe(donorCallsBefore)
    expect(await settledWithin(snapshotting)).toBe('pending')

    commit.release()
    succeeded(await commit.running)
    const snapshot = await snapshotting
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    expect(h.donorCalls).toBe(donorCallsBefore + 1)
    // The donor read ran only after the commit's rename landed.
    expect(h.log.length).toBeGreaterThan(0)
    expect(h.log.indexOf('commit:sync:done')).toBeLessThan(h.log.indexOf('donor:start'))
  })

  it('3b. a commit waits for a held client snapshot', async () => {
    const h = harness()
    h.seed()
    const composition = h.compose('on')
    h.donorHold.current = deferred()
    const donorHold = h.donorHold.current
    const snapshotting = composition.authority.snapshot(CONTEXT)
    await vi.waitFor(() => expect(h.donorCalls).toBe(1))
    h.donorHold.current = null

    const persisting = issuePersist(h, composition, 'p-1', 1)
    await vi.waitFor(() => expect(h.prepared).toBe(1))
    await pause(40)
    expect(h.log).not.toContain('commit:rename')
    expect(h.renames).toEqual([])
    expect(await settledWithin(persisting)).toBe('pending')

    donorHold.resolve()
    const snapshot = await snapshotting
    expect(snapshot.ok).toBe(true)
    succeeded(await persisting)
    expect(h.renames).toEqual([THREAD_ID])
    expect(h.log.length).toBeGreaterThan(0)
    expect(h.log.indexOf('donor:done')).toBeLessThan(h.log.indexOf('commit:rename'))
  })

  it('4. a reconciler pass calling snapshot completes with a committer queued at the gate', async () => {
    const h = harness()
    h.seed()
    const composition = h.compose('on')
    await composition.startProjectionReconciliation()
    expect(h.donorCalls).toBe(1)

    // Inside the pass's nested snapshot (the donor runs under the pass's
    // fence), a committer arrives and queues; a further nested snapshot must
    // still run directly rather than queue behind that writer.
    let persisting: ReturnType<typeof issuePersist> | null = null
    let nestedSnapshot: Awaited<
      ReturnType<HostStandaloneComposition['authority']['snapshot']>
    > | null = null
    h.donorHook.current = async () => {
      persisting = issuePersist(h, composition, 'p-queued', 1)
      await vi.waitFor(() => expect(h.tickets).toBe(1))
      await pause(40)
      expect(h.log).not.toContain('commit:rename')
      h.log.push('nested-snapshot:start')
      const nested = composition.authority.snapshot(CONTEXT)
      const settled = await settledWithin(nested, 500)
      if (settled === 'pending')
        throw new Error('the nested snapshot deadlocked behind the queued committer')
      nestedSnapshot = settled
      h.log.push('nested-snapshot:done')
    }
    const pass = await composition.reconcileProjection()
    expect(pass.kind).not.toBe('stopped')
    expect(pass.kind).not.toBe('unavailable')
    expect(nestedSnapshot).not.toBeNull()
    expect(nestedSnapshot!.ok).toBe(true)
    expect(persisting).not.toBeNull()
    succeeded(await persisting!)
    expect(h.renames).toEqual([THREAD_ID])
    // The committer's first gate-held step ran only after the pass's nested
    // snapshot and its donor read had both completed.
    expect(h.log.length).toBeGreaterThan(0)
    expect(h.log.indexOf('nested-snapshot:done')).toBeLessThan(h.log.indexOf('commit:rename'))
    expect(h.log.lastIndexOf('donor:done')).toBeLessThan(h.log.indexOf('commit:rename'))
    await composition.stopProjectionReconciliation()
  })

  it('5. a continuation that outlived its window is fenced anew: it waits for a held commit', async () => {
    const h = harness()
    h.seed()
    const composition = h.compose('on')
    const go = deferred()
    let continuation: ReturnType<HostStandaloneComposition['authority']['snapshot']> | null = null
    // The select's executor runs inside the window's fence. A timer it
    // schedules, and the promise chain registered from that timer, carry the
    // window's lease in their async context, as a provider stream started
    // inside a legacy window does; by the time it runs, that lease is stale.
    h.executorHook.current = () => {
      setTimeout(() => {
        continuation = go.promise.then(() => {
          h.log.push('continuation:snapshot:start')
          return composition.authority.snapshot(CONTEXT)
        })
      }, 0)
    }
    succeeded(await composition.authority.command(CONTEXT, command('s-1', 'thread.select')))
    await vi.waitFor(() => expect(continuation).not.toBeNull())
    const donorCallsAfterWindow = h.donorCalls
    expect(donorCallsAfterWindow).toBe(2)

    const commit = await holdCommit(h, composition, 'p-held', 1)
    go.resolve()
    await pause(40)
    expect(h.log).toContain('continuation:snapshot:start')
    // Fenced anew: the stale lease does not let it read under the held commit.
    expect(h.donorCalls).toBe(donorCallsAfterWindow)
    expect(await settledWithin(continuation!)).toBe('pending')

    commit.release()
    succeeded(await commit.running)
    const late = await continuation!
    expect(late.ok).toBe(true)
    expect(h.donorCalls).toBe(donorCallsAfterWindow + 1)
    expect(h.log.length).toBeGreaterThan(0)
    expect(h.log.indexOf('commit:sync:done')).toBeLessThan(h.log.lastIndexOf('donor:start'))
  })

  it('6. once shutdown has closed the gate, windows run unfenced and shutdown completes', async () => {
    const h = harness()
    h.seed()
    const descriptor = h.publish(
      baseRecord({ persistenceRevision: 1, title: 'Held' }),
      'transfer-held'
    )
    const prepareHold = deferred()
    const composition = createHostStandaloneComposition({
      ...h.base,
      threadRecordTransaction: {
        profilePath: h.profilePath,
        records: h.records,
        prepare: async (input) => {
          h.prepared += 1
          await prepareHold.promise
          return prepareHostThreadRecord(input)
        }
      }
    })
    compositions.push(composition)
    const before = readFileSync(h.chatPath)
    const running = composition.authority.command(CONTEXT, persist('p-held', descriptor, 0))
    await vi.waitFor(() => expect(h.prepared).toBe(1))

    let stopped = false
    const stopping = composition.shutdown().then(() => {
      stopped = true
    })
    await pause(20)
    // Shutdown waits for the in-flight transaction; the gate is closed.
    expect(stopped).toBe(false)

    // A legacy window and a client snapshot still run to completion.
    const selecting = composition.authority.command(CONTEXT, command('s-1', 'thread.select'))
    const snapshotting = composition.authority.snapshot(CONTEXT)
    succeeded(await selecting)
    const snapshot = await snapshotting
    expect(snapshot.ok).toBe(true)
    expect(h.executorCalls.map((c) => c.commandId)).toEqual(['s-1'])
    expect(stopped).toBe(false)

    prepareHold.resolve()
    const held = await running
    expect(held).toMatchObject({
      ok: true,
      value: { status: 'failed', errorCode: 'host_shutting_down' }
    })
    await stopping
    expect(stopped).toBe(true)
    expect(readFileSync(h.chatPath).equals(before)).toBe(true)
    expect(h.renames).toEqual([])
  })

  it('7. flag off: no transaction, no fence; commands and snapshots complete as before', async () => {
    const h = harness()
    h.seed()
    const composition = h.compose('off')
    const descriptor = h.publish(
      baseRecord({ persistenceRevision: 1, title: 'Legacy' }),
      'transfer-legacy'
    )

    // A held control never delays a persist: without the transaction the
    // persist is a legacy command in the FIFO, and no gate exists to wait on.
    const hold = deferred()
    h.executorHold.set('run.cancel', hold)
    const cancelling = composition.authority.command(CONTEXT, command('c-1', 'run.cancel'))
    await vi.waitFor(() => expect(h.log).toContain('executor:run.cancel:start'))
    const persisting = composition.authority.command(CONTEXT, persist('p-legacy', descriptor, 0))
    const snapshotting = composition.authority.snapshot(CONTEXT)
    const legacy = await persisting
    expect(legacy).toMatchObject({
      ok: true,
      value: { status: 'succeeded', resultSummary: 'thread.record.persist-done' }
    })
    const snapshot = await snapshotting
    expect(snapshot.ok).toBe(true)
    hold.resolve()
    succeeded(await cancelling)
    expect(h.executorCalls.map((c) => c.name)).toEqual(['run.cancel', 'thread.record.persist'])
    expect(h.prepared).toBe(0)
    expect(h.tickets).toBe(0)
    expect(h.renames).toEqual([])
    expect(h.log.filter((line) => line.startsWith('commit:'))).toEqual([])
  })
})

describe('AppStoreHostAuthority: the fence port pairs with the transaction port (M4 slice 13a)', () => {
  function authorityPorts(
    hostDataDir: string,
    extra: Partial<AppStoreHostAuthorityPorts>
  ): AppStoreHostAuthorityPorts {
    return {
      runtime: new HostRuntimeBootstrap({ hostDataDir }),
      snapshotDonor: () => families(),
      authorityEvaluator: () => ({ decision: 'allowed' }),
      commandExecutor: () => ({ status: 'succeeded' }),
      healthProvider: () => ({
        hostStatus: 'ok',
        connectionPhase: 'live',
        supervised: false,
        freshness: 'live'
      }),
      onShutdown: () => undefined,
      ...extra
    }
  }

  function construct(extra: Partial<AppStoreHostAuthorityPorts>): AppStoreHostAuthority {
    const hostDataDir = mkdtempSync(join(tmpdir(), 'appstore-host-auth-fence-'))
    roots.push(hostDataDir)
    return new AppStoreHostAuthority({
      mode: 'standalone',
      activationPermit: createHostStandaloneAuthorityActivationPermit({
        assertHeld: () => undefined
      }),
      ports: authorityPorts(hostDataDir, extra)
    })
  }

  const transactionPort: AppStoreHostAuthorityThreadRecordTransaction = {
    ledger: createHostScopeLedger({ hostIncarnation: BOOT_EPOCH }),
    available: () => true,
    create: () => ({
      execute: async () => ({ kind: 'failed', errorCode: 'thread_record_persist_failed' })
    })
  }
  const passThrough: HostCommitFence = (_label, operation) => operation()

  it('refuses the transaction port without a fence', () => {
    expect(() => construct({ threadRecordTransaction: transactionPort })).toThrow(
      'AppStoreHostAuthority requires complete injected ports'
    )
  })

  it('refuses a fence without the transaction port', () => {
    expect(() => construct({ fence: passThrough })).toThrow(
      'AppStoreHostAuthority requires complete injected ports'
    )
  })

  it('refuses a fence that is not a function', () => {
    expect(() =>
      construct({
        threadRecordTransaction: transactionPort,
        fence: {} as unknown as HostCommitFence
      })
    ).toThrow('AppStoreHostAuthority requires complete injected ports')
  })

  it('accepts the pair, and neither alone is required (flag off)', () => {
    expect(
      construct({ threadRecordTransaction: transactionPort, fence: passThrough })
    ).toBeInstanceOf(AppStoreHostAuthority)
    expect(construct({})).toBeInstanceOf(AppStoreHostAuthority)
  })
})
