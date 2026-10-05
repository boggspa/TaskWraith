/**
 * Under `noteDurabilityDebt`, a load takes the longest chain from the
 * checkpoint with no gap, and sets aside a segment that does not chain: kept
 * under one name per chat that nothing parses, counted, logged by chat id and
 * revisions only, and removed by erasure and the next checkpoint. Without the
 * option a gap throws, as it always has.
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
  type CheckpointPreparationSource,
  type PreparedCheckpoint
} from './CheckpointPreparationProtocol'
import {
  createIncrementalChatJournal,
  INCREMENTAL_CHAT_JOURNAL_ARTIFACT_SUFFIXES,
  type IncrementalChatJournal,
  type IncrementalChatJournalOptions
} from './IncrementalChatJournal'
import { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import type { ThreadDurabilityDebtNote } from './ThreadDurabilityDebt'
import type { ChatRecord } from './types'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-journal-set-aside-'

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
        content: `private words ${revision}`,
        timestamp: '2026-10-05T00:00:00.000Z'
      }
    ],
    runs: []
  }
}

/** `records[n]` is at revision n + 1, and `batches[n]` takes it to revision n + 2. */
const records: ChatRecord[] = Array.from({ length: 8 }, (_unused, index) => chat(index + 1))
const batches: ChatRecordMutationBatch[] = records
  .slice(0, -1)
  .map((record, index) => deriveChatRecordMutation(record, records[index + 1]))
const lines = (...from: ChatRecordMutationBatch[]): string =>
  from.map((batch) => `${JSON.stringify(batch)}\n`).join('')

/** Prepares a checkpoint on this thread when told to, as the worker would off it. */
class ControlledPreparation implements CheckpointPreparationPort {
  private ready: (() => void) | null = null

  constructor(private readonly baseDir: string) {}

  start(source: CheckpointPreparationSource): CheckpointPreparationJob {
    const outputPath = path.join(
      this.baseDir,
      `.${source.chatId}.checkpoint-prepared-${process.pid}-${randomUUID()}.tmp`
    )
    fs.writeFileSync(outputPath, '', { flag: 'wx', mode: 0o600 })
    const output = checkpointFileReference(outputPath)
    const result = new Promise<PreparedCheckpoint>((resolve) => {
      this.ready = () =>
        resolve(prepareCheckpoint({ ...source, output, maxOutputBytes: 1024 * 1024 }))
    })
    const release = (): void => fs.rmSync(outputPath, { force: true })
    return { output, result, cancel: release, release }
  }

  complete(): void {
    this.ready!()
  }
}

function descriptorCache(): IncrementalChatJournalDescriptorCache {
  return new IncrementalChatJournalDescriptorCache(
    new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (fd, complete) => {
        fs.fsyncSync(fd)
        queueMicrotask(complete)
        return { joinSync: () => {} }
      },
      fsyncSync: (fd) => fs.fsyncSync(fd),
      close: (fd) => fs.closeSync(fd)
    })
  )
}

