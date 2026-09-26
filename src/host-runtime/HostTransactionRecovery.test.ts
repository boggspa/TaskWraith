import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
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
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostCommandReceiptStore, type HostCommandReceiptRecord } from './HostCommandReceiptStore'
import { HostDeltaStore, type HostDeltaAppendResult } from './HostDeltaStore'
import { HostTransactionLog } from './HostTransactionLog'
import type { HostFileIdentity } from './HostTransactionManifest'
import { HOST_THREAD_RECORD_TRANSFER_DIRECTORY } from './HostThreadRecordTransfer'
import {
  recoverHostTransactions,
  type HostTransactionRecoveryPorts,
  type HostTransactionRecoveryReport
} from './HostTransactionRecovery'
import type { HostCursorPosition } from '../shared/hostProtocol'

// M4 slice 14a (design §24.1): the production transaction recovery driver,
// over real stores in a temp directory. Each state is built the way the
// slice 10 crash harness builds it (receipt `begin` with the transactional
// class, an artifact whose identity the prepare carries, a rename over
// `chats/<id>.json` for the commit, a group for the publication), then the
// driver runs on FRESH store instances, and every durability claim is checked
// by reopening the stores again afterwards.

const TEST_TIMEOUT = 15_000
const NOW_ISO = '2026-09-26T09:00:00.000Z'
const EPOCH = { hostIncarnation: 'recovery-test-incarnation', deleteCounter: 0 }
const ACTOR = {
  actorId: 'recovery-actor',
  clientId: 'recovery-client',
  clientClass: 'desktop' as const
}
const RESET_POSITION: HostCursorPosition = { generation: 2, cursor: 1 }

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

function openStores(dir: string): Stores {
  const deltas = new HostDeltaStore({
    dataDir: dir,
    now: () => NOW_ISO,
    compactAfterRecords: 10_000
  })
  const receipts = new HostCommandReceiptStore({
    dataDir: dir,
    now: () => NOW_ISO,
    getPosition: () => deltas.getPosition(),
    compactAfterRecords: 1000,
    scheduleCompaction: () => {}
  })
  const log = HostTransactionLog.open({ dataDir: dir })
  return { deltas, receipts, log }
}

function chatPath(dir: string, threadId: string): string {
  return join(dir, 'chats', `${threadId}.json`)
}

function transferDir(dir: string): string {
  return join(dir, HOST_THREAD_RECORD_TRANSFER_DIRECTORY)
}

function receiptOf(stores: Stores, commandId: string): HostCommandReceiptRecord | null {
  return stores.receipts.list().find((record) => record.commandId === commandId) ?? null
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

/** Write a file and return its identity, the way the executor reads its artifact back. */
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

let recordClock = 7000

function prepareRecord(
  commandId: string,
  threadId: string,
  prior: HostFileIdentity | null,
  resulting: HostFileIdentity,
  revision: number
): Record<string, unknown> {
  return {
    kind: 'prepare',
    commandId,
    threadId,
    epoch: EPOCH,
    expectedRevision: prior === null ? 0 : revision - 1,
    resultingRevision: prior === null ? 0 : revision,
    prior,
    resulting,
    effects: { count: 1, setDigest: sha256(commandId) },
    preparedAt: recordClock++
  }
}

function effectsFor(threadId: string, title: string) {
  return [
    { kind: 'upsert' as const, family: 'thread' as const, entityId: threadId, payload: { title } }
  ]
}

/**
 * The prior file, when asked for: an earlier persist's record at revision 1
 * and its delta, so the group's end is past the seed.
 */
function seedPrior(dir: string, stores: Stores, threadId: string): HostFileIdentity {
  const identity = writeIdentified(
    chatPath(dir, threadId),
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

interface StateOptions {
  /** Where the artifact is staged; the transfer directory only for sweep tests. */
  artifactDir?: string
  artifactName?: string
  prior?: boolean
  /** Promote the pending receipt to a recoverable indeterminate before recovery. */
  promote?: boolean
}

interface BuiltState {
  prior: HostFileIdentity | null
  resulting: HostFileIdentity
  artifactPath: string
}

function stageArtifact(
  dir: string,
  commandId: string,
  threadId: string,
  options: StateOptions
): { artifactPath: string; resulting: HostFileIdentity } {
  const artifactPath = join(
    options.artifactDir ?? join(dir, 'staged'),
    options.artifactName ?? `${commandId}.record.json`
  )
  const resulting = writeIdentified(
    artifactPath,
    JSON.stringify({ id: threadId, revision: 2, title: `Persisted by ${commandId}` }) + '\n'
  )
  return { artifactPath, resulting }
}

function promoteIfAsked(stores: Stores, commandId: string, options: StateOptions): void {
  if (!options.promote) return
  const marked = stores.receipts.markIndeterminate({
    commandId,
    position: stores.deltas.getPosition(),
    errorCode: 'transaction_commit_indeterminate'
  })
  if (marked.kind !== 'marked') throw new Error(`promote: ${JSON.stringify(marked)}`)
}

/** D1: prepared and committed (the rename happened), no group. */
async function buildD1(
  dir: string,
  stores: Stores,
  commandId: string,
  threadId: string,
  options: StateOptions = {}
): Promise<BuiltState> {
  const prior = options.prior ? seedPrior(dir, stores, threadId) : null
  beginReceipt(stores, commandId, threadId)
  const { artifactPath, resulting } = stageArtifact(dir, commandId, threadId, options)
  await appendDurable(stores, prepareRecord(commandId, threadId, prior, resulting, 2))
  mkdirSync(join(dir, 'chats'), { recursive: true })
  renameSync(artifactPath, chatPath(dir, threadId))
  promoteIfAsked(stores, commandId, options)
  return { prior, resulting, artifactPath }
}

/** D3: committed and its group durable; `published` and the receipt as asked. */
async function buildD3(
  dir: string,
  stores: Stores,
  commandId: string,
  threadId: string,
  options: StateOptions & { published?: boolean; receipt?: 'pending' | 'succeeded' } = {}
): Promise<BuiltState & { end: HostCursorPosition }> {
  const built = await buildD1(dir, stores, commandId, threadId, { ...options, promote: false })
  const appended = stores.deltas.appendGroup({
    commandId,
    effects: effectsFor(threadId, `Persisted by ${commandId}`)
  })
  if (appended.kind !== 'appended') throw new Error(`appendGroup: ${JSON.stringify(appended)}`)
  const durable = await stores.deltas.awaitDurable()
  if (durable.kind !== 'durable') throw new Error(`awaitDurable: ${JSON.stringify(durable)}`)
  const end = appended.group.end
  if (options.published) {
    await appendDurable(stores, { kind: 'published', commandId, position: end, at: recordClock++ })
  }
  if (options.receipt === 'succeeded') {
    stores.receipts.complete({ commandId, status: 'succeeded', position: end })
  }
  promoteIfAsked(stores, commandId, options)
  return { ...built, end }
}

/** D4: prepared and never committed (the artifact still staged), or never prepared. */
async function buildD4(
  dir: string,
  stores: Stores,
  commandId: string,
  threadId: string,
  options: StateOptions & {
    prepared?: boolean
    aborted?: boolean
    receipt?: 'pending' | 'failed'
  } = {}
): Promise<BuiltState> {
  const prior = options.prior ? seedPrior(dir, stores, threadId) : null
  beginReceipt(stores, commandId, threadId)
  const { artifactPath, resulting } = stageArtifact(dir, commandId, threadId, options)
  if (options.prepared !== false) {
    await appendDurable(stores, prepareRecord(commandId, threadId, prior, resulting, 2))
    if (options.aborted) {
      await appendDurable(stores, {
        kind: 'abort',
        commandId,
        reason: 'interrupted',
        at: recordClock++
      })
    }
  }
  if (options.receipt === 'failed') {
    stores.receipts.complete({ commandId, status: 'failed', errorCode: 'lane_refused' })
  }
  promoteIfAsked(stores, commandId, options)
  return { prior, resulting, artifactPath }
}

function portsFor(
  dir: string,
  stores: Stores,
  overrides: Partial<HostTransactionRecoveryPorts> = {}
): HostTransactionRecoveryPorts {
  return {
    receipts: stores.receipts,
    log: stores.log,
    deltas: stores.deltas,
    profilePath: dir,
    now: () => recordClock++,
    ...overrides
  }
}

async function recover(
  dir: string,
  reset: 'when-needed' | 'always' = 'when-needed',
  overrides: Partial<HostTransactionRecoveryPorts> = {}
): Promise<{ report: HostTransactionRecoveryReport; stores: Stores }> {
  const stores = openStores(dir)
  const report = await recoverHostTransactions(portsFor(dir, stores, overrides), { reset })
  return { report, stores }
}

function count(report: HostTransactionRecoveryReport, action: string): number {
  return report.counts[action] ?? 0
}

function snapshotFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.set(relative(dir, path), readFileSync(path).toString('hex'))
    }
  }
  walk(dir)
  return files
}

