import * as fs from 'fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import { prepareCheckpoint } from './CheckpointPreparationCore'
import {
  createIncrementalChatJournal,
  type IncrementalChatJournalOptions
} from './IncrementalChatJournal'
import {
  checkpointFileReference,
  type CheckpointPreparationJob,
  type CheckpointPreparationPort,
  type CheckpointPreparationRequest,
  type CheckpointPreparationSource,
  type PreparedCheckpoint
} from './CheckpointPreparationProtocol'
import type { ChatRecord } from './types'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) }
})

let baseDir: string
beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(tmpdir(), 'itp-journal-prepare-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(baseDir, { recursive: true, force: true })
})

function chat(revision = 1, content = 'initial'): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'test',
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages: [{ id: 'm', role: 'assistant', content, timestamp: '2026-09-24T00:00:00Z' }],
    runs: []
  }
}

/** Can deliberately deliver a late reply after cancellation, unlike the real process client. */
class ControlledPreparation implements CheckpointPreparationPort {
  requests: Array<{
    request: CheckpointPreparationRequest
    job: CheckpointPreparationJob
    ready: (value: PreparedCheckpoint) => void
    fail: (error: Error) => void
  }> = []
  saturated = false
  start(source: CheckpointPreparationSource): CheckpointPreparationJob | null {
    if (this.saturated) return null
    const outputPath = path.join(
      baseDir,
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
    const release = () => fs.rmSync(outputPath, { force: true })
    const job = { output, result, cancel: vi.fn(release), release }
    this.requests.push({
      request: { ...source, output, maxOutputBytes: 1024 * 1024 },
      job,
      ready,
      fail
    })
    return job
  }
  prepare(index = this.requests.length - 1): PreparedCheckpoint {
    return prepareCheckpoint(this.requests[index].request)
  }
  complete(index = this.requests.length - 1): void {
    this.requests[index].ready(this.prepare(index))
  }
}

function fixture(options: IncrementalChatJournalOptions = {}) {
  const preparation = new ControlledPreparation()
  const journal = createIncrementalChatJournal(baseDir, {
    checkpointPreparation: preparation,
    ...options
  })
  const before = chat()
  const after = chat(2, 'durable second')
  journal.initialize('chat-1', before)
  journal.append(deriveChatRecordMutation(before, after))
  return { journal, preparation, before, after }
}

describe('journal-owned prepared checkpoint adoption', () => {
  it('compacts the durable source without consulting a borrowed mutable head', async () => {
    const { journal, preparation, after } = fixture()
    const resolver = vi.fn(() => {
      throw new Error('main-thread full record resolver')
    })
    journal.setHeadRecordResolver!(resolver)
    const result = journal.checkpointDeferred!('chat-1')
    expect(journal.stats().checkpointsWritten).toBe(1)
    preparation.complete()
    await expect(result).resolves.toBe('checkpointed')
    expect(resolver).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(false)
    expect(createIncrementalChatJournal(baseDir).replay('chat-1').record).toEqual(after)
    expect(journal.stats()).toMatchObject({ checkpointsWritten: 2, checkpointsFromMemory: 0 })
  })

  it('never retires a newer tail when an append races a prepared reply', async () => {
    const { journal, preparation, after } = fixture()
    const result = journal.checkpointDeferred!('chat-1')
    const prepared = preparation.prepare()
    const latest = chat(3, 'newer tail survives')
    journal.append(deriveChatRecordMutation(after, latest))
    expect(preparation.requests[0].job.cancel).toHaveBeenCalledOnce()
    preparation.requests[0].ready(prepared)
    await expect(result).resolves.toBe('superseded')
    expect(journal.replay('chat-1').record).toEqual(latest)
    expect(
      fs.readFileSync(path.join(baseDir, 'chat-1.mutations.jsonl'), 'utf8').trim().split('\n')
    ).toHaveLength(2)
    const next = journal.checkpointDeferred!('chat-1')
    preparation.complete()
    await expect(next).resolves.toBe('checkpointed')
    expect(journal.replay('chat-1').record).toEqual(latest)
  })

  it.each(['replace', 'checkpoint', 'repair', 'delete', 'purge', 'clear', 'shutdown'] as const)(
    'fences a late ready across %s, including same-revision reincarnation',
    async (mutation) => {
      const { journal, preparation } = fixture()
      const result = journal.checkpointDeferred!('chat-1')
      const prepared = preparation.prepare()
      if (mutation === 'replace')
        journal.replaceAuthoritativeCheckpoint('chat-1', chat(2, 'same revision replacement'))
      if (mutation === 'checkpoint')
        journal.checkpoint('chat-1', 'manual', chat(2, 'sync replacement'))
      if (mutation === 'repair') {
        fs.appendFileSync(path.join(baseDir, 'chat-1.mutations.jsonl'), '{torn')
        journal.replay('chat-1')
      }
      if (mutation === 'delete') journal.delete('chat-1')
      if (mutation === 'purge') {
        journal.purge('chat-1')
        journal.initialize('chat-1', chat(2, 'new incarnation'))
      }
      if (mutation === 'clear') {
        journal.clear()
        journal.initialize('chat-1', chat(2, 'new incarnation'))
      }
      if (mutation === 'shutdown') journal.checkpointAll()
      const expected = journal.replay('chat-1').record
      preparation.requests[0].ready(prepared)
      await expect(result).resolves.toBe('superseded')
      expect(journal.replay('chat-1').record).toEqual(expected)
      expect(fs.readdirSync(baseDir).some((name) => name.includes('checkpoint-prepared'))).toBe(
        false
      )
    }
  )

  it('fences external erasure before the original files are removed', async () => {
    const { journal, preparation } = fixture()
    const result = journal.checkpointDeferred!('chat-1')
    const prepared = preparation.prepare()
    journal.cancelCheckpointPreparations!('chat-1')
    fs.rmSync(path.join(baseDir, 'chat-1.checkpoint.json'))
    fs.rmSync(path.join(baseDir, 'chat-1.mutations.jsonl'))
    preparation.requests[0].ready(prepared)
    await expect(result).resolves.toBe('superseded')
    expect(fs.readdirSync(baseDir)).toEqual([])
  })

  it('refuses adoption after writer authority changes', async () => {
    let writable = true
    const { journal, preparation } = fixture({ canWrite: () => writable })
    const result = journal.checkpointDeferred!('chat-1')
    preparation.complete()
    writable = false
    await expect(result).resolves.toBe('superseded')
    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(true)
  })

  it('rechecks after the authority callback and rejects reentrant invalidation', async () => {
    let guard: (() => void) | undefined
    const { journal, preparation, after } = fixture({ beforeSourceMutation: () => guard?.() })
    const result = journal.checkpointDeferred!('chat-1')
    preparation.complete()
    guard = () => {
      guard = undefined
      journal.append(deriveChatRecordMutation(after, chat(3, 'newer')))
    }
    await expect(result).resolves.toBe('superseded')
    expect(journal.replay('chat-1').record).toEqual(chat(3, 'newer'))
  })

  it('rejects a substituted output inode', async () => {
    const { journal, preparation } = fixture()
    const result = journal.checkpointDeferred!('chat-1')
    const prepared = preparation.prepare()
    const output = preparation.requests[0].job.output.path
    fs.renameSync(output, `${output}.substituted`)
    fs.writeFileSync(output, '{}')
    preparation.requests[0].ready(prepared)
    await expect(result).rejects.toThrow('ownership mismatch')
    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(true)
  })

  it('preserves the original journal and durability wait when preparation fails', async () => {
    const completions: Array<(error?: NodeJS.ErrnoException | null) => void> = []
    const { journal, preparation, after } = fixture({
      scheduleFsync: (_fd, done) => {
        completions.push(done)
      }
    })
    journal.append(deriveChatRecordMutation(after, chat(3, 'unflushed')), {
      durability: 'deferred'
    })
    let durable = false
    const barrier = journal.awaitDeferredDurability!('chat-1').then(() => {
      durable = true
    })
    const result = journal.checkpointDeferred!('chat-1')
    preparation.requests[0].fail(new Error('child failed'))
    await expect(result).rejects.toThrow('child failed')
    expect(durable).toBe(false)
    expect(journal.stats().checkpointsWritten).toBe(1)
    completions[0]()
    await barrier
    expect(journal.replay('chat-1').revision).toBe(3)
  })

  it('acknowledges deferred durability only after successful durable adoption', async () => {
    const completions: Array<(error?: NodeJS.ErrnoException | null) => void> = []
    const { journal, preparation, after } = fixture({
      scheduleFsync: (_fd, done) => {
        completions.push(done)
      }
    })
    journal.append(deriveChatRecordMutation(after, chat(3, 'pending flush')), {
      durability: 'deferred'
    })
    let durable = false
    const barrier = journal.awaitDeferredDurability!('chat-1').then(() => {
      durable = true
    })
    const result = journal.checkpointDeferred!('chat-1')
    const prepared = preparation.prepare()
    await Promise.resolve()
    expect(durable).toBe(false)
    preparation.requests[0].ready(prepared)
    await expect(result).resolves.toBe('checkpointed')
    await barrier
    expect(durable).toBe(true)
    completions[0]() // old descriptor is closed exactly once by its own callback
  })

  it('drains D1 durability and checkpoints healthy sources despite a preparation cleanup failure', async () => {
    const completions: Array<(error?: NodeJS.ErrnoException | null) => void> = []
    const { journal, preparation, after } = fixture({
      scheduleFsync: (_fd, done) => {
        completions.push(done)
      }
    })
    journal.append(deriveChatRecordMutation(after, chat(3, 'shutdown must retain this')), {
      durability: 'deferred'
    })
    let durable = false
    const barrier = journal.awaitDeferredDurability!('chat-1').then(() => {
      durable = true
    })
    const pending = journal.checkpointDeferred!('chat-1')
    const prepared = preparation.prepare()
    const output = preparation.requests[0].job.output.path
    // A deterministic filesystem cleanup failure, independent of platform
    // permission semantics: non-recursive removal must refuse this directory.
    fs.unlinkSync(output)
    fs.mkdirSync(output)
    fs.writeFileSync(path.join(output, 'retained'), 'private prepared bytes')
    expect(() => journal.checkpointAll()).toThrow()
    await barrier
    expect(durable).toBe(true)
    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(false)
    expect(journal.replay('chat-1').revision).toBe(3)
    expect(fs.existsSync(output)).toBe(true) // failure remains visible, not claimed cleaned
    fs.rmSync(output, { recursive: true })
    preparation.requests[0].ready(prepared)
    await expect(pending).resolves.toBe('superseded')
    completions[0]()
  })

  it('recovers if retirement fails after the new checkpoint has been renamed', async () => {
    const { journal, preparation, after } = fixture()
    const unlink = (await vi.importActual<typeof import('fs')>('fs')).unlinkSync
    const result = journal.checkpointDeferred!('chat-1')
    preparation.complete()
    vi.mocked(fs.unlinkSync).mockImplementation((file) => {
      if (file === path.join(baseDir, 'chat-1.mutations.jsonl')) throw new Error('crash window')
      unlink(file)
    })
    await expect(result).rejects.toThrow('crash window')
    expect(
      JSON.parse(fs.readFileSync(path.join(baseDir, 'chat-1.checkpoint.json'), 'utf8')).revision
    ).toBe(2)
    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(true)
    vi.mocked(fs.unlinkSync).mockImplementation(unlink)
    expect(createIncrementalChatJournal(baseDir).replay('chat-1')).toMatchObject({
      record: after,
      skippedBatches: 1
    })
  })

  it('skips saturated work and unknown chats without replaying on main', async () => {
    const { journal, preparation } = fixture()
    preparation.saturated = true
    const resolver = vi.fn(() => {
      throw new Error('must not run')
    })
    journal.setHeadRecordResolver!(resolver)
    await expect(journal.checkpointDeferred!('chat-1')).resolves.toBe('unavailable')
    await expect(journal.checkpointDeferred!('unopened')).resolves.toBe('unchanged')
    expect(resolver).not.toHaveBeenCalled()
    expect(fs.readdirSync(baseDir)).toHaveLength(2)
  })

  it('bounds each idle metadata pass and continues round-robin on the next pass', async () => {
    const preparation = new ControlledPreparation()
    const journal = createIncrementalChatJournal(baseDir, {
      checkpointPreparation: preparation,
      now: () => 0
    })
    for (let index = 0; index < 9; index += 1) {
      const before = { ...chat(), appChatId: `chat-${index}` }
      const after = { ...chat(2, 'after'), appChatId: before.appChatId }
      journal.initialize(before.appChatId, before)
      journal.append(deriveChatRecordMutation(before, after))
    }
    const first = journal.checkpointIdleDeferred!(20_000)
    expect(preparation.requests).toHaveLength(8)
    for (let index = 0; index < 8; index += 1) preparation.complete(index)
    await expect(first).resolves.toBe(8)
    const second = journal.checkpointIdleDeferred!(20_000)
    expect(preparation.requests[8].request.chatId).toBe('chat-8')
    preparation.complete(8)
    await expect(second).resolves.toBe(1)
  })

  it('scrubs crash leftovers on startup and erasure even with the flag off', () => {
    const file = path.join(
      baseDir,
      `.chat-1.checkpoint-prepared-${process.pid}-${randomUUID()}.tmp`
    )
    fs.writeFileSync(file, 'private transcript')
    createIncrementalChatJournal(baseDir, { canWrite: () => false })
    expect(fs.existsSync(file)).toBe(true)
    const journal = createIncrementalChatJournal(baseDir)
    expect(fs.existsSync(file)).toBe(false)
    fs.writeFileSync(file, 'private transcript')
    journal.cancelCheckpointPreparations!('chat-1')
    expect(fs.existsSync(file)).toBe(false)
  })
})
