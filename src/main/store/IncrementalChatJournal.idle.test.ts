/**
 * Idle, quit and re-anchor under `noteDurabilityDebt`, without a descriptor
 * cache. An idle chat whose lines pass a small byte threshold is compacted in
 * the worker; nothing is written on the calling thread at idle or at quit,
 * where the barrier makes the log durable. The re-anchor stays synced and on
 * the calling thread, and is counted by cause with its bytes and time.
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
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
import type { ChatRecord } from './types'
import { countSyncs, type SyncCount } from './unsyncedWriteCrashDisk.testutil'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-journal-idle-'

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
const OTHER = 'chat-2'
const THIRD = 'chat-3'
const CHECKPOINT = `${CHAT}.checkpoint.json`
const SEALED = `${CHAT}.sealed.mutations.jsonl`

function chat(id: string, revision: number, content = `content ${revision}`): ChatRecord {
  return {
    appChatId: id,
    title: id,
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages: [
      { id: 'message', role: 'assistant', content, timestamp: '2026-10-05T00:00:00.000Z' }
    ],
    runs: []
  }
}

/** `records(id)[n]` is at revision n + 1, and `batches(id)[n]` takes it to revision n + 2. */
const records = (id: string): ChatRecord[] =>
  Array.from({ length: 12 }, (_unused, index) => chat(id, index + 1))
const batches = (id: string): ChatRecordMutationBatch[] => {
  const all = records(id)
  return all.slice(0, -1).map((record, index) => deriveChatRecordMutation(record, all[index + 1]))
}

/** The worker, run on this thread when a test says so. Cancelling fails the job, as the pool's does. */
class HeldWorker implements CheckpointPreparationPort {
  started: Array<{
    request: CheckpointPreparationRequest
    ready: (value: PreparedCheckpoint) => void
    fail: (error: Error) => void
  }> = []
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
    let ready!: (value: PreparedCheckpoint) => void
    let fail!: (error: Error) => void
    const result = new Promise<PreparedCheckpoint>((resolve, reject) => {
      ready = resolve
      fail = reject
    })
    const release = (): void => fs.rmSync(outputPath, { force: true })
    const cancel = (): void => {
      fail(new Error('Checkpoint preparation cancelled'))
      release()
    }
    this.started.push({
      request: { ...source, output, maxOutputBytes: 1024 * 1024 },
      ready,
      fail
    })
    return { output, result, cancel, release }
  }

  complete(index = this.started.length - 1): void {
    const { request, ready } = this.started[index]
    ready(prepareCheckpoint(request))
  }

  /** The worker process died before it replied. */
  die(index = this.started.length - 1): void {
    this.started[index].fail(new Error('Checkpoint preparation process exited without a result'))
  }
}

