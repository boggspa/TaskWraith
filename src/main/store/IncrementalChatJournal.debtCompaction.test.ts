/**
 * Compaction under `noteDurabilityDebt`, without a descriptor cache: by bytes
 * alone, in the worker. The active segment is renamed to the sealed name, the
 * worker folds the checkpoint and the sealed segment into a checkpoint it
 * writes and syncs, and the journal renames that into place, makes the rename
 * durable off the calling thread, and only then unlinks the sealed segment.
 *
 * The worker here is `prepareCheckpoint` run on this thread when a test says
 * so, through the same port the real one uses.
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveChatRecordMutation, type ChatRecordMutationBatch } from './ChatRecordMutation'
import { prepareCheckpoint } from './CheckpointPreparationCore'
import {
  checkpointFileReference,
  type CheckpointPreparationJob,
  type CheckpointPreparationPort,
  type CheckpointPreparationRequest,
  type CheckpointPreparationSource,
  type PreparedCheckpoint
} from './CheckpointPreparationProtocol'
import {
  createIncrementalChatJournal,
  type IncrementalChatJournal,
  type IncrementalChatJournalOptions
} from './IncrementalChatJournal'
import { createIncrementalChatPersistence } from './IncrementalChatPersistence'
import type { ThreadDurabilityDebtNote } from './ThreadDurabilityDebt'
import type { ChatRecord } from './types'
import { countSyncs, type SyncCount } from './unsyncedWriteCrashDisk.testutil'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-journal-debt-compaction-'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  const made = temporary + path.sep + TEMPORARY_PREFIX
  if (
    directory === temporary ||
    !directory.startsWith(made) ||
    directory.length <= made.length ||
    path.dirname(directory) !== temporary
  )
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  fs.rmSync(directory, { recursive: true, force: true })
}

const CHAT = 'chat-1'
const ACTIVE = `${CHAT}.mutations.jsonl`
const SEALED = `${CHAT}.sealed.mutations.jsonl`
const CHECKPOINT = `${CHAT}.checkpoint.json`
/** Each line is a little over 200 bytes: the trigger is reached on the fifth. */
const TRIGGER = 1_000

function chat(revision: number): ChatRecord {
  return {
    appChatId: CHAT,
    title: CHAT,
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages: [
      {
        id: 'message',
        role: 'assistant',
        content: `content ${revision}`,
        timestamp: '2026-10-05T00:00:00.000Z'
      }
    ],
    runs: []
  }
}

/** `records[n]` is at revision n + 1, and `batches[n]` takes it to revision n + 2. */
const records: ChatRecord[] = Array.from({ length: 64 }, (_unused, index) => chat(index + 1))
const batches: ChatRecordMutationBatch[] = records
  .slice(0, -1)
  .map((record, index) => deriveChatRecordMutation(record, records[index + 1]))

interface Started {
  request: CheckpointPreparationRequest
  ready: (value: PreparedCheckpoint) => void
  fail: (error: Error) => void
}

/** The worker, run on this thread when a test says so. */
class HeldWorker implements CheckpointPreparationPort {
  started: Started[] = []
  refusing = false

  constructor(private readonly baseDir: string) {}

  start(source: CheckpointPreparationSource): CheckpointPreparationJob | null {
    if (this.refusing) return null
    const outputPath = path.join(
      this.baseDir,
      `.${source.chatId}.checkpoint-prepared-${process.pid}-${randomUUID()}.tmp`
    )
    fs.writeFileSync(outputPath, '', { flag: 'wx', mode: 0o600 })
    const output = checkpointFileReference(outputPath)
    let ready!: Started['ready']
    let fail!: Started['fail']
    const result = new Promise<PreparedCheckpoint>((resolve, reject) => {
      ready = resolve
      fail = reject
    })
    const release = (): void => fs.rmSync(outputPath, { force: true })
    this.started.push({ request: { ...source, output, maxOutputBytes: 1024 * 1024 }, ready, fail })
    return { output, result, cancel: release, release }
  }

  /** Fold and hand back the latest job, as the worker does: an error is its reply. */
  complete(): void {
    const { request, ready, fail } = this.started[this.started.length - 1]
    let folded: PreparedCheckpoint
    try {
      folded = prepareCheckpoint(request)
    } catch (error) {
      fail(error as Error)
      return
    }
    ready(folded)
  }

