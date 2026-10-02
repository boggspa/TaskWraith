/**
 * Independent Threads M4 slice 14b (design §24.3; tests owed, item 2): the
 * standalone composition's boot recovery wiring.
 *
 * - The clean-exit marker (SF-1): a clean shutdown writes it as its last step,
 *   after `onShutdown`; the next composition over the same runtime path reads
 *   `previousExitClean`; one never shut down, or one whose shutdown threw,
 *   leaves none; a marker that cannot be written is swallowed.
 * - `recoverTransactions()`: memoized; with the transaction wired it runs over
 *   the transaction's own manifest and resets the generation exactly once on
 *   an unclean exit (decision 2) and not at all on a clean one; a D1 resets
 *   anyway, once, and its receipt succeeds at the reset position, with the
 *   transaction's own `profilePath` winning over the input's; with the flag
 *   off it recovers a manifest, or a transactional receipt, that exists, and
 *   otherwise resolves null without creating a manifest file.
 *
 * States are built over real stores in the runtime directory the way
 * `HostTransactionRecovery.test.ts` builds them (helpers copied, not
 * imported), before the composition opens the same directory.
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
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { HostCursorPosition } from '../shared/hostProtocol'
import {
  consumeHostCleanExit,
  HOST_CLEAN_EXIT_FILENAME,
  recordHostCleanExit
} from './HostCleanExit'
import { HostCommandReceiptStore, type HostCommandReceiptRecord } from './HostCommandReceiptStore'
import { HostDeltaStore } from './HostDeltaStore'
import { HostProfileDomainStore } from './HostProfileDomainStore'
import { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
import {
  createHostStandaloneComposition,
  type HostStandaloneComposition,
  type HostStandaloneCompositionInput,
  type HostStandaloneThreadRecordTransactionInput
} from './HostStandaloneComposition'
import { prepareHostThreadRecord } from './HostThreadRecordPrepare'
import {
  createHostThreadRecordCommitPort,
  type HostThreadRecordCommitPort
} from './HostThreadRecordTransaction'
import { HOST_TRANSACTION_LOG_FILENAME, HostTransactionLog } from './HostTransactionLog'
import type { HostFileIdentity } from './HostTransactionManifest'

const TIMEOUT = 15_000
const NOW_MS = 1_760_000_000_000
const NOW_ISO = new Date(NOW_MS).toISOString()
const BOOT_EPOCH = 'd'.repeat(64)
const EPOCH = { hostIncarnation: 'recovery-wiring-incarnation', deleteCounter: 0 }
const ACTOR = {
  actorId: 'recovery-actor',
  clientId: 'recovery-client',
  clientClass: 'desktop' as const
}

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// State builders, copied from HostTransactionRecovery.test.ts: the stores live
// in the runtime directory, the chat files and staged artifacts in the profile.
// ---------------------------------------------------------------------------

interface Stores {
  deltas: HostDeltaStore
  receipts: HostCommandReceiptStore
  log: HostTransactionLog
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function identityOf(path: string): HostFileIdentity | null {
  try {
    const stat = lstatSync(path, { bigint: true })
    return { dev: stat.dev.toString(), ino: stat.ino.toString(), size: Number(stat.size) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function openStores(runtimePath: string): Stores {
  mkdirSync(runtimePath, { recursive: true })
  const deltas = new HostDeltaStore({
    dataDir: runtimePath,
    now: () => NOW_ISO,
    compactAfterRecords: 10_000
  })
  const receipts = new HostCommandReceiptStore({
    dataDir: runtimePath,
    now: () => NOW_ISO,
    getPosition: () => deltas.getPosition(),
    compactAfterRecords: 1000,
    scheduleCompaction: () => {}
  })
  const log = HostTransactionLog.open({ dataDir: runtimePath })
  return { deltas, receipts, log }
}

function beginReceipt(
  stores: Stores,
  commandId: string,
  threadId: string,
  commandClass: 'txn-record-persist' | 'legacy-observed' | 'none' = 'txn-record-persist'
): void {
  const begun = stores.receipts.begin({
    commandId,
    idempotencyKey: `${commandId}-key`,
    commandName: 'thread.record.persist',
    commandFingerprint: sha256(commandId),
    actor: ACTOR,
    target: { kind: 'thread', id: threadId },
    authority: { decision: 'allowed' },
    ...(commandClass === 'none' ? {} : { commandClass })
  })
  if (begun.kind !== 'created') throw new Error(`begin: ${JSON.stringify(begun)}`)
}

function writeIdentified(path: string, content: string): HostFileIdentity {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  const identity = identityOf(path)
  if (!identity) throw new Error(`no identity for ${path}`)
  return identity
}

async function appendDurable(stores: Stores, record: unknown): Promise<void> {
  const result = await stores.log.append(record)
  if (result.kind !== 'durable')
    throw new Error(`manifest append failed: ${JSON.stringify(result)}`)
}

let recordClock = 9000

function prepareRecord(
  commandId: string,
  threadId: string,
  prior: HostFileIdentity | null,
  resulting: HostFileIdentity
): Record<string, unknown> {
  return {
    kind: 'prepare',
    commandId,
    threadId,
    epoch: EPOCH,
    expectedRevision: prior === null ? 0 : 1,
    resultingRevision: prior === null ? 0 : 2,
    prior,
    resulting,
    effects: { count: 1, setDigest: sha256(commandId) },
    preparedAt: recordClock++
  }
}

interface Paths {
  profilePath: string
  runtimePath: string
}

function chatPath(paths: Paths, threadId: string): string {
  return join(paths.profilePath, 'chats', `${threadId}.json`)
}

/** An earlier persist's chat file at revision 1 and its delta. */
function seedPrior(paths: Paths, stores: Stores, threadId: string): HostFileIdentity {
  const identity = writeIdentified(
    chatPath(paths, threadId),
    JSON.stringify({ id: threadId, revision: 1 })
  )
  const seeded = stores.deltas.append({
    kind: 'upsert',
    family: 'thread',
    entityId: threadId,
    payload: { title: 'Prior' }
  })
  if (seeded.kind !== 'appended') throw new Error(`seed: ${JSON.stringify(seeded)}`)
  return identity
}

