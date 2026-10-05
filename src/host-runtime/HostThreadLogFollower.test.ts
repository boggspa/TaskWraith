/**
 * The Host follows a thread's log while the app writes it. These run the app's
 * real journal over a real directory, as it runs when it leaves syncing to the
 * thread barrier, and check the follower's view against the record the app
 * wrote, at every revision.
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyThreadLogBatch } from '../host-shared/thread-log/ThreadLogApply'
import {
  THREAD_LOG_BATCH_FORMAT,
  THREAD_LOG_BATCH_VERSION,
  type ThreadLogOperation
} from '../host-shared/thread-log/ThreadLogBatch'
import {
  deriveChatRecordMutation,
  type ChatRecordMutationBatch
} from '../main/store/ChatRecordMutation'
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
import type { ChatMessage, ChatRecord, ChatRun } from '../main/store/types'
import {
  HOST_THREAD_LOG_MAX_RETAINED_BYTES,
  HOST_THREAD_LOG_MAX_THREADS,
  HOST_THREAD_LOG_MAX_VIEW_BYTES,
  HOST_THREAD_LOG_WINDOW_MESSAGES,
  HOST_THREAD_LOG_WINDOW_RUNS,
  HostThreadLogFollower,
  HostThreadLogFollowers,
  type HostThreadLogAppliedBatch,
  type HostThreadLogFollowerOptions,
  type HostThreadLogMessage,
  type HostThreadLogRecord,
  type HostThreadLogSeedPort,
  type HostThreadLogSeedReason,
  type HostThreadLogSeedRequest
} from './HostThreadLogFollower'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'host-log-follower-'

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

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  return { id, role, content, timestamp: AT, ...extra }
}

function run(runId: string, extra: Partial<ChatRun> = {}): ChatRun {
  return { runId, startedAt: AT, status: 'running', ...extra }
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
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The checkpoint worker, run on this thread when a test says so, and the directory syncs it waits for. */
class Compactor implements CheckpointPreparationPort {
  private readonly jobs: Array<{
    request: CheckpointPreparationRequest
    ready: (value: PreparedCheckpoint) => void
    fail: (error: Error) => void
  }> = []
  private readonly syncs: Array<() => void> = []
  holdSyncs = false

  constructor(private readonly directory: string) {}

  get pending(): number {
    return this.jobs.length
  }

  get pendingSyncs(): number {
    return this.syncs.length
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

  /** The worker folds the oldest job and hands it back. */
  fold(): void {
    const job = this.jobs.shift()
    if (!job) throw new Error('no compaction is waiting for the worker')
    try {
      job.ready(prepareCheckpoint(job.request))
    } catch (error) {
      job.fail(error as Error)
    }
  }

  readonly syncDirectory = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (this.holdSyncs) this.syncs.push(resolve)
      else resolve()
    })

  releaseSync(): void {
    const release = this.syncs.shift()
    if (!release) throw new Error('no directory sync is waiting')
    release()
  }
}

/**
 * The app: its journal as it runs under the barrier, and every record it
 * wrote, by revision, to check the follower against.
 */
class App {
  readonly journal: IncrementalChatJournal
  readonly compactor: Compactor
  readonly records = new Map<number, ChatRecord>()
  record: ChatRecord
  lastBatch: ChatRecordMutationBatch | null = null
  private clock = Date.parse(AT)

  constructor(
    readonly directory: string,
    options: IncrementalChatJournalOptions = {},
    initial: ChatRecord = thread(),
    compactor?: Compactor
  ) {
    this.compactor = compactor ?? new Compactor(directory)
    this.journal = createIncrementalChatJournal(directory, {
      noteDurabilityDebt: () => {},
      checkpointPreparation: this.compactor,
      syncDirectory: this.compactor.syncDirectory,
      maxJournalBytes: 64 * 1024 * 1024,
      canRepairOnRead: () => false,
      repairTornTailBeforeAppend: true,
      ...options
    })
    this.record = clone(initial)
    if (this.journal.replay(CHAT).record === null) this.journal.initialize(CHAT, this.record)
    this.records.set(revisionOf(this.record), clone(this.record))
  }

  /** Change the record and append the batch the journal derives from the two. */
  change(edit: (next: ChatRecord) => void): ChatRecordMutationBatch {
    const next = clone(this.record)
    edit(next)
    next.persistenceRevision = revisionOf(this.record) + 1
    next.updatedAt = revisionOf(next)
    this.clock += 1000
    const batch = deriveChatRecordMutation(this.record, next, {
      savedAt: new Date(this.clock).toISOString()
    })
    return this.write(batch, next)
  }

  /** Append operations written by hand; the record they make is the shared apply code's. */
  operations(operations: ThreadLogOperation[]): ChatRecordMutationBatch {
    this.clock += 1000
    const batch = {
      format: THREAD_LOG_BATCH_FORMAT,
      version: THREAD_LOG_BATCH_VERSION,
      chatId: CHAT,
      baseRevision: revisionOf(this.record),
      revision: revisionOf(this.record) + 1,
      savedAt: new Date(this.clock).toISOString(),
      operations
    } as ChatRecordMutationBatch
    return this.write(batch, applyThreadLogBatch(this.record, batch))
  }

  private write(batch: ChatRecordMutationBatch, next: ChatRecord): ChatRecordMutationBatch {
    this.journal.append(batch)
    this.lastBatch = batch
    this.record = next
    this.records.set(revisionOf(next), clone(next))
    return batch
  }

  /** Let the worker fold the waiting compaction, and wait until it is adopted. */
  async compact(): Promise<void> {
    const adopted = this.journal.stats().compactionsAdopted
    this.compactor.fold()
    for (let turn = 0; turn < 500; turn += 1) {
      if (this.journal.stats().compactionsAdopted > adopted) return
      if (this.compactor.pendingSyncs > 0) this.compactor.releaseSync()
      await settle()
    }
    throw new Error('the compaction was not adopted')
  }
}

/** The app's own load, read-only, as the production seed must build it. */
function appLoad(directory: string): ChatRecord | null {
  return createIncrementalChatJournal(directory, {
    noteDurabilityDebt: () => {},
    canWrite: () => false
  }).replay(CHAT).record
}

function seedPortOf(directory: string): HostThreadLogSeedPort & {
  readonly requests: HostThreadLogSeedRequest[]
} {
  const requests: HostThreadLogSeedRequest[] = []
  return {
    requests,
    async seed(request) {
      requests.push(request)
      await settle()
      return appLoad(directory) as unknown as HostThreadLogRecord | null
    }
  }
}

function noSeedsBut(
  expected: Partial<Record<HostThreadLogSeedReason, number>>
): Record<string, number> {
  return {
    cold: 0,
    'checkpoint-passed': 0,
    lineage: 0,
    rewritten: 0,
    oversized: 0,
    unapplicable: 0,
    requested: 0,
    ...expected
  }
}

/**
 * The view holds the newest rows of `record`, at its revision: the record
 * without its transcript, the newest messages, and the runs it holds at their
 * positions, among them every newest run.
 */