  /** The worker process died before it replied. */
  die(): void {
    this.started[this.started.length - 1].fail(
      new Error('Checkpoint preparation process exited without a result')
    )
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('compaction in the worker, under the barrier, without a descriptor cache', () => {
  let baseDir: string
  let worker: HeldWorker
  let notes: ThreadDurabilityDebtNote[]
  let syncs: SyncCount
  let clock: number
  /** Directory syncs asked for off the calling thread, each held until released. */
  let directorySyncs: Array<{ directory: string; release: () => void; fail: (e: Error) => void }>
  let holdDirectorySyncs: boolean

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    worker = new HeldWorker(baseDir)
    notes = []
    syncs = countSyncs()
    clock = 1_000_000
    directorySyncs = []
    holdDirectorySyncs = false
  })

  afterEach(() => {
    syncs.dispose()
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    removeTemporaryDirectory(baseDir)
  })

  const options = (extra: IncrementalChatJournalOptions = {}): IncrementalChatJournalOptions => ({
    noteDurabilityDebt: (_chatId, note) => notes.push(note),
    checkpointPreparation: worker,
    maxJournalBytes: TRIGGER,
    now: () => clock,
    syncDirectory: (directory) =>
      new Promise<void>((resolve, reject) => {
        directorySyncs.push({ directory, release: resolve, fail: reject })
        if (!holdDirectorySyncs) resolve()
      }),
    ...extra
  })
  const open = (extra: IncrementalChatJournalOptions = {}): IncrementalChatJournal =>
    createIncrementalChatJournal(baseDir, options(extra))
  const read = (): ReturnType<IncrementalChatJournal['replay']> =>
    createIncrementalChatJournal(baseDir, {
      noteDurabilityDebt: () => {},
      canWrite: () => false
    }).replay(CHAT)
  const exists = (name: string): boolean => fs.existsSync(path.join(baseDir, name))
  const lines = (name: string): number[] =>
    fs
      .readFileSync(path.join(baseDir, name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as ChatRecordMutationBatch).revision)
  const prepared = (): string[] =>
    fs.readdirSync(baseDir).filter((name) => name.includes('.checkpoint-prepared-'))

  /** Append from the journal's head until the segments first reach the trigger. */
  const appendToTrigger = (journal: IncrementalChatJournal): number => {
    let head = journal.replay(CHAT).revision!
    while (worker.started.length === 0) {
      journal.append(batches[head - 1])
      head += 1
      if (head > 40) throw new Error('the trigger was never reached')
    }
    return head
  }

  it('seals the active segment at the byte trigger, and hands it to the worker, with no sync on the calling thread', () => {
    const journal = open()
    journal.initialize(CHAT, records[0])
    notes.length = 0

    const head = appendToTrigger(journal)

    expect(syncs.issued).toEqual([])
    expect(exists(ACTIVE)).toBe(false)
    expect(lines(SEALED)).toEqual(Array.from({ length: head - 1 }, (_unused, index) => index + 2))
    expect(worker.started).toHaveLength(1)
    expect(worker.started[0].request).toMatchObject({
      chatId: CHAT,
      revision: head,
      journal: { path: path.join(baseDir, SEALED) },
      checkpoint: { path: path.join(baseDir, CHECKPOINT) }
    })
    // The rename is owed, and the bytes now under the sealed name.
    expect(notes.slice(-2)).toEqual([
      {
        file: path.join(baseDir, SEALED),
        owner: 'journal',
        renamedFrom: path.join(baseDir, ACTIVE)
      },
      { directory: baseDir }
    ])
    expect(journal.stats()).toMatchObject({
      compactionsStarted: 1,
      checkpointsWritten: 1,
      forcedSynchronousCheckpoints: 0
    })
  })

  it('renames the folded checkpoint into place, makes the rename durable off the thread, and only then unlinks the sealed segment', async () => {
    const journal = open()
    journal.initialize(CHAT, records[0])
    const head = appendToTrigger(journal)
    holdDirectorySyncs = true
    notes.length = 0

    const adopted = journal.checkpointDeferred!(CHAT)
    worker.complete()
    const syncsBefore = syncs.issued.length // the fold's own sync, on the worker's thread here
    await settle()

    // Renamed into place; the sealed segment waits for the directory.
    expect(read()).toMatchObject({ revision: head })
    expect(JSON.parse(fs.readFileSync(path.join(baseDir, CHECKPOINT), 'utf8'))).toMatchObject({
      revision: head
    })
    expect(exists(SEALED)).toBe(true)
    expect(directorySyncs.map((each) => each.directory)).toEqual([baseDir])
    expect(prepared()).toEqual([])

    directorySyncs[0].release()
    await expect(adopted).resolves.toBe('checkpointed')

    expect(exists(SEALED)).toBe(false)
    expect(notes).toEqual([{ directory: baseDir }])
    expect(syncs.issued.length).toBe(syncsBefore)
    expect(journal.stats()).toMatchObject({ compactionsAdopted: 1, checkpointsWritten: 2 })
    expect(read()).toMatchObject({ record: records[head - 1], revision: head, appliedBatches: 0 })
  })

  it('leaves the sealed segment where it is when the directory cannot be made durable, and the next compaction finishes it', async () => {
    const journal = open()
    journal.initialize(CHAT, records[0])
    const head = appendToTrigger(journal)
    holdDirectorySyncs = true

    const adopted = journal.checkpointDeferred!(CHAT)
    worker.complete()
    await settle()
    directorySyncs[0].fail(Object.assign(new Error('EIO: injected'), { code: 'EIO' }))
    await expect(adopted).rejects.toThrow('EIO')

    expect(exists(SEALED)).toBe(true)
    expect(read()).toMatchObject({ revision: head })
    expect(journal.stats()).toMatchObject({ compactionsFailed: 1, compactionsAdopted: 0 })
    expect(prepared()).toEqual([])

    clock += 60_000
    holdDirectorySyncs = false
    const again = journal.checkpointDeferred!(CHAT)
    worker.complete()
    await expect(again).resolves.toBe('checkpointed')
    expect(exists(SEALED)).toBe(false)
    expect(read()).toMatchObject({ record: records[head - 1], revision: head })
    expect(prepared()).toEqual([])
  })

  it('keeps appending to a new active segment while the worker folds, and the chain reads through the adopted checkpoint', async () => {
    const journal = open()
    journal.initialize(CHAT, records[0])
    let head = appendToTrigger(journal)
    const sealedAt = head
    // Lines racing the fold.
    for (let index = 0; index < 2; index += 1) journal.append(batches[head++ - 1])

    const adopted = journal.checkpointDeferred!(CHAT)
    worker.complete()
    await expect(adopted).resolves.toBe('checkpointed')

    expect(lines(ACTIVE)).toEqual([sealedAt + 1, sealedAt + 2])
    expect(read()).toMatchObject({ record: records[head - 1], revision: head, appliedBatches: 2 })
    // The thread goes on, counted from the lines the active segment holds.
    journal.append(batches[head - 1])
    expect(read()).toMatchObject({ revision: head + 1 })
    expect(worker.started).toHaveLength(1)
  })

  it('starts no second fold while one runs: a second request joins it, and the trigger reached again forces nothing', async () => {
    const journal = open()
    journal.initialize(CHAT, records[0])
    let head = appendToTrigger(journal)
    for (let index = 0; index < 6; index += 1) journal.append(batches[head++ - 1])

    const first = journal.checkpointDeferred!(CHAT)
    const second = journal.checkpointDeferred!(CHAT)
    expect(worker.started).toHaveLength(1)
    expect(syncs.issued).toEqual([])
    expect(journal.stats()).toMatchObject({
      forcedSynchronousCheckpoints: 0,
      compactionCapFallbacks: 0,
      checkpointsWritten: 1
    })

    worker.complete()
    await expect(first).resolves.toBe('checkpointed')
    await expect(second).resolves.toBe('checkpointed')
    expect(worker.started).toHaveLength(1)
  })

  it('leaves the sealed segment and its lines when the worker dies mid-fold, removes its output, and tries again after a pause, not at the next line', async () => {
    const journal = open()
    journal.initialize(CHAT, records[0])
    let head = appendToTrigger(journal)
    const running = journal.checkpointDeferred!(CHAT)

    worker.die()
    await expect(running).rejects.toThrow('exited without a result')

    expect(exists(SEALED)).toBe(true)
    expect(prepared()).toEqual([])
    expect(read()).toMatchObject({ record: records[head - 1], revision: head })
    expect(journal.stats()).toMatchObject({ compactionsFailed: 1 })

    // At once: no new fold, however many lines arrive.
    journal.append(batches[head++ - 1])
    journal.append(batches[head++ - 1])
    expect(worker.started).toHaveLength(1)

    clock += 1_000
    journal.append(batches[head++ - 1])
    expect(worker.started).toHaveLength(2)
    // The sealed segment is folded as it stands; the new lines wait.
    expect(worker.started[1].request.journal.path).toBe(path.join(baseDir, SEALED))
    const retried = journal.checkpointDeferred!(CHAT)
    worker.complete()
    await expect(retried).resolves.toBe('checkpointed')
    expect(read()).toMatchObject({ record: records[head - 1], revision: head })
  })

  it('pauses longer after each failure in a row, up to a limit', async () => {
    const journal = open()
    journal.initialize(CHAT, records[0])
    appendToTrigger(journal)
    let running = journal.checkpointDeferred!(CHAT)
    const waits: number[] = []
    for (let failure = 0; failure < 9; failure += 1) {
      worker.die()
      await expect(running).rejects.toThrow()
      const before = worker.started.length
      let waited = 0
      for (;;) {
        clock += 1_000
        waited += 1_000
        running = journal.checkpointDeferred!(CHAT)
        if (worker.started.length > before) break
        await expect(running).resolves.toBe('unavailable')
      }
      waits.push(waited)
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 64, 64, 64].map((each) => each * 1_000))
    expect(journal.stats()).toMatchObject({ compactionsFailed: 9, compactionsStarted: 10 })
    worker.complete()
    await expect(running).resolves.toBe('checkpointed')
  })