function stageArtifact(
  paths: Paths,
  commandId: string,
  threadId: string
): { artifactPath: string; resulting: HostFileIdentity } {
  const artifactPath = join(paths.profilePath, 'staged', `${commandId}.record.json`)
  const resulting = writeIdentified(
    artifactPath,
    JSON.stringify({ id: threadId, revision: 2, title: `Persisted by ${commandId}` }) + '\n'
  )
  return { artifactPath, resulting }
}

/** D1: prepared and committed (the rename happened), no group. */
async function buildD1(
  paths: Paths,
  stores: Stores,
  commandId: string,
  threadId: string
): Promise<{ resulting: HostFileIdentity }> {
  const prior = seedPrior(paths, stores, threadId)
  beginReceipt(stores, commandId, threadId)
  const { artifactPath, resulting } = stageArtifact(paths, commandId, threadId)
  await appendDurable(stores, prepareRecord(commandId, threadId, prior, resulting))
  mkdirSync(join(paths.profilePath, 'chats'), { recursive: true })
  renameSync(artifactPath, chatPath(paths, threadId))
  return { resulting }
}

/** D3 without a mark: committed, its group durable, receipt pending, no `published`. */
async function buildD3(
  paths: Paths,
  stores: Stores,
  commandId: string,
  threadId: string
): Promise<{ end: HostCursorPosition }> {
  await buildD1(paths, stores, commandId, threadId)
  const appended = stores.deltas.appendGroup({
    commandId,
    effects: [
      {
        kind: 'upsert' as const,
        family: 'thread' as const,
        entityId: threadId,
        payload: { title: `Persisted by ${commandId}` }
      }
    ]
  })
  if (appended.kind !== 'appended') throw new Error(`appendGroup: ${JSON.stringify(appended)}`)
  const durable = await stores.deltas.awaitDurable()
  if (durable.kind !== 'durable') throw new Error(`awaitDurable: ${JSON.stringify(durable)}`)
  return { end: appended.group.end }
}

function position(value: { generation: number; cursor: number }): HostCursorPosition {
  return { generation: value.generation, cursor: value.cursor }
}

function receiptOf(runtimePath: string, commandId: string): HostCommandReceiptRecord | null {
  const reopened = new HostRuntimeBootstrap({ hostDataDir: runtimePath })
  return reopened.receiptStore.list().find((record) => record.commandId === commandId) ?? null
}