function expectViewOf(
  follower: HostThreadLogFollower,
  record: ChatRecord,
  window: { messages?: number; runs?: number; messagesFrom?: number; runsFrom?: number } = {}
): void {
  const view = follower.view()
  expect(view, 'the follower has a view').not.toBeNull()
  const { messages, runs, ...shell } = clone(record)
  expect(view!.revision).toBe(revisionOf(record))
  expect(view!.shell).toEqual(shell)
  expect(view!.messageCount).toBe(messages.length)
  expect(view!.messages).toEqual(messages.slice(messages.length - view!.messages.length))
  expect(view!.runCount).toBe(runs.length)
  for (const held of view!.runs) expect(held.run, `run at ${held.index}`).toEqual(runs[held.index])
  if (window.messages !== undefined) {
    expect(view!.messages.length).toBe(Math.min(window.messages, messages.length))
  }
  if (window.runs !== undefined) {
    const newest = runs.length - Math.min(window.runs, runs.length)
    for (let index = newest; index < runs.length; index += 1) {
      expect(
        view!.runs.some((held) => held.index === index),
        `newest run ${index} is held`
      ).toBe(true)
    }
  }
  if (window.messagesFrom !== undefined) {
    expect(view!.messageCount - view!.messages.length, 'where the message window begins').toBe(
      window.messagesFrom
    )
  }
  if (window.runsFrom !== undefined) {
    for (let index = window.runsFrom; index < runs.length; index += 1) {
      expect(
        view!.runs.some((held) => held.index === index),
        `run ${index}, in the window, is held`
      ).toBe(true)
    }
  }
}

/**
 * Where the follower's windows begin, by its rule, batch by batch from a
 * seed: rows put in where a window begins are in it, rows put in or taken
 * out wholly before it move it, and a splice across its start makes the rows
 * put in its oldest. A removal inside a window leaves it short until new rows
 * fill it: the follower never had the rows before it.
 */
class Windows {
  messagesFrom: number
  runsFrom: number
  private messageCount: number
  private runCount: number

  constructor(
    record: ChatRecord,
    private readonly windowMessages: number,
    private readonly windowRuns: number
  ) {
    this.messageCount = record.messages.length
    this.runCount = record.runs.length
    this.messagesFrom = Math.max(0, this.messageCount - windowMessages)
    this.runsFrom = Math.max(0, this.runCount - windowRuns)
  }

  apply(batch: ChatRecordMutationBatch): void {
    for (const operation of batch.operations) {
      if (operation.type === 'messages_splice') {
        const { index, deleteCount, messages } = operation
        if (index < this.messagesFrom) {
          if (index + deleteCount <= this.messagesFrom) {
            this.messagesFrom += messages.length - deleteCount
          } else this.messagesFrom = index
        }
        this.messageCount += messages.length - deleteCount
      } else if (operation.type === 'runs_splice') {
        const { index, deleteCount, runs } = operation
        if (index < this.runsFrom) {
          if (index + deleteCount <= this.runsFrom) this.runsFrom += runs.length - deleteCount
          else this.runsFrom = index
        }
        this.runCount += runs.length - deleteCount
      }
    }
    this.messagesFrom = Math.max(this.messagesFrom, this.messageCount - this.windowMessages)
    this.runsFrom = Math.max(this.runsFrom, this.runCount - this.windowRuns)
  }
}

/**
 * A seeded generator (mulberry32). The low digits of a power-of-two linear
 * congruential generator repeat with a short period: drawn one other draw
 * apart, `% 10` gave only even numbers, and whole kinds of change went untried.
 */
function randomOf(seed: number): (bound: number) => number {
  let state = seed >>> 0
  return (bound) => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) % bound
  }
}

/** Poll until the follower says it has caught up. */
async function catchUp(follower: HostThreadLogFollower): Promise<number> {
  let polls = 0
  for (;;) {
    polls += 1
    const result = await follower.poll()
    if (result.status !== 'following' || result.caughtUp) return polls
    if (polls > 1000) throw new Error('the follower never caught up')
  }
}

