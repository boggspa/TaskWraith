/**
 * Independent Threads M4 slice 12a (design §21): the transactional persist
 * over the real stores. Every test builds a real `HostTransactionLog`,
 * `HostDeltaStore`, `HostCommandReceiptStore`, `HostPublicWindowIndex`,
 * scope ledger and commit gate in one temp data directory, and a real
 * `HostProfileDomainStore` profile behind `createHostThreadRecordCommitPort`.
 * `prepare` is the in-process `prepareHostThreadRecord`; the catalogue
 * ticket and the legacy executor are stubbed. Failures, holds and ordering
 * are injected through seams: test doubles that delegate to the real port
 * and throw, hold or substitute at one chosen call.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { withPeopleDonorMutationGate } from '../host-shared/thread-catalogue/PeopleDonorMutationGate'
import type { HostCursorPosition } from '../shared/hostProtocol'
import { HostCommandReceiptStore, type HostCommandReceiptRecord } from './HostCommandReceiptStore'
import { createHostCommitGate, type HostCommitGate } from './HostCommitGate'
import type { HostCommandExecutionResult } from './HostCommandExecutionResult'
import { HostDeltaStore, HOST_DELTA_JOURNAL_FILENAME } from './HostDeltaStore'
import type { HostDomainEffectDto } from './HostDomainDeltaPublisher'
import {
  decodeHostProfileThread,
  HostProfileDomainStore,
  type HostProfileThreadSummary
} from './HostProfileDomainStore'
import { HostPublicWindowIndex, type HostPublicWindowTransaction } from './HostPublicWindowIndex'
import {
  createHostScopeLedger,
  HOST_SCOPE_EPOCH_STALE_MESSAGE,
  hostThreadScope,
  type HostScopeEpoch,
  type HostScopeLedger
} from './HostScopeLedger'
import { modelHostThreadRecordEffects } from './HostThreadRecordEffectModel'
import {
  prepareHostThreadRecord,
  type HostThreadRecordPrepareInput,
  type HostThreadRecordPrepareResult
} from './HostThreadRecordPrepare'
import {
  hostThreadRecordTransferDirectory,
  hostThreadRecordTransferPath,
  publishHostThreadRecordTransfer,
  type HostThreadRecordTransferDescriptor
} from './HostThreadRecordTransfer'
import {
  createHostThreadRecordCommitPort,
  HostThreadRecordTransaction,
  type HostThreadRecordCommitPort,
  type HostThreadRecordTransactionPorts
} from './HostThreadRecordTransaction'
import { HOST_TRANSACTION_LOG_FILENAME, HostTransactionLog } from './HostTransactionLog'
import {
  decideHostTransactionRecovery,
  type HostFileIdentity,
  type HostTransactionRecoveryAction,
  type HostTransactionRecoveryInput
} from './HostTransactionManifest'
import type { ThreadCatalogueProjection } from '../shared/threadCatalogueTypes'

const NOW = 1_760_000_000_000
const NOW_ISO = new Date(NOW).toISOString()
const INCARNATION = 'txn-test-incarnation'
const THREAD_ID = 'thread-1'
const OTHER_THREAD_ID = 'thread-2'
const COMMAND_ID = 'cmd-1'
const ACTOR = { actorId: 'test-actor', clientId: 'test-client', clientClass: 'desktop' as const }
const RESET_POSITION: HostCursorPosition = { generation: 2, cursor: 1 }

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

type LooseRecord = Record<string, unknown>

function baseRecord(threadId = THREAD_ID, overrides: LooseRecord = {}): LooseRecord {
  return {
    appChatId: threadId,
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
        runId: `run-${threadId}`,
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

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

function readIdentity(path: string): HostFileIdentity | null {
  try {
    const stat = lstatSync(path, { bigint: true })
    return { dev: stat.dev.toString(), ino: stat.ino.toString(), size: Number(stat.size) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (e: Error) => void
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

/** Polls until `condition` holds; fails loudly rather than asserting on a guess. */
async function waitFor(condition: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Resolves 'pending' when the promise has not settled within a short grace period. */
async function settledWithin<T>(promise: Promise<T>, ms = 100): Promise<T | 'pending'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface Ticket {
  threadId: string
  projection: ThreadCatalogueProjection
  finished: number
  failed: number
}

interface Seams {
  /** The delta store's journal write seam; set by a test to fail a write. */
  failWrite: () => boolean
  /** The delta store's journal fsync seam; set by a test to fail a group fsync. */
  failGroupFsync: () => boolean
  /** The transaction log's write seam; set by a test to fail a manifest write. */
  failLogWrite: () => boolean
}

interface Harness {
  profilePath: string
  dataDir: string
  chatPath: string
  store: HostProfileDomainStore
  deltas: HostDeltaStore
  receipts: HostCommandReceiptStore
  log: HostTransactionLog
  ledger: HostScopeLedger
  gate: HostCommitGate
  index: HostPublicWindowIndex
  records: HostThreadRecordCommitPort
  tickets: Ticket[]
  /** null tickets are answered while this is true. */
  untracked: { value: boolean }
  legacyCalls: unknown[]
  legacyResult: HostCommandExecutionResult
  legacyHold: { promise: Promise<void> | null }
  seams: Seams
  failStops: string[]
  ports: HostThreadRecordTransactionPorts
  /** Ports with the given overrides layered over the real ones. */
  withPorts(overrides: Partial<HostThreadRecordTransactionPorts>): HostThreadRecordTransactionPorts
  begin(commandId?: string, threadId?: string): HostCommandReceiptRecord
  receipt(commandId?: string): HostCommandReceiptRecord | null
  publish(
    record: LooseRecord,
    transferId?: string
  ): { descriptor: HostThreadRecordTransferDescriptor; bytes: Buffer }
  seed(threadId?: string): void
  transferListing(): string[]
  groupLines(commandId: string): number
  epoch(threadId?: string): HostScopeEpoch
  lane(threadId?: string): ReturnType<HostScopeLedger['view']>
  execute(
    input?: Partial<ExecuteInput>,
    ports?: HostThreadRecordTransactionPorts
  ): Promise<{ kind: string } & Record<string, unknown>>
}

interface ExecuteInput {
  commandId: string
  threadId: string
  descriptor: HostThreadRecordTransferDescriptor
  expectedRevision: number
  epoch: HostScopeEpoch
}

function serialQueue(): <T>(work: () => Promise<T> | T) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(work: () => Promise<T> | T): Promise<T> => {
    const run = tail.then(work)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

function harness(): Harness {
  const profilePath = mkdtempSync(join(tmpdir(), 'host-thread-record-transaction-'))
  roots.push(profilePath)
  const dataDir = join(profilePath, 'host-data')
  mkdirSync(dataDir)
  const seams: Seams = {
    failWrite: () => false,
    failGroupFsync: () => false,
    failLogWrite: () => false
  }
  const failStops: string[] = []
  const store = new HostProfileDomainStore({
    profilePath,
    authority: { assertProfileAuthority: () => undefined },
    now: () => NOW
  })
  const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
  const deltas = new HostDeltaStore({
    dataDir,
    now: () => NOW_ISO,
    compactAfterRecords: 10_000,
    batchWrite: (descriptor, bytes, offset, length) => {
      if (seams.failWrite()) throw new Error('injected journal write failure')
      return writeSync(descriptor, bytes, offset, length, null)
    },
    groupFsync: async (path) => {
      if (path === journal && seams.failGroupFsync()) {
        throw new Error('injected group fsync failure')
      }
    },
    onFailStop: (detail) => failStops.push(detail)
  })
  const receipts = new HostCommandReceiptStore({
    dataDir,
    now: () => NOW_ISO,
    getPosition: () => deltas.getPosition(),
    compactAfterRecords: 1000,
    scheduleCompaction: () => {}
  })
  const log = HostTransactionLog.open({
    dataDir,
    write: async (path, data) => {
      if (seams.failLogWrite()) throw new Error('injected manifest write failure')
      const { appendFile } = await import('node:fs/promises')
      await appendFile(path, data, { encoding: 'utf8', mode: 0o600 })
    }
  })
  const ledger = createHostScopeLedger({ hostIncarnation: INCARNATION })
  const gate = createHostCommitGate()
  const index = new HostPublicWindowIndex()
  const tickets: Ticket[] = []
  const untracked = { value: false }
  const records = createHostThreadRecordCommitPort({
    store,
    profilePath,
    beginTicket: async (threadId: string, projection: ThreadCatalogueProjection) => {
      if (untracked.value) return null
      const ticket: Ticket = { threadId, projection, finished: 0, failed: 0 }
      tickets.push(ticket)
      return {
        finish: () => {
          ticket.finished += 1
        },
        fail: () => {
          ticket.failed += 1
        }
      }
    }
  })
  const legacyCalls: unknown[] = []
  const legacyResult: HostCommandExecutionResult = {
    status: 'succeeded',
    resultSummary: 'legacy-persisted'
  }
  const legacyHold: { promise: Promise<void> | null } = { promise: null }
  const ports: HostThreadRecordTransactionPorts = {
    ledger,
    gate,
    log,
    index,
    deltas,
    receipts,
    prepare: async (input: HostThreadRecordPrepareInput) => prepareHostThreadRecord(input),
    records,
    legacy: async () => {
      legacyCalls.push(legacyCalls.length + 1)
      if (legacyHold.promise) await legacyHold.promise
      return legacyResult
    },
    profilePath,
    now: () => NOW,
    publicationLock: serialQueue()
  }
  const chatPath = join(profilePath, 'chats', `${THREAD_ID}.json`)
  const self: Harness = {
    profilePath,
    dataDir,
    chatPath,
    store,
    deltas,
    receipts,
    log,
    ledger,
    gate,
    index,
    records,
    tickets,
    untracked,
    legacyCalls,
    legacyResult,
    legacyHold,
    seams,
    failStops,
    ports,
    withPorts: (overrides) => ({ ...ports, ...overrides }),
    begin: (commandId = COMMAND_ID, threadId = THREAD_ID) => {
      const begun = receipts.begin({
        commandId,
        idempotencyKey: `${commandId}-key`,
        commandName: 'thread.record.persist',
        commandFingerprint: sha256(commandId),
        actor: ACTOR,
        target: { kind: 'thread', id: threadId },
        authority: { decision: 'allowed' },
        commandClass: 'txn-record-persist'
      })
      if (begun.kind !== 'created') throw new Error(`begin: ${JSON.stringify(begun)}`)
      return begun.receipt
    },
    receipt: (commandId = COMMAND_ID) =>
      receipts.list().find((record) => record.commandId === commandId) ?? null,
    publish: (record, transferId = 'transfer-1') => {
      const descriptor = publishHostThreadRecordTransfer({ profilePath, transferId, record })
      const bytes = readFileSync(hostThreadRecordTransferPath(profilePath, transferId))
      return { descriptor, bytes }
    },
    seed: (threadId = THREAD_ID) => {
      store.persistThreadRecord({ threadId, record: baseRecord(threadId), expectedRevision: 0 })
    },
    transferListing: () => {
      const directory = hostThreadRecordTransferDirectory(profilePath)
      return existsSync(directory) ? readdirSync(directory).sort() : []
    },
    groupLines: (commandId) => {
      if (!existsSync(journal)) return 0
      return readFileSync(journal, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .filter((line) => {
          const event = JSON.parse(line) as { op: string; commandId?: string }
          return event.op === 'group' && event.commandId === commandId
        }).length
    },
    epoch: (threadId = THREAD_ID) => ledger.view(hostThreadScope(threadId)).epoch,
    lane: (threadId = THREAD_ID) => ledger.view(hostThreadScope(threadId)),
    execute: async (input = {}, executePorts = ports) => {
      const transaction = new HostThreadRecordTransaction(executePorts)
      const threadId = input.threadId ?? THREAD_ID
      const full: ExecuteInput = {
        commandId: COMMAND_ID,
        threadId,
        descriptor: input.descriptor ?? self.publish(baseRecord(threadId)).descriptor,
        expectedRevision: 0,
        epoch: self.epoch(threadId),
        ...input
      }
      return (await transaction.execute(full)) as { kind: string } & Record<string, unknown>
    }
  }
  return self
}

/** A record stamped ahead of its CAS base: adopted as sent (`original`). */
function stampedRecord(
  threadId: string,
  revision: number,
  overrides: LooseRecord = {}
): LooseRecord {
  return baseRecord(threadId, {
    persistenceRevision: revision,
    title: `Stamped ${revision}`,
    ...overrides
  })
}

/** The identity the manifest records for a prepared artifact. */
function artifactIdentityOf(path: string, byteLength: number): HostFileIdentity {
  const stat = lstatSync(path, { bigint: true })
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), size: byteLength }
}

type CommitRenameResult = ReturnType<HostThreadRecordCommitPort['commitRename']>

/**
 * The records port with the synchronous `commitRename` wrapped: the wrapper
 * sees the artifact before it moves. `real` is the check-and-rename itself.
 */
function renameSeam(
  records: HostThreadRecordCommitPort,
  hook: (
    artifactPath: string,
    threadId: string,
    real: () => CommitRenameResult
  ) => CommitRenameResult
): HostThreadRecordCommitPort {
  return {
    ...records,
    commitRename: (artifactPath: string, threadId: string, expectedKey: string | null) =>
      hook(artifactPath, threadId, () => records.commitRename(artifactPath, threadId, expectedKey))
  }
}

function expectFailedReceipt(record: HostCommandReceiptRecord | null, errorCode: string): void {
  expect(record).not.toBeNull()
  expect(record?.status).toBe('failed')
  expect(record?.errorCode).toBe(errorCode)
  expect(record?.commandClass).toBe('txn-record-persist')
  expect(record).not.toHaveProperty('recoveryState')
}

function expectLaneFree(h: Harness, threadId = THREAD_ID): void {
  const lane = h.lane(threadId)
  expect(lane.owner).toBeNull()
  expect(lane.waiting).toBe(0)
}

/** The wire rows of a family the index published, by entity id. */
function wireIds(index: HostPublicWindowIndex, family: 'thread' | 'run'): string[] {
  return [...(index.wire().get(family)?.keys() ?? [])].sort()
}

/** The effects the index prepared for a transaction, captured through a seam. */
function captureIndexEffects(index: HostPublicWindowIndex): {
  index: HostPublicWindowIndex
  prepared: HostPublicWindowTransaction[]
} {
  const prepared: HostPublicWindowTransaction[] = []
  const seam = new Proxy(index, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (...args: Parameters<HostPublicWindowIndex['prepare']>) => {
          const transaction = target.prepare(...args)
          prepared.push(transaction)
          return transaction
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  return { index: seam, prepared }
}

/** Every step-2 state, chat file and artifact left as they were: nothing pre-rename leaks. */
function expectNothingCommitted(
  h: Harness,
  commandId: string,
  before: { chat: Buffer | null; identity: HostFileIdentity | null; version: number | null }
): void {
  const chat = existsSync(h.chatPath) ? readFileSync(h.chatPath) : null
  expect(chat === null ? null : chat.toString('hex')).toBe(
    before.chat === null ? null : before.chat.toString('hex')
  )
  expect(readIdentity(h.chatPath)).toEqual(before.identity)
  expect(h.transferListing()).toEqual([])
  expect(h.deltas.findGroup(commandId)).toBeNull()
  expect(h.groupLines(commandId)).toBe(0)
  expect(h.deltas.getPosition()).toEqual({ generation: 1, cursor: 0 })
  expect(wireIds(h.index, 'thread')).toEqual([])
  expect(h.lane().version).toBe(before.version)
  expect(h.lane().publishedCursor).toBeNull()
  expectLaneFree(h)
}

function snapshotBefore(h: Harness): {
  chat: Buffer | null
  identity: HostFileIdentity | null
  version: number | null
} {
  return {
    chat: existsSync(h.chatPath) ? readFileSync(h.chatPath) : null,
    identity: readIdentity(h.chatPath),
    version: h.lane().version
  }
}

describe('HostThreadRecordTransaction (M4 slice 12a)', () => {
  describe('1. the happy path', () => {
    it.each([
      ['original', (h: Harness) => h.publish(stampedRecord(THREAD_ID, 1))],
      ['normalized', (h: Harness) => h.publish(baseRecord(THREAD_ID, { title: 'Normalized' }))]
    ] as const)(
      '%s: commits, publishes one group and completes the receipt at its end',
      async (source, publish) => {
        const h = harness()
        h.seed()
        const prior = readIdentity(h.chatPath)
        expect(prior).not.toBeNull()
        const { descriptor, bytes: transferBytes } = publish(h)
        h.begin()

        let artifact: { path: string; bytes: Buffer; identity: HostFileIdentity } | null = null
        const records = renameSeam(h.records, (artifactPath, _threadId, real) => {
          const bytes = readFileSync(artifactPath)
          artifact = {
            path: artifactPath,
            bytes,
            identity: artifactIdentityOf(artifactPath, bytes.length)
          }
          return real()
        })
        const captured = captureIndexEffects(h.index)
        const outcome = await h.execute(
          { descriptor },
          h.withPorts({ records, index: captured.index })
        )

        expect(outcome.kind).toBe('succeeded')
        expect(artifact).not.toBeNull()
        const committed = artifact!
        // The chat file is the artifact's bytes, renamed: same inode, same bytes.
        expect(readFileSync(h.chatPath).equals(committed.bytes)).toBe(true)
        expect(readIdentity(h.chatPath)).toEqual(committed.identity)
        if (source === 'original') {
          expect(committed.bytes.equals(transferBytes)).toBe(true)
        } else {
          expect(committed.bytes.equals(transferBytes)).toBe(false)
          expect(JSON.parse(committed.bytes.toString('utf8'))).toMatchObject({
            persistenceRevision: 1,
            updatedAt: NOW,
            title: 'Normalized'
          })
        }
        expect(h.transferListing()).toEqual([])

        // One group, the index's effects, durable, at the group's end.
        const group = h.deltas.findGroup(COMMAND_ID)
        expect(group).not.toBeNull()
        expect(group?.durable).toBe(true)
        expect(captured.prepared).toHaveLength(1)
        const effects = captured.prepared[0]!.effects
        expect(effects.length).toBeGreaterThan(0)
        expect(group?.count).toBe(effects.length)
        expect(h.groupLines(COMMAND_ID)).toBe(1)
        const stored: string[] = []
        for (let cursor = group!.start.cursor; cursor <= group!.end.cursor; cursor += 1) {
          const record = h.deltas.getByCursor(cursor)
          expect(record).not.toBeNull()
          stored.push(`${record!.envelope.family}:${record!.envelope.entityId}`)
        }
        expect(stored).toEqual(effects.map((effect) => `${effect.family}:${effect.entityId}`))
        const end = group!.end
        expect(end).toEqual({ generation: 1, cursor: effects.length })
        expect(h.deltas.getPosition()).toEqual(end)

        // The receipt, at the group's end.
        const receipt = h.receipt()
        expect(receipt?.status).toBe('succeeded')
        expect(receipt?.resultSummary).toBe('thread_record_persisted')
        expect({ generation: receipt?.generation, cursor: receipt?.cursor }).toEqual(end)

        // The manifest: prepare, then published at the same position.
        const entry = h.log.get(COMMAND_ID)
        expect(entry?.prepare).toMatchObject({
          kind: 'prepare',
          commandId: COMMAND_ID,
          threadId: THREAD_ID,
          epoch: { hostIncarnation: INCARNATION, deleteCounter: 0 },
          expectedRevision: 0,
          resultingRevision: 1,
          prior,
          resulting: committed.identity,
          preparedAt: NOW
        })
        const decoded = decodeHostProfileThread(JSON.parse(committed.bytes.toString('utf8')))
        const model = modelHostThreadRecordEffects(decoded)
        expect(model.kind).toBe('modelled')
        if (model.kind === 'modelled') {
          expect(entry?.prepare?.effects).toEqual({
            count: model.runs.candidates.length,
            setDigest: sha256(JSON.stringify(model.thread))
          })
          expect(model.runs.candidates.length).toBe(1)
        }
        expect(entry?.terminal).toMatchObject({
          kind: 'published',
          commandId: COMMAND_ID,
          position: end
        })

        // The index holds the thread's rows; the ticket finished; the lane is free
        // with its version and cursor set; the store's cache agrees.
        expect(wireIds(h.index, 'thread')).toEqual([THREAD_ID])
        expect(wireIds(h.index, 'run')).toEqual([`run-${THREAD_ID}`])
        expect(h.tickets).toHaveLength(1)
        expect(h.tickets[0]).toMatchObject({ threadId: THREAD_ID, finished: 1, failed: 0 })
        expect(h.tickets[0]!.projection.revision).toBe(1)
        expect(h.lane().version).toBe(1)
        expect(h.lane().publishedCursor).toEqual(end)
        expectLaneFree(h)
        // The commit fed the store's caches: neither the revision nor the
        // summary re-parses the record (a miss would, and still answer right).
        const reads = h.store.threadRecordReads
        expect(h.store.threadRecordState(THREAD_ID)).toMatchObject({
          revision: 1,
          identity: committed.identity
        })
        const summaries = h.store.listThreadSummaries()
        expect(summaries.map((summary) => summary.appChatId)).toEqual([THREAD_ID])
        expect(summaries[0]!.persistenceRevision).toBe(1)
        expect(h.store.threadRecordReads).toBe(reads)
        expect(h.failStops).toEqual([])
      }
    )

    it('a create at revision 0 with no prior record commits with a null prior', async () => {
      const h = harness()
      expect(readIdentity(h.chatPath)).toBeNull()
      h.begin()
      const outcome = await h.execute()
      expect(outcome.kind).toBe('succeeded')
      const entry = h.log.get(COMMAND_ID)
      expect(entry?.prepare).toMatchObject({
        prior: null,
        expectedRevision: 0,
        resultingRevision: 0
      })
      expect(entry?.terminal?.kind).toBe('published')
      expect(readIdentity(h.chatPath)).toEqual(entry?.prepare?.resulting)
      expect(h.receipt()?.status).toBe('succeeded')
      expect(h.lane().version).toBe(0)
      expectLaneFree(h)
    })
  })

  describe('2. every pre-rename failure leaves nothing behind', () => {
    it('epoch_stale: thread_record_epoch_stale with the ledger message, no manifest', async () => {
      const h = harness()
      h.seed()
      const before = snapshotBefore(h)
      h.begin()
      const stale: HostScopeEpoch = { hostIncarnation: INCARNATION, deleteCounter: 7 }
      const outcome = await h.execute({ epoch: stale })
      expect(outcome.kind).toBe('failed')
      const receipt = h.receipt()
      expectFailedReceipt(receipt, 'thread_record_epoch_stale')
      expect(receipt?.errorMessage).toBe(HOST_SCOPE_EPOCH_STALE_MESSAGE)
      expect(h.log.get(COMMAND_ID)).toBeNull()
      expect(existsSync(join(h.dataDir, HOST_TRANSACTION_LOG_FILENAME))).toBe(false)
      expect(h.tickets).toEqual([])
      expectNothingCommitted(h, COMMAND_ID, before)
    })

    it('deleted: thread_record_gone after a committed delete closed the lane', async () => {
      const h = harness()
      h.seed()
      const held = await h.ledger.acquire(hostThreadScope(THREAD_ID), { owner: 'deleter' })
      expect(held.ok).toBe(true)
      if (!held.ok) return
      held.slot.deleted()
      held.slot.release()
      const before = snapshotBefore(h)
      h.begin()
      // Admitted after the delete, with the new epoch: still refused.
      const outcome = await h.execute({ epoch: h.epoch() })
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'thread_record_gone')
      expect(h.log.get(COMMAND_ID)).toBeNull()
      expect(h.tickets).toEqual([])
      expectNothingCommitted(h, COMMAND_ID, before)
    })

    it('closed: host_shutting_down when the ledger is closed', async () => {
      const h = harness()
      h.seed()
      const before = snapshotBefore(h)
      h.begin()
      h.ledger.close()
      const outcome = await h.execute()
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'host_shutting_down')
      expect(h.log.get(COMMAND_ID)).toBeNull()
      expect(h.tickets).toEqual([])
      expectNothingCommitted(h, COMMAND_ID, before)
    })

    it('aborted: host_shutting_down when the lane request is aborted', async () => {
      const h = harness()
      h.seed()
      const before = snapshotBefore(h)
      h.begin()
      const ledger: HostScopeLedger = {
        get hostIncarnation() {
          return h.ledger.hostIncarnation
        },
        get closed() {
          return h.ledger.closed
        },
        view: (scope) => h.ledger.view(scope),
        acquire: async () => ({ ok: false, reason: 'aborted' }),
        close: () => h.ledger.close()
      }
      const outcome = await h.execute({}, h.withPorts({ ledger }))
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'host_shutting_down')
      expect(h.log.get(COMMAND_ID)).toBeNull()
      expect(h.tickets).toEqual([])
      expectNothingCommitted(h, COMMAND_ID, before)
    })

    it('rejected prepare (revision conflict): its code, artifact reaped, no manifest', async () => {
      const h = harness()
      h.seed()
      const before = snapshotBefore(h)
      h.begin()
      const outcome = await h.execute({ expectedRevision: 5 })
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'thread_record_revision_conflict')
      expect(h.log.get(COMMAND_ID)).toBeNull()
      expect(h.tickets).toEqual([])
      expectNothingCommitted(h, COMMAND_ID, before)
    })

    it('rejected prepare (identity mismatch): its code, artifact reaped, no manifest', async () => {
      const h = harness()
      h.seed()
      const before = snapshotBefore(h)
      h.begin()
      const { descriptor } = h.publish(stampedRecord(OTHER_THREAD_ID, 1))
      const outcome = await h.execute({ descriptor })
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'thread_record_identity_mismatch')
      expect(h.log.get(COMMAND_ID)).toBeNull()
      expect(h.tickets).toEqual([])
      expectNothingCommitted(h, COMMAND_ID, before)
    })

    it('rejected prepare (transfer missing): its code and no manifest', async () => {
      const h = harness()
      h.seed()
      const before = snapshotBefore(h)
      h.begin()
      const { descriptor } = h.publish(stampedRecord(THREAD_ID, 1))
      rmSync(hostThreadRecordTransferPath(h.profilePath, descriptor.transferId))
      const outcome = await h.execute({ descriptor })
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'thread_record_transfer_missing')
      expect(h.log.get(COMMAND_ID)).toBeNull()
      expect(h.tickets).toEqual([])
      expectNothingCommitted(h, COMMAND_ID, before)
    })

    it('a throwing records.current fails thread_record_persist_failed with no manifest', async () => {
      const h = harness()
      h.seed()
      const before = snapshotBefore(h)
      h.begin()
      const records: HostThreadRecordCommitPort = {
        ...h.records,
        current: () => {
          throw new Error('Thread record changed while its revision was read')
        }
      }
      const outcome = await h.execute({}, h.withPorts({ records }))
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'thread_record_persist_failed')
      expect(h.log.get(COMMAND_ID)).toBeNull()
      expect(h.tickets).toEqual([])
      expectNothingCommitted(h, COMMAND_ID, before)
    })

    it('a prepare that throws (the worker died) fails thread_record_transfer_failed and removes the artifact', async () => {
      const h = harness()
      h.seed()
      const before = snapshotBefore(h)
      h.begin()
      const { descriptor } = h.publish(baseRecord(), 'transfer-worker-died')
      expect(h.transferListing()).toContain('transfer-worker-died.record.json')
      const prepare = async (): Promise<HostThreadRecordPrepareResult> => {
        throw new Error('Thread-record transfer worker exited before completing its jobs.')
      }
      const outcome = await h.execute({ descriptor }, h.withPorts({ prepare }))
      expect(outcome).toEqual({ kind: 'failed', errorCode: 'thread_record_transfer_failed' })
      expectFailedReceipt(h.receipt(), 'thread_record_transfer_failed')
      expect(h.log.get(COMMAND_ID)).toBeNull()
      expect(h.tickets).toEqual([])
      expect(h.transferListing()).not.toContain('transfer-worker-died.record.json')
      expectNothingCommitted(h, COMMAND_ID, before)
      expectLaneFree(h)
    })

    it('the index diff and the group append run inside the publication lock', async () => {
      const h = harness()
      h.seed()
      h.begin()
      const events: string[] = []
      const lock = serialQueue()
      const publicationLock = <T>(work: () => Promise<T> | T): Promise<T> =>
        lock(async () => {
          events.push('lock:enter')
          try {
            return await work()
          } finally {
            events.push('lock:exit')
          }
        })
      const index: HostThreadRecordTransactionPorts['index'] = {
        prepare: (changes, publication) => {
          events.push('index:prepare')
          return h.index.prepare(changes, publication)
        }
      }
      const deltas: HostThreadRecordTransactionPorts['deltas'] = {
        appendGroup: (input) => {
          events.push('deltas:appendGroup')
          return h.deltas.appendGroup(input)
        },
        awaitDurable: () => {
          events.push('deltas:awaitDurable')
          return h.deltas.awaitDurable()
        },
        getPosition: () => h.deltas.getPosition()
      }
      const outcome = await h.execute(
        { expectedRevision: 0, descriptor: h.publish(stampedRecord(THREAD_ID, 1)).descriptor },
        h.withPorts({ publicationLock, index, deltas })
      )
      expect(outcome.kind).toBe('succeeded')
      expect(events).toEqual([
        'lock:enter',
        'index:prepare',
        'deltas:appendGroup',
        'lock:exit',
        'deltas:awaitDurable'
      ])
    })

    it('refused effects: discard, thread_record_persist_failed, no manifest', async () => {
      const h = harness()
      h.seed()
      const before = snapshotBefore(h)
      h.begin()
      const discarded: unknown[] = []
      const records: HostThreadRecordCommitPort = {
        ...h.records,
        discard: (artifact) => {
          discarded.push(artifact)
          h.records.discard(artifact)
        }
      }
      const prepare = async (
        input: HostThreadRecordPrepareInput
      ): Promise<HostThreadRecordPrepareResult> => {
        const result = prepareHostThreadRecord(input)
        if (result.kind !== 'prepared') return result
        return {
          ...result,
          effects: {
            kind: 'refused',
            threadId: input.threadId,
            errorCode: 'thread_record_persist_failed'
          }
        }
      }
      const outcome = await h.execute({}, h.withPorts({ records, prepare }))
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'thread_record_persist_failed')
      expect(discarded).toHaveLength(1)
      expect(h.log.get(COMMAND_ID)).toBeNull()
      expect(h.tickets).toEqual([])
      expectNothingCommitted(h, COMMAND_ID, before)
    })

    it('null ticket (untracked): discard, thread_record_persist_failed, no manifest', async () => {
      const h = harness()
      h.seed()
      const before = snapshotBefore(h)
      h.begin()
      h.untracked.value = true
      const outcome = await h.execute()
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'thread_record_persist_failed')
      expect(h.log.get(COMMAND_ID)).toBeNull()
      expect(h.tickets).toEqual([])
      expectNothingCommitted(h, COMMAND_ID, before)
    })

    it('manifest failure: ticket failed, discard, thread_record_persist_failed, no records', async () => {
      const h = harness()
      h.seed()
      const before = snapshotBefore(h)
      h.begin()
      h.seams.failLogWrite = () => true
      const outcome = await h.execute()
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'thread_record_persist_failed')
      expect(h.log.get(COMMAND_ID)).toBeNull()
      expect(h.log.getFailure()).not.toBeNull()
      expect(h.tickets).toHaveLength(1)
      expect(h.tickets[0]).toMatchObject({ finished: 0, failed: 1 })
      expectNothingCommitted(h, COMMAND_ID, before)
    })

    it('gate closed: abort record, ticket failed, discard, host_shutting_down', async () => {
      const h = harness()
      h.seed()
      const before = snapshotBefore(h)
      h.begin()
      h.gate.close()
      const outcome = await h.execute()
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'host_shutting_down')
      const entry = h.log.get(COMMAND_ID)
      expect(entry?.prepare?.kind).toBe('prepare')
      expect(entry?.terminal?.kind).toBe('abort')
      expect(h.tickets).toHaveLength(1)
      expect(h.tickets[0]).toMatchObject({ finished: 0, failed: 1 })
      expectNothingCommitted(h, COMMAND_ID, before)
    })

    it('CAS mismatch: a non-lane write between step 2 and the commit is refused as a revision conflict', async () => {
      const h = harness()
      h.seed()
      const stateBefore = h.store.threadRecordState(THREAD_ID)
      expect(stateBefore).not.toBeNull()
      h.begin()
      const otherBytes = Buffer.from(
        `${JSON.stringify(baseRecord(THREAD_ID, { title: 'Written outside the lane', persistenceRevision: 3 }))}\n`,
        'utf8'
      )
      let overwritten: HostFileIdentity | null = null
      const records: HostThreadRecordCommitPort = {
        ...h.records,
        // Step 3 begins after the step-2 read: the other writer lands here.
        beginTicket: async (threadId, projection) => {
          const temp = `${h.chatPath}.other.tmp`
          writeFileSync(temp, otherBytes)
          renameSync(temp, h.chatPath)
          overwritten = readIdentity(h.chatPath)
          return h.records.beginTicket(threadId, projection)
        }
      }
      const outcome = await h.execute({}, h.withPorts({ records }))
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'thread_record_revision_conflict')
      expect(overwritten).not.toBeNull()
      expect(overwritten).not.toEqual(stateBefore?.identity)
      // The other writer's bytes stay; the artifact is gone; the manifest ends in abort.
      expect(readFileSync(h.chatPath).equals(otherBytes)).toBe(true)
      expect(readIdentity(h.chatPath)).toEqual(overwritten)
      expect(h.transferListing()).toEqual([])
      const entry = h.log.get(COMMAND_ID)
      expect(entry?.prepare).toMatchObject({ prior: stateBefore?.identity })
      expect(entry?.terminal?.kind).toBe('abort')
      expect(h.deltas.findGroup(COMMAND_ID)).toBeNull()
      expect(h.groupLines(COMMAND_ID)).toBe(0)
      expect(wireIds(h.index, 'thread')).toEqual([])
      expect(h.tickets).toHaveLength(1)
      expect(h.tickets[0]).toMatchObject({ finished: 0, failed: 1 })
      expect(h.lane().version).toBeNull()
      expectLaneFree(h)
    })

    it('CAS mismatch: an in-place rewrite of the same length (same inode) is refused too', async () => {
      const h = harness()
      h.seed()
      const stateBefore = h.store.threadRecordState(THREAD_ID)
      expect(stateBefore).not.toBeNull()
      h.begin()
      const original = readFileSync(h.chatPath, 'utf8')
      // One character of the title changes; the byte length and inode do not.
      const rewritten = original.replace('"title":"', '"title":"X').replace(/X(.)/, 'X')
      expect(rewritten).not.toBe(original)
      expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original))
      const records: HostThreadRecordCommitPort = {
        ...h.records,
        beginTicket: async (threadId, projection) => {
          const { openSync, writeSync: write, closeSync } = await import('node:fs')
          const fd = openSync(h.chatPath, 'r+')
          write(fd, rewritten, 0, 'utf8')
          closeSync(fd)
          return h.records.beginTicket(threadId, projection)
        }
      }
      const outcome = await h.execute({}, h.withPorts({ records }))
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'thread_record_revision_conflict')
      expect(readIdentity(h.chatPath)).toMatchObject({
        ino: stateBefore!.identity.ino,
        size: stateBefore!.identity.size
      })
      expect(readFileSync(h.chatPath, 'utf8')).toBe(rewritten)
      expect(h.log.get(COMMAND_ID)?.terminal?.kind).toBe('abort')
      expectLaneFree(h)
    })

    it('an abort record is written after the committer hold is released (one fsync under the hold)', async () => {
      const h = harness()
      h.seed()
      h.begin()
      const holdingAtAppend: Array<[string, string | null]> = []
      const log: HostThreadRecordTransactionPorts['log'] = {
        append: (record) => {
          holdingAtAppend.push([(record as { kind: string }).kind, h.gate.snapshot().holding])
          return h.log.append(record)
        }
      }
      const records: HostThreadRecordCommitPort = {
        ...h.records,
        // Another writer landed first: the synchronous check refuses.
        commitRename: () => 'changed'
      }
      const outcome = await h.execute({}, h.withPorts({ log, records }))
      expect(outcome).toEqual({ kind: 'failed', errorCode: 'thread_record_revision_conflict' })
      expect(holdingAtAppend).toEqual([
        ['prepare', null],
        ['abort', null]
      ])
    })

    it('rename throwing before the rename: abort record, ticket failed, thread_record_persist_failed', async () => {
      const h = harness()
      h.seed()
      const before = snapshotBefore(h)
      h.begin()
      const records = renameSeam(h.records, () => {
        throw new Error('injected rename failure before the rename')
      })
      const outcome = await h.execute({}, h.withPorts({ records }))
      expect(outcome.kind).toBe('failed')
      expectFailedReceipt(h.receipt(), 'thread_record_persist_failed')
      const entry = h.log.get(COMMAND_ID)
      expect(entry?.prepare?.kind).toBe('prepare')
      expect(entry?.terminal?.kind).toBe('abort')
      expect(h.tickets).toHaveLength(1)
      expect(h.tickets[0]).toMatchObject({ finished: 0, failed: 1 })
      expectNothingCommitted(h, COMMAND_ID, before)
    })
  })

  describe('3. rename throwing after the rename', () => {
    it('is judged committed by the witness and carries on to succeed', async () => {
      const h = harness()
      h.seed()
      h.begin()
      let resulting: HostFileIdentity | null = null
      const records = renameSeam(h.records, (artifactPath, _threadId, real) => {
        resulting = artifactIdentityOf(artifactPath, lstatSync(artifactPath).size)
        real()
        throw new Error('injected rename failure after the rename')
      })
      const outcome = await h.execute({}, h.withPorts({ records }))
      expect(outcome.kind).toBe('succeeded')
      expect(resulting).not.toBeNull()
      expect(readIdentity(h.chatPath)).toEqual(resulting)
      const group = h.deltas.findGroup(COMMAND_ID)
      expect(group).not.toBeNull()
      const receipt = h.receipt()
      expect(receipt?.status).toBe('succeeded')
      expect({ generation: receipt?.generation, cursor: receipt?.cursor }).toEqual(group?.end)
      const entry = h.log.get(COMMAND_ID)
      expect(entry?.terminal).toMatchObject({ kind: 'published', position: group?.end })
      expect(wireIds(h.index, 'thread')).toEqual([THREAD_ID])
      expect(h.tickets[0]).toMatchObject({ finished: 1, failed: 0 })
      expect(h.lane().version).toBe(1)
      expectLaneFree(h)
    })
  })

  describe('4. a group that completes at a generation reset', () => {
    it('write-failed with a proven rollback: receipt and published at the reset, index committed', async () => {
      const h = harness()
      h.seed()
      h.begin()
      let armed = false
      h.seams.failWrite = () => {
        if (!armed) return false
        // Only the group line fails; the reset that follows must succeed.
        armed = false
        return true
      }
      const deltas = {
        appendGroup: (input: Parameters<HostDeltaStore['appendGroup']>[0]) => {
          armed = true
          return h.deltas.appendGroup(input)
        },
        awaitDurable: () => h.deltas.awaitDurable(),
        getPosition: () => h.deltas.getPosition()
      }
      const outcome = await h.execute({}, h.withPorts({ deltas }))
      expect(outcome.kind).toBe('succeeded')
      expect(armed).toBe(false)
      expect(h.deltas.getPosition()).toEqual(RESET_POSITION)
      expect(h.deltas.findGroup(COMMAND_ID)).toBeNull()
      expect(h.deltas.getFailStop()).toBeNull()
      const receipt = h.receipt()
      expect(receipt?.status).toBe('succeeded')
      expect({ generation: receipt?.generation, cursor: receipt?.cursor }).toEqual(RESET_POSITION)
      expect(h.log.get(COMMAND_ID)?.terminal).toMatchObject({
        kind: 'published',
        position: RESET_POSITION
      })
      expect(wireIds(h.index, 'thread')).toEqual([THREAD_ID])
      expect(h.tickets[0]).toMatchObject({ finished: 1, failed: 0 })
      expect(h.lane().publishedCursor).toEqual(RESET_POSITION)
      expect(h.lane().version).toBe(1)
      expectLaneFree(h)
    })

    it('awaitDurable reset (failed group fsync): receipt and published at the reset, index committed', async () => {
      const h = harness()
      h.seed()
      h.begin()
      let failing = true
      h.seams.failGroupFsync = () => failing
      const outcome = await h.execute()
      failing = false
      expect(outcome.kind).toBe('succeeded')
      expect(h.deltas.getPosition()).toEqual(RESET_POSITION)
      expect(h.deltas.findGroup(COMMAND_ID)).toBeNull()
      expect(h.groupLines(COMMAND_ID)).toBe(1)
      expect(h.deltas.getFailStop()).toBeNull()
      const receipt = h.receipt()
      expect(receipt?.status).toBe('succeeded')
      expect({ generation: receipt?.generation, cursor: receipt?.cursor }).toEqual(RESET_POSITION)
      expect(h.log.get(COMMAND_ID)?.terminal).toMatchObject({
        kind: 'published',
        position: RESET_POSITION
      })
      expect(wireIds(h.index, 'thread')).toEqual([THREAD_ID])
      expect(h.tickets[0]).toMatchObject({ finished: 1, failed: 0 })
      expect(h.lane().publishedCursor).toEqual(RESET_POSITION)
      expectLaneFree(h)
    })
  })

  describe('5. fail-stop', () => {
    it('write-failed whose reset also fails: receipt pending, no published, index aborted, lane free', async () => {
      const h = harness()
      h.seed()
      h.begin()
      let armed = false
      h.seams.failWrite = () => armed
      const deltas = {
        appendGroup: (input: Parameters<HostDeltaStore['appendGroup']>[0]) => {
          armed = true
          return h.deltas.appendGroup(input)
        },
        awaitDurable: () => h.deltas.awaitDurable(),
        getPosition: () => h.deltas.getPosition()
      }
      const outcome = await h.execute({}, h.withPorts({ deltas }))
      expect(outcome.kind).toBe('fail-stopped')
      expect(h.deltas.getFailStop()).not.toBeNull()
      expect(h.failStops).toHaveLength(1)
      // The record is committed; nothing was published, and boot decides.
      expect(readIdentity(h.chatPath)).toEqual(h.log.get(COMMAND_ID)?.prepare?.resulting)
      const receipt = h.receipt()
      expect(receipt?.status).toBe('pending')
      expect(receipt).not.toHaveProperty('recoveryState')
      expect(h.log.get(COMMAND_ID)?.terminal).toBeNull()
      expect(wireIds(h.index, 'thread')).toEqual([])
      expect(h.tickets).toHaveLength(1)
      expect(h.tickets[0]).toMatchObject({ finished: 0, failed: 0 })
      expectLaneFree(h)
      // The index is not left with a transaction open.
      expect(() => h.index.prepare([], { generatedAt: NOW_ISO }).abort()).not.toThrow()
    })

    it('awaitDurable fail-stopped (fsync failed and its reset failed): the same', async () => {
      const h = harness()
      h.seed()
      h.begin()
      let fsyncFailed = false
      h.seams.failGroupFsync = () => {
        fsyncFailed = true
        return true
      }
      // The reset chained after the failed fsync is the next journal write.
      h.seams.failWrite = () => fsyncFailed
      const outcome = await h.execute()
      expect(outcome.kind).toBe('fail-stopped')
      expect(h.deltas.getFailStop()).not.toBeNull()
      expect(h.failStops).toHaveLength(1)
      const receipt = h.receipt()
      expect(receipt?.status).toBe('pending')
      expect(h.log.get(COMMAND_ID)?.prepare?.kind).toBe('prepare')
      expect(h.log.get(COMMAND_ID)?.terminal).toBeNull()
      expect(h.tickets).toHaveLength(1)
      expect(h.tickets[0]).toMatchObject({ finished: 0, failed: 0 })
      expectLaneFree(h)
    })
  })

  describe('6. an unpublishable group', () => {
    it('rejected by the delta store: indeterminate receipt with the new code, manifest indeterminate, index unchanged', async () => {
      const h = harness()
      h.seed()
      h.begin()
      const deltas = {
        appendGroup: (input: Parameters<HostDeltaStore['appendGroup']>[0]) => {
          const position = h.deltas.getAppendedPosition()
          return {
            kind: 'rejected' as const,
            failedAtIndex: 0,
            result: {
              kind: 'rejected' as const,
              reason: 'invalid_envelope' as const,
              detail: `injected rejection of ${input.commandId}`,
              position
            },
            position
          }
        },
        awaitDurable: () => h.deltas.awaitDurable(),
        getPosition: () => h.deltas.getPosition()
      }
      const outcome = await h.execute({}, h.withPorts({ deltas }))
      expect(outcome.kind).toBe('indeterminate')
      const receipt = h.receipt()
      expect(receipt?.status).toBe('indeterminate')
      expect(receipt?.errorCode).toBe('transaction_commit_indeterminate')
      expect(receipt?.recoveryState).toBe('recoverable-indeterminate')
      const entry = h.log.get(COMMAND_ID)
      expect(entry?.prepare?.kind).toBe('prepare')
      expect(entry?.terminal?.kind).toBe('indeterminate')
      // Committed on disk, published nowhere.
      expect(readIdentity(h.chatPath)).toEqual(entry?.prepare?.resulting)
      expect(h.deltas.findGroup(COMMAND_ID)).toBeNull()
      expect(h.groupLines(COMMAND_ID)).toBe(0)
      expect(wireIds(h.index, 'thread')).toEqual([])
      expect(() => h.index.prepare([], { generatedAt: NOW_ISO }).abort()).not.toThrow()
      expect(h.tickets).toHaveLength(1)
      expect(h.tickets[0]).toMatchObject({ finished: 0, failed: 1 })
      expect(h.transferListing()).toEqual([])
      expectLaneFree(h)
    })

    it('failing effect validation: the same, and the store is never asked', async () => {
      const h = harness()
      h.seed()
      h.begin()
      const appends: unknown[] = []
      const deltas = {
        appendGroup: (input: Parameters<HostDeltaStore['appendGroup']>[0]) => {
          appends.push(input)
          return h.deltas.appendGroup(input)
        },
        awaitDurable: () => h.deltas.awaitDurable(),
        getPosition: () => h.deltas.getPosition()
      }
      const index = new Proxy(h.index, {
        get(target, property, receiver) {
          if (property === 'prepare') {
            return (...args: Parameters<HostPublicWindowIndex['prepare']>) => {
              const transaction = target.prepare(...args)
              const invalid = {
                kind: 'upsert',
                family: 'thread',
                entityId: ''
              } as HostDomainEffectDto
              return { ...transaction, effects: [...transaction.effects, invalid] }
            }
          }
          const value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      const outcome = await h.execute({}, h.withPorts({ deltas, index }))
      expect(outcome.kind).toBe('indeterminate')
      expect(appends).toEqual([])
      const receipt = h.receipt()
      expect(receipt?.status).toBe('indeterminate')
      expect(receipt?.errorCode).toBe('transaction_commit_indeterminate')
      expect(h.log.get(COMMAND_ID)?.terminal?.kind).toBe('indeterminate')
      expect(h.deltas.findGroup(COMMAND_ID)).toBeNull()
      expect(wireIds(h.index, 'thread')).toEqual([])
      expect(h.tickets[0]).toMatchObject({ finished: 0, failed: 1 })
      expectLaneFree(h)
    })
  })

  describe('7. unsupported runs legacy under the lane', () => {
    it('calls legacy exactly once while holding the lane, and a queued persist waits for it', async () => {
      const h = harness()
      h.seed()
      h.begin()
      h.begin('cmd-2')
      const hold = deferred()
      h.legacyHold.promise = hold.promise
      const ownerDuringLegacy: string[] = []
      const legacy = async () => {
        ownerDuringLegacy.push(h.lane().owner ?? '<free>')
        return h.ports.legacy()
      }
      const secondCurrentReads: number[] = []
      const records: HostThreadRecordCommitPort = {
        ...h.records,
        current: (threadId) => {
          secondCurrentReads.push(Date.now())
          return h.records.current(threadId)
        }
      }
      const { descriptor: first } = h.publish(stampedRecord(THREAD_ID, 1), 'transfer-first')
      // The stub legacy writes nothing, so the queued persist is also a revision-0
      // base: it must reach prepare (and legacy) only after the first one ends.
      const { descriptor: second } = h.publish(stampedRecord(THREAD_ID, 1), 'transfer-second')

      const outcome = withPeopleDonorMutationGate(h.profilePath, async () => {
        const running = h.execute({ descriptor: first }, h.withPorts({ legacy }))
        // Legacy has been entered and is held.
        await waitFor(() => h.legacyCalls.length === 1, 'the legacy run to start')
        expect(h.legacyCalls).toHaveLength(1)
        expect(ownerDuringLegacy).toEqual([COMMAND_ID])
        expect(h.lane().owner).toBe(COMMAND_ID)

        // A second persist of the thread queues behind the legacy run.
        const queued = h.execute(
          { commandId: 'cmd-2', descriptor: second },
          h.withPorts({ records, legacy })
        )
        expect(await settledWithin(queued)).toBe('pending')
        expect(h.lane().waiting).toBe(1)
        expect(secondCurrentReads).toEqual([])

        hold.resolve()
        const result = await running
        expect(result.kind).toBe('legacy')
        expect(Object.values(result)).toContainEqual(h.legacyResult)
        // The caller completes a legacy receipt as today: the transaction leaves it.
        expect(h.receipt()?.status).toBe('pending')
        expect(h.log.get(COMMAND_ID)).toBeNull()

        const queuedResult = await queued
        expect(queuedResult.kind).toBe('legacy')
        // Each persist ran legacy once, each under its own hold of the lane.
        expect(h.legacyCalls).toHaveLength(2)
        expect(ownerDuringLegacy).toEqual([COMMAND_ID, 'cmd-2'])
        expect(secondCurrentReads).toHaveLength(1)
        return result
      })
      await outcome
      expectLaneFree(h)
    })
  })

  describe('7b. review fixes: demotion, the ticket, a foreign reset', () => {
    it('unsupported demotes the receipt to the legacy class, durably, before legacy runs', async () => {
      const h = harness()
      h.seed()
      h.begin()
      const classDuringLegacy: Array<string | undefined> = []
      const legacy = async () => {
        classDuringLegacy.push(h.receipt()?.commandClass)
        return h.ports.legacy()
      }
      const { descriptor } = h.publish(stampedRecord(THREAD_ID, 1), 'transfer-demote')
      await withPeopleDonorMutationGate(h.profilePath, async () => {
        const outcome = await h.execute({ descriptor }, h.withPorts({ legacy }))
        expect(outcome.kind).toBe('legacy')
      })
      expect(classDuringLegacy).toEqual(['legacy-observed'])
      // Durable: a reopened store reads the demoted class.
      const reopened = new HostCommandReceiptStore({
        dataDir: h.dataDir,
        now: () => NOW_ISO,
        getPosition: () => h.deltas.getPosition(),
        compactAfterRecords: 1000,
        scheduleCompaction: () => {}
      })
      const found = reopened.list().find((record) => record.commandId === COMMAND_ID)
      expect(found?.commandClass).toBe('legacy-observed')
    })

    it('unsupported whose demotion is refused fails persist_failed and never runs legacy', async () => {
      const h = harness()
      h.seed()
      h.begin()
      const receipts: HostThreadRecordTransactionPorts['receipts'] = {
        complete: (input) => h.receipts.complete(input),
        markIndeterminate: (input) => h.receipts.markIndeterminate(input),
        demoteTransactionalCommand: () => ({ kind: 'refused' })
      }
      const { descriptor } = h.publish(stampedRecord(THREAD_ID, 1), 'transfer-no-demote')
      await withPeopleDonorMutationGate(h.profilePath, async () => {
        const outcome = await h.execute({ descriptor }, h.withPorts({ receipts }))
        expect(outcome).toEqual({ kind: 'failed', errorCode: 'thread_record_persist_failed' })
      })
      expect(h.legacyCalls).toEqual([])
      expectFailedReceipt(h.receipt(), 'thread_record_persist_failed')
      expect(h.transferListing()).not.toContain('transfer-no-demote.record.json')
      expectLaneFree(h)
    })

    it('a throwing ticket never keeps the receipt from completing', async () => {
      const h = harness()
      h.seed()
      h.begin()
      const records: HostThreadRecordCommitPort = {
        ...h.records,
        beginTicket: async () => ({
          finish: () => {
            throw new Error('mirror observe failed')
          },
          fail: () => {
            throw new Error('publisher fail failed')
          }
        })
      }
      const outcome = await h.execute(
        { descriptor: h.publish(stampedRecord(THREAD_ID, 1)).descriptor },
        h.withPorts({ records })
      )
      expect(outcome.kind).toBe('succeeded')
      expect(h.receipt()?.status).toBe('succeeded')
      expectLaneFree(h)

      h.begin('cmd-abort')
      const aborting: HostThreadRecordCommitPort = { ...records, commitRename: () => 'changed' }
      const failed = await h.execute(
        {
          commandId: 'cmd-abort',
          expectedRevision: 1,
          descriptor: h.publish(stampedRecord(THREAD_ID, 2), 'transfer-abort').descriptor
        },
        h.withPorts({ records: aborting })
      )
      expect(failed).toEqual({ kind: 'failed', errorCode: 'thread_record_revision_conflict' })
      expectFailedReceipt(h.receipt('cmd-abort'), 'thread_record_revision_conflict')
      expect(h.transferListing()).not.toContain('transfer-abort.record.json')
    })

    it('a foreign reset while awaiting durability completes at the new generation', async () => {
      const h = harness()
      h.seed()
      h.begin()
      const moved = { generation: h.deltas.getPosition().generation + 1, cursor: 1 }
      const deltas: HostThreadRecordTransactionPorts['deltas'] = {
        appendGroup: (input) => h.deltas.appendGroup(input),
        getPosition: () => h.deltas.getPosition(),
        awaitDurable: async () => {
          await h.deltas.awaitDurable()
          return { kind: 'durable', position: moved }
        }
      }
      const outcome = await h.execute(
        { descriptor: h.publish(stampedRecord(THREAD_ID, 1)).descriptor },
        h.withPorts({ deltas })
      )
      expect(outcome).toMatchObject({ kind: 'succeeded', position: moved })
      expect(h.receipt()).toMatchObject({ status: 'succeeded', ...moved })
      expect(h.log.get(COMMAND_ID)?.terminal).toMatchObject({ kind: 'published', position: moved })
    })
  })

  describe('8. concurrency', () => {
    it('two threads prepare concurrently: neither waits on the other lane', async () => {
      const h = harness()
      h.seed(THREAD_ID)
      h.seed(OTHER_THREAD_ID)
      h.begin(COMMAND_ID, THREAD_ID)
      h.begin('cmd-2', OTHER_THREAD_ID)
      const hold = deferred()
      const prepareStarted: string[] = []
      const prepare = async (input: HostThreadRecordPrepareInput) => {
        prepareStarted.push(input.threadId)
        if (input.threadId === THREAD_ID) await hold.promise
        return prepareHostThreadRecord(input)
      }
      const { descriptor: first } = h.publish(stampedRecord(THREAD_ID, 1), 'transfer-a')
      const { descriptor: second } = h.publish(stampedRecord(OTHER_THREAD_ID, 1), 'transfer-b')
      const ports = h.withPorts({ prepare })
      const a = h.execute({ descriptor: first }, ports)
      const b = h.execute(
        { commandId: 'cmd-2', threadId: OTHER_THREAD_ID, descriptor: second },
        ports
      )

      // B finishes while A's prepare is still held.
      const bResult = await b
      expect(bResult.kind).toBe('succeeded')
      expect(prepareStarted).toEqual([THREAD_ID, OTHER_THREAD_ID])
      expect(await settledWithin(a)).toBe('pending')
      expect(h.lane(THREAD_ID).owner).toBe(COMMAND_ID)
      expect(h.receipt('cmd-2')?.status).toBe('succeeded')
      expect(wireIds(h.index, 'thread')).toEqual([OTHER_THREAD_ID])

      hold.resolve()
      const aResult = await a
      expect(aResult.kind).toBe('succeeded')
      expect(wireIds(h.index, 'thread')).toEqual([THREAD_ID, OTHER_THREAD_ID].sort())
      expectLaneFree(h, THREAD_ID)
      expectLaneFree(h, OTHER_THREAD_ID)
    })

    it('two persists of one thread run in FIFO order', async () => {
      const h = harness()
      h.seed()
      h.begin()
      h.begin('cmd-2')
      const hold = deferred()
      const prepareOrder: string[] = []
      const prepare = async (input: HostThreadRecordPrepareInput) => {
        prepareOrder.push(`${input.threadId}@${input.expectedRevision}`)
        if (input.expectedRevision === 0) await hold.promise
        return prepareHostThreadRecord(input)
      }
      const { descriptor: first } = h.publish(stampedRecord(THREAD_ID, 1), 'transfer-first')
      const { descriptor: second } = h.publish(stampedRecord(THREAD_ID, 2), 'transfer-second')
      const ports = h.withPorts({ prepare })
      const a = h.execute({ descriptor: first }, ports)
      const b = h.execute({ commandId: 'cmd-2', descriptor: second, expectedRevision: 1 }, ports)

      await waitFor(() => h.lane().waiting === 1, 'the second persist to queue')
      expect(prepareOrder).toEqual([`${THREAD_ID}@0`])
      expect(h.lane().owner).toBe(COMMAND_ID)
      expect(h.lane().waiting).toBe(1)
      expect(await settledWithin(b)).toBe('pending')

      hold.resolve()
      const aResult = await a
      const bResult = await b
      expect(aResult.kind).toBe('succeeded')
      expect(bResult.kind).toBe('succeeded')
      expect(prepareOrder).toEqual([`${THREAD_ID}@0`, `${THREAD_ID}@1`])
      // The second commit built on the first: revision 2 over revision 1.
      expect(h.log.get('cmd-2')?.prepare).toMatchObject({
        expectedRevision: 1,
        resultingRevision: 2,
        prior: h.log.get(COMMAND_ID)?.prepare?.resulting
      })
      expect(h.receipt()?.status).toBe('succeeded')
      expect(h.receipt('cmd-2')?.status).toBe('succeeded')
      const firstEnd = h.deltas.findGroup(COMMAND_ID)?.end
      const secondEnd = h.deltas.findGroup('cmd-2')?.end
      expect(firstEnd).toBeDefined()
      expect(secondEnd).toBeDefined()
      expect(secondEnd!.cursor).toBeGreaterThan(firstEnd!.cursor)
      expect(h.lane().version).toBe(2)
      expect(h.store.threadRecordState(THREAD_ID)?.revision).toBe(2)
      expectLaneFree(h)
    })

    it('a gate observer admitted before the commit delays the rename, not the prepare', async () => {
      const h = harness()
      h.seed()
      h.begin()
      const renames: string[] = []
      const records = renameSeam(h.records, (_artifactPath, threadId, real) => {
        renames.push(threadId)
        return real()
      })
      const observer = await h.gate.enter('observer', { label: 'legacy-window' })
      expect(observer.ok).toBe(true)
      if (!observer.ok) return

      const running = h.execute({}, h.withPorts({ records }))
      await waitFor(() => h.gate.snapshot().waiting === 1, 'the commit to queue at the gate')
      // Prepared and manifested under the lane, waiting at the gate for the commit.
      expect(h.log.get(COMMAND_ID)?.prepare?.kind).toBe('prepare')
      expect(h.log.get(COMMAND_ID)?.terminal).toBeNull()
      expect(h.tickets).toHaveLength(1)
      expect(renames).toEqual([])
      expect(h.gate.snapshot()).toMatchObject({ holding: 'observer', waiting: 1 })
      expect(h.transferListing()).toHaveLength(1)
      expect(await settledWithin(running)).toBe('pending')

      observer.lease.release()
      const outcome = await running
      expect(outcome.kind).toBe('succeeded')
      expect(renames).toEqual([THREAD_ID])
      expect(h.gate.snapshot()).toMatchObject({ holding: null, waiting: 0 })
      expect(h.gate.snapshot().modes.committer.entered).toBe(1)
      expect(h.receipt()?.status).toBe('succeeded')
      expectLaneFree(h)
    })
  })

  describe('9. recovery agreement with the crash harness', () => {
    /**
     * A transaction frozen at a step boundary. A port that never settles is
     * the in-process crash: the transaction stops where it is, holding what
     * it holds, and the on-disk state is exactly what boot would find. (A
     * port that throws is handled: the transaction completes or aborts, and
     * recovery decides `none`; the property test below pins that.) K8 has
     * no async port to hold, so its seam throws from the receipt store, which
     * the transaction does not catch. K9 needs no seam: it is a finished run.
     */
    interface Boundary {
      name: string
      /** The harness kill point this boundary is the in-process equivalent of. */
      kill: string
      stop: 'hang' | 'throw' | 'none'
      ports: (
        h: Harness,
        records: HostThreadRecordCommitPort,
        reached: Deferred
      ) => Partial<HostThreadRecordTransactionPorts>
      expected: (end: HostCursorPosition) => HostTransactionRecoveryAction
      chat: 'prior' | 'resulting'
      group: boolean
      terminal: 'none' | 'published'
    }

    const never = new Promise<never>(() => {})
    const hang = (reached: Deferred) => async (): Promise<never> => {
      reached.resolve()
      return never
    }

    const boundaries: Boundary[] = [
      {
        name: 'after prepare, before the ticket (K1)',
        kill: 'K1',
        stop: 'hang',
        ports: (_h, records, reached) => ({ records: { ...records, beginTicket: hang(reached) } }),
        expected: () => ({
          action: 'fail_interrupted',
          row: 'D4',
          writeAbort: false,
          completeReceipt: true
        }),
        chat: 'prior',
        group: false,
        terminal: 'none'
      },
      {
        name: 'after the durable prepare, before the rename (K3)',
        kill: 'K3',
        stop: 'hang',
        // Nothing awaits between the check and the rename, so the last await
        // before it is the gate: hang there.
        ports: (h, _records, reached) => ({
          gate: {
            ...h.gate,
            closed: h.gate.closed,
            snapshot: () => h.gate.snapshot(),
            close: () => h.gate.close(),
            enter: hang(reached)
          }
        }),
        expected: () => ({
          action: 'fail_interrupted',
          row: 'D4',
          writeAbort: true,
          completeReceipt: true
        }),
        chat: 'prior',
        group: false,
        terminal: 'none'
      },
      {
        name: 'after the rename, before the group (K4/K5)',
        kill: 'K5',
        stop: 'hang',
        ports: (_h, records, reached) => ({
          // The rename has landed; hang in its directory fsync, before the group.
          records: {
            ...records,
            syncChatsDirectory: async (threadId: string) => {
              await records.syncChatsDirectory(threadId)
              await hang(reached)()
            }
          }
        }),
        expected: () => ({ action: 'reset_and_complete', row: 'D1' }),
        chat: 'resulting',
        group: false,
        terminal: 'none'
      },
      {
        name: 'after the group write, before durability (K7)',
        kill: 'K7',
        stop: 'hang',
        ports: (h, _records, reached) => ({
          deltas: {
            appendGroup: (input: Parameters<HostDeltaStore['appendGroup']>[0]) =>
              h.deltas.appendGroup(input),
            awaitDurable: hang(reached),
            getPosition: () => h.deltas.getPosition()
          }
        }),
        expected: (end) => ({
          action: 'complete_at_position',
          row: 'D3',
          position: end,
          markPublished: true
        }),
        chat: 'resulting',
        group: true,
        terminal: 'none'
      },
      {
        name: 'after durability, before published (K10)',
        kill: 'K10',
        stop: 'hang',
        ports: (h, _records, reached) => ({
          log: {
            append: (record: unknown) =>
              (record as { kind?: string })?.kind === 'published'
                ? hang(reached)()
                : h.log.append(record)
          }
        }),
        expected: (end) => ({
          action: 'complete_at_position',
          row: 'D3',
          position: end,
          markPublished: true
        }),
        chat: 'resulting',
        group: true,
        terminal: 'none'
      },
      {
        name: 'after published, before the receipt (K8)',
        kill: 'K8',
        stop: 'throw',
        ports: (h) => ({
          receipts: {
            complete: () => {
              throw new Error('injected stop at receipts.complete')
            },
            markIndeterminate: (
              input: Parameters<HostCommandReceiptStore['markIndeterminate']>[0]
            ) => h.receipts.markIndeterminate(input),
            demoteTransactionalCommand: (commandId: string) =>
              h.receipts.demoteTransactionalCommand(commandId)
          }
        }),
        expected: (end) => ({
          action: 'complete_at_position',
          row: 'D3',
          position: end,
          markPublished: false
        }),
        chat: 'resulting',
        group: true,
        terminal: 'published'
      },
      {
        name: 'after the receipt (K9)',
        kill: 'K9',
        stop: 'none',
        ports: () => ({}),
        expected: () => ({ action: 'none' }),
        chat: 'resulting',
        group: true,
        terminal: 'published'
      }
    ]

    function recoveryInput(h: Harness, commandId: string): HostTransactionRecoveryInput {
      // Fresh store instances over the same directory, as boot would open them.
      const deltas = new HostDeltaStore({ dataDir: h.dataDir, now: () => NOW_ISO })
      const receipts = new HostCommandReceiptStore({
        dataDir: h.dataDir,
        now: () => NOW_ISO,
        getPosition: () => deltas.getPosition(),
        scheduleCompaction: () => {}
      })
      const log = HostTransactionLog.open({ dataDir: h.dataDir })
      const record = receipts.list().find((entry) => entry.commandId === commandId) ?? null
      const entry = log.get(commandId)
      const group = deltas.findGroup(commandId)
      return {
        receipt: record
          ? {
              status: record.status,
              recoveryState: record.recoveryState ?? null,
              commandClass: record.commandClass ?? 'legacy-observed'
            }
          : null,
        prepare: entry?.prepare ?? null,
        terminal: entry?.terminal ?? null,
        observed: readIdentity(h.chatPath),
        group: group ? { count: group.count, setDigest: group.setDigest, end: group.end } : null
      }
    }

    it.each(boundaries.map((boundary) => [boundary.name, boundary] as const))(
      'stopped %s decides the harness row',
      async (_name, boundary) => {
        const h = harness()
        h.seed()
        const prior = readIdentity(h.chatPath)
        expect(prior).not.toBeNull()
        h.begin()
        let resulting: HostFileIdentity | null = null
        const capturing = renameSeam(h.records, (artifactPath, _threadId, real) => {
          resulting = artifactIdentityOf(artifactPath, lstatSync(artifactPath).size)
          return real()
        })
        const reached = deferred()
        const ports = h.withPorts({ records: capturing, ...boundary.ports(h, capturing, reached) })

        const running = h.execute({}, ports)
        if (boundary.stop === 'hang') {
          await reached.promise
          expect(await settledWithin(running)).toBe('pending')
          // Frozen, not finished: the lane is still the transaction's.
          expect(h.lane().owner).toBe(COMMAND_ID)
        } else {
          if (boundary.stop === 'throw') await expect(running).rejects.toThrow('injected stop')
          else expect((await running).kind).toBe('succeeded')
          expectLaneFree(h)
        }

        const input = recoveryInput(h, COMMAND_ID)
        expect(input.receipt?.commandClass).toBe('txn-record-persist')
        if (boundary.chat === 'prior') {
          expect(input.observed).toEqual(prior)
        } else {
          expect(resulting).not.toBeNull()
          expect(input.observed).toEqual(resulting)
        }
        if (boundary.group) {
          expect(input.group).not.toBeNull()
          expect(input.group?.count).toBeGreaterThan(0)
          expect(h.groupLines(COMMAND_ID)).toBe(1)
        } else {
          expect(input.group).toBeNull()
          expect(h.groupLines(COMMAND_ID)).toBe(0)
        }
        expect(input.terminal?.kind ?? 'none').toBe(boundary.terminal)
        const end = input.group?.end ?? { generation: 1, cursor: 0 }
        expect(decideHostTransactionRecovery(input)).toEqual(boundary.expected(end))
      }
    )

    /**
     * A port that throws is not a crash: the transaction handles it on the
     * spot, so the receipt is terminal or the state is one recovery decides
     * without an abort or a reset, and the lane is never left held.
     */
    const throwing: Array<[string, (h: Harness) => Partial<HostThreadRecordTransactionPorts>]> = [
      ['beginTicket', (h) => ({ records: { ...h.records, beginTicket: thrower('beginTicket') } })],
      ['identity', (h) => ({ records: { ...h.records, identity: thrower('identity') } })],
      ['committed', (h) => ({ records: { ...h.records, committed: thrower('committed') } })],
      [
        'log.append(published)',
        (h) => ({
          log: {
            append: (record: unknown) => {
              if ((record as { kind?: string })?.kind === 'published') thrower('log')()
              return h.log.append(record)
            }
          }
        })
      ]
    ]

    function thrower(name: string) {
      return () => {
        throw new Error(`injected throw at ${name}`)
      }
    }

    it.each(throwing)(
      'a throwing %s port never wedges: the lane is free and recovery needs no abort or reset',
      async (_name, overrides) => {
        const h = harness()
        h.seed()
        h.begin()
        const outcome = await settledWithin(h.execute({}, h.withPorts(overrides(h))), 2000)
        expect(outcome).not.toBe('pending')
        expectLaneFree(h)
        expect(h.transferListing()).toEqual([])
        const input = recoveryInput(h, COMMAND_ID)
        expect(input.receipt).not.toBeNull()
        const decision = decideHostTransactionRecovery(input)
        expect(['none', 'mark_published']).toContain(decision.action)
        if (input.receipt?.status === 'failed') {
          // A failure before the commit left the chat file alone and no group.
          expect(input.group).toBeNull()
          expect(input.observed).not.toEqual(input.prepare?.resulting ?? {})
        }
      }
    )
  })

  describe('13b. no concurrent synchronous write is ever lost', () => {
    type Point =
      | 'beginTicket'
      | 'log.append'
      | 'gate.enter'
      | 'syncChatsDirectory'
      | 'publicationLock'
      | 'awaitDurable'
    const points: Point[] = [
      'beginTicket',
      'log.append',
      'gate.enter',
      'syncChatsDirectory',
      'publicationLock',
      'awaitDurable'
    ]
    const timings = ['microtask', 'macrotask'] as const

    for (const point of points) {
      for (const timing of timings) {
        it(`a transcript append landing at ${point} (${timing}) survives`, async () => {
          const h = harness()
          h.seed()
          h.begin()
          const content = `written at ${point} (${timing})`
          let fired = 0
          const fire = (): void => {
            if (fired > 0) return
            fired += 1
            const write = (): void => {
              h.store.appendTranscript({ threadId: THREAD_ID, role: 'assistant', content })
            }
            if (timing === 'microtask') queueMicrotask(write)
            else setImmediate(write)
          }
          const settle = async (): Promise<void> => {
            if (timing === 'macrotask') await new Promise((resolve) => setImmediate(resolve))
          }
          const records: HostThreadRecordCommitPort = {
            ...h.records,
            beginTicket: async (threadId, projection) => {
              if (point === 'beginTicket') fire()
              const ticket = await h.records.beginTicket(threadId, projection)
              await settle()
              return ticket
            },
            syncChatsDirectory: async (threadId) => {
              if (point === 'syncChatsDirectory') fire()
              await h.records.syncChatsDirectory(threadId)
              await settle()
            }
          }
          const log: HostThreadRecordTransactionPorts['log'] = {
            append: async (record) => {
              const result = await h.log.append(record)
              if (point === 'log.append' && (record as { kind: string }).kind === 'prepare') {
                fire()
                await settle()
              }
              return result
            }
          }
          const gate: HostThreadRecordTransactionPorts['gate'] = {
            get closed() {
              return h.gate.closed
            },
            snapshot: () => h.gate.snapshot(),
            close: () => h.gate.close(),
            enter: async (mode, request) => {
              if (point === 'gate.enter') fire()
              const entered = await h.gate.enter(mode, request)
              await settle()
              return entered
            }
          }
          const lock = serialQueue()
          const publicationLock = <T>(work: () => Promise<T> | T): Promise<T> => {
            if (point === 'publicationLock') fire()
            return lock(async () => {
              await settle()
              return work()
            })
          }
          const deltas: HostThreadRecordTransactionPorts['deltas'] = {
            appendGroup: (input) => h.deltas.appendGroup(input),
            getPosition: () => h.deltas.getPosition(),
            awaitDurable: async () => {
              if (point === 'awaitDurable') fire()
              const durable = await h.deltas.awaitDurable()
              await settle()
              return durable
            }
          }
          const outcome = await h.execute(
            { descriptor: h.publish(stampedRecord(THREAD_ID, 1)).descriptor },
            h.withPorts({ records, log, gate, publicationLock, deltas })
          )
          await new Promise((resolve) => setImmediate(resolve))
          expect(fired).toBe(1)

          // The append is never lost, whichever side of the commit it landed on.
          const thread = h.store.getThread(THREAD_ID)
          expect(thread).not.toBeNull()
          const contents = thread!.messages.map((message) => message.content)
          expect(contents.length).toBeGreaterThan(0)
          expect(contents).toContain(content)
          if (outcome.kind === 'succeeded') {
            // Landed after the rename: its read-modify-write saw the commit.
            expect(thread!.title).toBe('Stamped 1')
          } else {
            // Landed before the check: the persist failed as a conflict.
            expect(outcome).toEqual({
              kind: 'failed',
              errorCode: 'thread_record_revision_conflict'
            })
            expect(h.log.get(COMMAND_ID)?.terminal?.kind).toBe('abort')
          }
          expectLaneFree(h)
        })
      }
    }
  })

  describe('createHostThreadRecordCommitPort', () => {
    it('reads the store state, identity, renames with an fsync, records the commit and discards by inode', async () => {
      const h = harness()
      expect(h.records.current(THREAD_ID)).toBeNull()
      expect(await h.records.identity(THREAD_ID)).toBeNull()
      h.seed()
      const state = h.records.current(THREAD_ID)
      expect(state).toMatchObject({ revision: 0, identity: readIdentity(h.chatPath) })
      expect(state?.key).toBe(await h.records.identityKey(THREAD_ID))
      expect(await h.records.identity(THREAD_ID)).toEqual(state?.identity)

      // A prepared artifact, renamed into place.
      const { descriptor } = h.publish(stampedRecord(THREAD_ID, 1))
      const prepared = prepareHostThreadRecord({
        profilePath: h.profilePath,
        threadId: THREAD_ID,
        descriptor,
        expectedRevision: 0,
        currentRevision: 0,
        now: NOW
      })
      expect(prepared.kind).toBe('prepared')
      if (prepared.kind !== 'prepared') return
      const artifactIdentity = artifactIdentityOf(
        prepared.artifact.path,
        prepared.artifact.byteLength
      )
      // A stale expected key renames nothing; the current one commits.
      expect(h.records.commitRename(prepared.artifact.path, THREAD_ID, 'stale-key')).toBe('changed')
      expect(h.records.commitRename(prepared.artifact.path, THREAD_ID, null)).toBe('changed')
      const currentKey = h.records.current(THREAD_ID)?.key ?? null
      expect(currentKey).not.toBeNull()
      expect(h.records.commitRename(prepared.artifact.path, THREAD_ID, currentKey)).toBe('renamed')
      await h.records.syncChatsDirectory(THREAD_ID)
      expect(readIdentity(h.chatPath)).toEqual(artifactIdentity)
      expect(h.transferListing()).toEqual([])
      const summary: HostProfileThreadSummary | null = prepared.summary
      expect(summary).not.toBeNull()
      h.records.committed(THREAD_ID, prepared.persistenceRevision, summary)
      expect(h.records.current(THREAD_ID)).toMatchObject({
        revision: 1,
        identity: artifactIdentity
      })
      expect(h.store.listThreadSummaries().map((entry) => entry.persistenceRevision)).toEqual([1])

      // Discard removes exactly the prepared inode and leaves a replacement alone.
      const { descriptor: second } = h.publish(stampedRecord(THREAD_ID, 2), 'transfer-2')
      const preparedTwo = prepareHostThreadRecord({
        profilePath: h.profilePath,
        threadId: THREAD_ID,
        descriptor: second,
        expectedRevision: 1,
        currentRevision: 1,
        now: NOW
      })
      expect(preparedTwo.kind).toBe('prepared')
      if (preparedTwo.kind !== 'prepared') return
      expect(h.transferListing()).toHaveLength(1)
      h.records.discard(preparedTwo.artifact)
      expect(h.transferListing()).toEqual([])
      // A substitute at the same path is not the prepared inode: left alone.
      const { descriptor: third } = h.publish(stampedRecord(THREAD_ID, 3), 'transfer-2')
      expect(third.transferId).toBe(second.transferId)
      h.records.discard(preparedTwo.artifact)
      expect(h.transferListing()).toHaveLength(1)
    })
  })
})
