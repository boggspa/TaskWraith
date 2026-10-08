/**
 * A thread loaded from its log for a seed, as the seed worker loads it, run
 * here on the test's own thread: the app's real journal writes the log, and
 * every load is checked against the app's own load of the same files.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ThreadLogSegmentReaderFs } from '../host-shared/thread-log/ThreadLogSegmentReader'
import { deriveChatRecordMutation } from '../main/store/ChatRecordMutation'
import { prepareCheckpoint } from '../main/store/CheckpointPreparationCore'
import {
  checkpointFileReference,
  type CheckpointPreparationJob,
  type CheckpointPreparationPort,
  type CheckpointPreparationRequest,
  type CheckpointPreparationSource,
  type PreparedCheckpoint
} from '../main/store/CheckpointPreparationProtocol'
import {
  createIncrementalChatJournal,
  type IncrementalChatJournal,
  type IncrementalChatJournalOptions
} from '../main/store/IncrementalChatJournal'
import type { ChatMessage, ChatRecord } from '../main/store/types'
import {
  HostThreadLogFollower,
  type HostThreadLogRecord,
  type HostThreadLogSeedPort,
  type HostThreadLogWindowBounds,
  type HostThreadLogWindowSeed
} from './HostThreadLogFollower'
import { hostThreadLogEntriesBefore } from './HostThreadLogHistory'
import { loadThreadLog, type HostThreadLogLoadResult } from './HostThreadLogLoad'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'host-log-load-'

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
const AT = '2026-10-05T00:00:00.000Z'
const ACTIVE = `${CHAT}.mutations.jsonl`
const SEALED = `${CHAT}.sealed.mutations.jsonl`
const CHECKPOINT = `${CHAT}.checkpoint.json`
const BOUNDS: HostThreadLogWindowBounds = { messages: 4, runs: 2, maxViewBytes: 64 * 1024 }

function message(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'user', content, timestamp: AT, ...extra }
}

function thread(extra: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: CHAT,
    title: 'Thread',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    persistenceRevision: 1,
    messages: [],
    runs: [],
    ...extra
  }
}

const revisionOf = (record: ChatRecord): number => record.persistenceRevision ?? 0
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The checkpoint worker, folding when a test says so. */
class Compactor implements CheckpointPreparationPort {
  private readonly jobs: Array<{
    request: CheckpointPreparationRequest
    ready: (value: PreparedCheckpoint) => void
    fail: (error: Error) => void
  }> = []

  constructor(private readonly directory: string) {}

  get pending(): number {
    return this.jobs.length
  }

  start(source: CheckpointPreparationSource): CheckpointPreparationJob | null {
    const outputPath = path.join(
      this.directory,
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
    this.jobs.push({ request: { ...source, output, maxOutputBytes: 8 * 1024 * 1024 }, ready, fail })
    return { output, result, cancel: release, release }
  }

  fold(): void {
    const job = this.jobs.shift()
    if (!job) throw new Error('no compaction is waiting for the worker')
    try {
      job.ready(prepareCheckpoint(job.request))
    } catch (error) {
      job.fail(error as Error)
    }
  }
}

/** The app: its journal as it runs under the barrier. */
class App {
  readonly journal: IncrementalChatJournal
  readonly compactor: Compactor
  record: ChatRecord
  private clock = Date.parse(AT)

  constructor(
    readonly directory: string,
    options: IncrementalChatJournalOptions = {},
    initial: ChatRecord = thread()
  ) {
    this.compactor = new Compactor(directory)
    this.journal = createIncrementalChatJournal(directory, {
      noteDurabilityDebt: () => {},
      checkpointPreparation: this.compactor,
      syncDirectory: () => Promise.resolve(),
      maxJournalBytes: 64 * 1024 * 1024,
      canRepairOnRead: () => false,
      repairTornTailBeforeAppend: true,
      ...options
    })
    this.record = clone(initial)
    this.journal.initialize(CHAT, this.record)
  }

  change(edit: (next: ChatRecord) => void): void {
    const next = clone(this.record)
    edit(next)
    next.persistenceRevision = revisionOf(this.record) + 1
    next.updatedAt = revisionOf(next)
    this.clock += 1000
    this.journal.append(
      deriveChatRecordMutation(this.record, next, { savedAt: new Date(this.clock).toISOString() })
    )
    this.record = next
  }

