/**
 * A journal told to leave syncing to the thread's barrier. An append then
 * only writes: it issues no sync, schedules none, and says what the disk is
 * owed for the line. The second half runs it over a model of a power loss, to
 * show what a barrier makes safe and what is lost without one.
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
  MAX_PENDING_DEFERRED_FSYNCS,
  type IncrementalChatAppendDurability,
  type IncrementalChatJournal,
  type IncrementalChatJournalOptions
} from './IncrementalChatJournal'
import { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'
import { createIncrementalChatPersistence } from './IncrementalChatPersistence'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import {
  createThreadDurabilityDebt,
  type NoteThreadDurabilityDebt,
  type ThreadDurabilityDebt,
  type ThreadDurabilityDebtNote
} from './ThreadDurabilityDebt'
import type { ChatRecord } from './types'
import {
  countSyncs,
  watchCrashDisk,
  type CrashDisk,
  type SyncCount
} from './unsyncedWriteCrashDisk.testutil'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-journal-unsynced-'

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

function chat(revision = 1, content = 'initial'): ChatRecord {
  return {
    appChatId: CHAT,
    title: CHAT,
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages: [
      { id: 'message', role: 'assistant', content, timestamp: '2026-10-04T00:00:00.000Z' }
    ],
    runs: []
  }
}

/** `records[n]` is at revision n + 1, and `batches[n]` takes `records[n]` to `records[n + 1]`. */
function chain(length: number): { records: ChatRecord[]; batches: ChatRecordMutationBatch[] } {
  const records = [chat()]
  const batches: ChatRecordMutationBatch[] = []
  for (let index = 0; index < length; index += 1) {
    const next = structuredClone(records[index])
    next.messages[0].content = `content ${index + 2}`
    next.persistenceRevision = index + 2
    next.updatedAt = index + 2
    batches.push(deriveChatRecordMutation(records[index], next))
    records.push(next)
  }
  return { records, batches }
}

/** The classes a caller may ask for. A journal that does not sync treats them alike. */
const CLASSES: Array<IncrementalChatAppendDurability | undefined> = [
  'immediate',
  'deferred',
  undefined
]

/** A flusher whose every sync goes through `node:fs`, where the tests can see it. */
function flusher(): MainDurabilityFlusher {
  return new MainDurabilityFlusher({
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    fsync: (fd, complete) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        fs.fsyncSync(fd)
        complete()
      }
      queueMicrotask(finish)
      return { joinSync: finish }
    },
    fsyncSync: (fd) => fs.fsyncSync(fd),
    close: (fd) => fs.closeSync(fd)
  })
}

/** Prepares a checkpoint on this thread when told to, as the worker would off it. */
class ControlledPreparation implements CheckpointPreparationPort {
  private readonly requests: Array<{
    request: CheckpointPreparationRequest
    ready: (value: PreparedCheckpoint) => void
  }> = []
  constructor(private readonly baseDir: string) {}
  start(source: CheckpointPreparationSource): CheckpointPreparationJob {
    const outputPath = path.join(
      this.baseDir,
      `.${source.chatId}.checkpoint-prepared-${process.pid}-${randomUUID()}.tmp`
    )
    fs.writeFileSync(outputPath, '', { flag: 'wx', mode: 0o600 })
    const output = checkpointFileReference(outputPath)
    let ready!: (value: PreparedCheckpoint) => void
    const result = new Promise<PreparedCheckpoint>((resolve) => {
      ready = resolve
    })
    const release = (): void => fs.rmSync(outputPath, { force: true })
    this.requests.push({ request: { ...source, output, maxOutputBytes: 1024 * 1024 }, ready })
    return { output, result, cancel: release, release }
  }
  complete(): void {
    const { request, ready } = this.requests[this.requests.length - 1]
    ready(prepareCheckpoint(request))
  }
}