function markerPath(runtimePath: string): string {
  return join(runtimePath, HOST_CLEAN_EXIT_FILENAME)
}

function manifestExists(runtimePath: string): boolean {
  return existsSync(join(runtimePath, HOST_TRANSACTION_LOG_FILENAME))
}

/** Counts every generation reset the composition delivers from now on. */
function watchResets(composition: HostStandaloneComposition): {
  resets: () => number
  stop: () => void
} {
  let resets = 0
  const stop = composition.subscribeDeltas((event) => {
    if (event.record.envelope.kind === 'generation-reset') resets += 1
  })
  return { resets: () => resets, stop }
}

// ---------------------------------------------------------------------------
// The composition over a real profile, as the seed and txnPersist suites build it.
// ---------------------------------------------------------------------------

interface Profile extends Paths {
  store: HostProfileDomainStore
  records: HostThreadRecordCommitPort
  base: Omit<HostStandaloneCompositionInput, 'threadRecordTransaction' | 'profilePath'>
  transactionInput(): HostStandaloneThreadRecordTransactionInput
}

function profile(options: { onShutdown?: () => void | Promise<void> } = {}): Profile {
  const profilePath = mkdtempSync(join(tmpdir(), 'host-standalone-recovery-'))
  roots.push(profilePath)
  const runtimePath = join(profilePath, 'host-data')
  const store = new HostProfileDomainStore({
    profilePath,
    authority: { assertProfileAuthority: () => undefined },
    now: () => NOW_MS
  })
  const records = createHostThreadRecordCommitPort({
    store,
    profilePath,
    beginTicket: async () => ({ finish: () => undefined, fail: () => undefined })
  })
  const base: Profile['base'] = {
    runtimePath,
    lease: { assertHeld: () => undefined },
    host: { hostId: 'standalone-host', hostVersion: '1.0.0' },
    hostCapabilityOffer: ['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts', 'health'],
    bootEpochFactory: () => BOOT_EPOCH,
    now: () => NOW_ISO,
    snapshotDonor: () => ({
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
    }),
    authorityEvaluator: () => ({ decision: 'allowed' }),
    commandExecutor: () => ({ status: 'succeeded', resultSummary: 'legacy' }),
    healthProvider: () => ({
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: false,
      freshness: 'live'
    }),
    ...(options.onShutdown ? { onShutdown: options.onShutdown } : {})
  }
  return {
    profilePath,
    runtimePath,
    store,
    records,
    base,
    transactionInput: () => ({
      profilePath,
      records,
      prepare: async (input) => prepareHostThreadRecord(input),
      now: () => NOW_MS
    })
  }
}