  it('is not adopted when the thread is erased mid-fold, and the output is removed', async () => {
    const journal = open()
    journal.initialize(CHAT, records[0])
    appendToTrigger(journal)
    const running = journal.checkpointDeferred!(CHAT)

    journal.delete(CHAT)
    worker.complete()

    await expect(running).resolves.toBe('superseded')
    expect(exists(CHECKPOINT)).toBe(false)
    expect(exists(SEALED)).toBe(false)
    expect(exists(`${CHAT}.tombstone`)).toBe(true)
    expect(prepared()).toEqual([])
  })

  it('is not adopted when the thread is purged or re-anchored mid-fold', async () => {
    const journal = open()
    journal.initialize(CHAT, records[0])
    let head = appendToTrigger(journal)
    const running = journal.checkpointDeferred!(CHAT)
    journal.replaceAuthoritativeCheckpoint(CHAT, records[head + 4])
    worker.complete()
    await expect(running).resolves.toBe('superseded')
    expect(read()).toMatchObject({ record: records[head + 4], revision: head + 5 })
    expect(prepared()).toEqual([])

    head += 5
    while (worker.started.length < 2) journal.append(batches[head++ - 1])
    const purged = journal.checkpointDeferred!(CHAT)
    journal.purge(CHAT)
    worker.complete()
    await expect(purged).resolves.toBe('superseded')
    expect(fs.readdirSync(baseDir)).toEqual([])
  })