describe('a journal that leaves syncing to the thread barrier', () => {
  let baseDir: string
  let activePath: string
  let sealedPath: string
  let syncs: SyncCount
  let notes: Array<[string, ThreadDurabilityDebtNote]>
  let scheduled: number
  const note: NoteThreadDurabilityDebt = (chatId, debt) => {
    notes.push([chatId, debt])
  }

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    activePath = path.join(baseDir, ACTIVE)
    sealedPath = path.join(baseDir, SEALED)
    syncs = countSyncs()
    notes = []
    scheduled = 0
  })

  afterEach(() => {
    syncs.dispose()
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    removeTemporaryDirectory(baseDir)
  })

  const writer = (options: IncrementalChatJournalOptions = {}): IncrementalChatJournal =>
    createIncrementalChatJournal(baseDir, {
      noteDurabilityDebt: note,
      scheduleFsync: () => {
        scheduled += 1
      },
      ...options
    })
  const replayed = (): ReturnType<IncrementalChatJournal['replay']> =>
    createIncrementalChatJournal(baseDir, { canWrite: () => false }).replay(CHAT)
  /** Forget what the set-up issued and noted: the test is about what follows. */
  const fromHere = (): void => {
    syncs.issued.length = 0
    notes.length = 0
  }
  const segment = { file: '', owner: 'journal' } as { file: string; owner: 'journal' }
  const owedSegment = (): [string, ThreadDurabilityDebtNote] => [
    CHAT,
    { ...segment, file: activePath }
  ]
  const owedDirectory = (): [string, ThreadDurabilityDebtNote] => [CHAT, { directory: baseDir }]
  /** The sealed segment, with the name its bytes were under until the rotation. */
  const owedSealed = (): [string, ThreadDurabilityDebtNote] => [
    CHAT,
    { file: sealedPath, owner: 'journal', renamedFrom: activePath }
  ]

  it('writes a long run of lines without issuing or scheduling one sync', () => {
    const { records, batches } = chain(3 * MAX_PENDING_DEFERRED_FSYNCS)
    const journal = writer()
    journal.initialize(CHAT, records[0])
    fromHere()

    batches.forEach((batch, index) => {
      journal.append(batch, { durability: CLASSES[index % CLASSES.length] })
    })

    expect(syncs.issued).toEqual([])
    expect(scheduled).toBe(0)
    expect(journal.stats()).toMatchObject({
      appends: batches.length,
      unsyncedAppends: batches.length,
      deferredAppends: 0,
      deferredFsyncFailures: 0,
      immediateFsyncFailures: 0,
      drainedDeferredFsyncs: 0
    })
    expect(replayed()).toMatchObject({
      record: records[batches.length],
      appliedBatches: batches.length
    })
  })

  it('counts no line as unsynced when it was not asked to leave syncing alone', () => {
    const { records, batches } = chain(2)
    const journal = writer({ noteDurabilityDebt: undefined })
    journal.initialize(CHAT, records[0])
    journal.append(batches[0])
    journal.append(batches[1], { durability: 'deferred' })

    expect(journal.stats()).toMatchObject({ appends: 2, unsyncedAppends: 0, deferredAppends: 1 })
    expect(notes).toEqual([])
  })

  it('notes the segment for every line, and its directory for the line that creates it', () => {
    const { records, batches } = chain(3)
    const journal = writer()
    journal.initialize(CHAT, records[0])
    expect(notes).toEqual([])

    journal.append(batches[0])
    expect(notes).toEqual([owedDirectory(), owedSegment()])
    journal.append(batches[1], { durability: 'deferred' })
    journal.append(batches[2], { durability: 'immediate' })
    expect(notes).toEqual([owedDirectory(), owedSegment(), owedSegment(), owedSegment()])
  })

  it('notes the directory in place of the sync that follows a compaction', () => {
    const { records, batches } = chain(3)
    const journal = writer()
    journal.initialize(CHAT, records[0])
    journal.append(batches[0])
    journal.append(batches[1])
    fromHere()

    expect(journal.checkpoint(CHAT, 'manual')).toBe(true)

    // The checkpoint file and the directory that now names it are still synced
    // in line. The removal of the segment after them is what is owed.
    expect(syncs.issued).toEqual(['fsyncSync', 'fsyncSync'])
    expect(notes).toEqual([owedDirectory()])
    expect(fs.existsSync(activePath)).toBe(false)

    // The next line makes a new segment under the old name.
    fromHere()
    journal.append(batches[2])
    expect(syncs.issued).toEqual([])
    expect(notes).toEqual([owedDirectory(), owedSegment()])
  })

  it('a compaction by a journal that syncs issues the third sync itself', () => {
    const { records, batches } = chain(1)
    const journal = writer({ noteDurabilityDebt: undefined })
    journal.initialize(CHAT, records[0])
    journal.append(batches[0])
    fromHere()

    expect(journal.checkpoint(CHAT, 'manual')).toBe(true)

    expect(syncs.issued).toEqual(['fsyncSync', 'fsyncSync', 'fsyncSync'])
    expect(notes).toEqual([])
  })

  it('still syncs in line when it writes the first checkpoint, re-anchors or erases', () => {
    const { records, batches } = chain(2)
    const journal = writer()

    journal.initialize(CHAT, records[0])
    expect(syncs.issued).toEqual(['fsyncSync', 'fsyncSync', 'fsyncSync'])

    journal.append(batches[0])
    fromHere()
    journal.replaceAuthoritativeCheckpoint(CHAT, records[2])
    expect(syncs.issued).toEqual(['fsyncSync', 'fsyncSync', 'fsyncSync'])
    expect(fs.existsSync(activePath)).toBe(false)

    fromHere()
    journal.delete(CHAT)
    expect(syncs.issued).toEqual(['fsyncSync', 'fsyncSync', 'fsyncSync'])

    fromHere()
    journal.purge(CHAT)
    expect(syncs.issued).toEqual(['fsyncSync'])
    expect(notes).toEqual([])
  })

  it('does not count an owed line as a synchronous durability moment', () => {
    const { records, batches } = chain(2)
    const moments: string[] = []
    const journal = writer({ residualObserver: (counter) => moments.push(counter) })
    journal.initialize(CHAT, records[0])

    journal.append(batches[0], { durability: 'immediate' })
    journal.append(batches[1])

    expect(moments).toEqual([])
  })

  it('has no flush of its own to wait for or to drain', async () => {
    const { records, batches } = chain(2)
    const journal = writer()
    journal.initialize(CHAT, records[0])
    journal.append(batches[0], { durability: 'immediate' })
    journal.append(batches[1], { durability: 'deferred' })
    fromHere()

    expect(journal.drainDeferredDurability()).toBe(0)
    await expect(journal.awaitDeferredDurability!(CHAT)).resolves.toBeUndefined()

    expect(syncs.issued).toEqual([])
    expect(journal.stats().drainedDeferredFsyncs).toBe(0)
  })

  it('fails an append whose write fails, closes its descriptor and owes nothing for it', () => {
    const { records, batches } = chain(2)
    const journal = writer()
    journal.initialize(CHAT, records[0])
    fromHere()
    const opened: number[] = []
    const closed: number[] = []
    const realOpen = fs.openSync
    const realClose = fs.closeSync
    vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
      const fd = realOpen(target, flags, mode)
      if (target === activePath) opened.push(fd)
      return fd
    })
    vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      closed.push(fd)
      realClose(fd)
    })
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    })
    syncBuiltinESMExports()

    expect(() => journal.append(batches[0])).toThrow('ENOSPC')

    expect(opened).toHaveLength(1)
    expect(closed.filter((fd) => fd === opened[0])).toHaveLength(1)
    expect(notes).toEqual([])
    expect(syncs.issued).toEqual([])
    expect(journal.stats()).toMatchObject({ appends: 0, unsyncedAppends: 0 })

    // The same batch is still the next one, and the line that creates the
    // segment's bytes is the one that owes its directory.
    journal.append(batches[0])
    journal.append(batches[1])
    expect(notes).toEqual([owedDirectory(), owedSegment(), owedSegment()])
    expect(replayed()).toMatchObject({ record: records[2], appliedBatches: 2 })
  })

  it('through the persistence coordinator, only the terminal checkpoint still syncs', () => {
    const { records } = chain(3)
    const persistence = createIncrementalChatPersistence({
      journal: writer(),
      logger: { error: () => {}, warn: () => {} }
    })
    persistence.persist(null, records[0], 'normal')
    fromHere()

    persistence.persist(records[0], records[1], 'normal')
    persistence.persist(records[1], records[2], 'approval')
    expect(syncs.issued).toEqual([])

    expect(persistence.persist(records[2], records[3], 'terminal')).toMatchObject({
      checkpointed: true
    })
    // The checkpoint file and its directory: the line before them owed its own.
    expect(syncs.issued).toEqual(['fsyncSync', 'fsyncSync'])
    expect(persistence.stats().journal).toMatchObject({ appends: 3, unsyncedAppends: 3 })
  })

  describe('with a descriptor cache', () => {
    let pool: MainDurabilityFlusher
    let cache: IncrementalChatJournalDescriptorCache

    let told: ReturnType<typeof vi.spyOn>[]

    beforeEach(() => {
      pool = flusher()
      told = [vi.spyOn(pool, 'noteWrite'), vi.spyOn(pool, 'transferDependencies')]
      cache = new IncrementalChatJournalDescriptorCache(pool)
    })

    afterEach(() => {
      cache.retireSync()
    })

    const cached = (options: IncrementalChatJournalOptions = {}): IncrementalChatJournal =>
      writer({
        descriptorCache: cache,
        descriptorDrainSync: () => pool.drainSync(),
        ...options
      })
    /** A directory that gained a name. Windows has no directory sync, and the cache owes none there. */
    const named = (): Array<[string, ThreadDurabilityDebtNote]> =>
      process.platform === 'win32' ? [] : [owedDirectory()]
    const untouched = (): void => {
      for (const call of told) expect(call).not.toHaveBeenCalled()
      expect(pool.counters).toEqual({
        asyncFsyncs: 0,
        syncFsyncs: 0,
        strictFsyncs: 0,
        dependencySyncFsyncs: 0,
        hardBoundFsyncs: 0,
        escalations: 0,
        errors: 0
      })
      const owners = pool.ownerSnapshot()
      expect(owners.journal).toMatchObject({ writtenBytes: 0, dirtyBytes: 0 })
      expect(owners.directory).toMatchObject({ registeredFiles: 0, directoryMutations: 0 })
    }

    it('writes through the cached descriptor and tells the flusher nothing', () => {
      const { records, batches } = chain(3 * MAX_PENDING_DEFERRED_FSYNCS)
      const journal = cached()
      journal.initialize(CHAT, records[0])
      fromHere()
      const opens = vi.spyOn(fs, 'openSync')
      syncBuiltinESMExports()

      batches.forEach((batch, index) => {
        journal.append(batch, { durability: CLASSES[index % CLASSES.length] })
      })

      expect(opens.mock.calls.filter(([target]) => target === activePath)).toHaveLength(1)
      expect(syncs.issued).toEqual([])
      expect(scheduled).toBe(0)
      untouched()
      expect(notes).toEqual([...named(), ...batches.map(() => owedSegment())])
      expect(journal.stats()).toMatchObject({
        appends: batches.length,
        unsyncedAppends: batches.length,
        deferredAppends: 0
      })
      expect(replayed()).toMatchObject({
        record: records[batches.length],
        appliedBatches: batches.length
      })
    })

    it('counts no owed line as a synchronous durability moment there either', () => {
      const { records, batches } = chain(1)
      const moments: string[] = []
      const journal = cached({ residualObserver: (counter) => moments.push(counter) })
      journal.initialize(CHAT, records[0])

      journal.append(batches[0], { durability: 'immediate' })

      expect(moments).toEqual([])
    })

    it('has nothing in the flusher to wait for or to drain', async () => {
      const { records, batches } = chain(2)
      const journal = cached()
      journal.initialize(CHAT, records[0])
      journal.append(batches[0], { durability: 'immediate' })
      journal.append(batches[1], { durability: 'deferred' })
      fromHere()

      expect(journal.drainDeferredDurability()).toBe(0)
      await expect(journal.awaitDeferredDurability!(CHAT)).resolves.toBeUndefined()

      expect(syncs.issued).toEqual([])
      untouched()
    })

    it('fails an append whose write fails, still owing the directory the open changed', () => {
      const { records, batches } = chain(1)
      const failure = new Error('ENOSPC: no space left on device, write')
      let fail = true
      cache = new IncrementalChatJournalDescriptorCache(pool, {
        write: (fd, bytes) => {
          if (fail) throw failure
          fs.writeFileSync(fd, bytes)
        }
      })
      const journal = cached()
      journal.initialize(CHAT, records[0])
      fromHere()

      expect(() => journal.append(batches[0])).toThrow(failure)
      expect(notes).toEqual(named())
      expect(journal.stats()).toMatchObject({ appends: 0, unsyncedAppends: 0 })

      fail = false
      journal.append(batches[0])
      expect(notes).toEqual([...named(), owedSegment()])
      expect(syncs.issued).toEqual([])
      untouched()
      expect(replayed()).toMatchObject({ record: records[1], appliedBatches: 1 })
    })

    it('notes a rotation: the directory the rename changed, and the sealed segment under its new name', () => {
      const { records, batches } = chain(3)
      const journal = cached({ rotationEnabled: true })
      journal.initialize(CHAT, records[0])
      journal.append(batches[0])
      journal.append(batches[1])
      fromHere()

      expect(journal.rotateForPreparation!(CHAT)).toMatchObject({ revision: 3 })

      expect(fs.existsSync(sealedPath)).toBe(true)
      expect(notes).toEqual([owedDirectory(), owedSealed()])
      expect(syncs.issued).toEqual([])
      untouched()

      // The line after it makes a new segment under the old name.
      fromHere()
      journal.append(batches[2])
      expect(notes).toEqual([...named(), owedSegment()])
      expect(syncs.issued).toEqual([])
      untouched()
      expect(replayed()).toMatchObject({ record: records[3], appliedBatches: 3 })
    })

    it('rotates at the bound instead of compacting, and still issues no sync', () => {
      const { records, batches } = chain(2)
      const journal = cached({ rotationEnabled: true, maxJournalEntries: 2 })
      journal.initialize(CHAT, records[0])
      fromHere()

      journal.append(batches[0])
      journal.append(batches[1])

      expect(fs.existsSync(sealedPath)).toBe(true)
      expect(fs.existsSync(activePath)).toBe(false)
      expect(syncs.issued).toEqual([])
      untouched()
      expect(notes).toEqual([
        ...named(),
        owedSegment(),
        owedSegment(),
        owedDirectory(),
        owedSealed()
      ])
    })

    it('still pays in line for the checkpoint forced by a bound reached while a sealed segment is outstanding', () => {
      const { records, batches } = chain(3)
      const journal = cached({ rotationEnabled: true, maxJournalEntries: 2 })
      journal.initialize(CHAT, records[0])
      journal.append(batches[0])
      journal.append(batches[1])
      fromHere()

      journal.append(batches[2])

      expect(journal.stats().forcedSynchronousCheckpoints).toBe(1)
      // The checkpoint file and its directory. Both segments' removal is owed.
      expect(syncs.issued).toEqual(['fsyncSync', 'fsyncSync'])
      expect(notes).toEqual([...named(), owedSegment(), owedDirectory()])
      expect(fs.existsSync(sealedPath)).toBe(false)
      expect(fs.existsSync(activePath)).toBe(false)
      untouched()
      expect(replayed()).toMatchObject({ record: records[3], appliedBatches: 0 })
    })
  })
})