describe('HostStandaloneComposition: the clean-exit marker (M4 slice 14b, SF-1)', () => {
  it(
    'a fresh runtime path reads unclean; a clean shutdown writes the marker, and the next composition over the same runtime path reads clean and consumes it',
    async () => {
      const p = profile()
      const first = createHostStandaloneComposition({ ...p.base })
      expect(first.previousExitClean).toBe(false)
      expect(existsSync(markerPath(p.runtimePath))).toBe(false)
      await first.shutdown()
      expect(lstatSync(markerPath(p.runtimePath)).isFile()).toBe(true)

      const second = createHostStandaloneComposition({ ...p.base })
      try {
        expect(second.previousExitClean).toBe(true)
        // Consumed at creation: a crash from here reads unclean next boot.
        expect(existsSync(markerPath(p.runtimePath))).toBe(false)
        expect(consumeHostCleanExit(p.runtimePath)).toBe(false)
      } finally {
        await second.shutdown()
      }
      // The second's own clean shutdown wrote a fresh marker.
      expect(existsSync(markerPath(p.runtimePath))).toBe(true)
    },
    TIMEOUT
  )

  it(
    'no shutdown reads unclean: a composition never shut down leaves no marker for the next one',
    async () => {
      const p = profile()
      const abandoned = createHostStandaloneComposition({ ...p.base })
      const next = createHostStandaloneComposition({ ...p.base })
      try {
        expect(existsSync(markerPath(p.runtimePath))).toBe(false)
        expect(next.previousExitClean).toBe(false)
      } finally {
        await next.shutdown()
        await abandoned.shutdown()
      }
    },
    TIMEOUT
  )

  it(
    'the marker is written last, after onShutdown; a shutdown that throws writes no marker, and the retried shutdown does',
    async () => {
      let markerSeenByOnShutdown: boolean | null = null
      let failShutdown = true
      const p = profile({
        onShutdown: () => {
          markerSeenByOnShutdown = existsSync(markerPath(p.runtimePath))
          if (failShutdown) throw new Error('injected onShutdown failure')
        }
      })
      const composition = createHostStandaloneComposition({ ...p.base })

      await expect(composition.shutdown()).rejects.toThrow('injected onShutdown failure')
      expect(markerSeenByOnShutdown).toBe(false)
      expect(existsSync(markerPath(p.runtimePath))).toBe(false)
      // A crash now reads unclean.
      const afterFailure = createHostStandaloneComposition({ ...p.base })
      expect(afterFailure.previousExitClean).toBe(false)

      failShutdown = false
      markerSeenByOnShutdown = null
      await composition.shutdown()
      expect(markerSeenByOnShutdown).toBe(false)
      expect(lstatSync(markerPath(p.runtimePath)).isFile()).toBe(true)
      await afterFailure.shutdown()
    },
    TIMEOUT
  )

  it(
    'a marker that cannot be written is swallowed: shutdown resolves and the next boot reads unclean',
    async () => {
      let onShutdownCalls = 0
      const p = profile({
        onShutdown: () => {
          onShutdownCalls += 1
        }
      })
      const composition = createHostStandaloneComposition({ ...p.base })
      // A directory where the marker goes: the rename into place fails.
      mkdirSync(markerPath(p.runtimePath), { recursive: true })

      await expect(composition.shutdown()).resolves.toBeUndefined()
      expect(onShutdownCalls).toBe(1)
      expect(lstatSync(markerPath(p.runtimePath)).isDirectory()).toBe(true)

      const next = createHostStandaloneComposition({ ...p.base })
      try {
        expect(next.previousExitClean).toBe(false)
      } finally {
        await next.shutdown()
      }
    },
    TIMEOUT
  )
})

