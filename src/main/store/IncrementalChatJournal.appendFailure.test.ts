/**
 * The journal's head has to say what the file says. An append whose line did
 * not reach the file whole has failed, whichever of the two write paths it
 * took, and must leave the head where it was. An append whose line is in the
 * file has happened, whatever the sync after it said, and the head must move.
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveChatRecordMutation, type ChatRecordMutationBatch } from './ChatRecordMutation'
import {
  createIncrementalChatJournal,
  type IncrementalChatAppendDurability,
  type IncrementalChatJournal,
  type IncrementalChatJournalOptions
} from './IncrementalChatJournal'
import { createIncrementalChatPersistence } from './IncrementalChatPersistence'
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

function advance(source: ChatRecord, content: string): ChatRecord {
  const next = structuredClone(source)
  next.messages[0].content = content
  next.persistenceRevision = (source.persistenceRevision ?? 0) + 1
  next.updatedAt += 1
  return next
}

const lineOf = (batch: ChatRecordMutationBatch): Buffer => Buffer.from(`${JSON.stringify(batch)}\n`)

function diskFull(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
}

function ioError(): NodeJS.ErrnoException {
  return Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' })
}

/** The bytes one `writeSync` call was asked to write, whichever way it was called. */
function bytesOf(data: unknown, offset: unknown, length: unknown): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  const bytes = data as Buffer
  const from = typeof offset === 'number' ? offset : 0
  return bytes.subarray(from, from + (typeof length === 'number' ? length : bytes.length - from))
}

