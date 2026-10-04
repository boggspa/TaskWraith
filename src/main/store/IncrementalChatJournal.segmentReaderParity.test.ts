/**
 * The Host is to follow a thread's log with the shared segment reader while
 * the app appends to it through the journal. The two must make the same record
 * of the same bytes, stop at the same batch when the bytes are damaged, and
 * lose nothing when the journal seals the segment being followed.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyThreadLogBatches } from '../../host-shared/thread-log/ThreadLogApply'
import {
  openThreadLogSegmentReader,
  type ThreadLogSegmentReader
} from '../../host-shared/thread-log/ThreadLogSegmentReader'
import { deriveChatRecordMutation, type ChatRecordMutationBatch } from './ChatRecordMutation'
import {
  createIncrementalChatJournal,
  type IncrementalChatJournal,
  type IncrementalChatJournalOptions
} from './IncrementalChatJournal'
import { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import type { ChatRecord } from './types'

function chat(revision = 1, content = 'initial'): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'chat-1',
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

function advance(source: ChatRecord, change: (next: ChatRecord) => void): ChatRecord {
  const next = structuredClone(source)
  change(next)
  next.persistenceRevision = (source.persistenceRevision ?? 0) + 1
  next.updatedAt += 1
  return next
}

const withContent = (source: ChatRecord, content: string): ChatRecord =>
  advance(source, (next) => {
    next.messages[0].content = content
  })

const lineOf = (batch: ChatRecordMutationBatch): Buffer => Buffer.from(`${JSON.stringify(batch)}\n`)

describe('segment reader against the journal that writes the segment', () => {
  let baseDir: string
  let activePath: string
  let sealedPath: string
  const readers: ThreadLogSegmentReader[] = []
  const retirements: Array<() => Promise<void>> = []

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-reader-parity-'))
    activePath = path.join(baseDir, 'chat-1.mutations.jsonl')
    sealedPath = path.join(baseDir, 'chat-1.sealed.mutations.jsonl')
  })

  afterEach(async () => {
    for (const reader of readers.splice(0)) reader.close()
    for (const retire of retirements.splice(0)) await retire()
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  // The app under Host ownership: it may append, and may not repair on read.
  const app = (options: IncrementalChatJournalOptions = {}): IncrementalChatJournal =>
    createIncrementalChatJournal(baseDir, { canRepairOnRead: () => false, ...options })
  const replayed = (): ReturnType<IncrementalChatJournal['replay']> =>
    createIncrementalChatJournal(baseDir, {
      canWrite: () => false,
      canRepairOnRead: () => false
    }).replay('chat-1')
  const follow = (headRevision: number, filePath = activePath): ThreadLogSegmentReader => {
    const reader = openThreadLogSegmentReader({ filePath, chatId: 'chat-1', headRevision })
    if (!reader) throw new Error(`no segment at ${filePath}`)
    readers.push(reader)
    return reader
  }

  const descriptorCache = (): IncrementalChatJournalDescriptorCache => {
    const pending: Array<() => void> = []
    const flusher = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (fd, complete) => {
        const finish = (): void => {
          fs.fsyncSync(fd)
          complete()
        }
        pending.push(finish)
        return {
          joinSync: () => {
            pending.splice(pending.indexOf(finish), 1)
            finish()
          }
        }
      },
      fsyncSync: fs.fsyncSync,
      close: fs.closeSync
    })
    const cache = new IncrementalChatJournalDescriptorCache(flusher)
    retirements.push(() => cache.retire())
    return cache
  }

  const first = chat()
  const second = withContent(first, 'second')
  const third = withContent(second, 'third')
  const fourth = withContent(third, 'fourth')
  const secondBatch = deriveChatRecordMutation(first, second)
  const thirdBatch = deriveChatRecordMutation(second, third)
  const fourthBatch = deriveChatRecordMutation(third, fourth)

  it('returns each batch as the journal appends it, and folds to the record the journal replays', () => {
    const steps: Array<(next: ChatRecord) => void> = [
      (next) => {
        next.messages[0].content += ' and more, café € \u{1f600}'
      },
      (next) => {
        next.title = 'renamed'
      },
      (next) => {
        next.messages.push({
          id: 'reply',
          role: 'user',
          content: '日本語',
          timestamp: '2026-10-04T00:00:01.000Z'
        })
      },
      (next) => {
        next.messages[1].content += ' continued'
      },
      (next) => {
        next.archived = true
        next.messages.splice(0, 1)
      }
    ]
    const journal = app()
    journal.initialize('chat-1', first)
    expect(
      openThreadLogSegmentReader({ filePath: activePath, chatId: 'chat-1', headRevision: 1 })
    ).toBeNull()

    let record = first
    let copy: ChatRecord = structuredClone(first)
    let reader: ThreadLogSegmentReader | null = null
    const operations = new Set<string>()
    for (const step of steps) {
      const next = advance(record, step)
      const batch = deriveChatRecordMutation(record, next)
      for (const operation of batch.operations) operations.add(operation.type)
      journal.append(batch)
      reader ??= follow(1)

      const read = reader.read()
      expect(read).toMatchObject({
        status: 'ok',
        reachedEnd: true,
        duplicates: 0,
        offset: fs.statSync(activePath).size,
        headRevision: next.persistenceRevision,
        pendingBytes: 0,
        file: 'at-path'
      })
      expect(read.batches).toEqual([JSON.parse(JSON.stringify(batch))])
      copy = applyThreadLogBatches(copy, read.batches)
      expect(copy).toEqual(next)
      record = next
    }

    expect(operations.size).toBeGreaterThanOrEqual(3)
    expect(replayed()).toMatchObject({ record: copy, revision: 6, appliedBatches: steps.length })
  })

  it('reads on when the app cuts a crash fragment away before its next append', () => {
    const before = app()
    before.initialize('chat-1', first)
    before.append(secondBatch)
    const reader = follow(1)
    expect(reader.read()).toMatchObject({ batches: [secondBatch] })

    // The app dies part way through writing the next batch.
    const lost = deriveChatRecordMutation(second, withContent(second, 'lost in the crash'))
    fs.appendFileSync(activePath, lineOf(lost).subarray(0, 61))
    expect(reader.read()).toMatchObject({ status: 'ok', batches: [], pendingBytes: 61 })

    const restarted = app({ repairTornTailBeforeAppend: true })
    restarted.append(thirdBatch)
    restarted.append(fourthBatch)

    const read = reader.read()
    expect(read).toMatchObject({
      status: 'ok',
      batches: [thirdBatch, fourthBatch],
      headRevision: 4,
      pendingBytes: 0
    })
    expect(restarted.stats()).toMatchObject({ tornTailsTruncated: 1 })
    expect(replayed()).toMatchObject({ record: fourth, revision: 4, appliedBatches: 3 })
  })

  it('stops at the batch the journal itself can no longer replay when the fragment is not cut', () => {
    const before = app()
    before.initialize('chat-1', first)
    before.append(secondBatch)
    const reader = follow(1)
    reader.read()
    const lost = deriveChatRecordMutation(second, withContent(second, 'lost in the crash'))
    fs.appendFileSync(activePath, lineOf(lost).subarray(0, 61))

    // Today's default: the next batch lands straight after the fragment.
    app().append(thirdBatch)

    expect(reader.read()).toMatchObject({
      status: 'corrupt',
      batches: [],
      offset: lineOf(secondBatch).length,
      headRevision: 2
    })
    expect(replayed()).toMatchObject({ record: second, revision: 2, appliedBatches: 1 })
  })

  it('passes over the batches a checkpoint already holds, as the journal does', () => {
    const crashing = app({
      afterCheckpointWrite: () => {
        throw new Error('crash after the checkpoint, before the tail is removed')
      }
    })
    crashing.initialize('chat-1', first)
    crashing.append(secondBatch)
    crashing.append(thirdBatch)
    expect(() => crashing.checkpoint('chat-1', 'terminal')).toThrow('crash after the checkpoint')
    app().append(fourthBatch)

    // A follower seeded from the checkpoint starts at its revision.
    const read = follow(3).read()
    expect(read).toMatchObject({
      status: 'ok',
      batches: [fourthBatch],
      duplicates: 2,
      headRevision: 4,
      pendingBytes: 0
    })
    expect(replayed()).toMatchObject({
      record: applyThreadLogBatches(third, read.batches),
      revision: 4,
      appliedBatches: 1,
      skippedBatches: 2
    })
  })

  it('reports a gap in the batches the journal refuses to load', () => {
    const journal = app()
    journal.initialize('chat-1', first)
    journal.append(secondBatch)
    fs.appendFileSync(activePath, lineOf(fourthBatch))

    expect(follow(1).read()).toMatchObject({
      status: 'gap',
      baseRevision: 3,
      revision: 4,
      batches: [secondBatch],
      offset: lineOf(secondBatch).length,
      headRevision: 2
    })
    expect(() => replayed()).toThrow(/revision gap for chat-1: head 2, batch 3 -> 4/)
  })

  it('loses nothing when the journal seals the segment it is following', () => {
    const journal = app({ descriptorCache: descriptorCache(), rotationEnabled: true })
    journal.initialize('chat-1', first)
    journal.append(secondBatch)
    const reader = follow(1)
    expect(reader.read()).toMatchObject({ batches: [secondBatch], file: 'at-path' })

    journal.append(thirdBatch)
    expect(journal.rotateForPreparation!('chat-1')).toMatchObject({ revision: 3 })
    journal.append(fourthBatch)
    expect(fs.existsSync(sealedPath)).toBe(true)

    // The descriptor went with the rename: the sealed file is read to its end.
    const sealed = reader.read()
    expect(sealed).toMatchObject({
      status: 'ok',
      reachedEnd: true,
      batches: [thirdBatch],
      headRevision: 3,
      pendingBytes: 0,
      file: 'moved'
    })
    // What the journal wrote next is in a new file under the old name.
    expect(follow(sealed.headRevision).read()).toMatchObject({
      status: 'ok',
      batches: [fourthBatch],
      duplicates: 0,
      headRevision: 4,
      file: 'at-path'
    })
    expect(replayed()).toMatchObject({ record: fourth, revision: 4, appliedBatches: 3 })
  })
})