describe('idle and quit under the barrier, without a descriptor cache', () => {
  let baseDir: string
  let worker: HeldWorker
  let syncs: SyncCount
  let clock: number

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    worker = new HeldWorker(baseDir)
    syncs = countSyncs()
    clock = 1_000_000
  })

  afterEach(() => {
    syncs.dispose()
    vi.restoreAllMocks()
    removeTemporaryDirectory(baseDir)
  })

  const open = (extra: IncrementalChatJournalOptions = {}): IncrementalChatJournal =>
    createIncrementalChatJournal(baseDir, {
      noteDurabilityDebt: () => {},
      checkpointPreparation: worker,
      maxJournalBytes: 1024 * 1024,
      idleCompactionBytes: 500,
      idleCheckpointMs: 1_000,
      syncDirectory: async () => {},
      now: () => clock,
      ...extra
    })
  const write = (journal: IncrementalChatJournal, id: string, lines: number): void => {
    journal.initialize(id, records(id)[0])
    for (let index = 0; index < lines; index += 1) journal.append(batches(id)[index])
  }
  const read = (id = CHAT): ReturnType<IncrementalChatJournal['replay']> =>
    createIncrementalChatJournal(baseDir, {
      noteDurabilityDebt: () => {},
      canWrite: () => false
    }).replay(id)

  it('compacts an idle chat in the worker once its lines pass the idle threshold, and writes nothing on the calling thread', async () => {
    const journal = open()
    write(journal, CHAT, 3)
    syncs.issued.length = 0
    clock += 1_000

    expect(journal.checkpointIdle(clock)).toBe(1)

    expect(worker.started).toHaveLength(1)
    expect(worker.started[0].request).toMatchObject({ chatId: CHAT, revision: 4 })
    expect(syncs.issued).toEqual([])
    expect(journal.stats()).toMatchObject({ checkpointsWritten: 1, idleCompactionsRequested: 1 })

    const adopted = journal.checkpointDeferred!(CHAT)
    worker.complete()
    await expect(adopted).resolves.toBe('checkpointed')
    expect(fs.existsSync(path.join(baseDir, SEALED))).toBe(false)
    expect(read()).toMatchObject({ record: records(CHAT)[3], revision: 4, appliedBatches: 0 })
  })

  it('leaves a chat that is not idle yet, or whose lines are below the threshold, alone, without a look at its files', () => {
    const looked: string[] = []
    const journal = open({ beforeSourceMutation: (chatId) => looked.push(chatId) })
    write(journal, CHAT, 3)
    write(journal, OTHER, 1)
    looked.length = 0
    clock += 999
    expect(journal.checkpointIdle(clock)).toBe(0)

    clock += 1
    // Now the first is idle and over the threshold; the second is under it.
    expect(journal.checkpointIdle(clock)).toBe(1)
    expect(worker.started.map((each) => each.request.chatId)).toEqual([CHAT])
    expect(looked).not.toContain(OTHER)
  })

  it('asks no second fold of a chat whose fold is running', () => {
    const journal = open()
    write(journal, CHAT, 3)
    clock += 1_000
    expect(journal.checkpointIdle(clock)).toBe(1)
    clock += 5_000
    expect(journal.checkpointIdle(clock)).toBe(0)
    expect(worker.started).toHaveLength(1)
  })

  it('counts no fold the worker refused', () => {
    const journal = open()
    write(journal, CHAT, 3)
    worker.refusing = true
    clock += 1_000

    expect(journal.checkpointIdle(clock)).toBe(0)
    expect(journal.stats()).toMatchObject({ idleCompactionsRequested: 0, compactionsRefused: 1 })
  })

  it('counts, when deferred, only the folds it adopted', async () => {
    const journal = open()
    write(journal, CHAT, 3)
    write(journal, OTHER, 3)
    write(journal, THIRD, 3)
    clock += 1_000

    const folded = journal.checkpointIdleDeferred!(clock)
    expect(worker.started.map((each) => each.request.chatId)).toEqual([CHAT, OTHER, THIRD])
    worker.complete(0)
    worker.die(1)
    journal.delete(THIRD)

    await expect(folded).resolves.toBe(1)
  })

  it('waits for the folds it asks for when deferred', async () => {
    const journal = open()
    write(journal, CHAT, 3)
    clock += 1_000

    const folded = journal.checkpointIdleDeferred!(clock)
    expect(worker.started).toHaveLength(1)
    worker.complete()

    await expect(folded).resolves.toBe(1)
    expect(read()).toMatchObject({ revision: 4, appliedBatches: 0 })
  })

  it('writes no checkpoint at quit: every chat is left to its log, and the skip is counted', () => {
    const journal = open()
    write(journal, CHAT, 3)
    write(journal, OTHER, 2)
    // A chat with no lines has nothing a checkpoint would fold.
    write(journal, THIRD, 0)
    syncs.issued.length = 0

    expect(journal.checkpointAll('shutdown')).toBe(0)

    expect(syncs.issued).toEqual([])
    expect(journal.stats()).toMatchObject({ checkpointsWritten: 3, shutdownCheckpointsSkipped: 2 })
    expect(read(CHAT)).toMatchObject({ revision: 4, appliedBatches: 3 })
    expect(read(OTHER)).toMatchObject({ revision: 3, appliedBatches: 2 })
  })

  it('stops a fold that is running at quit, and leaves its sealed segment to the next start', async () => {
    const journal = open()
    write(journal, CHAT, 3)
    clock += 1_000
    journal.checkpointIdle(clock)
    const running = journal.checkpointDeferred!(CHAT)

    expect(journal.checkpointAll('shutdown')).toBe(0)

    await expect(running).resolves.toBe('superseded')
    expect(fs.existsSync(path.join(baseDir, SEALED))).toBe(true)
    expect(read()).toMatchObject({ revision: 4 })
  })

  it('without the option, idle and quit still checkpoint on the calling thread', () => {
    const journal = createIncrementalChatJournal(baseDir, {
      checkpointPreparation: worker,
      idleCheckpointMs: 1_000,
      now: () => clock
    })
    write(journal, CHAT, 3)
    write(journal, OTHER, 2)
    clock += 1_000
    syncs.issued.length = 0

    expect(journal.checkpointIdle(clock)).toBe(2)
    expect(syncs.issued.length).toBeGreaterThan(0)
    expect(worker.started).toHaveLength(0)

    journal.append(batches(CHAT)[3])
    expect(journal.checkpointAll('shutdown')).toBe(1)
  })
})