describe('journal append when the write itself goes wrong', () => {
  let baseDir: string
  let activePath: string
  /** Completion callbacks of the flushes the journal scheduled and has not been told about. */
  let scheduled: Array<(error?: NodeJS.ErrnoException | null) => void>

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-append-failure-'))
    activePath = path.join(baseDir, 'chat-1.mutations.jsonl')
    scheduled = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  const writer = (options: IncrementalChatJournalOptions = {}): IncrementalChatJournal =>
    createIncrementalChatJournal(baseDir, {
      scheduleFsync: (_fd, done) => {
        scheduled.push(done)
      },
      ...options
    })
  const replayed = (): ReturnType<IncrementalChatJournal['replay']> =>
    createIncrementalChatJournal(baseDir, { canWrite: () => false }).replay('chat-1')
  const onDisk = (): Buffer =>
    fs.existsSync(activePath) ? fs.readFileSync(activePath) : Buffer.alloc(0)

  /** The next `writeSync` writes the first `kept` bytes it was given and then does `after`. */
  const nextWrite = (kept: number, after: 'fails' | 'returns'): void => {
    const realWrite = fs.writeSync
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(((
      fd: number,
      data: unknown,
      ...rest: unknown[]
    ) => {
      const part = bytesOf(data, rest[0], rest[1]).subarray(0, kept)
      if (part.length > 0) realWrite(fd, part, 0, part.length)
      if (after === 'fails') throw diskFull()
      return part.length
    }) as typeof fs.writeSync)
    syncBuiltinESMExports()
  }

  const first = chat()
  const second = advance(first, 'second')
  const third = advance(second, 'third')
  const secondBatch = deriveChatRecordMutation(first, second)
  const thirdBatch = deriveChatRecordMutation(second, third)
  const paths: IncrementalChatAppendDurability[] = ['immediate', 'deferred']

  it.each(paths)(
    'fails a %s append whose write fails, and leaves the head where it was',
    (durability) => {
      const journal = writer()
      journal.initialize('chat-1', first)
      nextWrite(0, 'fails')

      expect(() => journal.append(secondBatch, { durability })).toThrow('ENOSPC')

      expect(onDisk()).toEqual(Buffer.alloc(0))
      expect(scheduled).toHaveLength(0)
      expect(journal.stats()).toMatchObject({
        appends: 0,
        deferredAppends: 0,
        mutationBytesWritten: 0
      })

      // The same batch is still the next one, and what follows it is readable.
      journal.append(secondBatch, { durability })
      journal.append(thirdBatch, { durability })
      expect(onDisk()).toEqual(Buffer.concat([lineOf(secondBatch), lineOf(thirdBatch)]))
      expect(replayed()).toMatchObject({ record: third, revision: 3, appliedBatches: 2 })
    }
  )

  it.each(paths)('closes the descriptor of a %s append whose write fails', (durability) => {
    const journal = writer()
    journal.initialize('chat-1', first)
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
    nextWrite(0, 'fails')

    expect(() => journal.append(secondBatch, { durability })).toThrow('ENOSPC')

    expect(opened).toHaveLength(1)
    expect(closed.filter((fd) => fd === opened[0])).toHaveLength(1)
  })

  it.each(paths)(
    'fails a %s append whose write stops part way, and the next one starts on a clean line',
    (durability) => {
      const journal = writer({ canRepairOnRead: () => false, repairTornTailBeforeAppend: true })
      journal.initialize('chat-1', first)
      nextWrite(40, 'fails')

      expect(() => journal.append(secondBatch, { durability })).toThrow('ENOSPC')

      expect(onDisk()).toEqual(lineOf(secondBatch).subarray(0, 40))
      expect(journal.stats()).toMatchObject({ appends: 0, deferredAppends: 0 })

      journal.append(secondBatch, { durability })
      expect(onDisk()).toEqual(lineOf(secondBatch))
      expect(journal.stats()).toMatchObject({ appends: 1, tornTailsTruncated: 1 })
      expect(replayed()).toMatchObject({ record: second, revision: 2, appliedBatches: 1 })
    }
  )

  it.each(paths)('writes the rest of a %s line the disk took only part of', (durability) => {
    const journal = writer()
    journal.initialize('chat-1', first)
    nextWrite(10, 'returns')

    journal.append(secondBatch, { durability })
    journal.append(thirdBatch, { durability })

    expect(onDisk()).toEqual(Buffer.concat([lineOf(secondBatch), lineOf(thirdBatch)]))
    expect(journal.stats()).toMatchObject({
      appends: 2,
      mutationBytesWritten: lineOf(secondBatch).length + lineOf(thirdBatch).length
    })
    expect(replayed()).toMatchObject({ record: third, revision: 3, appliedBatches: 2 })
  })

  it('fails an append when the disk takes no more of the line at all', () => {
    const journal = writer()
    journal.initialize('chat-1', first)
    const realWrite = fs.writeSync
    let calls = 0
    vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      data: unknown,
      ...rest: unknown[]
    ) => {
      calls += 1
      if (calls > 50) throw new Error('kept writing after the disk stopped taking bytes')
      if (calls > 1) return 0
      const part = bytesOf(data, rest[0], rest[1]).subarray(0, 10)
      return realWrite(fd, part, 0, part.length)
    }) as typeof fs.writeSync)
    syncBuiltinESMExports()

    expect(() => journal.append(secondBatch, { durability: 'deferred' })).toThrow(/wrote 10 of/)
    expect(calls).toBe(2)
    expect(journal.stats()).toMatchObject({ appends: 0 })
  })

  it('still flushes in line, and counts the append, when only the scheduling of the flush fails', async () => {
    const journal = writer({
      scheduleFsync: () => {
        throw new Error('no thread to flush on')
      }
    })
    journal.initialize('chat-1', first)
    const opened: number[] = []
    const synced: number[] = []
    const realOpen = fs.openSync
    const realSync = fs.fsyncSync
    vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
      const fd = realOpen(target, flags, mode)
      if (target === activePath) opened.push(fd)
      return fd
    })
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      synced.push(fd)
      realSync(fd)
    })
    syncBuiltinESMExports()

    journal.append(secondBatch, { durability: 'deferred' })

    expect(opened).toHaveLength(1)
    expect(synced.filter((fd) => fd === opened[0])).toHaveLength(1)
    expect(onDisk()).toEqual(lineOf(secondBatch))
    expect(journal.stats()).toMatchObject({ appends: 1, deferredAppends: 1 })
    await expect(journal.awaitDeferredDurability!('chat-1')).resolves.toBeUndefined()
    expect(replayed()).toMatchObject({ record: second, revision: 2, appliedBatches: 1 })
  })
})