function deltaJournalLines(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith('host-deltas.journal') && name.endsWith('.jsonl'))
    .sort()
    .flatMap((name) =>
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
    )
}

function resetLines(dir: string): number {
  return deltaJournalLines(dir).filter(
    (line) => (JSON.parse(line) as { op: string }).op === 'generation-reset'
  ).length
}

function groupLines(dir: string, commandId: string): number {
  return deltaJournalLines(dir).filter((line) => {
    const event = JSON.parse(line) as { op: string; commandId?: string }
    return event.op === 'group' && event.commandId === commandId
  }).length
}

function expectReceipt(
  record: HostCommandReceiptRecord | null,
  status: HostCommandReceiptRecord['status'],
  position?: HostCursorPosition
): void {
  expect(record?.status).toBe(status)
  expect(record).not.toHaveProperty('recoveryState')
  if (position) {
    expect({ generation: record?.generation, cursor: record?.cursor }).toEqual(position)
  }
}

describe('recoverHostTransactions (M4 slice 14a)', () => {
  const roots: string[] = []

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'host-transaction-recovery-'))
    roots.push(dir)
    mkdirSync(join(dir, 'chats'))
    return dir
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  describe('1. each action path over real stores', () => {
    for (const promote of [false, true]) {
      const label = promote ? ' (receipt promoted recoverable-indeterminate)' : ''

      it(
        `D1: one reset, published at the reset position, then the receipt${label}`,
        async () => {
          const dir = freshDir()
          const built = await buildD1(dir, openStores(dir), 'cmd-d1', 't-1', {
            prior: true,
            promote
          })
          const { report } = await recover(dir)

          expect(report.decisions.get('cmd-d1')).toEqual({
            action: 'reset_and_complete',
            row: 'D1'
          })
          expect(count(report, 'reset_and_complete')).toBe(1)
          expect(report.reset).toEqual(RESET_POSITION)
          expect(resetLines(dir)).toBe(1)

          const reopened = openStores(dir)
          expectReceipt(receiptOf(reopened, 'cmd-d1'), 'succeeded', RESET_POSITION)
          expect(reopened.log.get('cmd-d1')?.terminal).toMatchObject({
            kind: 'published',
            position: RESET_POSITION
          })
          expect(reopened.deltas.getPosition()).toEqual(RESET_POSITION)
          expect(reopened.deltas.findGroup('cmd-d1')).toBeNull()
          expect(identityOf(chatPath(dir, 't-1'))).toEqual(built.resulting)
        },
        TEST_TIMEOUT
      )

      it(
        `D3 with a mark: published at the group's end, then the receipt, no reset${label}`,
        async () => {
          const dir = freshDir()
          const built = await buildD3(dir, openStores(dir), 'cmd-d3', 't-1', {
            prior: true,
            promote
          })
          const { report } = await recover(dir)

          expect(report.decisions.get('cmd-d3')).toEqual({
            action: 'complete_at_position',
            row: 'D3',
            position: built.end,
            markPublished: true
          })
          expect(count(report, 'complete_at_position')).toBe(1)
          expect(report.reset).toBeNull()
          expect(resetLines(dir)).toBe(0)

          const reopened = openStores(dir)
          expectReceipt(receiptOf(reopened, 'cmd-d3'), 'succeeded', built.end)
          expect(reopened.log.get('cmd-d3')?.terminal).toMatchObject({
            kind: 'published',
            position: built.end
          })
          expect(groupLines(dir, 'cmd-d3')).toBe(1)
          expect(reopened.deltas.getPosition()).toEqual(built.end)
        },
        TEST_TIMEOUT
      )

      it(
        `D3 without a mark: the receipt completes at the published position, nothing appended${label}`,
        async () => {
          const dir = freshDir()
          const built = await buildD3(dir, openStores(dir), 'cmd-d3', 't-1', {
            published: true,
            promote
          })
          const logBefore = readFileSync(join(dir, 'host-transactions.jsonl'), 'utf8')
          const { report } = await recover(dir)

          expect(report.decisions.get('cmd-d3')).toEqual({
            action: 'complete_at_position',
            row: 'D3',
            position: built.end,
            markPublished: false
          })
          expect(readFileSync(join(dir, 'host-transactions.jsonl'), 'utf8')).toBe(logBefore)
          expect(resetLines(dir)).toBe(0)

          const reopened = openStores(dir)
          expectReceipt(receiptOf(reopened, 'cmd-d3'), 'succeeded', built.end)
        },
        TEST_TIMEOUT
      )

      it(
        `D4 with an abort: the abort record, then the receipt failed as interrupted${label}`,
        async () => {
          const dir = freshDir()
          const built = await buildD4(dir, openStores(dir), 'cmd-d4', 't-1', {
            prior: true,
            promote
          })
          const { report } = await recover(dir)

          expect(report.decisions.get('cmd-d4')).toEqual({
            action: 'fail_interrupted',
            row: 'D4',
            writeAbort: true,
            completeReceipt: true
          })
          expect(count(report, 'fail_interrupted')).toBe(1)
          expect(report.reset).toBeNull()

          const reopened = openStores(dir)
          const receipt = receiptOf(reopened, 'cmd-d4')
          expectReceipt(receipt, 'failed')
          expect(receipt?.errorCode).toBe('interrupted')
          expect(reopened.log.get('cmd-d4')?.terminal).toMatchObject({ kind: 'abort' })
          expect(identityOf(chatPath(dir, 't-1'))).toEqual(built.prior)
          expect(reopened.deltas.findGroup('cmd-d4')).toBeNull()
        },
        TEST_TIMEOUT
      )

      it(
        `D4 without an abort (never prepared): the receipt fails, the log stays absent${label}`,
        async () => {
          const dir = freshDir()
          await buildD4(dir, openStores(dir), 'cmd-d4', 't-1', { prepared: false, promote })
          const { report } = await recover(dir)

          expect(report.decisions.get('cmd-d4')).toEqual({
            action: 'fail_interrupted',
            row: 'D4',
            writeAbort: false,
            completeReceipt: true
          })
          expect(existsSync(join(dir, 'host-transactions.jsonl'))).toBe(false)

          const reopened = openStores(dir)
          const receipt = receiptOf(reopened, 'cmd-d4')
          expectReceipt(receipt, 'failed')
          expect(receipt?.errorCode).toBe('interrupted')
          expect(reopened.log.get('cmd-d4')).toBeNull()
          expect(identityOf(chatPath(dir, 't-1'))).toBeNull()
        },
        TEST_TIMEOUT
      )
    }

    it(
      'D4 without an abort (abort already recorded): only the receipt is written',
      async () => {
        const dir = freshDir()
        await buildD4(dir, openStores(dir), 'cmd-d4', 't-1', { prior: true, aborted: true })
        const logBefore = readFileSync(join(dir, 'host-transactions.jsonl'), 'utf8')
        const { report } = await recover(dir)

        expect(report.decisions.get('cmd-d4')).toEqual({
          action: 'fail_interrupted',
          row: 'D4',
          writeAbort: false,
          completeReceipt: true
        })
        expect(readFileSync(join(dir, 'host-transactions.jsonl'), 'utf8')).toBe(logBefore)
        const reopened = openStores(dir)
        expectReceipt(receiptOf(reopened, 'cmd-d4'), 'failed')
        expect(receiptOf(reopened, 'cmd-d4')?.errorCode).toBe('interrupted')
      },
      TEST_TIMEOUT
    )

    it(
      'D4 with an abort and no receipt to complete: the abort is written, the failed receipt is untouched',
      async () => {
        const dir = freshDir()
        await buildD4(dir, openStores(dir), 'cmd-d4', 't-1', { prior: true, receipt: 'failed' })
        const before = receiptOf(openStores(dir), 'cmd-d4')
        const { report } = await recover(dir)

        expect(report.decisions.get('cmd-d4')).toEqual({
          action: 'fail_interrupted',
          row: 'D4',
          writeAbort: true,
          completeReceipt: false
        })
        const reopened = openStores(dir)
        expect(receiptOf(reopened, 'cmd-d4')).toEqual(before)
        expect(reopened.log.get('cmd-d4')?.terminal).toMatchObject({ kind: 'abort' })
      },
      TEST_TIMEOUT
    )

    it(
      "mark_published: the receipt already succeeded, only the manifest's mark is written",
      async () => {
        const dir = freshDir()
        const built = await buildD3(dir, openStores(dir), 'cmd-mark', 't-1', {
          prior: true,
          receipt: 'succeeded'
        })
        const receiptsBefore = snapshotFiles(dir)
        const { report } = await recover(dir)

        expect(report.decisions.get('cmd-mark')).toEqual({
          action: 'mark_published',
          row: 'D3',
          position: built.end
        })
        expect(count(report, 'mark_published')).toBe(1)
        expect(report.reset).toBeNull()

        const reopened = openStores(dir)
        expectReceipt(receiptOf(reopened, 'cmd-mark'), 'succeeded', built.end)
        expect(reopened.log.get('cmd-mark')?.terminal).toMatchObject({
          kind: 'published',
          position: built.end
        })
        // Only the transaction log changed.
        const after = snapshotFiles(dir)
        for (const [name, bytes] of receiptsBefore) {
          if (name !== 'host-transactions.jsonl') expect(after.get(name)).toBe(bytes)
        }
      },
      TEST_TIMEOUT
    )

    it(
      'none: a finished command and a manifest-final indeterminate are left alone',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        await buildD3(dir, stores, 'cmd-done', 't-1', { published: true, receipt: 'succeeded' })
        // Manifest-final: prepared, never committed, recorded indeterminate.
        await buildD4(dir, stores, 'cmd-final', 't-2')
        await appendDurable(stores, {
          kind: 'indeterminate',
          commandId: 'cmd-final',
          reason: 'unknown_identity',
          at: recordClock++
        })
        stores.receipts.markIndeterminate({
          commandId: 'cmd-final',
          position: stores.deltas.getPosition(),
          errorCode: 'transaction_recovery_indeterminate'
        })
        const before = snapshotFiles(dir)
        const { report } = await recover(dir)

        expect(report.decisions.get('cmd-done')).toEqual({ action: 'none' })
        expect(report.decisions.get('cmd-final')).toEqual({ action: 'none' })
        expect(count(report, 'none')).toBe(2)
        expect(report.reset).toBeNull()
        expect(report.indeterminate.size).toBe(0)
        // The finished command's anchor is released, which leaves the next
        // checkpoint; nothing else is written.
        expect(report.anchorsReleased).toEqual(['cmd-done'])
        expect(snapshotFiles(dir)).toEqual(before)
      },
      TEST_TIMEOUT
    )

    it(
      'not_transactional: receipts of another class, or no class, are never touched',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        beginReceipt(stores, 'cmd-legacy', 't-1', 'legacy-observed')
        beginReceipt(stores, 'cmd-unclassified', 't-2', 'none')
        // Whatever the store's own reopen makes of them (the legacy path
        // promotes a pending legacy receipt), the driver leaves them as found.
        const reopenedFirst = openStores(dir)
        const legacyBefore = receiptOf(reopenedFirst, 'cmd-legacy')
        const unclassifiedBefore = receiptOf(reopenedFirst, 'cmd-unclassified')
        expect(legacyBefore?.status).toBe('indeterminate')
        expect(legacyBefore?.recoveryState).toBe('recoverable-indeterminate')
        expect(unclassifiedBefore).not.toBeNull()

        const { report } = await recover(dir)
        expect(report.decisions.get('cmd-legacy')).toEqual({ action: 'not_transactional' })
        expect(report.decisions.get('cmd-unclassified')).toEqual({ action: 'not_transactional' })
        expect(count(report, 'not_transactional')).toBe(2)
        expect(report.reset).toBeNull()
        expect(report.indeterminate.size).toBe(0)

        const reopened = openStores(dir)
        expect(receiptOf(reopened, 'cmd-legacy')).toEqual(legacyBefore)
        expect(receiptOf(reopened, 'cmd-unclassified')).toEqual(unclassifiedBefore)
        expect(existsSync(join(dir, 'host-transactions.jsonl'))).toBe(false)
      },
      TEST_TIMEOUT
    )

    it(
      'several D1s share one reset, and each is published and completed there',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        await buildD1(dir, stores, 'cmd-a', 't-a')
        await buildD1(dir, stores, 'cmd-b', 't-b')
        await buildD1(dir, stores, 'cmd-c', 't-c')
        const { report } = await recover(dir)

        expect(count(report, 'reset_and_complete')).toBe(3)
        expect(report.reset).toEqual(RESET_POSITION)
        expect(resetLines(dir)).toBe(1)

        const reopened = openStores(dir)
        for (const commandId of ['cmd-a', 'cmd-b', 'cmd-c']) {
          expectReceipt(receiptOf(reopened, commandId), 'succeeded', RESET_POSITION)
          expect(reopened.log.get(commandId)?.terminal).toMatchObject({
            kind: 'published',
            position: RESET_POSITION
          })
        }
        expect(reopened.deltas.getPosition()).toEqual(RESET_POSITION)
      },
      TEST_TIMEOUT
    )

    it(
      'indeterminate: the manifest record when a prepare exists, and the pending receipt marked',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        // group_without_commit: prepared, a group durable, the chat file still prior.
        const prior = seedPrior(dir, stores, 't-1')
        beginReceipt(stores, 'cmd-gwc', 't-1')
        const { resulting } = stageArtifact(dir, 'cmd-gwc', 't-1', {})
        await appendDurable(stores, prepareRecord('cmd-gwc', 't-1', prior, resulting, 2))
        const appended = stores.deltas.appendGroup({
          commandId: 'cmd-gwc',
          effects: effectsFor('t-1', 'x')
        })
        if (appended.kind !== 'appended') throw new Error('appendGroup')
        await stores.deltas.awaitDurable()
        // group_without_manifest: a group and a pending receipt, no prepare.
        beginReceipt(stores, 'cmd-gwm', 't-2')
        stores.deltas.appendGroup({ commandId: 'cmd-gwm', effects: effectsFor('t-2', 'y') })
        await stores.deltas.awaitDurable()

        const { report } = await recover(dir)
        expect(report.decisions.get('cmd-gwc')).toEqual({
          action: 'indeterminate',
          reason: 'group_without_commit'
        })
        expect(report.decisions.get('cmd-gwm')).toEqual({
          action: 'indeterminate',
          reason: 'group_without_manifest'
        })
        expect(count(report, 'indeterminate')).toBe(2)
        expect([...report.indeterminate]).toEqual([
          ['cmd-gwc', 'group_without_commit'],
          ['cmd-gwm', 'group_without_manifest']
        ])
        expect(report.reset).toBeNull()

        const reopened = openStores(dir)
        expect(reopened.log.get('cmd-gwc')?.terminal).toMatchObject({
          kind: 'indeterminate',
          reason: 'group_without_commit'
        })
        expect(reopened.log.get('cmd-gwm')).toBeNull()
        for (const commandId of ['cmd-gwc', 'cmd-gwm']) {
          const receipt = receiptOf(reopened, commandId)
          expect(receipt?.status).toBe('indeterminate')
          expect(receipt?.recoveryState).toBe('recoverable-indeterminate')
          expect(receipt?.errorCode).toBe('transaction_recovery_indeterminate')
        }
        expect(identityOf(chatPath(dir, 't-1'))).toEqual(prior)
      },
      TEST_TIMEOUT
    )

    it(
      'indeterminate: a receipt already recoverable-indeterminate is not rewritten',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        beginReceipt(stores, 'cmd-gwm', 't-2')
        stores.deltas.appendGroup({ commandId: 'cmd-gwm', effects: effectsFor('t-2', 'y') })
        await stores.deltas.awaitDurable()
        stores.receipts.markIndeterminate({
          commandId: 'cmd-gwm',
          position: stores.deltas.getPosition(),
          errorCode: 'transaction_commit_indeterminate'
        })
        const before = receiptOf(openStores(dir), 'cmd-gwm')
        const { report } = await recover(dir)
        expect(report.decisions.get('cmd-gwm')).toEqual({
          action: 'indeterminate',
          reason: 'group_without_manifest'
        })
        expect(receiptOf(openStores(dir), 'cmd-gwm')).toEqual(before)
      },
      TEST_TIMEOUT
    )
  })

  describe('2. NH-1 order', () => {
    function orderedPorts(stores: Stores, calls: string[]): Partial<HostTransactionRecoveryPorts> {
      return {
        log: {
          get: (commandId) => stores.log.get(commandId),
          commandIds: () => stores.log.commandIds(),
          append: async (record) => {
            const result = await stores.log.append(record)
            const { kind, commandId } = record as { kind: string; commandId: string }
            calls.push(`${kind}-durable:${commandId}`)
            return result
          }
        },
        receipts: {
          list: () => stores.receipts.list(),
          complete: (input) => {
            calls.push(`complete:${input.commandId}:${input.status}`)
            return stores.receipts.complete(input)
          },
          markIndeterminate: (input) => stores.receipts.markIndeterminate(input)
        }
      }
    }

    it(
      "D3: the manifest's published is durable before the receipt completes",
      async () => {
        const dir = freshDir()
        await buildD3(dir, openStores(dir), 'cmd-d3', 't-1', { prior: true })
        const stores = openStores(dir)
        const calls: string[] = []
        await recoverHostTransactions(portsFor(dir, stores, orderedPorts(stores, calls)), {
          reset: 'when-needed'
        })
        expect(calls).toEqual(['published-durable:cmd-d3', 'complete:cmd-d3:succeeded'])
      },
      TEST_TIMEOUT
    )

    it(
      "D1: the manifest's published at the reset position is durable before the receipt completes",
      async () => {
        const dir = freshDir()
        await buildD1(dir, openStores(dir), 'cmd-d1', 't-1', { prior: true })
        const stores = openStores(dir)
        const calls: string[] = []
        const deltas = stores.deltas
        await recoverHostTransactions(
          portsFor(dir, stores, {
            ...orderedPorts(stores, calls),
            deltas: {
              findGroup: (commandId) => deltas.findGroup(commandId),
              getPosition: () => deltas.getPosition(),
              releaseGroup: (commandId) => deltas.releaseGroup(commandId),
              anchoredCommandIds: () => deltas.anchoredCommandIds(),
              resetGeneration: (reason, family) => {
                calls.push('reset')
                return deltas.resetGeneration(reason, family)
              }
            }
          }),
          { reset: 'when-needed' }
        )
        expect(calls).toEqual(['reset', 'published-durable:cmd-d1', 'complete:cmd-d1:succeeded'])
      },
      TEST_TIMEOUT
    )

    it(
      'D3 and D4 are applied before the D1 reset',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        const d3 = await buildD3(dir, stores, 'cmd-d3', 't-3', { prior: true })
        await buildD4(dir, stores, 'cmd-d4', 't-4')
        await buildD1(dir, stores, 'cmd-d1', 't-1')
        const fresh = openStores(dir)
        const calls: string[] = []
        const deltas = fresh.deltas
        await recoverHostTransactions(
          portsFor(dir, fresh, {
            ...orderedPorts(fresh, calls),
            deltas: {
              findGroup: (commandId) => deltas.findGroup(commandId),
              getPosition: () => deltas.getPosition(),
              releaseGroup: (commandId) => deltas.releaseGroup(commandId),
              anchoredCommandIds: () => deltas.anchoredCommandIds(),
              resetGeneration: (reason, family) => {
                calls.push('reset')
                return deltas.resetGeneration(reason, family)
              }
            }
          }),
          { reset: 'when-needed' }
        )
        const resetAt = calls.indexOf('reset')
        expect(resetAt).toBeGreaterThan(-1)
        expect(calls.slice(0, resetAt).sort()).toEqual(
          [
            'published-durable:cmd-d3',
            'complete:cmd-d3:succeeded',
            'abort-durable:cmd-d4',
            'complete:cmd-d4:failed'
          ].sort()
        )
        expect(calls.slice(resetAt + 1)).toEqual([
          'published-durable:cmd-d1',
          'complete:cmd-d1:succeeded'
        ])
        const reopened = openStores(dir)
        expectReceipt(receiptOf(reopened, 'cmd-d3'), 'succeeded', d3.end)
        expectReceipt(receiptOf(reopened, 'cmd-d1'), 'succeeded', RESET_POSITION)
      },
      TEST_TIMEOUT
    )
  })

  describe('3. the reset option', () => {
    it(
      "'always' with no D1 resets once, after the D3 completed at its group's end",
      async () => {
        const dir = freshDir()
        const built = await buildD3(dir, openStores(dir), 'cmd-d3', 't-1', { prior: true })
        const { report } = await recover(dir, 'always')
        expect(count(report, 'reset_and_complete')).toBe(0)
        expect(report.reset).toEqual(RESET_POSITION)
        expect(resetLines(dir)).toBe(1)
        const reopened = openStores(dir)
        expectReceipt(receiptOf(reopened, 'cmd-d3'), 'succeeded', built.end)
        expect(reopened.log.get('cmd-d3')?.terminal).toMatchObject({
          kind: 'published',
          position: built.end
        })
        expect(reopened.deltas.getPosition()).toEqual(RESET_POSITION)
      },
      TEST_TIMEOUT
    )

    it(
      "'always' over an empty profile still resets once",
      async () => {
        const dir = freshDir()
        const { report } = await recover(dir, 'always')
        expect(report.decisions.size).toBe(0)
        expect(report.reset).toEqual(RESET_POSITION)
        expect(resetLines(dir)).toBe(1)
        expect(openStores(dir).deltas.getPosition()).toEqual(RESET_POSITION)
      },
      TEST_TIMEOUT
    )

    it(
      "'when-needed' with no D1 never resets",
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        await buildD3(dir, stores, 'cmd-d3', 't-1', { prior: true })
        await buildD4(dir, stores, 'cmd-d4', 't-2')
        const { report } = await recover(dir, 'when-needed')
        expect(report.reset).toBeNull()
        expect(resetLines(dir)).toBe(0)
        expect(openStores(dir).deltas.getPosition().generation).toBe(1)
      },
      TEST_TIMEOUT
    )

    it(
      "'always' with D1s still resets exactly once",
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        await buildD1(dir, stores, 'cmd-a', 't-a')
        await buildD1(dir, stores, 'cmd-b', 't-b')
        const { report } = await recover(dir, 'always')
        expect(report.reset).toEqual(RESET_POSITION)
        expect(resetLines(dir)).toBe(1)
        const reopened = openStores(dir)
        expectReceipt(receiptOf(reopened, 'cmd-a'), 'succeeded', RESET_POSITION)
        expectReceipt(receiptOf(reopened, 'cmd-b'), 'succeeded', RESET_POSITION)
      },
      TEST_TIMEOUT
    )
  })

  describe('4. a reset that fails is a boot failure after D3 and D4 are durable', () => {
    async function mixedState(dir: string): Promise<HostCursorPosition> {
      const stores = openStores(dir)
      const d3 = await buildD3(dir, stores, 'cmd-d3', 't-3', { prior: true })
      await buildD4(dir, stores, 'cmd-d4', 't-4')
      await buildD1(dir, stores, 'cmd-d1', 't-1')
      return d3.end
    }

    function expectStepsOneAndTwoDurable(dir: string, end: HostCursorPosition): void {
      const reopened = openStores(dir)
      expectReceipt(receiptOf(reopened, 'cmd-d3'), 'succeeded', end)
      expect(reopened.log.get('cmd-d3')?.terminal).toMatchObject({
        kind: 'published',
        position: end
      })
      expectReceipt(receiptOf(reopened, 'cmd-d4'), 'failed')
      expect(receiptOf(reopened, 'cmd-d4')?.errorCode).toBe('interrupted')
      expect(reopened.log.get('cmd-d4')?.terminal).toMatchObject({ kind: 'abort' })
      // The D1 is untouched: still pending, no terminal record, no reset line.
      expect(receiptOf(reopened, 'cmd-d1')?.status).toBe('pending')
      expect(reopened.log.get('cmd-d1')?.terminal).toBeNull()
      expect(resetLines(dir)).toBe(0)
      expect(reopened.deltas.getPosition().generation).toBe(1)
    }

    function refusingDeltas(
      deltas: HostDeltaStore,
      refuse: () => HostDeltaAppendResult
    ): HostTransactionRecoveryPorts['deltas'] {
      return {
        findGroup: (commandId) => deltas.findGroup(commandId),
        getPosition: () => deltas.getPosition(),
        releaseGroup: (commandId) => deltas.releaseGroup(commandId),
        anchoredCommandIds: () => deltas.anchoredCommandIds(),
        resetGeneration: () => refuse()
      }
    }

    it(
      'a reset that is not appended rejects, and the next boot completes the D1',
      async () => {
        const dir = freshDir()
        const end = await mixedState(dir)
        const stores = openStores(dir)
        const ports = portsFor(dir, stores, {
          deltas: refusingDeltas(stores.deltas, () => ({
            kind: 'rejected',
            reason: 'invalid_envelope',
            detail: 'refused by the test',
            position: stores.deltas.getPosition()
          }))
        })
        await expect(recoverHostTransactions(ports, { reset: 'when-needed' })).rejects.toThrow()
        expectStepsOneAndTwoDurable(dir, end)

        const { report } = await recover(dir)
        expect(report.decisions.get('cmd-d3')).toEqual({ action: 'none' })
        expect(report.decisions.get('cmd-d4')).toEqual({ action: 'none' })
        expect(report.decisions.get('cmd-d1')).toEqual({ action: 'reset_and_complete', row: 'D1' })
        expect(report.reset).toEqual(RESET_POSITION)
        expectReceipt(receiptOf(openStores(dir), 'cmd-d1'), 'succeeded', RESET_POSITION)
      },
      TEST_TIMEOUT
    )

    it(
      'a reset that throws rejects with that error, after D3 and D4 are durable',
      async () => {
        const dir = freshDir()
        const end = await mixedState(dir)
        const stores = openStores(dir)
        const ports = portsFor(dir, stores, {
          deltas: refusingDeltas(stores.deltas, () => {
            throw new Error('append authority is blocked (test)')
          })
        })
        await expect(recoverHostTransactions(ports, { reset: 'when-needed' })).rejects.toThrow(
          /append authority is blocked \(test\)/
        )
        expectStepsOneAndTwoDurable(dir, end)
      },
      TEST_TIMEOUT
    )

    it(
      "a refused 'always' reset with nothing to recover still rejects",
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        const ports = portsFor(dir, stores, {
          deltas: refusingDeltas(stores.deltas, () => {
            throw new Error('reset refused (test)')
          })
        })
        await expect(recoverHostTransactions(ports, { reset: 'always' })).rejects.toThrow(
          /reset refused \(test\)/
        )
        expect(resetLines(dir)).toBe(0)
      },
      TEST_TIMEOUT
    )
  })

  describe('5. anchors', () => {
    it(
      'the anchor of every command whose receipt is now terminal is released',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        // D3 pending (completed by this run), and one already succeeded (mark only).
        await buildD3(dir, stores, 'cmd-d3', 't-3', { prior: true })
        await buildD3(dir, stores, 'cmd-mark', 't-4', { receipt: 'succeeded' })
        // Fully done, its anchor never released before the crash.
        await buildD3(dir, stores, 'cmd-done', 't-5', { published: true, receipt: 'succeeded' })
        const fresh = openStores(dir)
        expect(fresh.deltas.anchoredCommandIds().sort()).toEqual(['cmd-d3', 'cmd-done', 'cmd-mark'])

        const report = await recoverHostTransactions(portsFor(dir, fresh), { reset: 'when-needed' })
        expect([...report.anchorsReleased].sort()).toEqual(['cmd-d3', 'cmd-done', 'cmd-mark'])
        expect(fresh.deltas.anchoredCommandIds()).toEqual([])
        expect(fresh.deltas.findGroup('cmd-d3')).toBeNull()
        // Released anchors leave the next checkpoint.
        const compacted = await fresh.deltas.compactInBackground()
        expect(compacted.kind).toBe('compacted')
        expect(openStores(dir).deltas.anchoredCommandIds()).toEqual([])
      },
      TEST_TIMEOUT
    )

    it(
      'a pending (not transactional) receipt keeps its anchor',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        beginReceipt(stores, 'cmd-legacy', 't-1', 'legacy-observed')
        stores.deltas.appendGroup({ commandId: 'cmd-legacy', effects: effectsFor('t-1', 'x') })
        await stores.deltas.awaitDurable()
        // Same instances: the receipt is still pending, not yet promoted by a reopen.
        expect(receiptOf(stores, 'cmd-legacy')?.status).toBe('pending')
        const report = await recoverHostTransactions(portsFor(dir, stores), {
          reset: 'when-needed'
        })
        expect(report.decisions.get('cmd-legacy')).toEqual({ action: 'not_transactional' })
        expect(report.anchorsReleased).toEqual([])
        expect(stores.deltas.anchoredCommandIds()).toEqual(['cmd-legacy'])
        expect(receiptOf(stores, 'cmd-legacy')?.status).toBe('pending')
      },
      TEST_TIMEOUT
    )

    it(
      'an indeterminate-final command keeps its anchor: the receipt stays an anchor per NH-2',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        const prior = seedPrior(dir, stores, 't-1')
        beginReceipt(stores, 'cmd-gwc', 't-1')
        const { resulting } = stageArtifact(dir, 'cmd-gwc', 't-1', {})
        await appendDurable(stores, prepareRecord('cmd-gwc', 't-1', prior, resulting, 2))
        stores.deltas.appendGroup({ commandId: 'cmd-gwc', effects: effectsFor('t-1', 'x') })
        await stores.deltas.awaitDurable()

        const first = await recover(dir)
        expect(first.report.decisions.get('cmd-gwc')).toEqual({
          action: 'indeterminate',
          reason: 'group_without_commit'
        })
        expect(first.report.anchorsReleased).toEqual([])
        expect(first.stores.deltas.anchoredCommandIds()).toEqual(['cmd-gwc'])

        // The manifest record is final; a second boot decides none and still keeps it.
        const second = await recover(dir)
        expect(second.report.decisions.get('cmd-gwc')).toEqual({ action: 'none' })
        expect(second.report.anchorsReleased).toEqual([])
        expect(second.stores.deltas.anchoredCommandIds()).toEqual(['cmd-gwc'])
        expect(receiptOf(second.stores, 'cmd-gwc')?.status).toBe('indeterminate')
      },
      TEST_TIMEOUT
    )

    it(
      'an anchor with no receipt is released when it has no manifest, or a terminal one',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        // No receipt, no manifest.
        stores.deltas.appendGroup({ commandId: 'cmd-bare', effects: effectsFor('t-1', 'x') })
        // No receipt, manifest published (the receipt was compacted away).
        const { resulting } = stageArtifact(dir, 'cmd-published', 't-2', {})
        await appendDurable(stores, prepareRecord('cmd-published', 't-2', null, resulting, 2))
        const appended = stores.deltas.appendGroup({
          commandId: 'cmd-published',
          effects: effectsFor('t-2', 'y')
        })
        if (appended.kind !== 'appended') throw new Error('appendGroup')
        await stores.deltas.awaitDurable()
        await appendDurable(stores, {
          kind: 'published',
          commandId: 'cmd-published',
          position: appended.group.end,
          at: recordClock++
        })

        const { report, stores: fresh } = await recover(dir)
        expect(report.decisions.get('cmd-bare')).toBeUndefined()
        expect(report.decisions.get('cmd-published')).toEqual({ action: 'none' })
        expect([...report.anchorsReleased].sort()).toEqual(['cmd-bare', 'cmd-published'])
        expect(fresh.deltas.anchoredCommandIds()).toEqual([])
      },
      TEST_TIMEOUT
    )

    it(
      'an anchor with no receipt and an open prepare: the manifest is ended indeterminate, then released',
      async () => {
        // receipt_missing. Once step 4 ends the manifest, it is terminal; step 5
        // then releases the anchor (the contract's "now terminal" reading).
        const dir = freshDir()
        const stores = openStores(dir)
        const { resulting } = stageArtifact(dir, 'cmd-orphan', 't-1', {})
        await appendDurable(stores, prepareRecord('cmd-orphan', 't-1', null, resulting, 2))
        stores.deltas.appendGroup({ commandId: 'cmd-orphan', effects: effectsFor('t-1', 'x') })
        await stores.deltas.awaitDurable()

        const { report, stores: fresh } = await recover(dir)
        expect(report.decisions.get('cmd-orphan')).toEqual({
          action: 'indeterminate',
          reason: 'receipt_missing'
        })
        expect(fresh.log.get('cmd-orphan')?.terminal).toMatchObject({
          kind: 'indeterminate',
          reason: 'receipt_missing'
        })
        expect(report.anchorsReleased).toEqual(['cmd-orphan'])
        expect(fresh.deltas.anchoredCommandIds()).toEqual([])
      },
      TEST_TIMEOUT
    )
  })

  describe('6. the artifact sweep', () => {
    it(
      'removes only the artifacts whose identity a not-committed prepare holds',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        const transfers = transferDir(dir)
        // D4 (abort written by this run): its artifact is still in the transfer directory.
        const d4 = await buildD4(dir, stores, 'cmd-d4', 't-4', {
          prior: true,
          artifactDir: transfers,
          artifactName: 'stranded-d4.record.json'
        })
        // Already aborted before the crash, receipt pending: swept too.
        const aborted = await buildD4(dir, stores, 'cmd-aborted', 't-5', {
          aborted: true,
          artifactDir: transfers,
          artifactName: 'stranded-aborted.record.json'
        })
        // Indeterminate whose witness is not committed (group_without_commit).
        const prior6 = seedPrior(dir, stores, 't-6')
        beginReceipt(stores, 'cmd-gwc', 't-6')
        const gwc = stageArtifact(dir, 'cmd-gwc', 't-6', {
          artifactDir: transfers,
          artifactName: 'stranded-gwc.record.json'
        })
        await appendDurable(stores, prepareRecord('cmd-gwc', 't-6', prior6, gwc.resulting, 2))
        stores.deltas.appendGroup({ commandId: 'cmd-gwc', effects: effectsFor('t-6', 'x') })
        await stores.deltas.awaitDurable()
        // A committed prepare (D1): its artifact was renamed into chats/.
        const d1 = await buildD1(dir, stores, 'cmd-d1', 't-1', {
          artifactDir: transfers,
          artifactName: 'committed.record.json'
        })
        // A client's own transfer, no prepare: never the Host's to sweep.
        writeIdentified(join(transfers, 'client-own.record.json'), '{"id":"t-9"}')
        // A non-artifact name in the directory is not touched either.
        writeIdentified(join(transfers, 'notes.txt'), 'not an artifact')
        // A client's artifact the same size as a stranded one: identity is the
        // inode, not the size.
        writeFileSync(
          join(transfers, 'client-same-size.record.json'),
          'x'.repeat(d4.resulting.size)
        )
        const chatBefore = readFileSync(chatPath(dir, 't-1'))

        expect(identityOf(d4.artifactPath)).toEqual(d4.resulting)
        const { report } = await recover(dir)

        expect([...report.artifactsRemoved].sort()).toEqual([
          'stranded-aborted.record.json',
          'stranded-d4.record.json',
          'stranded-gwc.record.json'
        ])
        expect(existsSync(d4.artifactPath)).toBe(false)
        expect(existsSync(aborted.artifactPath)).toBe(false)
        expect(existsSync(gwc.artifactPath)).toBe(false)
        expect(existsSync(join(transfers, 'client-own.record.json'))).toBe(true)
        expect(existsSync(join(transfers, 'notes.txt'))).toBe(true)
        expect(existsSync(join(transfers, 'client-same-size.record.json'))).toBe(true)
        expect(existsSync(join(transfers, 'committed.record.json'))).toBe(false)
        // The committed prepare's chat file is untouched, and published at the reset.
        expect(identityOf(chatPath(dir, 't-1'))).toEqual(d1.resulting)
        expect(readFileSync(chatPath(dir, 't-1'))).toEqual(chatBefore)
        expectReceipt(receiptOf(openStores(dir), 'cmd-d1'), 'succeeded', RESET_POSITION)
        // The prior chat files of the swept prepares are untouched.
        expect(identityOf(chatPath(dir, 't-4'))).toEqual(d4.prior)
        expect(identityOf(chatPath(dir, 't-6'))).toEqual(prior6)
      },
      TEST_TIMEOUT
    )

    it(
      'a hard link sharing the inode of a stranded artifact matches by identity',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        const transfers = transferDir(dir)
        // Stage the artifact outside the transfer directory, hard-link it in:
        // same dev and ino, so the sweep removes the linked name.
        const d4 = await buildD4(dir, stores, 'cmd-d4', 't-4', {
          artifactDir: join(dir, 'staged'),
          artifactName: 'source.json'
        })
        mkdirSync(transfers, { recursive: true })
        linkSync(d4.artifactPath, join(transfers, 'linked.record.json'))
        // The same inode under a name that is not an artifact is left alone.
        linkSync(d4.artifactPath, join(transfers, 'linked.tmp'))
        const linked = lstatSync(join(transfers, 'linked.record.json'), { bigint: true })
        expect(linked.ino.toString()).toBe(d4.resulting.ino)

        const { report } = await recover(dir)
        expect(report.artifactsRemoved).toEqual(['linked.record.json'])
        expect(existsSync(join(transfers, 'linked.record.json'))).toBe(false)
        expect(existsSync(join(transfers, 'linked.tmp'))).toBe(true)
        // The source name outside the transfer directory is not the Host's.
        expect(existsSync(d4.artifactPath)).toBe(true)
      },
      TEST_TIMEOUT
    )

    it(
      'a committed (D3) prepare and a missing transfer directory sweep nothing',
      async () => {
        const dir = freshDir()
        await buildD3(dir, openStores(dir), 'cmd-d3', 't-1', {
          prior: true,
          artifactDir: transferDir(dir),
          artifactName: 'renamed.record.json'
        })
        rmSync(transferDir(dir), { recursive: true, force: true })
        const chatBefore = readFileSync(chatPath(dir, 't-1'))
        const { report } = await recover(dir)
        expect(report.artifactsRemoved).toEqual([])
        expect(existsSync(transferDir(dir))).toBe(false)
        expect(readFileSync(chatPath(dir, 't-1'))).toEqual(chatBefore)
      },
      TEST_TIMEOUT
    )

    it(
      'a not-committed prepare whose artifact is already gone reports nothing removed',
      async () => {
        const dir = freshDir()
        const built = await buildD4(dir, openStores(dir), 'cmd-d4', 't-4', {
          artifactDir: transferDir(dir),
          artifactName: 'gone.record.json'
        })
        rmSync(built.artifactPath)
        writeIdentified(join(transferDir(dir), 'other.record.json'), '{"id":"t-8"}')
        const { report } = await recover(dir)
        expect(report.decisions.get('cmd-d4')?.action).toBe('fail_interrupted')
        expect(report.artifactsRemoved).toEqual([])
        expect(existsSync(join(transferDir(dir), 'other.record.json'))).toBe(true)
      },
      TEST_TIMEOUT
    )
  })

  describe('7. idempotence', () => {
    it(
      'a second run decides none for every transactional command, appends nothing and does not reset',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        await buildD1(dir, stores, 'cmd-d1', 't-1', { prior: true })
        await buildD3(dir, stores, 'cmd-d3', 't-3', { prior: true })
        await buildD3(dir, stores, 'cmd-d3-published', 't-7', { published: true })
        await buildD3(dir, stores, 'cmd-mark', 't-8', { receipt: 'succeeded' })
        await buildD4(dir, stores, 'cmd-d4', 't-4', {
          prior: true,
          artifactDir: transferDir(dir),
          artifactName: 'd4.record.json'
        })
        await buildD4(dir, stores, 'cmd-d4-bare', 't-5', { prepared: false })
        // An indeterminate WITH a prepare: its manifest record makes it final.
        const prior6 = seedPrior(dir, stores, 't-6')
        beginReceipt(stores, 'cmd-gwc', 't-6')
        const gwc = stageArtifact(dir, 'cmd-gwc', 't-6', {})
        await appendDurable(stores, prepareRecord('cmd-gwc', 't-6', prior6, gwc.resulting, 2))
        stores.deltas.appendGroup({ commandId: 'cmd-gwc', effects: effectsFor('t-6', 'x') })
        await stores.deltas.awaitDurable()

        const first = await recover(dir)
        expect(first.report.counts).toMatchObject({
          reset_and_complete: 1,
          complete_at_position: 2,
          mark_published: 1,
          fail_interrupted: 2,
          indeterminate: 1
        })
        expect(first.report.reset).toEqual(RESET_POSITION)
        expect(first.report.artifactsRemoved).toEqual(['d4.record.json'])

        const before = snapshotFiles(dir)
        const second = await recover(dir)
        expect([...second.report.decisions.keys()].sort()).toEqual(
          [...first.report.decisions.keys()].sort()
        )
        for (const [commandId, decision] of second.report.decisions) {
          expect({ commandId, decision }).toEqual({ commandId, decision: { action: 'none' } })
        }
        expect(count(second.report, 'none')).toBe(first.report.decisions.size)
        expect(second.report.reset).toBeNull()
        expect(second.report.artifactsRemoved).toEqual([])
        expect(second.report.indeterminate.size).toBe(0)
        expect(snapshotFiles(dir)).toEqual(before)

        // A third run after 'always' resets again, and still decides none.
        const third = await recover(dir, 'always')
        expect(third.report.reset).toEqual({ generation: 3, cursor: 1 })
        for (const decision of third.report.decisions.values()) {
          expect(decision).toEqual({ action: 'none' })
        }
      },
      TEST_TIMEOUT
    )

    it(
      'an indeterminate without a prepare is final: a later boot never re-decides it, even after a reset clears its group',
      async () => {
        // group_without_manifest has no prepare, so no manifest record can
        // make it final; the driver's own receipt mark does
        // (`transaction_recovery_indeterminate`). Before that rule, a reset
        // in the same boot cleared the group, and the next boot failed the
        // receipt as `interrupted`: an indeterminate silently turned failure.
        const dir = freshDir()
        const stores = openStores(dir)
        beginReceipt(stores, 'cmd-gwm', 't-6')
        stores.deltas.appendGroup({ commandId: 'cmd-gwm', effects: effectsFor('t-6', 'x') })
        await stores.deltas.awaitDurable()

        const first = await recover(dir, 'always')
        expect(first.report.decisions.get('cmd-gwm')).toEqual({
          action: 'indeterminate',
          reason: 'group_without_manifest'
        })
        expect(first.report.reset).not.toBeNull()
        const before = snapshotFiles(dir)
        const second = await recover(dir)
        expect(second.report.decisions.get('cmd-gwm')).toEqual({ action: 'none' })
        expect(second.report.reset).toBeNull()
        expect(snapshotFiles(dir)).toEqual(before)
        const receipt = second.stores.receipts.list().find((r) => r.commandId === 'cmd-gwm')
        expect(receipt).toMatchObject({
          status: 'indeterminate',
          errorCode: 'transaction_recovery_indeterminate'
        })
      },
      TEST_TIMEOUT
    )

    it(
      'the report counts every decision, by action',
      async () => {
        const dir = freshDir()
        const stores = openStores(dir)
        await buildD1(dir, stores, 'cmd-d1', 't-1')
        beginReceipt(stores, 'cmd-legacy', 't-2', 'legacy-observed')
        const { report } = await recover(dir)
        const total = Object.values(report.counts).reduce((sum, value) => sum + value, 0)
        expect(total).toBe(report.decisions.size)
        expect(report.decisions.size).toBe(2)
        expect(count(report, 'reset_and_complete')).toBe(1)
        expect(count(report, 'not_transactional')).toBe(1)
      },
      TEST_TIMEOUT
    )
  })
})
