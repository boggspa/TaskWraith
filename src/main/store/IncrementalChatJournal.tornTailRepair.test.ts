/**
 * A crash can leave the last journal line half written. Where reads may not
 * repair (`canRepairOnRead` false, as under Host ownership), the fragment used
 * to stay put: the next batch was written straight after it, the two formed
 * one invalid line, and every batch from there on was unreadable.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveChatRecordMutation, type ChatRecordMutationBatch } from './ChatRecordMutation'
import {
  createIncrementalChatJournal,
  type IncrementalChatAppendDurability,
  type IncrementalChatJournal,
  type IncrementalChatJournalOptions
} from './IncrementalChatJournal'
import { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import type { ChatRecord } from './types'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-torn-tail-'

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

function advance(source: ChatRecord, content: string): ChatRecord {
  const next = structuredClone(source)
  next.messages[0].content = content
  next.persistenceRevision = (source.persistenceRevision ?? 0) + 1
  next.updatedAt += 1
  return next
}

const lineOf = (batch: ChatRecordMutationBatch): Buffer => Buffer.from(`${JSON.stringify(batch)}\n`)

/** The first `bytes` bytes of a batch line: what a crash mid-write leaves. */
const fragmentOf = (batch: ChatRecordMutationBatch, bytes: number): Buffer =>
  lineOf(batch).subarray(0, bytes)

interface CacheFixture {
  cache: IncrementalChatJournalDescriptorCache
  /** The next write through the cache stores only this many bytes, then fails. */
  failNextWriteAfter(bytes: number): void
  retire(): Promise<void>
}

function descriptorCache(): CacheFixture {
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
  let failAfter: number | null = null
  const cache = new IncrementalChatJournalDescriptorCache(flusher, {
    write: (fd, bytes) => {
      if (failAfter === null) {
        fs.writeFileSync(fd, bytes)
        return
      }
      fs.writeFileSync(fd, bytes.subarray(0, failAfter))
      failAfter = null
      throw new Error('disk full')
    }
  })
  return {
    cache,
    failNextWriteAfter: (bytes) => {
      failAfter = bytes
    },
    retire: () => cache.retire()
  }
}