describe('a journal that leaves syncing to the barrier, loading segments that do not chain', () => {
  let baseDir: string
  let activePath: string
  let sealedPath: string
  let setAsidePath: string
  let noted: ThreadDurabilityDebtNote[]
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    activePath = path.join(baseDir, `${CHAT}.mutations.jsonl`)
    sealedPath = path.join(baseDir, `${CHAT}.sealed.mutations.jsonl`)
    setAsidePath = path.join(baseDir, `${CHAT}.set-aside.mutations.jsonl`)
    noted = []
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The checkpoint at revision 1, written as a journal that syncs writes it.
    createIncrementalChatJournal(baseDir).initialize(CHAT, records[0])
  })

  afterEach(() => {
    warn.mockRestore()
    removeTemporaryDirectory(baseDir)
  })

  const owing = (options: IncrementalChatJournalOptions = {}): IncrementalChatJournal =>
    createIncrementalChatJournal(baseDir, {
      noteDurabilityDebt: (_chatId, note) => noted.push(note),
      ...options
    })
  const warnings = (): string[] => warn.mock.calls.map((call) => String(call[0]))

  it('loads the chain up to a segment whose first line does not chain, and sets that segment aside', () => {
    // Revision 2 never reached the disk; the line for 3 did.
    fs.writeFileSync(activePath, lines(batches[1], batches[2]))

    const journal = owing()
    expect(journal.replay(CHAT)).toMatchObject({
      record: records[0],
      revision: 1,
      appliedBatches: 0
    })

    expect(fs.existsSync(activePath)).toBe(false)
    expect(fs.readFileSync(setAsidePath, 'utf8')).toBe(lines(batches[1], batches[2]))
    expect(noted).toEqual([
      { file: setAsidePath, owner: 'journal', renamedFrom: activePath },
      { directory: baseDir }
    ])
    expect(journal.stats().segmentsSetAside).toBe(1)
    expect(journal.stats().corruptSegmentRejects).toBe(0)
  })

  it('logs the chat id and the revisions it set aside, and nothing of what they hold', () => {
    fs.writeFileSync(activePath, lines(batches[1], batches[2]))

    owing().replay(CHAT)

    expect(warnings()).toEqual([
      `[incremental-chat] a segment of ${CHAT} does not chain and is set aside: revisions 3 to 4`
    ])
    expect(warnings().join('\n')).not.toContain('private words')
  })

  it('never parses a segment it set aside again, and the thread goes on from the chain', () => {
    fs.writeFileSync(activePath, lines(batches[1], batches[2]))
    owing().replay(CHAT)
    warn.mockClear()

    const next = owing()
    expect(next.replay(CHAT)).toMatchObject({ revision: 1 })
    next.append(batches[0])

    expect(warnings()).toEqual([])
    expect(owing().replay(CHAT)).toMatchObject({ record: records[1], revision: 2 })
    expect(fs.readFileSync(setAsidePath, 'utf8')).toBe(lines(batches[1], batches[2]))
  })

  it('adds a second segment set aside to the first, under the one name erasure finds', () => {
    // A sealed segment past a gap, and an active one past it.
    fs.writeFileSync(sealedPath, lines(batches[2]))
    fs.writeFileSync(activePath, lines(batches[3]))

    const journal = owing()
    expect(journal.replay(CHAT)).toMatchObject({ revision: 1 })

    expect(fs.existsSync(sealedPath)).toBe(false)
    expect(fs.existsSync(activePath)).toBe(false)
    expect(fs.readFileSync(setAsidePath, 'utf8')).toBe(lines(batches[2], batches[3]))
    expect(noted).toEqual([
      { file: setAsidePath, owner: 'journal', renamedFrom: sealedPath },
      { file: setAsidePath, owner: 'journal' },
      { directory: baseDir }
    ])
    expect(journal.stats().segmentsSetAside).toBe(2)
    expect(warnings()).toHaveLength(2)
  })

  it('sets every segment aside when there is no checkpoint, and the chat has no record', () => {
    fs.rmSync(path.join(baseDir, `${CHAT}.checkpoint.json`))
    fs.writeFileSync(activePath, lines(batches[0]))

    const journal = owing()
    expect(journal.replay(CHAT)).toMatchObject({ record: null, revision: null })
    expect(fs.readFileSync(setAsidePath, 'utf8')).toBe(lines(batches[0]))
    expect(() => journal.append(batches[0])).toThrow('must be initialized')

    // A new baseline starts the chat again, and the segment set aside goes with it.
    journal.initialize(CHAT, records[1])
    expect(fs.existsSync(setAsidePath)).toBe(false)
    expect(owing().replay(CHAT)).toMatchObject({ record: records[1], revision: 2 })
  })

  describe('where a read may not change the directory', () => {
    it('reads past the segment, leaves it where it is, and the next append moves it before it writes', () => {
      fs.writeFileSync(activePath, lines(batches[1]))

      const journal = owing({ canRepairOnRead: () => false })
      expect(journal.replay(CHAT)).toMatchObject({ revision: 1 })
      expect(fs.readFileSync(activePath, 'utf8')).toBe(lines(batches[1]))
      expect(fs.existsSync(setAsidePath)).toBe(false)
      expect(noted).toEqual([])
      expect(warnings()).toHaveLength(1)

      journal.append(batches[0])

      expect(fs.readFileSync(setAsidePath, 'utf8')).toBe(lines(batches[1]))
      expect(fs.readFileSync(activePath, 'utf8')).toBe(lines(batches[0]))
      expect(journal.stats().segmentsSetAside).toBe(1)
      expect(warnings()).toHaveLength(1)
      expect(owing().replay(CHAT)).toMatchObject({ record: records[1], revision: 2 })
    })

    it('a journal that may not write reads past it and moves nothing', () => {
      fs.writeFileSync(activePath, lines(batches[1]))

      const reader = owing({ canWrite: () => false })
      expect(reader.replay(CHAT)).toMatchObject({ record: records[0], revision: 1 })

      expect(fs.readFileSync(activePath, 'utf8')).toBe(lines(batches[1]))
      expect(fs.existsSync(setAsidePath)).toBe(false)
      expect(reader.stats().segmentsSetAside).toBe(0)
      expect(noted).toEqual([])
    })

    it('a read the write gate refuses still loads, and the move waits for the next append', () => {
      fs.writeFileSync(activePath, lines(batches[1]))
      let held = true
      const journal = owing({
        beforeSourceMutation: () => {
          if (held) throw new Error('recovery hold')
        }
      })

      expect(journal.replay(CHAT)).toMatchObject({ revision: 1 })
      expect(fs.readFileSync(activePath, 'utf8')).toBe(lines(batches[1]))
      expect(() => journal.append(batches[0])).toThrow('recovery hold')
      expect(fs.readFileSync(activePath, 'utf8')).toBe(lines(batches[1]))

      held = false
      journal.append(batches[0])
      expect(fs.readFileSync(setAsidePath, 'utf8')).toBe(lines(batches[1]))
      expect(owing().replay(CHAT)).toMatchObject({ revision: 2 })
    })
  })

  describe('a line that does not chain after lines of its own segment that did', () => {
    beforeEach(() => {
      fs.writeFileSync(activePath, lines(batches[0], batches[2]))
    })

    it('ends what the segment adds, stays where it is, and no line is appended after it', () => {
      const journal = owing()
      expect(journal.replay(CHAT)).toMatchObject({ record: records[1], revision: 2 })
      expect(() => journal.append(batches[1])).toThrow('is damaged; refusing to append after it')

      expect(journal.stats().corruptSegmentRejects).toBe(1)
      expect(journal.stats().segmentsSetAside).toBe(0)
      expect(fs.readFileSync(activePath, 'utf8')).toBe(lines(batches[0], batches[2]))
    })

    it('is not sealed by a rotation', () => {
      const cache = descriptorCache()
      try {
        const journal = owing({ descriptorCache: cache, rotationEnabled: true })
        expect(journal.replay(CHAT)).toMatchObject({ revision: 2 })
        expect(journal.rotateForPreparation!(CHAT)).toBeNull()
        expect(fs.existsSync(sealedPath)).toBe(false)
      } finally {
        cache.retireSync()
      }
    })

    it('is not handed to a compaction in the worker', async () => {
      const journal = owing({ checkpointPreparation: new ControlledPreparation(baseDir) })
      expect(journal.replay(CHAT)).toMatchObject({ revision: 2 })
      await expect(journal.checkpointDeferred!(CHAT)).resolves.toBe('unavailable')
      expect(fs.readFileSync(activePath, 'utf8')).toBe(lines(batches[0], batches[2]))
    })

    it('is cleared by a checkpoint, after which the thread goes on', () => {
      const journal = owing()
      expect(journal.replay(CHAT)).toMatchObject({ revision: 2 })
      expect(journal.checkpoint(CHAT, 'bounded')).toBe(true)
      journal.append(batches[1])
      expect(owing().replay(CHAT)).toMatchObject({ record: records[2], revision: 3 })
    })
  })

  describe('the segments set aside are removed', () => {
    beforeEach(() => {
      fs.writeFileSync(activePath, lines(batches[1]))
      owing().replay(CHAT)
      expect(fs.existsSync(setAsidePath)).toBe(true)
    })

    it('by the next checkpoint', () => {
      const journal = owing()
      journal.append(batches[0])
      expect(journal.checkpoint(CHAT, 'bounded')).toBe(true)
      expect(fs.existsSync(setAsidePath)).toBe(false)
    })

    it('by a re-anchor', () => {
      owing().replaceAuthoritativeCheckpoint(CHAT, records[4])
      expect(fs.existsSync(setAsidePath)).toBe(false)
    })

    it.each([false, true])(
      'by a compaction adopted from the worker (rotating: %s)',
      async (rotating) => {
        const cache = rotating ? descriptorCache() : undefined
        try {
          const preparation = new ControlledPreparation(baseDir)
          const journal = owing({
            checkpointPreparation: preparation,
            ...(cache ? { descriptorCache: cache, rotationEnabled: true } : {})
          })
          journal.append(batches[0])

          const adopted = journal.checkpointDeferred!(CHAT)
          preparation.complete()
          await expect(adopted).resolves.toBe('checkpointed')

          expect(fs.existsSync(setAsidePath)).toBe(false)
          expect(owing().replay(CHAT)).toMatchObject({ record: records[1], revision: 2 })
        } finally {
          cache?.retireSync()
        }
      }
    )

    it('by erasure, and by a purge', () => {
      owing().delete(CHAT)
      expect(fs.existsSync(setAsidePath)).toBe(false)

      fs.writeFileSync(setAsidePath, lines(batches[1]))
      owing().purge(CHAT)
      expect(fs.existsSync(setAsidePath)).toBe(false)
    })

    it('by the store’s erasure, which removes every suffix the journal lists', () => {
      expect(INCREMENTAL_CHAT_JOURNAL_ARTIFACT_SUFFIXES).toContain('.set-aside.mutations.jsonl')
    })
  })

  describe('without the option', () => {
    it('throws for a gap, as it always has, and moves nothing', () => {
      fs.writeFileSync(activePath, lines(batches[1]))

      expect(() => createIncrementalChatJournal(baseDir).replay(CHAT)).toThrow('revision gap')
      expect(fs.readFileSync(activePath, 'utf8')).toBe(lines(batches[1]))
      expect(fs.existsSync(setAsidePath)).toBe(false)
      expect(warnings()).toEqual([])
    })

    it('throws for segments without a checkpoint, as it always has', () => {
      fs.rmSync(path.join(baseDir, `${CHAT}.checkpoint.json`))
      fs.writeFileSync(activePath, lines(batches[0]))

      expect(() => createIncrementalChatJournal(baseDir).replay(CHAT)).toThrow(
        'has no checkpoint baseline'
      )
      expect(fs.readFileSync(activePath, 'utf8')).toBe(lines(batches[0]))
    })
  })
})