describe('following a thread log', () => {
  let directory: string
  const followers: HostThreadLogFollower[] = []

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  })

  afterEach(() => {
    for (const follower of followers.splice(0)) follower.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    removeTemporaryDirectory(directory)
  })

  const follow = (
    options: Partial<HostThreadLogFollowerOptions> = {},
    seedPort: HostThreadLogSeedPort = seedPortOf(directory)
  ): HostThreadLogFollower => {
    const follower = new HostThreadLogFollower({
      chatId: CHAT,
      directory,
      seedPort,
      ...options
    })
    followers.push(follower)
    return follower
  }

  describe('the view', () => {
    it('is seeded once, then takes every kind of change the app appends', async () => {
      const app = new App(directory)
      const seedPort = seedPortOf(directory)
      const follower = follow({}, seedPort)
      expect(await follower.poll()).toEqual({
        status: 'following',
        revision: 1,
        caughtUp: true,
        applied: 0,
        stoppedAt: null
      })
      expectViewOf(follower, app.record)

      const operations = new Set<string>()
      const steps: Array<() => ChatRecordMutationBatch> = [
        () => app.change((next) => next.messages.push(message('m1', 'user', 'hello'))),
        () =>
          app.change((next) => {
            next.runs.push(run('r1'))
            next.messages.push(message('m2', 'assistant', '', { runId: 'r1' }))
          }),
        () =>
          app.change((next) => {
            next.messages[1].content += 'streamed text, café € \u{1f600}'
          }),
        () =>
          app.change((next) => {
            next.runs[0].status = 'completed'
            next.runs[0].endedAt = AT
          }),
        () => app.change((next) => (next.title = 'Renamed')),
        () =>
          app.change((next) => {
            next.messages[1].toolActivities = [
              { id: 'tool-1', toolName: 'read_file', status: 'success' } as never
            ]
          }),
        () =>
          app.change((next) => {
            next.messages[1].toolActivities![0] = {
              id: 'tool-1',
              toolName: 'read_file',
              status: 'error'
            } as never
          }),
        () =>
          app.change((next) => {
            next.messages[0] = message('m1', 'user', 'hello, edited', { metadata: { kind: 'x' } })
          }),
        () =>
          app.operations([
            {
              type: 'message_put',
              messageId: 'm2',
              message: message('m2', 'assistant', 'replaced whole', { runId: 'r1' })
            }
          ]),
        () => app.change((next) => next.messages.splice(0, 1)),
        () => app.change((next) => next.messages.unshift(message('m0', 'system', 'earlier'))),
        () =>
          app.operations([
            {
              type: 'record_patch',
              set: { ensemble: { participants: [{ id: 'seat-1' }] } },
              clear: []
            }
          ]),
        () =>
          app.operations([
            { type: 'ensemble_patch', set: { roundStatus: 'running' }, clear: [] },
            {
              type: 'ensemble_participant_patch',
              participantId: 'seat-1',
              set: { role: 'Reviewer' },
              clear: []
            }
          ]),
        () => app.change((next) => next.runs.splice(0, 1))
      ]
      for (const step of steps) {
        const batch = step()
        for (const operation of batch.operations) operations.add(operation.type)
        expect(await follower.poll()).toEqual({
          status: 'following',
          revision: batch.revision,
          caughtUp: true,
          applied: 1,
          stoppedAt: null
        })
        expectViewOf(follower, app.record)
      }

      // Every operation the log knows was applied, by the shared code.
      expect([...operations].sort()).toEqual([
        'ensemble_participant_patch',
        'ensemble_patch',
        'message_content_append',
        'message_patch',
        'message_put',
        'messages_splice',
        'record_patch',
        'run_put',
        'runs_splice',
        'tool_activities_presence',
        'tool_activities_splice',
        'tool_activity_put'
      ])
      expect(seedPort.requests).toEqual([{ chatId: CHAT, reason: 'cold' }])
      expect(follower.stats()).toMatchObject({
        seeds: noSeedsBut({ cold: 1 }),
        batchesApplied: steps.length,
        olderMessageOperations: 0,
        olderRunOperations: 0
      })
    })

    it('holds the newest messages and runs, and every older run a held message names', async () => {
      const runs = Array.from({ length: 6 }, (_unused, index) => run(`r${index}`))
      const messages = Array.from({ length: 10 }, (_unused, index) =>
        message(`m${index}`, 'assistant', `text ${index}`)
      )
      messages[9].runId = 'r0'
      const app = new App(directory, {}, thread({ runs, messages }))
      const follower = follow({ windowMessages: 3, windowRuns: 2 })
      await follower.poll()
      expectViewOf(follower, app.record, { messages: 3, runs: 2 })
      expect(follower.view()!.runs.map((held) => held.index)).toEqual([0, 4, 5])

      app.change((next) => next.messages.push(message('m10', 'user', 'more')))
      await follower.poll()
      expectViewOf(follower, app.record, { messages: 3, runs: 2 })
      expect(follower.view()!.runs.map((held) => held.index)).toEqual([0, 4, 5])

      // The message naming r0 leaves the window, and r0 goes with it.
      app.change((next) => next.messages.push(message('m11', 'user', 'more')))
      app.change((next) => next.messages.push(message('m12', 'user', 'more')))
      await follower.poll()
      expectViewOf(follower, app.record, { messages: 3, runs: 2 })
      expect(follower.view()!.runs.map((held) => held.index)).toEqual([4, 5])

      app.change((next) => next.runs.push(run('r6')))
      await follower.poll()
      expectViewOf(follower, app.record, { messages: 3, runs: 2 })
      expect(follower.view()!.runs.map((held) => held.index)).toEqual([5, 6])

      // A new message names a run the view let go of: it cannot be ruled out, so it is reported.
      app.change((next) => next.messages.push(message('m13', 'assistant', 'late', { runId: 'r1' })))
      await follower.poll()
      expectViewOf(follower, app.record, { messages: 3, runs: 2 })
      expect(follower.view()!.unresolvedRunIds).toEqual(['r1'])

      // One that names a run the record does not have is known to be missing once seeded.
      follower.requestSeed()
      await follower.poll()
      expectViewOf(follower, app.record, { messages: 3, runs: 2 })
      expect(follower.view()!.runs.map((held) => held.index)).toEqual([1, 5, 6])
      expect(follower.view()!.unresolvedRunIds).toEqual([])
      app.change((next) => next.messages.push(message('m14', 'assistant', 'x', { runId: 'gone' })))
      follower.requestSeed()
      await follower.poll()
      expect(follower.view()!.unresolvedRunIds).toEqual([])
      expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1, requested: 2 }))
    })

    it('notes changes to rows it does not hold instead of reseeding, and stays a suffix', async () => {
      const messages = Array.from({ length: 8 }, (_unused, index) =>
        message(`m${index}`, 'user', `text ${index}`)
      )
      const app = new App(
        directory,
        {},
        thread({ messages, runs: [run('r0'), run('r1'), run('r2')] })
      )
      const follower = follow({ windowMessages: 3, windowRuns: 1 })
      await follower.poll()

      // An older message's text, and an older run.
      app.change((next) => (next.messages[1].content += ' changed'))
      app.change((next) => (next.runs[0].status = 'completed'))
      await follower.poll()
      expectViewOf(follower, app.record, { messages: 3, runs: 1 })
      expect(follower.stats()).toMatchObject({ olderMessageOperations: 1, olderRunOperations: 1 })

      // Messages taken out and put in wholly before the window.
      app.change((next) => next.messages.splice(0, 2, message('n0', 'user', 'new first')))
      await follower.poll()
      expectViewOf(follower, app.record, { messages: 3 })

      // A cut across the window's start leaves the rows put in as its oldest.
      app.change((next) =>
        next.messages.splice(5, 1, message('p0', 'user', 'across'), message('p1', 'user', 'too'))
      )
      await follower.poll()
      expectViewOf(follower, app.record)
      const view = follower.view()!
      expect(view.messages.map((each) => each.id)).toEqual(['p0', 'p1', 'm7'])
      // And a cut that takes the window's rows away leaves a shorter window, still a suffix.
      app.change((next) => next.messages.splice(next.messages.length - 3, 3))
      await follower.poll()
      expectViewOf(follower, app.record)
      expect(follower.view()!.messages).toEqual([])
      app.change((next) => next.messages.push(message('q0', 'user', 'after')))
      await follower.poll()
      expectViewOf(follower, app.record)
      expect(follower.view()!.messages.map((each) => each.id)).toEqual(['q0'])
      expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1 }))
    })

    it('holds runs put in where its newest runs begin, as it holds messages put in where its window begins', async () => {
      const app = new App(directory)
      const follower = follow({ windowRuns: 2 })
      await follower.poll()
      app.change((next) => next.runs.push(run('r0')))
      await follower.poll()
      expectViewOf(follower, app.record, { runs: 2 })
      app.change((next) => next.runs.unshift(run('r-first')))
      await follower.poll()
      expectViewOf(follower, app.record, { runs: 2 })
      expect(follower.view()!.runs.map((held) => held.run.runId)).toEqual(['r-first', 'r0'])
      // With the window full, the newest two stay.
      app.change((next) => next.runs.unshift(run('r-older')))
      await follower.poll()
      expect(follower.view()!.runs.map((held) => held.run.runId)).toEqual(['r-first', 'r0'])
      expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1 }))
    })

    it('equals the record the app wrote at every revision of a random history', async () => {
      // Seeded, so a failure names its history. 400 changes over 3 seeds.
      for (const seed of [1, 7, 42]) {
        const local = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
        try {
          await randomHistory(local, seed, 400)
        } finally {
          removeTemporaryDirectory(local)
        }
      }
    }, 60_000)

    async function randomHistory(local: string, seed: number, changes: number): Promise<void> {
      const random = randomOf(seed)
      const app = new App(
        local,
        {},
        thread({ ensemble: { participants: [{ id: 'seat-1' }] } as never })
      )
      const follower = new HostThreadLogFollower({
        chatId: CHAT,
        directory: local,
        seedPort: seedPortOf(local),
        windowMessages: 4,
        windowRuns: 3
      })
      try {
        await follower.poll()
        const windows = new Windows(app.record, 4, 3)
        let made = 0
        for (let step = 0; step < changes; step += 1) {
          const choice = random(10)
          const length = app.record.messages.length
          if (choice === 0 && app.record.runs.length > 0) {
            app.operations([
              {
                type: 'ensemble_participant_patch',
                participantId: 'seat-1',
                set: { order: step },
                clear: []
              }
            ])
          } else if (choice === 1) {
            app.change((next) => next.runs.push(run(`run-${made++}`)))
          } else if (choice === 2 && app.record.runs.length > 0) {
            const at = random(app.record.runs.length)
            app.change((next) => (next.runs[at].status = `s${step}`))
          } else if (choice === 3 && app.record.runs.length > 2) {
            app.change((next) => next.runs.splice(random(next.runs.length), 1))
          } else if (choice === 4 && length > 0) {
            app.change((next) => next.messages.splice(random(length), 1 + random(2)))
          } else if (choice === 5) {
            const runs = app.record.runs
            const named =
              runs.length > 0 && random(2) === 0 ? runs[random(runs.length)].runId : undefined
            app.change((next) =>
              next.messages.splice(
                random(length + 1),
                0,
                message(`msg-${made++}`, 'assistant', `x${step}`, named ? { runId: named } : {})
              )
            )
          } else if (choice <= 7 && length > 0) {
            const at = random(length)
            app.change((next) => (next.messages[at].content += ` ${step}`))
          } else if (choice === 8 && length > 0) {
            const at = random(length)
            app.change((next) => (next.messages[at].role = random(2) === 0 ? 'tool' : 'user'))
          } else {
            app.change((next) => next.messages.push(message(`msg-${made++}`, 'user', `${step}`)))
          }
          windows.apply(app.lastBatch!)
          if (random(3) === 0) continue
          await catchUp(follower)
          expectViewOf(follower, app.record, {
            messagesFrom: windows.messagesFrom,
            runsFrom: windows.runsFrom
          })
        }
        await catchUp(follower)
        expectViewOf(follower, app.record, {
          messagesFrom: windows.messagesFrom,
          runsFrom: windows.runsFrom
        })
        expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1 }))
        expect(follower.stats().batchesApplied).toBe(changes)
      } finally {
        follower.close()
      }
    }

    it('tells its observer of each seed, batch and drop, in order', async () => {
      const app = new App(directory, {}, thread({ messages: [message('m0', 'user', 'a')] }))
      const events: string[] = []
      const appliedBatches: HostThreadLogAppliedBatch[] = []
      const trimmedIds: string[][] = []
      const follower = follow({
        windowMessages: 2,
        observer: {
          seeded: (record) => events.push(`seeded ${revisionOf(record as never)}`),
          applied: (applied, trimmed: readonly HostThreadLogMessage[]) => {
            events.push(`applied ${applied.batch.revision}`)
            appliedBatches.push(applied)
            trimmedIds.push(trimmed.map((each) => each.id))
          },
          dropped: (reason) => events.push(`dropped ${reason}`)
        }
      })
      await follower.poll()
      app.change((next) => next.messages.push(message('m1', 'assistant', 'b')))
      app.change((next) => {
        next.messages.push(message('m2', 'user', 'c'))
        next.messages[1].content += '!'
      })
      app.change((next) => next.messages.splice(1, 1))
      await follower.poll()
      app.journal.delete(CHAT)
      expect(await follower.poll()).toEqual({ status: 'absent' })

      expect(events).toEqual(['seeded 1', 'applied 2', 'applied 3', 'applied 4', 'dropped absent'])
      expect(appliedBatches.map((each) => each.effects)).toEqual([
        {
          messagesChanged: ['m1'],
          messagesAdded: ['m1'],
          messagesRemoved: [],
          messagesMoved: false,
          olderMessageOperations: [],
          runsChanged: [],
          olderRunOperations: [],
          shellChanged: true
        },
        {
          messagesChanged: ['m1', 'm2'],
          messagesAdded: ['m2'],
          messagesRemoved: [],
          messagesMoved: false,
          olderMessageOperations: [],
          runsChanged: [],
          olderRunOperations: [],
          shellChanged: true
        },
        {
          messagesChanged: [],
          messagesAdded: [],
          messagesRemoved: ['m1'],
          messagesMoved: true,
          olderMessageOperations: [],
          runsChanged: [],
          olderRunOperations: [],
          shellChanged: true
        }
      ])
      expect(trimmedIds).toEqual([[], ['m0'], []])
      expect(appliedBatches[0].bytes).toBe(
        Buffer.byteLength(JSON.stringify(appliedBatches[0].batch)) + 1
      )
    })

    it('hands out views that later batches never change', async () => {
      const app = new App(directory, {}, thread({ messages: [message('m0', 'user', 'a')] }))
      const follower = follow()
      await follower.poll()
      const before = follower.view()!
      const frozen = clone(before)
      app.change((next) => {
        next.messages[0].content += ' more'
        next.title = 'changed'
        next.messages.push(message('m1', 'user', 'b'))
      })
      await follower.poll()
      expect(clone(before)).toEqual(frozen)
      expectViewOf(follower, app.record)
    })
  })

  describe('the batches it keeps', () => {
    it('answers what was applied since a revision while every batch since is kept', async () => {
      const app = new App(directory)
      const follower = follow({ maxRetainedBatches: 3 })
      await follower.poll()
      expect(follower.appliedSince(1)).toEqual([])
      const written = [1, 2, 3, 4, 5].map((index) =>
        app.change((next) => next.messages.push(message(`m${index}`, 'user', `${index}`)))
      )
      await follower.poll()
      expect(follower.headRevision).toBe(6)
      expect(follower.appliedSince(6)).toEqual([])
      expect(follower.appliedSince(5)!.map((each) => each.batch)).toEqual(clone(written.slice(4)))
      expect(follower.appliedSince(3)!.map((each) => each.batch)).toEqual(clone(written.slice(2)))
      // Older ones are no longer kept, and a revision past the head was never seen.
      expect(follower.appliedSince(2)).toBeNull()
      expect(follower.appliedSince(1)).toBeNull()
      expect(follower.appliedSince(7)).toBeNull()
    })

    it('keeps no batch from before a seed', async () => {
      const app = new App(directory)
      const follower = follow()
      await follower.poll()
      app.change((next) => next.messages.push(message('m1', 'user', 'a')))
      await follower.poll()
      expect(follower.appliedSince(1)).toHaveLength(1)
      follower.requestSeed()
      await follower.poll()
      expect(follower.appliedSince(1)).toBeNull()
      expect(follower.appliedSince(2)).toEqual([])
    })
  })

  describe('rotation and compaction', () => {
    /** Each line here is about 300 bytes: the trigger is reached on the fourth. */
    const TRIGGER = 1_000
    const grow = (app: App, index: number): ChatRecordMutationBatch =>
      app.change((next) =>
        next.messages.push(message(`m${index}`, 'assistant', `${index} `.padEnd(120, '.')))
      )
    const exists = (name: string): boolean => fs.existsSync(path.join(directory, name))
    const untilCompactionWaits = (app: App, write: () => void): void => {
      for (let writes = 0; app.compactor.pending === 0; writes += 1) {
        if (writes > 100) throw new Error('no compaction was started')
        write()
      }
    }

    it('reads a segment to its end after the app seals it, then the next one', async () => {
      const app = new App(directory, { maxJournalBytes: TRIGGER })
      const follower = follow()
      await follower.poll()
      let index = 0
      while (!exists(SEALED)) {
        if (index > 100) throw new Error('the app never sealed its segment')
        grow(app, index++)
        await follower.poll()
        expectViewOf(follower, app.record)
      }
      // Sealed by the append just made; the follower read that line from the moved file.
      grow(app, index++)
      grow(app, index++)
      expect(await follower.poll()).toMatchObject({ status: 'following', caughtUp: true })
      expectViewOf(follower, app.record)
      expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1 }))
    })

    it('lets a checkpoint that folds what it has read pass without a reseed', async () => {
      const app = new App(directory, { maxJournalBytes: TRIGGER })
      const follower = follow()
      await follower.poll()
      for (let index = 0; index < 30; index += 1) {
        grow(app, index)
        if (app.compactor.pending > 0) {
          await follower.poll()
          await app.compact()
        }
        await follower.poll()
        expectViewOf(follower, app.record)
      }
      expect(app.journal.stats().compactionsAdopted).toBeGreaterThanOrEqual(3)
      expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1 }))
      expect(follower.memory().openFiles).toBeLessThanOrEqual(2)
    })

    it('holds a sealed segment through its unlink and reads it to its end', async () => {
      const app = new App(directory, { maxJournalBytes: TRIGGER })
      const follower = follow()
      await follower.poll()
      let index = 0
      // The follower holds the active segment; then, before it reads again,
      // the app writes more, seals it, folds it, unlinks it and writes on.
      grow(app, index++)
      await follower.poll()
      untilCompactionWaits(app, () => grow(app, index++))
      grow(app, index++)
      await app.compact()
      expect(exists(SEALED)).toBe(false)
      grow(app, index++)
      expect(await follower.poll()).toMatchObject({ status: 'following', caughtUp: true })
      expectViewOf(follower, app.record)
      expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1 }))
    })

    it('reseeds when a checkpoint has passed it and the lines it needs are gone', async () => {
      const app = new App(directory, { maxJournalBytes: TRIGGER })
      const follower = follow()
      await follower.poll()
      let index = 0
      grow(app, index++)
      await follower.poll()
      // Two whole segments come and go while the follower does not read.
      for (let cycle = 0; cycle < 2; cycle += 1) {
        untilCompactionWaits(app, () => grow(app, index++))
        await app.compact()
      }
      grow(app, index++)
      expect(await follower.poll()).toMatchObject({ status: 'following', caughtUp: true })
      expectViewOf(follower, app.record)
      expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1, 'checkpoint-passed': 1 }))
    })

    it('reseeds when the app re-anchors the thread, even at the same revision', async () => {
      const app = new App(directory, {}, thread({ messages: [message('m0', 'user', 'a')] }))
      const follower = follow()
      await follower.poll()
      app.change((next) => next.messages.push(message('m1', 'user', 'b')))
      await follower.poll()
      // Another lineage at the revision the follower holds: same number, other content.
      const other = thread({
        persistenceRevision: revisionOf(app.record),
        messages: [message('x0', 'user', 'other')]
      })
      app.journal.replaceAuthoritativeCheckpoint(CHAT, other)
      app.record = other
      app.change((next) => next.messages.push(message('x1', 'user', 'other too')))
      expect(await follower.poll()).toMatchObject({ status: 'following', caughtUp: true })
      expectViewOf(follower, app.record)
      expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1, lineage: 1 }))
    })

    for (const at of ['lstatSync', 'openSync'] as const) {
      it(`sees a re-anchor made as it ${at === 'lstatSync' ? 'looks for' : 'opens'} the next file`, async () => {
        const app = new App(directory)
        app.change((next) => next.messages.push(message('m1', 'user', 'a')))
        app.change((next) => next.messages.push(message('m2', 'user', 'b')))
        expect(app.journal.checkpoint(CHAT, 'manual', app.record)).toBe(true)
        let armed = false
        let reanchored = false
        // At the follower's revision, below the app's head, so that the line the
        // app writes next would continue the follower's view.
        const reanchor = (target: string): void => {
          if (!armed || reanchored || target !== path.join(directory, ACTIVE)) return
          reanchored = true
          const other = thread({
            persistenceRevision: revisionOf(app.record) - 1,
            title: 'another lineage',
            messages: [message('x0', 'user', 'other')]
          })
          app.journal.replaceAuthoritativeCheckpoint(CHAT, other)
          app.record = other
          app.change((next) => next.messages.push(message('x1', 'user', 'other too')))
        }
        const seam: HostThreadLogFollowerOptions['fs'] = {
          constants: fs.constants,
          openSync: (target, flags) => {
            if (at === 'openSync') reanchor(target)
            return fs.openSync(target, flags)
          },
          fstatSync: (fd, options) => fs.fstatSync(fd, options),
          lstatSync: (target, options) => {
            if (at === 'lstatSync') reanchor(target)
            return fs.lstatSync(target, options)
          },
          readSync: (fd, buffer, offset, length, position) =>
            fs.readSync(fd, buffer, offset, length, position),
          closeSync: (fd) => fs.closeSync(fd)
        }
        const follower = follow({ fs: seam })
        expect(await follower.poll()).toMatchObject({ status: 'following', revision: 3 })
        app.change((next) => next.messages.push(message('m3', 'user', 'c')))
        armed = true
        expect(await follower.poll()).toMatchObject({ status: 'following', caughtUp: true })
        expect(reanchored).toBe(true)
        expectViewOf(follower, app.record)
        expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1, lineage: 1 }))
      })
    }

    it('reseeds when a file it never held repeats revisions it has: a re-anchor below it, folded unseen', async () => {
      const app = new App(directory, { maxJournalBytes: TRIGGER })
      const follower = follow()
      await follower.poll()
      let index = 0
      grow(app, index++)
      grow(app, index++)
      await follower.poll()
      expect(follower.headRevision).toBe(3)
      // Another lineage one revision below the follower; it writes on until a
      // compaction folds it, so that its checkpoint is not the re-anchor's when
      // the follower next looks. The folded segment waits on its sync.
      const other = thread({
        persistenceRevision: 2,
        title: 'another lineage',
        messages: [message('x0', 'user', 'other')]
      })
      app.journal.replaceAuthoritativeCheckpoint(CHAT, other)
      app.record = other
      app.compactor.holdSyncs = true
      untilCompactionWaits(app, () => grow(app, index++))
      app.compactor.fold()
      for (let turn = 0; turn < 100 && app.compactor.pendingSyncs === 0; turn += 1) await settle()
      expect(app.compactor.pendingSyncs).toBe(1)
      grow(app, index++)
      expect(await follower.poll()).toMatchObject({ status: 'following', caughtUp: true })
      expectViewOf(follower, app.record)
      expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1, lineage: 1 }))
      app.compactor.releaseSync()
    })
  })

  describe('damage', () => {
    const active = (): string => path.join(directory, ACTIVE)
    const lineOf = (batch: unknown): string => `${JSON.stringify(batch)}\n`

    it('reads on, losing nothing, when the restarted app cuts a crash fragment', async () => {
      const crashed = new App(directory, {}, thread({ messages: [message('m0', 'user', 'a')] }))
      crashed.change((next) => next.messages.push(message('m1', 'user', 'b')))
      const follower = follow()
      await follower.poll()
      // The app dies part way through its next line.
      const lost = deriveChatRecordMutation(crashed.record, {
        ...clone(crashed.record),
        persistenceRevision: revisionOf(crashed.record) + 1,
        title: 'lost'
      })
      fs.appendFileSync(active(), lineOf(lost).slice(0, 40))
      expect(await follower.poll()).toMatchObject({ status: 'following', revision: 2 })

      // The restarted app cuts the fragment before its next append.
      const restarted = new App(directory, {}, crashed.record)
      restarted.records.clear()
      restarted.change((next) => next.messages.push(message('m2', 'user', 'c')))
      restarted.change((next) => (next.title = 'after the crash'))
      expect(restarted.journal.stats().tornTailsTruncated).toBe(1)
      expect(await follower.poll()).toMatchObject({ status: 'following', caughtUp: true })
      expectViewOf(follower, restarted.record)
      expect(appLoad(directory)).toEqual(restarted.record)
      expect(follower.stats()).toMatchObject({
        seeds: noSeedsBut({ cold: 1 }),
        stops: { corrupt: 0, gap: 0, unapplicable: 0 }
      })
    })

    it('stops where the app stops when the next line was written onto a fragment', async () => {
      const app = new App(directory, { repairTornTailBeforeAppend: false })
      app.change((next) => next.messages.push(message('m1', 'user', 'a')))
      const follower = follow()
      await follower.poll()
      fs.appendFileSync(active(), '{"torn')
      app.change((next) => next.messages.push(message('m2', 'user', 'glued on')))
      app.change((next) => next.messages.push(message('m3', 'user', 'unreadable')))
      expect(await follower.poll()).toEqual({
        status: 'following',
        revision: 2,
        caughtUp: true,
        applied: 0,
        stoppedAt: 'corrupt'
      })
      // The app's own load stops at the same line.
      expect(revisionOf(appLoad(directory)!)).toBe(2)
      expectViewOf(follower, appLoad(directory)!)
      expect(follower.stats()).toMatchObject({
        seeds: noSeedsBut({ cold: 1 }),
        stops: { corrupt: 1, gap: 0, unapplicable: 0 }
      })
      // Asked again, it neither reads the damage again nor reseeds.
      expect(await follower.poll()).toMatchObject({ revision: 2, stoppedAt: 'corrupt' })
      expect(follower.stats().stops).toEqual({ corrupt: 1, gap: 0, unapplicable: 0 })
    })

    it('stops at a segment that does not chain, and follows the app past it once it is set aside', async () => {
      const app = new App(directory)
      app.change((next) => next.messages.push(message('m1', 'user', 'a')))
      // What a power cut can leave: the chain's end lost, a later line kept in a segment of its own.
      fs.renameSync(active(), path.join(directory, SEALED))
      fs.writeFileSync(
        active(),
        lineOf({
          format: THREAD_LOG_BATCH_FORMAT,
          version: THREAD_LOG_BATCH_VERSION,
          chatId: CHAT,
          baseRevision: 5,
          revision: 6,
          savedAt: AT,
          operations: [{ type: 'record_patch', set: { title: 'from a lost lineage' }, clear: [] }]
        })
      )
      const follower = follow()
      expect(await follower.poll()).toEqual({
        status: 'following',
        revision: 2,
        caughtUp: true,
        applied: 0,
        stoppedAt: 'gap'
      })
      // The app's own load takes the same chain.
      expect(revisionOf(appLoad(directory)!)).toBe(2)
      expectViewOf(follower, appLoad(directory)!)
      expect(await follower.poll()).toMatchObject({ revision: 2, stoppedAt: 'gap' })

      // The app starts, sets the segment aside, and writes on.
      const restarted = new App(directory, {}, appLoad(directory)!)
      restarted.change((next) => next.messages.push(message('m2', 'user', 'b')))
      expect(fs.existsSync(path.join(directory, `${CHAT}.set-aside.mutations.jsonl`))).toBe(true)
      expect(await follower.poll()).toEqual({
        status: 'following',
        revision: 3,
        caughtUp: true,
        applied: 1,
        stoppedAt: null
      })
      expectViewOf(follower, restarted.record)
      expect(appLoad(directory)).toEqual(restarted.record)
      expect(follower.stats()).toMatchObject({
        seeds: noSeedsBut({ cold: 1 }),
        stops: { corrupt: 0, gap: 1, unapplicable: 0 }
      })
    })

    it('reseeds for a line too long to read on the event loop, and reads on past it', async () => {
      const app = new App(directory)
      const follower = follow({ maxLineBytes: 2_000 })
      await follower.poll()
      app.change((next) => next.messages.push(message('m1', 'user', 'short')))
      app.change((next) => next.messages.push(message('m2', 'user', 'long '.repeat(1_000))))
      app.change((next) => next.messages.push(message('m3', 'user', 'short again')))
      expect(await follower.poll()).toMatchObject({ status: 'following', caughtUp: true })
      expectViewOf(follower, app.record)
      app.change((next) => next.messages.push(message('m4', 'user', 'and on')))
      expect(await follower.poll()).toMatchObject({ status: 'following', caughtUp: true })
      expectViewOf(follower, app.record)
      expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1, oversized: 1 }))
    })

    it('reseeds when a segment it read is cut short or changed in place', async () => {
      const app = new App(directory)
      app.change((next) => next.messages.push(message('m1', 'user', 'a')))
      app.change((next) => next.messages.push(message('m2', 'user', 'b')))
      const follower = follow()
      await follower.poll()
      const bytes = fs.readFileSync(active())
      const firstLine = bytes.indexOf(0x0a) + 1
      fs.truncateSync(active(), firstLine)
      expect(await follower.poll()).toMatchObject({ status: 'following', revision: 2 })
      expectViewOf(follower, appLoad(directory)!)
      expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1, rewritten: 1 }))

      // The same bytes back: it reads on from where it was.
      fs.writeFileSync(active(), bytes)
      expect(await follower.poll()).toMatchObject({ status: 'following', revision: 3 })

      // A digit it has read changed in place, so the line is still a batch, then a line after it.
      let at = bytes.length - 2
      while (bytes[at] < 0x30 || bytes[at] > 0x38) at -= 1
      expect(bytes.length - at).toBeLessThan(64)
      const descriptor = fs.openSync(active(), 'r+')
      fs.writeSync(descriptor, Buffer.from([bytes[at] + 1]), 0, 1, at)
      fs.closeSync(descriptor)
      app.change((next) => next.messages.push(message('m3', 'user', 'c')))
      expect(await follower.poll()).toMatchObject({
        status: 'following',
        revision: 4,
        caughtUp: true
      })
      const load = appLoad(directory)!
      expect(load).not.toEqual(app.record)
      expectViewOf(follower, load)
      expect(follower.stats().seeds).toEqual(noSeedsBut({ cold: 1, rewritten: 2 }))
    })

    it('reseeds once for a batch the apply code refuses, then holds before it', async () => {
      const app = new App(directory, {}, thread({ messages: [message('m0', 'user', 'a')] }))
      app.change((next) => next.messages.push(message('m1', 'user', 'b')))
      // A seed port that falls back to the last record it could load.
      const requests: HostThreadLogSeedRequest[] = []
      const seedPort: HostThreadLogSeedPort = {
        async seed(request) {
          requests.push(request)
          try {
            return appLoad(directory) as unknown as HostThreadLogRecord
          } catch {
            return clone(app.records.get(2)) as unknown as HostThreadLogRecord
          }
        }
      }
      const follower = follow({}, seedPort)
      await follower.poll()
      // A put whose row names another id: the shared apply code refuses it,
      // and so the app's own load cannot get past it either.
      fs.appendFileSync(
        active(),
        lineOf({
          format: THREAD_LOG_BATCH_FORMAT,
          version: THREAD_LOG_BATCH_VERSION,
          chatId: CHAT,
          baseRevision: 2,
          revision: 3,
          savedAt: AT,
          operations: [
            { type: 'message_put', messageId: 'm0', message: message('other', 'user', 'x') }
          ]
        })
      )
      expect(() => appLoad(directory)).toThrow()
      const held = {
        status: 'following',
        revision: 2,
        caughtUp: true,
        applied: 0,
        stoppedAt: 'unapplicable'
      }
      expect(await follower.poll()).toEqual(held)
      expect(await follower.poll()).toEqual(held)
      expectViewOf(follower, app.record)
      expect(requests.map((each) => each.reason)).toEqual(['cold', 'unapplicable'])
      expect(follower.stats()).toMatchObject({
        seeds: noSeedsBut({ cold: 1, unapplicable: 1 }),
        stops: { corrupt: 0, gap: 0, unapplicable: 1 }
      })

      // The app writes its record as a checkpoint, which ends the segment, and goes on.
      expect(app.journal.checkpoint(CHAT, 'manual', app.record)).toBe(true)
      app.change((next) => next.messages.push(message('m2', 'user', 'c')))
      expect(await follower.poll()).toEqual({
        status: 'following',
        revision: 3,
        caughtUp: true,
        applied: 1,
        stoppedAt: null
      })
      expectViewOf(follower, app.record)
      expect(requests).toHaveLength(2)
      expect(follower.memory().openFiles).toBe(1)
    })
  })

  describe('seeds', () => {
    it('refuses a seed from behind the log, without asking again until the checkpoint changes', async () => {
      const app = new App(directory, { maxJournalBytes: 1_000 })
      for (let index = 0; index < 20 && app.compactor.pending === 0; index += 1) {
        app.change((next) =>
          next.messages.push(message(`m${index}`, 'user', `${index}`.repeat(200)))
        )
      }
      await app.compact()
      // The full copy a strict reader falls back to after a power cut.
      const fullCopy = clone(app.records.get(1)!)
      const seed = vi.fn(async () => fullCopy as unknown as HostThreadLogRecord)
      const follower = follow({}, { seed })
      expect(await follower.poll()).toEqual({
        status: 'unfollowable',
        why: 'seed-behind-checkpoint'
      })
      expect(await follower.poll()).toEqual({
        status: 'unfollowable',
        why: 'seed-behind-checkpoint'
      })
      expect(seed).toHaveBeenCalledTimes(1)
      expect(follower.view()).toBeNull()

      // A new checkpoint, and a seed that has the log: it follows.
      for (let index = 20; index < 40 && app.compactor.pending === 0; index += 1) {
        app.change((next) =>
          next.messages.push(message(`m${index}`, 'user', `${index}`.repeat(200)))
        )
      }
      await app.compact()
      seed.mockImplementation(async () => appLoad(directory) as unknown as HostThreadLogRecord)
      expect(await follower.poll()).toMatchObject({ status: 'following', caughtUp: true })
      expectViewOf(follower, app.record)
      expect(seed).toHaveBeenCalledTimes(2)
      expect(follower.stats()).toMatchObject({ seedsRefused: 1, seeds: noSeedsBut({ cold: 1 }) })
    })

    it('has nothing to follow before the thread has a checkpoint, and follows once it has', async () => {
      const seedPort = seedPortOf(directory)
      const follower = follow({}, seedPort)
      expect(await follower.poll()).toEqual({ status: 'absent' })
      expect(await follower.poll()).toEqual({ status: 'absent' })
      expect(seedPort.requests).toHaveLength(1)
      const app = new App(directory)
      app.change((next) => next.messages.push(message('m1', 'user', 'a')))
      expect(await follower.poll()).toMatchObject({ status: 'following', caughtUp: true })
      expectViewOf(follower, app.record)
      expect(seedPort.requests).toHaveLength(2)
    })

    it('drops its view and its files when the thread is deleted', async () => {
      const app = new App(directory)
      app.change((next) => next.messages.push(message('m1', 'user', 'a')))
      const follower = follow()
      await follower.poll()
      expect(follower.memory().openFiles).toBe(1)
      app.journal.delete(CHAT)
      expect(await follower.poll()).toEqual({ status: 'absent' })
      expect(follower.view()).toBeNull()
      expect(follower.memory()).toMatchObject({ openFiles: 0, viewBytes: 2, retainedBytes: 0 })
    })

    it('takes a thread whose erasure has begun as gone, as the app does', async () => {
      const app = new App(directory)
      app.change((next) => next.messages.push(message('m1', 'user', 'a')))
      const follower = follow()
      await follower.poll()
      // An erasure's first steps: the tombstone, then the active segment; the checkpoint is still there.
      fs.writeFileSync(path.join(directory, `${CHAT}.tombstone`), '')
      fs.unlinkSync(path.join(directory, ACTIVE))
      expect(appLoad(directory)).toBeNull()
      expect(await follower.poll()).toEqual({ status: 'absent' })
      expect(await follower.poll()).toEqual({ status: 'absent' })
      expect(follower.memory().openFiles).toBe(0)
    })

    it('shares one poll between concurrent callers', async () => {
      const app = new App(directory)
      app.change((next) => next.messages.push(message('m1', 'user', 'a')))
      const seedPort = seedPortOf(directory)
      const follower = follow({}, seedPort)
      const [first, second] = await Promise.all([follower.poll(), follower.poll()])
      expect(first).toBe(second)
      expect(seedPort.requests).toHaveLength(1)
    })
  })

  describe('bounds', () => {
    it('does a bounded amount of reading per poll and hands back', async () => {
      const app = new App(directory)
      const follower = follow({ maxPollBytes: 64 * 1024 })
      await follower.poll()
      for (let index = 0; index < 200; index += 1) {
        app.change((next) => next.messages.push(message(`m${index}`, 'user', 'x'.repeat(2_000))))
      }
      const total = fs.statSync(path.join(directory, ACTIVE)).size
      const longest = Math.max(
        ...fs
          .readFileSync(path.join(directory, ACTIVE), 'utf8')
          .split('\n')
          .map((line) => Buffer.byteLength(line) + 1)
      )
      let polls = 0
      let read = follower.stats().bytesRead
      for (;;) {
        polls += 1
        if (polls > 1_000) throw new Error('the follower never caught up')
        const result = await follower.poll()
        const now = follower.stats().bytesRead
        // A poll stops once past its budget: the budget, one piece the segment
        // reader reads at a time (64 KiB), and the line it is in at most.
        expect(now - read).toBeLessThanOrEqual(64 * 1024 + 64 * 1024 + longest)
        read = now
        if (result.status === 'following' && result.caughtUp) break
      }
      expect(total).toBeGreaterThan(6 * 64 * 1024)
      expect(polls).toBeGreaterThanOrEqual(Math.floor(total / (2 * 64 * 1024 + longest)))
      expectViewOf(follower, app.record, { messages: HOST_THREAD_LOG_WINDOW_MESSAGES })
    })

    it('keeps a thread to its byte bound, however large its newest messages', async () => {
      const app = new App(directory)
      const maxViewBytes = 64 * 1024
      const maxRetainedBytes = 16 * 1024
      const follower = follow({ maxViewBytes, maxRetainedBytes })
      await follower.poll()
      for (let index = 0; index < 40; index += 1) {
        app.change((next) => {
          next.messages.push(message(`m${index}`, 'assistant', 'y'.repeat(5_000 + index * 100)))
          next.runs.push(run(`r${index}`, { promptMessageId: 'z'.repeat(300) }))
        })
        await follower.poll()
        const view = follower.view()!
        const memory = follower.memory()
        const actual =
          Buffer.byteLength(JSON.stringify(view.shell)) +
          view.messages.reduce((sum, each) => sum + Buffer.byteLength(JSON.stringify(each)), 0) +
          view.runs.reduce((sum, each) => sum + Buffer.byteLength(JSON.stringify(each.run)), 0)
        expect(actual).toBeLessThanOrEqual(memory.viewBytes)
        expect(memory.viewBytes).toBeLessThanOrEqual(maxViewBytes)
        expect(memory.retainedBytes).toBeLessThanOrEqual(maxRetainedBytes)
        expectViewOf(follower, app.record)
      }
      // The window shrank to the newest messages that fit beside the record
      // without its transcript and the newest runs, which it keeps first.
      const view = follower.view()!
      const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
      let used = bytes(view.shell) + view.runs.reduce((sum, each) => sum + bytes(each.run), 0)
      let fits = 0
      for (const each of [...app.record.messages].reverse()) {
        used += bytes(each)
        if (used > maxViewBytes) break
        fits += 1
      }
      expect(view.runs).toHaveLength(40)
      expect(view.messages).toHaveLength(fits)
      expect(fits).toBeGreaterThan(3)
      expect(fits).toBeLessThan(15)
    })

    it('refuses to follow a thread whose record without its transcript is over the bound', async () => {
      new App(directory, {}, thread({ huge: 'h'.repeat(10_000) } as never))
      const follower = follow({ maxViewBytes: 4_000 })
      expect(await follower.poll()).toEqual({ status: 'unfollowable', why: 'over-budget' })
      expect(follower.memory()).toMatchObject({ viewBytes: 2, openFiles: 0 })
    })

    it('follows at most the threads it is given, dropping the least recently used', async () => {
      const ids = Array.from({ length: 20 }, (_unused, index) => `thread-${index}`)
      for (const id of ids) {
        const journal = createIncrementalChatJournal(directory, { noteDurabilityDebt: () => {} })
        journal.initialize(id, { ...thread(), appChatId: id, title: 'x'.repeat(1_000) })
        journal.append(
          deriveChatRecordMutation(
            { ...thread(), appChatId: id, title: 'x'.repeat(1_000) },
            {
              ...thread(),
              appChatId: id,
              title: 'x'.repeat(1_000),
              persistenceRevision: 2,
              messages: [message('m', 'user', 'z'.repeat(20_000))]
            }
          )
        )
      }
      const maxViewBytes = 32 * 1024
      const maxRetainedBytes = 32 * 1024
      const pool = new HostThreadLogFollowers({
        directory,
        maxThreads: 16,
        maxViewBytes,
        maxRetainedBytes,
        seedPort: {
          seed: async ({ chatId }) =>
            createIncrementalChatJournal(directory, {
              noteDurabilityDebt: () => {},
              canWrite: () => false
            }).replay(chatId).record as unknown as HostThreadLogRecord
        }
      })
      try {
        const opened: HostThreadLogFollower[] = []
        for (const id of ids) {
          const follower = pool.follow(id)
          opened.push(follower)
          await follower.poll()
          expect(pool.memory().threads).toBeLessThanOrEqual(16)
          expect(pool.memory().viewBytes).toBeLessThanOrEqual(16 * maxViewBytes)
          expect(pool.memory().retainedBytes).toBeLessThanOrEqual(16 * maxRetainedBytes)
        }
        expect(pool.memory()).toMatchObject({ threads: 16, evictions: 4, openFiles: 16 })
        // The four used least recently were dropped, with their descriptors.
        for (const follower of opened.slice(0, 4)) {
          expect(follower.memory()).toMatchObject({ openFiles: 0, viewBytes: 2 })
          await expect(follower.poll()).rejects.toThrow(/closed/)
        }
        expect(pool.peek('thread-0')).toBeUndefined()
        // Using one makes it the most recent: the next new thread drops another.
        pool.follow('thread-4')
        pool.follow('thread-0')
        expect(pool.peek('thread-4')).toBeDefined()
        expect(pool.peek('thread-5')).toBeUndefined()
      } finally {
        pool.close()
      }
      expect(pool.memory()).toMatchObject({ threads: 0, openFiles: 0 })
    })

    it('defaults to the bounds the design names', () => {
      expect(HOST_THREAD_LOG_WINDOW_MESSAGES).toBe(256)
      expect(HOST_THREAD_LOG_WINDOW_RUNS).toBe(256)
      expect(HOST_THREAD_LOG_MAX_VIEW_BYTES + HOST_THREAD_LOG_MAX_RETAINED_BYTES).toBe(
        8 * 1024 * 1024
      )
      expect(HOST_THREAD_LOG_MAX_THREADS).toBe(16)
    })
  })

  describe('what it may touch', () => {
    it('writes nothing and opens nothing for writing, through rotation, compaction and reseeds', async () => {
      const app = new App(directory, { maxJournalBytes: 1_000 })
      const writes: string[] = []
      const opens: number[] = []
      const writeBits =
        fs.constants.O_WRONLY |
        fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_APPEND |
        fs.constants.O_TRUNC
      // Every call that can change a file, on the module itself: a path that
      // went around the follower's file seam would be seen here.
      const watched = [
        'writeSync',
        'writevSync',
        'writeFileSync',
        'appendFileSync',
        'renameSync',
        'unlinkSync',
        'rmSync',
        'rmdirSync',
        'truncateSync',
        'ftruncateSync',
        'mkdirSync',
        'mkdtempSync',
        'symlinkSync',
        'linkSync',
        'copyFileSync',
        'cpSync',
        'fsyncSync',
        'fdatasyncSync',
        'utimesSync',
        'futimesSync',
        'lutimesSync',
        'chmodSync',
        'fchmodSync',
        'chownSync',
        'fchownSync',
        'createWriteStream',
        'writeFile',
        'appendFile',
        'rename',
        'unlink',
        'rm',
        'truncate',
        'ftruncate',
        'mkdir',
        'fsync',
        'write'
      ] as const
      let observing = false
      const module = fs as unknown as Record<string, (...args: unknown[]) => unknown>
      for (const name of watched) {
        const real = module[name]
        vi.spyOn(module, name).mockImplementation((...args: unknown[]) => {
          if (observing) writes.push(name)
          return real(...args)
        })
      }
      const realOpen = module.openSync
      vi.spyOn(module, 'openSync').mockImplementation((...args: unknown[]) => {
        if (observing) {
          const flags = args[1]
          if (typeof flags !== 'number' || (flags & writeBits) !== 0) {
            writes.push(`openSync ${String(flags)}`)
          }
        }
        return realOpen(...args)
      })
      for (const name of [
        'writeFile',
        'appendFile',
        'rename',
        'unlink',
        'rm',
        'truncate',
        'mkdir',
        'open'
      ] as const) {
        const real = fs.promises[name] as (...args: unknown[]) => unknown
        vi.spyOn(
          fs.promises as unknown as Record<string, (...args: unknown[]) => unknown>,
          name
        ).mockImplementation((...args: unknown[]) => {
          if (observing) writes.push(`promises.${name}`)
          return real(...args)
        })
      }
      syncBuiltinESMExports()
      // And every call through the follower's own file seam.
      const seam: HostThreadLogFollowerOptions['fs'] = {
        constants: fs.constants,
        openSync: (target, flags) => {
          opens.push(flags)
          return fs.openSync(target, flags)
        },
        fstatSync: (fd, options) => fs.fstatSync(fd, options),
        lstatSync: (target, options) => fs.lstatSync(target, options),
        readSync: (fd, buffer, offset, length, position) =>
          fs.readSync(fd, buffer, offset, length, position),
        closeSync: (fd) => fs.closeSync(fd)
      }
      const load = seedPortOf(directory)
      const follower = follow(
        { maxLineBytes: 3_000, fs: seam },
        {
          // The seed port is the caller's code, and the app's load: not watched.
          async seed(request) {
            observing = false
            try {
              return await load.seed(request)
            } finally {
              observing = true
            }
          }
        }
      )
      const poll = async (): Promise<void> => {
        observing = true
        try {
          await follower.poll()
        } finally {
          observing = false
        }
      }

      await poll()
      for (let index = 0; index < 40; index += 1) {
        app.change((next) =>
          next.messages.push(
            message(
              `m${index}`,
              'user',
              index === 20 ? 'long '.repeat(800) : `${index} `.repeat(60)
            )
          )
        )
        // Read at once after the long line, before a compaction can fold it.
        if (index % 3 === 0 || index === 20) await poll()
        if (app.compactor.pending > 0 && index % 2 === 0) await app.compact()
      }
      await poll()
      await poll()
      expectViewOf(follower, app.record)
      const seeds = follower.stats().seeds
      expect(seeds.oversized).toBe(1)
      expect(seeds['checkpoint-passed']).toBeGreaterThan(0)
      expect(app.journal.stats().compactionsAdopted).toBeGreaterThan(3)
      expect(writes).toEqual([])
      expect(opens.length).toBeGreaterThan(10)
      for (const flags of opens) expect(flags & writeBits).toBe(0)
    })

    it('starts no timer and watches nothing: it reads only when asked', async () => {
      const app = new App(directory)
      vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
      const watch = vi.spyOn(fs, 'watch')
      const watchFile = vi.spyOn(fs, 'watchFile')
      syncBuiltinESMExports()
      const follower = follow()
      await follower.poll()
      app.change((next) => next.messages.push(message('m1', 'user', 'a')))
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(60_000)
      expect(follower.headRevision).toBe(1)
      await follower.poll()
      expect(follower.headRevision).toBe(2)
      follower.close()
      expect(vi.getTimerCount()).toBe(0)
      expect(watch).not.toHaveBeenCalled()
      expect(watchFile).not.toHaveBeenCalled()
    })
  })
})

// Names used only to keep this file's helpers exhaustive.
void CHECKPOINT