describe('torn journal tail under an owner that may not repair on read', () => {
  let baseDir: string
  let activePath: string
  let sealedPath: string
  const caches: CacheFixture[] = []

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    activePath = path.join(baseDir, 'chat-1.mutations.jsonl')
    sealedPath = path.join(baseDir, 'chat-1.sealed.mutations.jsonl')
  })

  afterEach(async () => {
    for (const fixture of caches.splice(0)) await fixture.retire()
    removeTemporaryDirectory(baseDir)
  })

  const cached = (): CacheFixture => {
    const fixture = descriptorCache()
    caches.push(fixture)
    return fixture
  }
  const writer = (options: IncrementalChatJournalOptions = {}): IncrementalChatJournal =>
    createIncrementalChatJournal(baseDir, {
      canRepairOnRead: () => false,
      repairTornTailBeforeAppend: true,
      ...options
    })
  const reader = (): IncrementalChatJournal =>
    createIncrementalChatJournal(baseDir, { canWrite: () => false, canRepairOnRead: () => false })

  const first = chat()
  const second = advance(first, 'second')
  const lost = advance(second, 'lost in the crash')
  const third = advance(second, 'third')
  const fourth = advance(third, 'fourth')
  const secondBatch = deriveChatRecordMutation(first, second)
  const lostBatch = deriveChatRecordMutation(second, lost)
  const thirdBatch = deriveChatRecordMutation(second, third)
  const fourthBatch = deriveChatRecordMutation(third, fourth)

  /** One good batch on disk, then the first `bytes` bytes of the batch the crash cut short. */
  function crashAfterSecond(bytes = 60): Buffer {
    const crashed = writer()
    crashed.initialize('chat-1', first)
    crashed.append(secondBatch)
    const fragment = fragmentOf(lostBatch, bytes)
    fs.appendFileSync(activePath, fragment)
    return fragment
  }

  it('replays every batch appended after a crash left a partial last line', () => {
    crashAfterSecond()

    const restarted = writer()
    // The replayed head matches, so the baseline is accepted without a rewrite.
    restarted.initialize('chat-1', second)
    restarted.append(thirdBatch)
    restarted.append(fourthBatch, { durability: 'deferred' })

    expect(reader().replay('chat-1')).toMatchObject({
      record: fourth,
      revision: 4,
      appliedBatches: 3
    })
    expect(fs.existsSync(sealedPath)).toBe(false)
  })

  it.each([
    ['immediate', false],
    ['deferred', false],
    ['immediate', true],
    ['deferred', true]
  ] as const)(
    'cuts the fragment before a first %s append (descriptor cache: %s) and counts it',
    (durability: IncrementalChatAppendDurability, withCache) => {
      const fragment = crashAfterSecond()
      const inode = fs.statSync(activePath).ino
      const restarted = writer(withCache ? { descriptorCache: cached().cache } : {})

      restarted.append(thirdBatch, { durability })

      expect(fs.readFileSync(activePath)).toEqual(
        Buffer.concat([lineOf(secondBatch), lineOf(thirdBatch)])
      )
      // Truncated where it is: a reader holding the file keeps the same inode.
      expect(fs.statSync(activePath).ino).toBe(inode)
      expect(restarted.stats()).toMatchObject({
        tornTailsTruncated: 1,
        tornTailBytesTruncated: fragment.length,
        corruptSegmentRejects: 0,
        tornTailsRecovered: 0
      })
      expect(reader().replay('chat-1')).toMatchObject({ record: third, appliedBatches: 2 })
      // The repair is paid once: later appends find nothing to do.
      restarted.append(fourthBatch, { durability })
      expect(restarted.stats().tornTailsTruncated).toBe(1)
      expect(reader().replay('chat-1').record).toEqual(fourth)
    }
  )

  it('stops counting the removed fragment toward the journal size bound', () => {
    const fragment = crashAfterSecond(lineOf(lostBatch).length - 5)
    expect(fragment.length).toBeGreaterThan(1)
    const restarted = writer({
      maxJournalBytes: lineOf(secondBatch).length + lineOf(thirdBatch).length + 1
    })

    restarted.append(thirdBatch)

    // Under the bound once the fragment is gone, so no bounded checkpoint folded the tail away.
    expect(fs.readFileSync(activePath)).toEqual(
      Buffer.concat([lineOf(secondBatch), lineOf(thirdBatch)])
    )
    expect(restarted.stats().checkpointsWritten).toBe(0)
  })

  it('leaves the fragment and glues the next batch to it when the option is off', () => {
    const fragment = crashAfterSecond()
    const restarted = createIncrementalChatJournal(baseDir, { canRepairOnRead: () => false })

    restarted.append(thirdBatch)

    expect(fs.readFileSync(activePath)).toEqual(
      Buffer.concat([lineOf(secondBatch), fragment, lineOf(thirdBatch)])
    )
    expect(restarted.stats()).toMatchObject({ tornTailsTruncated: 0, tornTailBytesTruncated: 0 })
    expect(reader().replay('chat-1')).toMatchObject({ record: second, appliedBatches: 1 })
  })

  it('changes no byte on any read, only when an append is about to land', () => {
    crashAfterSecond()
    const torn = fs.readFileSync(activePath)
    const before = fs.statSync(activePath, { bigint: true })
    const restarted = writer()

    restarted.initialize('chat-1', second)
    expect(restarted.replay('chat-1')).toMatchObject({ record: second, recoveredTornTail: false })
    expect(restarted.pendingReplayState('chat-1').hasTail).toBe(true)

    expect(fs.readFileSync(activePath)).toEqual(torn)
    expect(fs.statSync(activePath, { bigint: true }).mtimeNs).toBe(before.mtimeNs)
    expect(restarted.stats().tornTailsTruncated).toBe(0)
  })

  it('cuts a fragment that ends inside a multi-byte character without touching the line before', () => {
    const accented = advance(first, 'café € \u{1f600} 日本語')
    const accentedBatch = deriveChatRecordMutation(first, accented)
    const cutShort = deriveChatRecordMutation(accented, advance(accented, '€€€€'))
    const crashed = writer()
    crashed.initialize('chat-1', first)
    crashed.append(accentedBatch)
    const whole = lineOf(cutShort)
    // Stop one byte into the first three-byte character of the new content.
    const cut = whole.indexOf(Buffer.from('€')) + 1
    fs.appendFileSync(activePath, whole.subarray(0, cut))
    const next = advance(accented, 'after the crash')

    const restarted = writer()
    restarted.append(deriveChatRecordMutation(accented, next))

    expect(fs.readFileSync(activePath).subarray(0, lineOf(accentedBatch).length)).toEqual(
      lineOf(accentedBatch)
    )
    expect(restarted.stats().tornTailBytesTruncated).toBe(cut)
    expect(reader().replay('chat-1')).toMatchObject({ record: next, appliedBatches: 2 })
  })

  it('cuts a torn sealed segment where it is and never carries it into the active one', () => {
    const crashed = writer()
    crashed.initialize('chat-1', first)
    crashed.append(secondBatch)
    // The torn active segment was sealed as it was by an owner without the repair.
    const fragment = fragmentOf(lostBatch, 60)
    fs.appendFileSync(activePath, fragment)
    fs.renameSync(activePath, sealedPath)
    const sealedInode = fs.statSync(sealedPath).ino

    const restarted = writer()
    restarted.append(thirdBatch)

    expect(fs.readFileSync(sealedPath)).toEqual(lineOf(secondBatch))
    expect(fs.statSync(sealedPath).ino).toBe(sealedInode)
    expect(fs.readFileSync(activePath)).toEqual(lineOf(thirdBatch))
    expect(restarted.stats()).toMatchObject({
      tornTailsTruncated: 1,
      tornTailBytesTruncated: fragment.length
    })
    expect(reader().replay('chat-1')).toMatchObject({ record: third, appliedBatches: 2 })
  })

  it('asks the source-mutation guard again before it removes anything', () => {
    crashAfterSecond()
    const torn = fs.readFileSync(activePath)
    const sizesSeen: number[] = []
    let refuse = false
    const restarted = writer({
      beforeSourceMutation: () => {
        sizesSeen.push(fs.statSync(activePath).size)
        // The append's own check passes; the hold lands before the truncation.
        if (refuse && sizesSeen.length === 2) throw new Error('held for recovery')
      }
    })
    refuse = true

    expect(() => restarted.append(thirdBatch)).toThrow('held for recovery')
    expect(sizesSeen).toEqual([torn.length, torn.length])
    expect(fs.readFileSync(activePath)).toEqual(torn)
    expect(restarted.stats().tornTailsTruncated).toBe(0)

    // Once the hold is gone the same append repairs and lands.
    refuse = false
    restarted.append(thirdBatch)
    expect(reader().replay('chat-1')).toMatchObject({ record: third, appliedBatches: 2 })
  })

  it('refuses to append after an invalid complete line and removes nothing', () => {
    // What an owner without the repair left behind: fragment and batch as one line.
    const crashed = writer()
    crashed.initialize('chat-1', first)
    crashed.append(secondBatch)
    const damaged = Buffer.concat([
      lineOf(secondBatch),
      fragmentOf(lostBatch, 60),
      lineOf(thirdBatch),
      lineOf(fourthBatch)
    ])
    fs.writeFileSync(activePath, damaged)

    const restarted = writer()
    expect(restarted.replay('chat-1')).toMatchObject({ record: second, appliedBatches: 1 })
    expect(() => restarted.append(thirdBatch)).toThrow('refusing to append')

    // The batches after the damage are still on disk for whoever can recover them.
    expect(fs.readFileSync(activePath)).toEqual(damaged)
    expect(restarted.stats()).toMatchObject({ corruptSegmentRejects: 1, tornTailsTruncated: 0 })
    // Re-anchoring on an authoritative record is what clears the damage.
    restarted.replaceAuthoritativeCheckpoint('chat-1', fourth)
    const fifth = advance(fourth, 'fifth')
    restarted.append(deriveChatRecordMutation(fourth, fifth))
    expect(reader().replay('chat-1').record).toEqual(fifth)
  })

  it('repairs a fragment its own failed write left, retiring the cached descriptor first', () => {
    const fixture = cached()
    const journal = writer({ descriptorCache: fixture.cache })
    journal.initialize('chat-1', first)
    journal.append(secondBatch)
    // A long batch dies part-way through the cached descriptor, so the flusher
    // has counted more bytes than the repaired file plus a short batch will hold.
    const long = advance(second, 'x'.repeat(4_000))
    fixture.failNextWriteAfter(3_000)
    expect(() => journal.append(deriveChatRecordMutation(second, long))).toThrow('disk full')
    expect(fs.statSync(activePath).size).toBe(lineOf(secondBatch).length + 3_000)

    journal.append(thirdBatch)

    expect(fs.readFileSync(activePath)).toEqual(
      Buffer.concat([lineOf(secondBatch), lineOf(thirdBatch)])
    )
    expect(journal.stats()).toMatchObject({ tornTailsTruncated: 1, tornTailBytesTruncated: 3_000 })
    expect(reader().replay('chat-1')).toMatchObject({ record: third, appliedBatches: 2 })
  })

  it('does not seal a segment whose tail it knows is torn', () => {
    const fixture = cached()
    const journal = writer({ descriptorCache: fixture.cache, rotationEnabled: true })
    journal.initialize('chat-1', first)
    journal.append(secondBatch)
    fixture.failNextWriteAfter(40)
    expect(() => journal.append(lostBatch)).toThrow('disk full')

    expect(journal.rotateForPreparation!('chat-1')).toBeNull()
    expect(fs.existsSync(sealedPath)).toBe(false)

    // The next append repairs it, and only then may it be sealed.
    journal.append(thirdBatch)
    expect(journal.rotateForPreparation!('chat-1')).toMatchObject({ revision: 3 })
    expect(fs.readFileSync(sealedPath)).toEqual(
      Buffer.concat([lineOf(secondBatch), lineOf(thirdBatch)])
    )
  })

  it('fences a checkpoint preparation in flight before it cuts a segment', async () => {
    const fixture = cached()
    let cancelled = 0
    let finish: (prepared: never) => void = () => {}
    const journal = writer({
      descriptorCache: fixture.cache,
      rotationEnabled: true,
      checkpointPreparation: {
        start: (source) => ({
          output: source.checkpoint,
          result: new Promise((resolve) => {
            finish = resolve
          }),
          cancel: () => {
            cancelled += 1
          },
          release: () => {}
        })
      }
    })
    journal.initialize('chat-1', first)
    journal.append(secondBatch)
    const adoption = journal.checkpointDeferred!('chat-1')
    expect(fs.existsSync(sealedPath)).toBe(true)
    journal.append(thirdBatch)
    fixture.failNextWriteAfter(40)
    expect(() => journal.append(fourthBatch)).toThrow('disk full')
    expect(cancelled).toBe(0)

    // The repair retires the sealed descriptor the preparation would adopt.
    journal.append(fourthBatch)

    expect(cancelled).toBe(1)
    finish({} as never)
    await expect(adoption).resolves.toBe('superseded')
    expect(reader().replay('chat-1')).toMatchObject({ record: fourth, appliedBatches: 3 })
  })

  it('leaves the repair to the read path where reads may repair', () => {
    crashAfterSecond()
    const legacy = createIncrementalChatJournal(baseDir, { repairTornTailBeforeAppend: true })

    legacy.append(thirdBatch)

    expect(legacy.stats()).toMatchObject({ tornTailsRecovered: 1, tornTailsTruncated: 0 })
    expect(reader().replay('chat-1')).toMatchObject({ record: third, appliedBatches: 2 })
  })
})