  /** Let the worker fold the waiting compaction, and wait, by the clock, until it is adopted. */
  async compact(): Promise<void> {
    const adopted = this.journal.stats().compactionsAdopted
    this.compactor.fold()
    const until = Date.now() + 10_000
    while (this.journal.stats().compactionsAdopted === adopted) {
      if (Date.now() > until) throw new Error('the compaction was not adopted')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
}

/** The app's own load, read-only. */
function appLoad(directory: string): ChatRecord | null {
  return createIncrementalChatJournal(directory, {
    noteDurabilityDebt: () => {},
    canWrite: () => false
  }).replay(CHAT).record
}

function recordOf(result: HostThreadLogLoadResult): HostThreadLogRecord {
  if (result.kind !== 'record') throw new Error(`a record was not loaded: ${result.kind}`)
  return result.record
}

function windowOf(result: HostThreadLogLoadResult): HostThreadLogWindowSeed {
  if (result.kind !== 'window') throw new Error(`a window was not loaded: ${result.kind}`)
  return result.seed
}

/** The load, as the seed worker answers a follower with it. */
function loadPort(directory: string, options: Parameters<typeof loadThreadLog>[1] = {}) {
  const port = {
    loads: 0,
    async seed({ chatId, window }: Parameters<HostThreadLogSeedPort['seed']>[0]) {
      port.loads += 1
      const result = await loadThreadLog({ directory, chatId, window }, options)
      if (result.kind === 'absent') return null
      return structuredClone(result.kind === 'window' ? result.seed : result.record)
    }
  }
  return port
}

/** Poll until the follower says it has caught up. */
async function catchUp(follower: HostThreadLogFollower): Promise<void> {
  for (let polls = 0; ; polls += 1) {
    const result = await follower.poll()
    if (result.status !== 'following' || result.caughtUp) return
    if (polls > 1000) throw new Error('the follower never caught up')
  }
}

describe('loading a thread from its log', () => {
  let directory: string
  const followers: HostThreadLogFollower[] = []

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  })

  afterEach(() => {
    for (const follower of followers.splice(0)) follower.close()
    removeTemporaryDirectory(directory)
  })

  const follow = (port: HostThreadLogSeedPort, maxLineBytes?: number): HostThreadLogFollower => {
    const follower = new HostThreadLogFollower({
      chatId: CHAT,
      directory,
      seedPort: port,
      windowMessages: BOUNDS.messages,
      windowRuns: BOUNDS.runs,
      maxViewBytes: BOUNDS.maxViewBytes,
      ...(maxLineBytes ? { maxLineBytes } : {})
    })
    followers.push(follower)
    return follower
  }

  it('builds the thread at the head of its log, as the app builds it, through rotation and compaction', async () => {
    const app = new App(directory, { maxJournalBytes: 2_000 })
    let compacted = 0
    for (let index = 0; index < 60; index += 1) {
      app.change((next) => {
        next.messages.push(message(`m${index}`, `${index} `.padEnd(150, '.')))
        if (index % 7 === 0) next.runs.push({ runId: `r${index}`, startedAt: AT, status: 'done' })
        if (index % 5 === 0 && next.messages.length > 3) next.messages.splice(1, 1)
      })
      // Folded before the next append: left waiting, the journal's cap would supersede it.
      if (app.compactor.pending > 0) {
        await app.compact()
        compacted += 1
      }
      const loaded = await loadThreadLog({ directory, chatId: CHAT })
      expect(recordOf(loaded), `after change ${index}`).toEqual(appLoad(directory))
      expect(recordOf(loaded)).toEqual(app.record)
    }
    expect(compacted).toBeGreaterThan(2)
  }, 60_000)

  it("cuts the record to a follower's window as the follower would, and says what the rows before it show", async () => {
    const app = new App(directory, { maxJournalBytes: 2_000 })
    for (let index = 0; index < 30; index += 1) {
      app.change((next) => {
        next.runs.push({ runId: `r${index}`, startedAt: AT, status: 'done' })
        next.messages.push(
          message(`m${index}`, `${index} `.padEnd(120, '.'), {
            role: 'assistant',
            runId: index % 4 === 0 ? `gone-${index}` : `r${index}`
          })
        )
      })
      if (app.compactor.pending > 0) await app.compact()
    }
    const record = appLoad(directory) as unknown as HostThreadLogRecord
    const seed = windowOf(await loadThreadLog({ directory, chatId: CHAT, window: BOUNDS }))
    const cut = HostThreadLogFollower.windowOf(record, BOUNDS)
    expect({ ...seed, readFrom: [] }).toEqual({
      kind: 'window',
      ...cut,
      readFrom: [],
      entriesBefore: hostThreadLogEntriesBefore(record, cut)
    })
    expect(seed.entriesBefore.shown).toBe(26)
    expect(seed.entriesBefore.missingRunIds.length).toBeGreaterThan(0)
    // Every segment under a name, read to its end.
    const named = [ACTIVE, SEALED]
      .map((name) => path.join(directory, name))
      .filter((filePath) => fs.existsSync(filePath))
      .map((filePath) => fs.statSync(filePath, { bigint: true }))
      .map((stat) => ({ dev: stat.dev, ino: stat.ino, offset: Number(stat.size) }))
    expect(named.length).toBeGreaterThan(0)
    expect(new Set(seed.readFrom.map((each) => `${each.dev}:${each.ino}:${each.offset}`))).toEqual(
      new Set(named.map((each) => `${each.dev}:${each.ino}:${each.offset}`))
    )
  })

  it('lets a follower seeded with its window read on from where it stopped, never reading a line twice', async () => {
    const app = new App(directory, { maxJournalBytes: 3_000 })
    for (let index = 0; index < 40; index += 1) {
      app.change((next) => next.messages.push(message(`m${index}`, `${index} `.padEnd(100, '.'))))
      if (app.compactor.pending > 0 && index < 30) await app.compact()
    }
    const port = loadPort(directory)
    const windowed = follow(port)
    await catchUp(windowed)
    expect(windowed.stats()).toMatchObject({ bytesRead: 0, duplicatesPassed: 0, batchesApplied: 0 })
    const before = [ACTIVE, SEALED].map((name) =>
      fs.existsSync(path.join(directory, name)) ? fs.statSync(path.join(directory, name)).size : 0
    )
    expect(before[0] + before[1]).toBeGreaterThan(1_000)
    for (let index = 40; index < 43; index += 1) {
      app.change((next) => next.messages.push(message(`m${index}`, `${index}`)))
    }
    await catchUp(windowed)
    const view = windowed.view()!
    expect(view.revision).toBe(revisionOf(app.record))
    expect(view.messages).toEqual(app.record.messages.slice(-BOUNDS.messages))
    expect(windowed.stats()).toMatchObject({ duplicatesPassed: 0, batchesApplied: 3 })
    // A follower seeded with the whole record reads every line in the segments again.
    const whole = follow({
      seed: async (request) => recordOf(await loadThreadLog({ directory, chatId: request.chatId }))
    })
    await catchUp(whole)
    // The same view, but for the time of the last batch applied, which a seed does not have.
    expect({ ...whole.view(), savedAt: view.savedAt }).toEqual(view)
    expect(whole.stats().duplicatesPassed).toBeGreaterThan(5)
    expect(windowed.stats().bytesRead).toBeLessThan(whole.stats().bytesRead)
  })

  it('reads the checkpoint it opened to its end, whatever the app puts in its place meanwhile', async () => {
    const app = new App(directory)
    for (let index = 0; index < 5; index += 1) {
      app.change((next) => next.messages.push(message(`m${index}`, `${index}`)))
    }
    const checkpointPath = path.join(directory, CHECKPOINT)
    const replaced: number[] = []
    let replacementDeferred = false
    let opens = 0
    const seam: ThreadLogSegmentReaderFs = {
      constants: fs.constants,
      openSync: (filePath, flags) => {
        const fd = fs.openSync(filePath, flags)
        // The load's second open of the checkpoint is the whole read, after the
        // follower looked at its header: the app checkpoints as it begins.
        if (filePath === checkpointPath && ++opens === 2) {
          app.change((next) => next.messages.push(message('m-late', 'late')))
          try {
            app.journal.checkpoint(CHAT, 'manual', app.record)
            replaced.push(revisionOf(app.record))
          } catch (error) {
            if (
              process.platform !== 'win32' ||
              !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
            )
              throw error
            replacementDeferred = true
          }
        }
        return fd
      },
      fstatSync: (fd, options) => fs.fstatSync(fd, options),
      lstatSync: (filePath, options) => fs.lstatSync(filePath, options),
      readSync: (fd, buffer, offset, length, position) =>
        fs.readSync(fd, buffer, offset, length, position),
      closeSync: (fd) => fs.closeSync(fd)
    }
    const loaded = await loadThreadLog({ directory, chatId: CHAT }, { fs: seam })
    if (replacementDeferred) {
      // Windows can retain the old name while it is open. The journal still
      // carries the new revision; replacement succeeds once the reader closes.
      expect(recordOf(loaded)).toEqual(app.record)
      app.journal.checkpoint(CHAT, 'manual', app.record)
      replaced.push(revisionOf(app.record))
    }
    expect(replaced).toEqual([7])
    expect(recordOf(loaded)).toEqual(app.record)
    expect(recordOf(loaded)).toEqual(appLoad(directory))
    // The checkpoint it held, then the one that passed it.
    if (loaded.kind === 'record' && !replacementDeferred) expect(loaded.timings.checkpoints).toBe(2)
  })

  it('reads a line too long for the event loop, so a follower it seeds reads on past it', async () => {
    const app = new App(directory)
    app.change((next) => next.messages.push(message('m1', 'short')))
    app.change((next) => next.messages.push(message('m2', 'long '.repeat(1_000))))
    app.change((next) => next.messages.push(message('m3', 'short again')))
    const follower = follow(loadPort(directory), 2_000)
    await catchUp(follower)
    app.change((next) => next.messages.push(message('m4', 'and on')))
    await catchUp(follower)
    expect(follower.view()!.messages).toEqual(app.record.messages.slice(-BOUNDS.messages))
    expect(follower.stats().seeds).toMatchObject({ cold: 1, oversized: 0 })
  })

  it('finds no thread without a checkpoint, with one that does not parse, or being erased', async () => {
    expect(await loadThreadLog({ directory, chatId: CHAT })).toEqual({ kind: 'absent' })
    const app = new App(directory)
    app.change((next) => next.messages.push(message('m1', 'a')))
    expect(recordOf(await loadThreadLog({ directory, chatId: CHAT }))).toEqual(app.record)
    const checkpointPath = path.join(directory, CHECKPOINT)
    const kept = fs.readFileSync(checkpointPath)
    fs.writeFileSync(checkpointPath, kept.subarray(0, kept.length - 10))
    expect(await loadThreadLog({ directory, chatId: CHAT })).toEqual({ kind: 'absent' })
    fs.writeFileSync(checkpointPath, kept)
    expect(recordOf(await loadThreadLog({ directory, chatId: CHAT }))).toEqual(app.record)
    fs.writeFileSync(path.join(directory, `${CHAT}.tombstone`), '')
    expect(await loadThreadLog({ directory, chatId: CHAT, window: BOUNDS })).toEqual({
      kind: 'absent'
    })
  })

  it('reads a line longer than the segment reader takes by default', async () => {
    const app = new App(directory)
    app.change((next) => next.messages.push(message('m1', 'short')))
    // Over the 16 MiB a Host follower reads on its loop: the load reads it whole.
    app.change((next) => next.messages.push(message('m2', 'x'.repeat(17 * 1024 * 1024))))
    app.change((next) => next.messages.push(message('m3', 'short again')))
    const loaded = recordOf(await loadThreadLog({ directory, chatId: CHAT }))
    expect(loaded.persistenceRevision).toBe(4)
    expect(loaded).toEqual(app.record)
  }, 60_000)

  it('refuses a chat id the journal would never name a file for', async () => {
    await expect(loadThreadLog({ directory, chatId: '../chat' })).rejects.toThrow(
      'Thread log load: unsafe chat id'
    )
  })
})