describe('journal append whose line is written but whose sync fails', () => {
  let baseDir: string
  let activePath: string
  let scheduled: Array<(error?: NodeJS.ErrnoException | null) => void>

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-append-unsynced-'))
    activePath = path.join(baseDir, 'chat-1.mutations.jsonl')
    scheduled = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  const writer = (): IncrementalChatJournal =>
    createIncrementalChatJournal(baseDir, {
      scheduleFsync: (_fd, done) => {
        scheduled.push(done)
      }
    })
  const replayed = (): ReturnType<IncrementalChatJournal['replay']> =>
    createIncrementalChatJournal(baseDir, { canWrite: () => false }).replay('chat-1')
  const nextSyncFails = (): void => {
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw ioError()
    })
    syncBuiltinESMExports()
  }

  const first = chat()
  const second = advance(first, 'second')
  const third = advance(second, 'third')
  const retried = advance(first, 'second, in other words')
  const secondBatch = deriveChatRecordMutation(first, second)
  const thirdBatch = deriveChatRecordMutation(second, third)
  const retriedBatch = deriveChatRecordMutation(first, retried)

  /** A journal whose append of the second batch has just failed at the sync. */
  const afterFailedSync = (): IncrementalChatJournal => {
    const journal = writer()
    journal.initialize('chat-1', first)
    nextSyncFails()
    expect(() => journal.append(secondBatch)).toThrow('EIO')
    return journal
  }

  it('tells the caller the sync failed, and counts the line it wrote', () => {
    const journal = writer()
    journal.initialize('chat-1', first)
    nextSyncFails()

    let thrown: unknown
    try {
      journal.append(secondBatch)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({ code: 'EIO' })
    expect(fs.readFileSync(activePath)).toEqual(lineOf(secondBatch))
    expect(journal.stats()).toMatchObject({
      appends: 1,
      immediateFsyncFailures: 1,
      mutationBytesWritten: lineOf(secondBatch).length
    })
  })

  it('moves the head with the line, so the next batch continues from it', () => {
    const journal = afterFailedSync()

    journal.append(thirdBatch)

    expect(fs.readFileSync(activePath)).toEqual(
      Buffer.concat([lineOf(secondBatch), lineOf(thirdBatch)])
    )
    expect(replayed()).toMatchObject({ record: third, revision: 3, appliedBatches: 2 })
  })

  it('never lets a second line at the same revision in behind it', () => {
    const journal = afterFailedSync()

    // Behind the first line this one would be skipped as a duplicate on every
    // later load, and the thread would come back as the save that failed.
    expect(() => journal.append(retriedBatch)).toThrow(/revision mismatch for chat-1: 2 != 1/)

    expect(fs.readFileSync(activePath)).toEqual(lineOf(secondBatch))
    expect(replayed()).toMatchObject({ record: second, revision: 2, appliedBatches: 1 })
  })

  it('keeps the failure for whoever waits on the chat, and syncs the next append in line', async () => {
    const journal = afterFailedSync()
    await expect(journal.awaitDeferredDurability!('chat-1')).rejects.toMatchObject({ code: 'EIO' })

    journal.append(thirdBatch, { durability: 'deferred' })

    // Not left to a scheduled flush: this sync is what makes both lines safe.
    expect(scheduled).toHaveLength(0)
    expect(journal.stats()).toMatchObject({ appends: 2, deferredAppends: 0 })
    await expect(journal.awaitDeferredDurability!('chat-1')).resolves.toBeUndefined()
  })

  it('does not tell a waiter on an earlier line that it is safe', async () => {
    const journal = writer()
    journal.initialize('chat-1', first)
    journal.append(secondBatch, { durability: 'deferred' })
    expect(scheduled).toHaveLength(1)
    let outcome = 'waiting'
    const waiting = journal.awaitDeferredDurability!('chat-1').then(
      () => {
        outcome = 'safe'
      },
      () => {
        outcome = 'failed'
      }
    )
    nextSyncFails()

    expect(() => journal.append(thirdBatch)).toThrow('EIO')
    await new Promise((resolve) => setImmediate(resolve))
    expect(outcome).toBe('waiting')

    // Its own flush, when that lands, is what settles it.
    scheduled[0](null)
    await waiting
    expect(outcome).toBe('safe')
  })

  it('lets a drain pay the flush the failed sync left owing', async () => {
    const journal = afterFailedSync()
    vi.restoreAllMocks()
    const synced: number[] = []
    const realSync = fs.fsyncSync
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      synced.push(fd)
      realSync(fd)
    })
    syncBuiltinESMExports()

    journal.drainDeferredDurability()

    expect(synced).toHaveLength(1)
    await expect(journal.awaitDeferredDurability!('chat-1')).resolves.toBeUndefined()
  })

  describe('through the persistence coordinator', () => {
    const quiet = { error: (): void => {}, warn: (): void => {} }

    it('carries on from the written line without a new checkpoint when the store moved on', () => {
      const journal = writer()
      const persistence = createIncrementalChatPersistence({ journal, logger: quiet })
      persistence.persist(null, first, 'normal')
      nextSyncFails()
      expect(() => persistence.persist(first, second, 'approval')).toThrow('EIO')
      const checkpoints = journal.stats().checkpointsWritten

      persistence.persist(second, third, 'approval')

      expect(journal.stats().checkpointsWritten).toBe(checkpoints)
      expect(replayed()).toMatchObject({ record: third, revision: 3, appliedBatches: 2 })
    })

    it('replaces the line when the save is made again from the same base', () => {
      const journal = writer()
      const persistence = createIncrementalChatPersistence({ journal, logger: quiet })
      persistence.persist(null, first, 'normal')
      nextSyncFails()
      expect(() => persistence.persist(first, second, 'approval')).toThrow('EIO')

      persistence.persist(first, retried, 'approval')

      expect(replayed()).toMatchObject({ record: retried, revision: 2, appliedBatches: 1 })
    })
  })
})