  it('compacts on the calling thread once, counted, when the active segment reaches its cap with the worker refusing', () => {
    worker.refusing = true
    const journal = open({ compactionHardCapBytes: 2 * TRIGGER })
    journal.initialize(CHAT, records[0])
    let head = 1
    while (journal.stats().compactionCapFallbacks === 0) {
      journal.append(batches[head++ - 1])
      clock += 1
      if (head > 60) throw new Error('the cap was never reached')
    }

    expect(journal.stats()).toMatchObject({
      compactionsRefused: 1,
      compactionCapFallbacks: 1,
      checkpointsWritten: 2
    })
    expect(exists(SEALED)).toBe(false)
    expect(exists(ACTIVE)).toBe(false)
    expect(read()).toMatchObject({ record: records[head - 1], revision: head, appliedBatches: 0 })
    // The next lines start from nothing again.
    journal.append(batches[head++ - 1])
    expect(journal.stats()).toMatchObject({ compactionCapFallbacks: 1 })
  })

  it('waits out a pause after a compaction at the cap fails, rather than trying at every line', () => {
    worker.refusing = true
    const journal = open({ compactionHardCapBytes: 2 * TRIGGER })
    journal.initialize(CHAT, records[0])
    const real = fs.openSync
    let full = true
    vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (full && String(target).includes(`${CHECKPOINT}.`))
        throw Object.assign(new Error('ENOSPC: injected'), { code: 'ENOSPC' })
      return (real as (...args: unknown[]) => number)(target, ...rest)
    }) as typeof fs.openSync)
    syncBuiltinESMExports()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    let head = 1
    while (journal.stats().compactionCapFallbacks === 0) journal.append(batches[head++ - 1])
    for (let index = 0; index < 5; index += 1) journal.append(batches[head++ - 1])
    expect(journal.stats()).toMatchObject({ compactionCapFallbacks: 1, checkpointsWritten: 1 })

    full = false
    clock += 1_000
    journal.append(batches[head++ - 1])
    expect(journal.stats()).toMatchObject({ compactionCapFallbacks: 2, checkpointsWritten: 2 })
    expect(read()).toMatchObject({ record: records[head - 1], revision: head })
  })

  it('removes a sealed name a power cut left with no bytes, and seals the active segment in its place', async () => {
    const journal = open()
    journal.initialize(CHAT, records[0])
    fs.writeFileSync(path.join(baseDir, SEALED), '')

    const head = appendToTrigger(journal)
    expect(worker.started[0].request.revision).toBe(head)
    const adopted = journal.checkpointDeferred!(CHAT)
    worker.complete()
    await expect(adopted).resolves.toBe('checkpointed')
    expect(exists(SEALED)).toBe(false)
    expect(read()).toMatchObject({ record: records[head - 1], revision: head })
  })

  it('removes a sealed segment that holds only a torn line once the next append has cut it', async () => {
    const writer = open()
    writer.initialize(CHAT, records[0])
    fs.writeFileSync(path.join(baseDir, SEALED), JSON.stringify(batches[0]).slice(0, 40))

    const journal = open({ repairTornTailBeforeAppend: true, canRepairOnRead: () => false })
    expect(journal.replay(CHAT)).toMatchObject({ revision: 1 })
    const head = appendToTrigger(journal)
    const adopted = journal.checkpointDeferred!(CHAT)
    worker.complete()
    await expect(adopted).resolves.toBe('checkpointed')
    expect(exists(SEALED)).toBe(false)
    expect(read()).toMatchObject({ record: records[head - 1], revision: head })
  })

  it('counts the active segment from its own lines once a torn sealed tail is cut, so the trigger fires on time', async () => {
    const writer = open()
    writer.initialize(CHAT, records[0])
    // Four whole lines and a torn tail longer than two lines, left by a power cut.
    fs.writeFileSync(
      path.join(baseDir, SEALED),
      batches
        .slice(0, 4)
        .map((batch) => `${JSON.stringify(batch)}\n`)
        .join('') + 'x'.repeat(500)
    )
    const journal = open({ repairTornTailBeforeAppend: true, canRepairOnRead: () => false })
    expect(journal.replay(CHAT)).toMatchObject({ revision: 5 })
    let head = 5
    // The next line cuts the torn tail first, then reaches the trigger.
    journal.append(batches[head++ - 1])
    expect(worker.started).toHaveLength(1)
    expect(worker.started[0].request.revision).toBe(5)
    const adopted = journal.checkpointDeferred!(CHAT)
    worker.complete()
    await expect(adopted).resolves.toBe('checkpointed')

    // The active segment holds one line; the trigger fires when its own lines reach it.
    let active = Buffer.byteLength(`${JSON.stringify(batches[4])}\n`)
    let last = 0
    while (worker.started.length === 1) {
      last = Buffer.byteLength(`${JSON.stringify(batches[head - 1])}\n`)
      journal.append(batches[head++ - 1])
      active += last
    }
    expect(active).toBeGreaterThanOrEqual(TRIGGER)
    expect(active - last).toBeLessThan(TRIGGER)
  })

  it('counts the time the segments spend at or above the trigger, from the line that reached it to the adoption that ended it', async () => {
    const journal = open()
    journal.initialize(CHAT, records[0])
    appendToTrigger(journal)
    clock += 600
    const adopted = journal.checkpointDeferred!(CHAT)
    worker.complete()
    await expect(adopted).resolves.toBe('checkpointed')

    expect(journal.stats()).toMatchObject({
      compactionMsAboveTrigger: 600,
      compactionLongestMsAboveTrigger: 600
    })
  })

  it('folds a sealed segment an earlier process left as it stands, never renaming over it', async () => {
    const before = open()
    before.initialize(CHAT, records[0])
    let head = appendToTrigger(before)
    const sealedAt = head
    before.append(batches[head++ - 1])
    // That process stops before its fold returns.

    worker = new HeldWorker(baseDir)
    const after = open()
    expect(after.replay(CHAT)).toMatchObject({ revision: head })
    const adopted = after.checkpointDeferred!(CHAT)
    expect(worker.started[0].request).toMatchObject({
      revision: sealedAt,
      journal: { path: path.join(baseDir, SEALED) }
    })
    worker.complete()
    await expect(adopted).resolves.toBe('checkpointed')

    expect(exists(SEALED)).toBe(false)
    expect(lines(ACTIVE)).toEqual([sealedAt + 1])
    expect(read()).toMatchObject({ record: records[head - 1], revision: head, appliedBatches: 1 })
  })

  it('folds a sealed segment the checkpoint already covers to the same revision, and removes it', async () => {
    // A crash after the adoption's rename and before the unlink leaves this.
    const writer = open()
    writer.initialize(CHAT, records[2])
    fs.writeFileSync(
      path.join(baseDir, SEALED),
      `${JSON.stringify(batches[0])}\n${JSON.stringify(batches[1])}\n`
    )
    fs.writeFileSync(path.join(baseDir, ACTIVE), `${JSON.stringify(batches[2])}\n`)

    const journal = open()
    expect(journal.replay(CHAT)).toMatchObject({ revision: 4, skippedBatches: 2 })
    const adopted = journal.checkpointDeferred!(CHAT)
    expect(worker.started[0].request.revision).toBe(3)
    worker.complete()
    await expect(adopted).resolves.toBe('checkpointed')

    expect(exists(SEALED)).toBe(false)
    expect(read()).toMatchObject({ record: records[3], revision: 4, appliedBatches: 1 })
  })

  it('is set off by bytes alone: neither the count of lines nor their age compacts', () => {
    const journal = open({ maxJournalEntries: 2, maxUncheckpointedMs: 10 })
    journal.initialize(CHAT, records[0])
    for (let head = 1; head <= 3; head += 1) {
      journal.append(batches[head - 1])
      clock += 1_000
    }

    expect(worker.started).toHaveLength(0)
    expect(journal.stats()).toMatchObject({
      checkpointsWritten: 1,
      forcedSynchronousCheckpoints: 0
    })
    expect(lines(ACTIVE)).toEqual([2, 3, 4])
  })

  it('without the option still compacts in line at the bound, as it always has', () => {
    const journal = createIncrementalChatJournal(baseDir, {
      checkpointPreparation: worker,
      maxJournalBytes: TRIGGER
    })
    journal.initialize(CHAT, records[0])
    let head = 1
    while (journal.stats().checkpointsWritten < 2) journal.append(batches[head++ - 1])

    expect(worker.started).toHaveLength(0)
    expect(exists(SEALED)).toBe(false)
    expect(exists(ACTIVE)).toBe(false)
  })

  describe('through the persistence coordinator', () => {
    it('writes no checkpoint for a thread’s final save: it is an append like any other', () => {
      const journal = open()
      const persistence = createIncrementalChatPersistence({ journal })
      persistence.persist(null, records[0], 'normal')
      notes.length = 0

      const result = persistence.persist(records[0], records[1], 'terminal')

      expect(result).toMatchObject({ checkpointed: false, mutationBytes: expect.any(Number) })
      expect(result.terminalCheckpointDeferred).toBeUndefined()
      expect(journal.stats()).toMatchObject({ checkpointsWritten: 1, appends: 1 })
      expect(syncs.issued).toEqual([])
      // Nor does the trailing flush a deferred one would have waited for.
      expect(persistence.checkpointChat(CHAT)).toBe(false)
      expect(journal.stats()).toMatchObject({ checkpointsWritten: 1 })
    })
  })
})