describe.skipIf(process.platform === 'win32')(
  'what a power loss leaves of a journal that does not sync',
  () => {
    let baseDir: string
    let activePath: string
    let sealedPath: string
    let disk: CrashDisk
    let debt: ThreadDurabilityDebt

    beforeEach(() => {
      baseDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
      activePath = path.join(baseDir, ACTIVE)
      sealedPath = path.join(baseDir, SEALED)
      disk = watchCrashDisk(baseDir)
      debt = createThreadDurabilityDebt({ port: disk.port })
    })

    afterEach(() => {
      disk.dispose()
      removeTemporaryDirectory(baseDir)
    })

    const writer = (options: IncrementalChatJournalOptions = {}): IncrementalChatJournal =>
      createIncrementalChatJournal(baseDir, { noteDurabilityDebt: debt.note, ...options })
    /** Lose power, then read the thread back the way a fresh start does. */
    const afterPowerLoss = (): ReturnType<IncrementalChatJournal['replay']> => {
      disk.powerLoss()
      return createIncrementalChatJournal(baseDir).replay(CHAT)
    }
    const fromHere = (): void => {
      disk.issued.length = 0
      disk.paid.length = 0
    }

    it('keeps every line a barrier covered and loses the lines after it', async () => {
      const { records, batches } = chain(5)
      const journal = writer()
      journal.initialize(CHAT, records[0])
      fromHere()

      journal.append(batches[0], { durability: 'immediate' })
      journal.append(batches[1], { durability: 'deferred' })
      journal.append(batches[2])
      await debt.barrier(CHAT)
      journal.append(batches[3], { durability: 'immediate' })
      journal.append(batches[4])

      expect(disk.issued).toEqual([])
      expect(disk.paid).toEqual([`file:${ACTIVE}`, 'directory:.'])
      expect(afterPowerLoss()).toMatchObject({ record: records[3], appliedBatches: 3 })
    })

    it('loses the whole segment, name and all, when no barrier was raised', () => {
      const { records, batches } = chain(3)
      const journal = writer()
      journal.initialize(CHAT, records[0])
      for (const batch of batches) journal.append(batch, { durability: 'immediate' })

      expect(afterPowerLoss()).toMatchObject({ record: records[0], appliedBatches: 0 })
      expect(fs.existsSync(activePath)).toBe(false)
    })

    it('a journal that syncs loses none of the same lines', () => {
      const { records, batches } = chain(3)
      const journal = writer({ noteDurabilityDebt: undefined })
      journal.initialize(CHAT, records[0])
      for (const batch of batches) journal.append(batch, { durability: 'immediate' })

      expect(afterPowerLoss()).toMatchObject({ record: records[3], appliedBatches: 3 })
    })

    it('brings folded lines back beside the checkpoint when no barrier followed the compaction, and replay passes over them', async () => {
      const { records, batches } = chain(2)
      const journal = writer()
      journal.initialize(CHAT, records[0])
      journal.append(batches[0])
      journal.append(batches[1])
      await debt.barrier(CHAT)

      expect(journal.checkpoint(CHAT, 'manual')).toBe(true)
      expect(fs.existsSync(activePath)).toBe(false)

      expect(afterPowerLoss()).toMatchObject({
        record: records[2],
        appliedBatches: 0,
        skippedBatches: 2
      })
      expect(fs.existsSync(activePath)).toBe(true)
    })

    it('makes the removal safe with the barrier after a compaction', async () => {
      const { records, batches } = chain(2)
      const journal = writer()
      journal.initialize(CHAT, records[0])
      journal.append(batches[0])
      journal.append(batches[1])
      await debt.barrier(CHAT)
      expect(journal.checkpoint(CHAT, 'manual')).toBe(true)
      fromHere()

      await debt.barrier(CHAT)

      expect(disk.paid).toEqual(['directory:.'])
      expect(afterPowerLoss()).toMatchObject({
        record: records[2],
        appliedBatches: 0,
        skippedBatches: 0
      })
      expect(fs.existsSync(activePath)).toBe(false)
    })

    it('keeps a line appended after a compaction once its barrier settles, under the name the old segment had', async () => {
      const { records, batches } = chain(4)
      const journal = writer()
      journal.initialize(CHAT, records[0])
      journal.append(batches[0])
      journal.append(batches[1])
      await debt.barrier(CHAT)
      expect(journal.checkpoint(CHAT, 'manual')).toBe(true)

      journal.append(batches[2])
      await debt.barrier(CHAT)
      journal.append(batches[3])

      expect(afterPowerLoss()).toMatchObject({
        record: records[3],
        appliedBatches: 1,
        skippedBatches: 0
      })
    })

    it('without that barrier brings the old segment back under the name, and the new line is lost', async () => {
      const { records, batches } = chain(3)
      const journal = writer()
      journal.initialize(CHAT, records[0])
      journal.append(batches[0])
      journal.append(batches[1])
      await debt.barrier(CHAT)
      expect(journal.checkpoint(CHAT, 'manual')).toBe(true)

      journal.append(batches[2])

      expect(afterPowerLoss()).toMatchObject({
        record: records[2],
        appliedBatches: 0,
        skippedBatches: 2
      })
    })

    it('leaves nothing of the lines a re-anchor replaced, with or without a barrier', async () => {
      const { records, batches } = chain(2)
      const journal = writer()
      journal.initialize(CHAT, records[0])
      journal.append(batches[0])
      journal.append(batches[1])
      await debt.barrier(CHAT)
      // The store went another way from revision 2: the line to 3 is abandoned.
      const other = structuredClone(records[1])
      other.messages[0].content = 'another way'

      journal.replaceAuthoritativeCheckpoint(CHAT, other)

      expect(afterPowerLoss()).toMatchObject({ record: other, revision: 2, appliedBatches: 0 })
      expect(fs.existsSync(activePath)).toBe(false)
    })

    it('adopts a prepared checkpoint with the one sync that makes it safe, and owes the removal after it', async () => {
      const { records, batches } = chain(2)
      const preparation = new ControlledPreparation(baseDir)
      const journal = writer({ checkpointPreparation: preparation })
      journal.initialize(CHAT, records[0])
      journal.append(batches[0])
      journal.append(batches[1])
      await debt.barrier(CHAT)
      fromHere()

      const adopted = journal.checkpointDeferred!(CHAT)
      preparation.complete()
      await expect(adopted).resolves.toBe('checkpointed')

      // The prepared file's own sync, then the directory that now names it.
      expect(disk.issued.map((entry) => entry.split(':')[0])).toEqual(['file', 'directory'])
      expect(fs.existsSync(activePath)).toBe(false)
      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 0, directories: 1 })

      await debt.barrier(CHAT)
      expect(disk.paid).toEqual(['directory:.'])
      expect(afterPowerLoss()).toMatchObject({ record: records[2], skippedBatches: 0 })
      expect(fs.existsSync(activePath)).toBe(false)
    })

    describe('with rotation', () => {
      let pool: MainDurabilityFlusher
      let cache: IncrementalChatJournalDescriptorCache

      beforeEach(() => {
        pool = flusher()
        cache = new IncrementalChatJournalDescriptorCache(pool)
      })

      afterEach(() => {
        cache.retireSync()
      })

      const rotating = (options: IncrementalChatJournalOptions = {}): IncrementalChatJournal =>
        writer({ descriptorCache: cache, rotationEnabled: true, ...options })

      it('makes the sealed segment, the new one and both names safe with one barrier', async () => {
        const { records, batches } = chain(4)
        const journal = rotating()
        journal.initialize(CHAT, records[0])
        fromHere()
        journal.append(batches[0])
        journal.append(batches[1])
        expect(journal.rotateForPreparation!(CHAT)).toMatchObject({ revision: 3 })
        journal.append(batches[2])

        await debt.barrier(CHAT)
        journal.append(batches[3])

        expect(disk.issued).toEqual([])
        expect([...disk.paid].sort()).toEqual(['directory:.', `file:${ACTIVE}`, `file:${SEALED}`])
        expect(disk.paid[disk.paid.length - 1]).toBe('directory:.')
        expect(afterPowerLoss()).toMatchObject({ record: records[3], appliedBatches: 3 })
        expect(fs.existsSync(sealedPath)).toBe(true)
      })

      /** A ledger whose file syncs reach the disk only when the test lets them, as on a busy pool. */
      const lateBarriers = (): { late: ThreadDurabilityDebt; letThrough: () => void } => {
        let letThrough!: () => void
        const held = new Promise<void>((resolve) => {
          letThrough = resolve
        })
        const late = createThreadDurabilityDebt({
          port: {
            syncFile: async (target) => {
              await held
              return disk.port.syncFile(target)
            },
            syncDirectory: (target) => disk.port.syncDirectory(target)
          }
        })
        return { late, letThrough }
      }

      it('keeps the lines a barrier was raised for when their segment is sealed before the barrier reaches it', async () => {
        const { records, batches } = chain(1)
        const { late, letThrough } = lateBarriers()
        const journal = rotating({ noteDurabilityDebt: late.note })
        journal.initialize(CHAT, records[0])
        journal.append(batches[0])
        fromHere()

        const acknowledged = late.barrier(CHAT)
        expect(journal.rotateForPreparation!(CHAT)).toMatchObject({ revision: 2 })
        letThrough()
        await acknowledged

        // Nothing is under the old name any more: the line is in the sealed segment.
        expect(disk.paid).toEqual([`file:${SEALED}`, 'directory:.'])
        expect(afterPowerLoss()).toMatchObject({ record: records[1], appliedBatches: 1 })
      })

      it('keeps them when a new segment has taken the old name by then as well', async () => {
        const { records, batches } = chain(2)
        const { late, letThrough } = lateBarriers()
        const journal = rotating({ noteDurabilityDebt: late.note })
        journal.initialize(CHAT, records[0])
        journal.append(batches[0])
        fromHere()

        const acknowledged = late.barrier(CHAT)
        expect(journal.rotateForPreparation!(CHAT)).toMatchObject({ revision: 2 })
        journal.append(batches[1])
        letThrough()
        await acknowledged

        expect(disk.paid).toEqual([`file:${ACTIVE}`, `file:${SEALED}`, 'directory:.'])
        expect(afterPowerLoss()).toMatchObject({ record: records[2], appliedBatches: 2 })
      })

      it('undoes a rotation no barrier covered: the old name holds the lines the last barrier did', async () => {
        const { records, batches } = chain(3)
        const journal = rotating()
        journal.initialize(CHAT, records[0])
        journal.append(batches[0])
        await debt.barrier(CHAT)

        journal.append(batches[1])
        expect(journal.rotateForPreparation!(CHAT)).toMatchObject({ revision: 3 })
        journal.append(batches[2])

        expect(afterPowerLoss()).toMatchObject({ record: records[1], appliedBatches: 1 })
        expect(fs.existsSync(sealedPath)).toBe(false)
      })

      it('can be left with a chain replay refuses, when the new segment reaches the disk and the end of the sealed one does not', async () => {
        const { records, batches } = chain(3)
        const journal = rotating()
        journal.initialize(CHAT, records[0])
        journal.append(batches[0])
        await debt.barrier(CHAT)

        journal.append(batches[1])
        expect(journal.rotateForPreparation!(CHAT)).toMatchObject({ revision: 3 })
        journal.append(batches[2])
        // No barrier was raised, and none acknowledged these lines. The system
        // wrote out the new segment and the directory by itself all the same.
        disk.flushedAnyway(activePath)
        disk.flushedAnyway(baseDir)

        disk.powerLoss()

        // The sealed segment ends at revision 2 and the new one starts from 3.
        expect(fs.readFileSync(sealedPath, 'utf8')).toBe(`${JSON.stringify(batches[0])}\n`)
        expect(fs.readFileSync(activePath, 'utf8')).toBe(`${JSON.stringify(batches[2])}\n`)
        expect(() => createIncrementalChatJournal(baseDir).replay(CHAT)).toThrow('revision gap')
      })

      it('owes the removal of an adopted sealed segment to the next barrier', async () => {
        const { records, batches } = chain(3)
        const preparation = new ControlledPreparation(baseDir)
        const journal = rotating({ checkpointPreparation: preparation })
        journal.initialize(CHAT, records[0])
        journal.append(batches[0])
        journal.append(batches[1])
        await debt.barrier(CHAT)

        const adopted = journal.checkpointDeferred!(CHAT)
        journal.append(batches[2])
        await debt.barrier(CHAT)
        fromHere()
        preparation.complete()
        await expect(adopted).resolves.toBe('checkpointed')

        expect(fs.existsSync(sealedPath)).toBe(false)
        expect(debt.snapshot().owed).toEqual({ threads: 1, files: 0, directories: 1 })
        // Without the barrier the sealed segment comes back, and is passed over.
        disk.powerLoss()
        expect(fs.existsSync(sealedPath)).toBe(true)
        expect(createIncrementalChatJournal(baseDir).replay(CHAT)).toMatchObject({
          record: records[3],
          appliedBatches: 1,
          skippedBatches: 2
        })
      })
    })
  }
)