describe('HostStandaloneComposition.recoverTransactions (M4 slice 14b, §24.3)', () => {
  it(
    'flag on, unclean exit: recovery over the transaction’s manifest resets the generation exactly once with no D1, and is memoized',
    async () => {
      const p = profile()
      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput()
      })
      const watch = watchResets(composition)
      try {
        expect(composition.previousExitClean).toBe(false)
        const before = position(composition.getPosition())

        const first = composition.recoverTransactions()
        const second = composition.recoverTransactions()
        const report = await first
        expect(report).not.toBeNull()
        expect(await second).toBe(report)

        expect(report!.reset).not.toBeNull()
        expect(position(report!.reset!)).toEqual(position(composition.getPosition()))
        expect(report!.reset!.generation).toBe(before.generation + 1)
        expect(report!.counts['reset_and_complete'] ?? 0).toBe(0)
        expect(report!.decisions.size).toBe(0)
        expect(watch.resets()).toBe(1)

        // Memoized: a third call after settlement neither re-runs nor resets again.
        expect(await composition.recoverTransactions()).toBe(report)
        expect(watch.resets()).toBe(1)
        expect(position(composition.getPosition())).toEqual(position(report!.reset!))
      } finally {
        watch.stop()
        await composition.shutdown()
      }
    },
    TIMEOUT
  )

  it(
    'flag on, clean exit: recovery runs but does not reset',
    async () => {
      const p = profile()
      mkdirSync(p.runtimePath, { recursive: true })
      recordHostCleanExit(p.runtimePath, () => NOW_MS)
      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput()
      })
      const watch = watchResets(composition)
      try {
        expect(composition.previousExitClean).toBe(true)
        const before = position(composition.getPosition())

        const report = await composition.recoverTransactions()
        expect(report).not.toBeNull()
        expect(report!.reset).toBeNull()
        expect(report!.decisions.size).toBe(0)
        expect(watch.resets()).toBe(0)
        expect(position(composition.getPosition())).toEqual(before)
      } finally {
        watch.stop()
        await composition.shutdown()
      }
    },
    TIMEOUT
  )

  it(
    'flag off, no manifest and no transactional receipt: null, memoized, and no manifest file is created',
    async () => {
      const p = profile()
      // A legacy receipt is not a reason to open the manifest. (Terminal,
      // because the store promotes a pending legacy receipt on reopen anyway.)
      const stores = openStores(p.runtimePath)
      beginReceipt(stores, 'cmd-legacy', 'thread-legacy', 'legacy-observed')
      stores.receipts.complete({ commandId: 'cmd-legacy', status: 'succeeded' })
      expect(manifestExists(p.runtimePath)).toBe(false)

      const composition = createHostStandaloneComposition({
        ...p.base,
        profilePath: p.profilePath
      })
      const watch = watchResets(composition)
      try {
        const first = composition.recoverTransactions()
        const second = composition.recoverTransactions()
        expect(await first).toBeNull()
        expect(await second).toBeNull()
        expect(await composition.recoverTransactions()).toBeNull()
        expect(watch.resets()).toBe(0)
        expect(manifestExists(p.runtimePath)).toBe(false)
        expect(readdirSync(p.runtimePath)).not.toContain(HOST_TRANSACTION_LOG_FILENAME)
      } finally {
        watch.stop()
        await composition.shutdown()
      }
      expect(manifestExists(p.runtimePath)).toBe(false)
      const legacy = receiptOf(p.runtimePath, 'cmd-legacy')
      expect(legacy?.status).toBe('succeeded')
      expect(legacy).not.toHaveProperty('recoveryState')
    },
    TIMEOUT
  )

  it(
    'flag off with a manifest holding a D3 state: recovered, the receipt completes at the group’s end, no reset',
    async () => {
      const p = profile()
      const built = await buildD3(p, openStores(p.runtimePath), 'cmd-d3', 'thread-d3')
      expect(manifestExists(p.runtimePath)).toBe(true)

      const composition = createHostStandaloneComposition({
        ...p.base,
        profilePath: p.profilePath
      })
      const watch = watchResets(composition)
      try {
        const report = await composition.recoverTransactions()
        expect(report).not.toBeNull()
        expect(report!.decisions.get('cmd-d3')).toEqual({
          action: 'complete_at_position',
          row: 'D3',
          position: built.end,
          markPublished: true
        })
        expect(report!.counts['complete_at_position']).toBe(1)
        expect(report!.reset).toBeNull()
        expect(watch.resets()).toBe(0)
        expect(await composition.recoverTransactions()).toBe(report)
      } finally {
        watch.stop()
        await composition.shutdown()
      }

      const receipt = receiptOf(p.runtimePath, 'cmd-d3')
      expect(receipt?.status).toBe('succeeded')
      expect(receipt).not.toHaveProperty('recoveryState')
      expect(position({ generation: receipt!.generation!, cursor: receipt!.cursor! })).toEqual(
        position(built.end)
      )
      const entry = HostTransactionLog.open({ dataDir: p.runtimePath }).get('cmd-d3')
      // Recovery succeeded at the durable group position; maintenance retires
      // the terminal manifest once that durable receipt is its authority.
      expect(entry).toBeNull()
    },
    TIMEOUT
  )

  it(
    'flag off with a transactional receipt and no manifest: recovered (failed interrupted), and still no manifest file',
    async () => {
      const p = profile()
      const stores = openStores(p.runtimePath)
      beginReceipt(stores, 'cmd-never-prepared', 'thread-np', 'txn-record-persist')
      expect(manifestExists(p.runtimePath)).toBe(false)

      const composition = createHostStandaloneComposition({
        ...p.base,
        profilePath: p.profilePath
      })
      try {
        const report = await composition.recoverTransactions()
        expect(report).not.toBeNull()
        expect(report!.decisions.get('cmd-never-prepared')).toEqual({
          action: 'fail_interrupted',
          row: 'D4',
          writeAbort: false,
          completeReceipt: true
        })
        expect(report!.reset).toBeNull()
      } finally {
        await composition.shutdown()
      }
      const receipt = receiptOf(p.runtimePath, 'cmd-never-prepared')
      expect(receipt).toMatchObject({ status: 'failed', errorCode: 'interrupted' })
      // Nothing was appended, so nothing created the file.
      expect(manifestExists(p.runtimePath)).toBe(false)
    },
    TIMEOUT
  )

  it(
    'flag off with a manifest and no profilePath: recovery rejects and the receipt stays pending',
    async () => {
      const p = profile()
      await buildD3(p, openStores(p.runtimePath), 'cmd-d3', 'thread-d3')
      const manifestBefore = readFileSync(
        join(p.runtimePath, HOST_TRANSACTION_LOG_FILENAME),
        'utf8'
      )

      const composition = createHostStandaloneComposition({ ...p.base })
      try {
        await expect(composition.recoverTransactions()).rejects.toThrow()
        // Memoized rejection: the second call does not silently succeed.
        await expect(composition.recoverTransactions()).rejects.toThrow()
      } finally {
        await composition.shutdown()
      }
      expect(receiptOf(p.runtimePath, 'cmd-d3')?.status).toBe('pending')
      expect(readFileSync(join(p.runtimePath, HOST_TRANSACTION_LOG_FILENAME), 'utf8')).toBe(
        manifestBefore
      )
    },
    TIMEOUT
  )

  it(
    'flag on with a D1 state on an unclean exit: one reset, the receipt succeeds at the reset position, and the transaction’s profilePath wins over the input’s',
    async () => {
      const p = profile()
      const built = await buildD1(p, openStores(p.runtimePath), 'cmd-d1', 'thread-d1')
      expect(identityOf(chatPath(p, 'thread-d1'))).toEqual(built.resulting)

      const composition = createHostStandaloneComposition({
        ...p.base,
        // Wrong on purpose: the transaction's own profilePath is where the
        // committed chat file is, and only there is this a D1.
        profilePath: join(p.profilePath, 'not-the-profile'),
        threadRecordTransaction: p.transactionInput()
      })
      const watch = watchResets(composition)
      let reset: HostCursorPosition
      try {
        expect(composition.previousExitClean).toBe(false)
        const before = position(composition.getPosition())

        const report = await composition.recoverTransactions()
        expect(report).not.toBeNull()
        expect(report!.decisions.get('cmd-d1')).toEqual({ action: 'reset_and_complete', row: 'D1' })
        expect(report!.counts['reset_and_complete']).toBe(1)
        expect(report!.reset).not.toBeNull()
        reset = position(report!.reset!)
        expect(reset.generation).toBe(before.generation + 1)
        // Unclean exit AND a D1: still exactly one reset.
        expect(watch.resets()).toBe(1)
        expect(position(composition.getPosition())).toEqual(reset)
        expect(await composition.recoverTransactions()).toBe(report)
        expect(watch.resets()).toBe(1)
      } finally {
        watch.stop()
        await composition.shutdown()
      }

      const receipt = receiptOf(p.runtimePath, 'cmd-d1')
      expect(receipt?.status).toBe('succeeded')
      expect(receipt).not.toHaveProperty('recoveryState')
      expect(position({ generation: receipt!.generation!, cursor: receipt!.cursor! })).toEqual(
        reset!
      )
      const entry = HostTransactionLog.open({ dataDir: p.runtimePath }).get('cmd-d1')
      // The committed inode and succeeded receipt survive terminal compaction.
      expect(entry).toBeNull()
      expect(identityOf(chatPath(p, 'thread-d1'))).toEqual(built.resulting)
    },
    TIMEOUT
  )

  it(
    'flag on with a D1 state on a clean exit: the D1 still resets, once',
    async () => {
      const p = profile()
      await buildD1(p, openStores(p.runtimePath), 'cmd-d1', 'thread-d1')
      recordHostCleanExit(p.runtimePath, () => NOW_MS)

      const composition = createHostStandaloneComposition({
        ...p.base,
        threadRecordTransaction: p.transactionInput()
      })
      const watch = watchResets(composition)
      try {
        expect(composition.previousExitClean).toBe(true)
        const report = await composition.recoverTransactions()
        expect(report?.decisions.get('cmd-d1')).toEqual({ action: 'reset_and_complete', row: 'D1' })
        expect(report?.reset).not.toBeNull()
        expect(watch.resets()).toBe(1)
      } finally {
        watch.stop()
        await composition.shutdown()
      }
      expect(receiptOf(p.runtimePath, 'cmd-d1')?.status).toBe('succeeded')
    },
    TIMEOUT
  )
})