describe('the re-anchor, counted by cause', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    removeTemporaryDirectory(baseDir)
  })

  const owing = (): IncrementalChatJournal =>
    createIncrementalChatJournal(baseDir, { noteDurabilityDebt: () => {} })

  it('counts each one with its bytes and its time on the calling thread, and stays synced', () => {
    const journal = owing()
    journal.initialize(CHAT, records(CHAT)[0])
    const syncs = countSyncs()
    let earlier!: ReturnType<IncrementalChatJournal['stats']>['reanchors']
    try {
      journal.replaceAuthoritativeCheckpoint(CHAT, records(CHAT)[4], 'baseline-mismatch')
      earlier = journal.stats().reanchors
      journal.replaceAuthoritativeCheckpoint(CHAT, records(CHAT)[5])
      expect(syncs.issued.length).toBe(6)
    } finally {
      syncs.dispose()
    }
    // What stats returned is a copy, not the counts as they go on.
    expect(earlier.direct.count).toBe(0)

    const bytes = fs.statSync(path.join(baseDir, CHECKPOINT)).size
    const { reanchors } = journal.stats()
    expect(reanchors['baseline-mismatch']).toMatchObject({ count: 1 })
    expect(reanchors['baseline-mismatch'].bytes).toBeGreaterThan(0)
    expect(reanchors.direct).toMatchObject({ count: 1, bytes })
    expect(reanchors.direct.mainMs).toBeGreaterThan(0)
    expect(reanchors.direct.longestMainMs).toBe(reanchors.direct.mainMs)
    expect(reanchors['revision-behind']).toMatchObject({ count: 0, bytes: 0 })
    expect(reanchors['parity-repair']).toMatchObject({ count: 0, bytes: 0 })
  })

  describe('through the persistence coordinator', () => {
    const silent = { error: () => {}, warn: () => {} }

    it('names a record that moved on without the journal "revision-behind"', () => {
      const journal = owing()
      const persistence = createIncrementalChatPersistence({ journal, logger: silent })
      const all = records(CHAT)
      persistence.persist(null, all[0], 'normal')

      // The Host saved revisions 2 and 3 as whole records, past the journal.
      persistence.persist(all[2], all[3], 'normal')

      expect(journal.stats().reanchors['revision-behind']).toMatchObject({ count: 1 })
    })

    it('names a journal whose head is not the record the save starts from "baseline-mismatch"', () => {
      const journal = owing()
      const all = records(CHAT)
      journal.initialize(CHAT, all[0])

      createIncrementalChatPersistence({ journal, logger: silent }).persist(
        all[1],
        all[2],
        'normal'
      )

      expect(journal.stats().reanchors['baseline-mismatch']).toMatchObject({ count: 1 })
    })

    it('names a journal that replays a different record at the same revision "parity-repair"', () => {
      const journal = owing()
      journal.initialize(CHAT, chat(CHAT, 1, 'a different record'))
      const all = records(CHAT)

      createIncrementalChatPersistence({ journal, logger: silent }).persist(
        all[0],
        all[1],
        'normal'
      )

      expect(journal.stats().reanchors['parity-repair']).toMatchObject({ count: 1 })
    })

    it('names a call from outside "direct"', () => {
      const journal = owing()
      const persistence = createIncrementalChatPersistence({ journal, logger: silent })
      persistence.replaceAuthoritative(CHAT, records(CHAT)[2])

      expect(journal.stats().reanchors.direct).toMatchObject({ count: 1 })
    })
  })
})

describe('erasure, which still syncs on the calling thread under the barrier', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  })

  afterEach(() => {
    removeTemporaryDirectory(baseDir)
  })

  it('counts each erasure of a chat, by delete or by purge', () => {
    const journal = createIncrementalChatJournal(baseDir, { noteDurabilityDebt: () => {} })
    journal.initialize(CHAT, records(CHAT)[0])
    journal.initialize(OTHER, records(OTHER)[0])
    const syncs = countSyncs()
    try {
      journal.delete(CHAT)
      const afterDelete = syncs.issued.length
      journal.purge(OTHER)
      expect(afterDelete).toBeGreaterThan(0)
      expect(syncs.issued.length).toBeGreaterThan(afterDelete)
    } finally {
      syncs.dispose()
    }

    expect(journal.stats()).toMatchObject({ erasures: 2 })
  })
})
