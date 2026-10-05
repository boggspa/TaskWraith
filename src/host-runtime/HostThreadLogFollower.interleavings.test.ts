/**
 * Every order in which the app's file steps can fall among the follower's own
 * file calls.
 *
 * The app's journal is played one file-system call at a time, in the order
 * the journal itself makes them; the first test checks that order, and what
 * the files then hold, against the journal. The follower runs unchanged on a
 * real temporary directory. Before each of its calls that looks at a name or
 * measures a file (lstat, open, fstat), and before and after each seed, the
 * explorer either lets it go on or runs the app's next step first. A
 * depth-first search over those choices runs every schedule of a scenario's
 * steps within the polls it names, leaving out only choices that cannot
 * change what the follower sees (a step before a call that looks at nothing
 * any step left changes is the same schedule as that step after it).
 *
 * In every schedule the view must equal the record of the lineage it follows
 * after each batch, and the app's last record at the end; a scenario names
 * the reseeds it allows. Each states how many schedules it has at least.
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { deriveChatRecordMutation } from '../main/store/ChatRecordMutation'
import { prepareCheckpoint } from '../main/store/CheckpointPreparationCore'
import {
  checkpointFileReference,
  type CheckpointPreparationJob,
  type CheckpointPreparationPort,
  type CheckpointPreparationSource,
  type PreparedCheckpoint,
  type CheckpointPreparationRequest
} from '../main/store/CheckpointPreparationProtocol'
import {
  createIncrementalChatJournal,
  INCREMENTAL_CHAT_CHECKPOINT_FORMAT,
  INCREMENTAL_CHAT_CHECKPOINT_VERSION
} from '../main/store/IncrementalChatJournal'
import type { ChatRecord } from '../main/store/types'
import {
  HOST_THREAD_LOG_SEED_REASONS,
  HostThreadLogFollower,
  type HostThreadLogFollowerOptions,
  type HostThreadLogRecord,
  type HostThreadLogSeedReason,
  type HostThreadLogView
} from './HostThreadLogFollower'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'host-log-interleavings-'

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
const NAMES = {
  checkpoint: `${CHAT}.checkpoint.json`,
  sealed: `${CHAT}.sealed.mutations.jsonl`,
  active: `${CHAT}.mutations.jsonl`,
  tombstone: `${CHAT}.tombstone`,
  setAside: `${CHAT}.set-aside.mutations.jsonl`
} as const

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const revisionOf = (record: { readonly persistenceRevision?: number }): number =>
  record.persistenceRevision ?? 0

/** A lineage's record: its title names the lineage, and every message in it. */
function thread(lineage: string, revision: number): ChatRecord {
  return {
    appChatId: CHAT,
    title: lineage,
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages: [{ id: `${lineage}-0`, role: 'user', content: `${lineage} begins`, timestamp: AT }],
    runs: []
  }
}

/** The next record of a lineage: one more message, of a steady size so lines are alike. */
function grown(record: ChatRecord): ChatRecord {
  const next = clone(record)
  const revision = revisionOf(record) + 1
  next.persistenceRevision = revision
  next.updatedAt = revision
  next.messages.push({
    id: `${record.title}-${revision}`,
    role: 'user',
    content: `${record.title} at ${revision} `.padEnd(300, '.'),
    timestamp: AT
  })
  return next
}

/** The app's own load, read-only, as the production seed must build it. */
function appLoad(directory: string): ChatRecord | null {
  return createIncrementalChatJournal(directory, {
    noteDurabilityDebt: () => {},
    canWrite: () => false
  }).replay(CHAT).record
}

/**
 * The app's files, changed one file-system call at a time in the order its
 * journal changes them when it leaves syncing to the thread barrier. Each
 * method is one step another process can see; `effects` names each.
 */
class Writer {
  /** Each lineage's records by revision: a re-anchor starts another. */
  readonly lineages: Array<Map<number, ChatRecord>> = []
  readonly effects: string[] = []
  record: ChatRecord = thread('A', 1)
  private clock = Date.parse(AT)
  private temporaries = 0
  private sealedThrough: number | null = null

  constructor(readonly directory: string) {}

  private at(name: keyof typeof NAMES): string {
    return path.join(this.directory, NAMES[name])
  }

  private savedAt(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }

  /** Written under a temporary name, then renamed: only the rename is seen. */
  private install(name: 'checkpoint' | 'tombstone', contents: string): void {
    const temporary = path.join(this.directory, `.${NAMES[name]}.${this.temporaries++}.tmp`)
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, this.at(name))
    this.effects.push(`rename temporary ${name}`)
  }

  private checkpoint(record: ChatRecord, reason: string): void {
    this.install(
      'checkpoint',
      JSON.stringify({
        format: INCREMENTAL_CHAT_CHECKPOINT_FORMAT,
        version: INCREMENTAL_CHAT_CHECKPOINT_VERSION,
        chatId: CHAT,
        revision: revisionOf(record),
        savedAt: this.savedAt(),
        reason,
        record
      })
    )
  }

  /** The first checkpoint. */
  begin(): void {
    this.lineages.push(new Map([[revisionOf(this.record), clone(this.record)]]))
    this.checkpoint(this.record, 'initial')
  }

  /** The append's open, when it makes the active segment. */
  create(): void {
    fs.closeSync(fs.openSync(this.at('active'), 'wx', 0o600))
    this.effects.push('create active')
  }

  /** The append's write: one line, to the active segment, which must be there. */
  write(): void {
    const next = grown(this.record)
    const batch = deriveChatRecordMutation(this.record, next, { savedAt: this.savedAt() })
    const fd = fs.openSync(this.at('active'), fs.constants.O_WRONLY | fs.constants.O_APPEND)
    try {
      fs.writeSync(fd, `${JSON.stringify(batch)}\n`)
    } finally {
      fs.closeSync(fd)
    }
    this.record = next
    this.lineages[this.lineages.length - 1].set(revisionOf(next), clone(next))
    this.effects.push('write active')
  }

  /** Rotation: the active segment becomes the one the worker folds. */
  seal(): void {
    fs.renameSync(this.at('active'), this.at('sealed'))
    this.sealedThrough = revisionOf(this.record)
    this.effects.push('rename active sealed')
  }

  /** The worker's checkpoint of the sealed segment, renamed over the checkpoint. */
  adopt(): void {
    const through = this.sealedThrough
    if (through === null) throw new Error('nothing is sealed')
    this.checkpoint(this.lineages[this.lineages.length - 1].get(through)!, 'idle')
  }

  unlinkSealed(): void {
    fs.unlinkSync(this.at('sealed'))
    this.sealedThrough = null
    this.effects.push('unlink sealed')
  }

  unlinkActive(): void {
    fs.unlinkSync(this.at('active'))
    this.effects.push('unlink active')
  }

  unlinkCheckpoint(): void {
    fs.unlinkSync(this.at('checkpoint'))
    this.effects.push('unlink checkpoint')
  }

  /** A checkpoint of the head, written on the calling thread (at the cap, say). */
  checkpointHead(reason: string): void {
    this.checkpoint(this.record, reason)
  }

  /** A re-anchor: another lineage's record, at the head's revision unless told otherwise. */
  reanchor(lineage: string, revision = revisionOf(this.record)): void {
    this.record = thread(lineage, revision)
    this.lineages.push(new Map([[revisionOf(this.record), clone(this.record)]]))
    this.checkpoint(this.record, 'recovery')
  }

  tombstone(): void {
    this.install('tombstone', '')
  }
}

/**
 * What a step changes and a call of the follower looks at: which file is under
 * each name, what a file holds, and whether a file still has a name.
 */
type Observable = 'active' | 'sealed' | 'checkpoint' | 'tombstone' | 'content' | 'links'
const EVERYTHING: readonly Observable[] = [
  'active',
  'sealed',
  'checkpoint',
  'tombstone',
  'content',
  'links'
]

interface Step {
  readonly name: string
  readonly changes: readonly Observable[]
  readonly run: (writer: Writer) => void
}

const step = (
  name: string,
  changes: readonly Observable[],
  run: (writer: Writer) => void
): Step => ({ name, changes, run })
const begin = step('begin', ['checkpoint'], (writer) => writer.begin())
const create = step('create', ['active'], (writer) => writer.create())
const write = step('write', ['content'], (writer) => writer.write())
const seal = step('seal', ['active', 'sealed'], (writer) => writer.seal())
// A rename over the checkpoint leaves the file it replaces with no name.
const adopt = step('adopt', ['checkpoint', 'links'], (writer) => writer.adopt())
const unlinkSealed = step('unlink sealed', ['sealed', 'links'], (writer) => writer.unlinkSealed())
const unlinkActive = step('unlink active', ['active', 'links'], (writer) => writer.unlinkActive())
const unlinkCheckpoint = step('unlink checkpoint', ['checkpoint', 'links'], (writer) =>
  writer.unlinkCheckpoint()
)
const checkpointAtCap = step('checkpoint', ['checkpoint', 'links'], (writer) =>
  writer.checkpointHead('bounded')
)
const reanchor = step('re-anchor', ['checkpoint', 'links'], (writer) => writer.reanchor('B'))
const reanchorBelow = step('re-anchor below', ['checkpoint', 'links'], (writer) =>
  writer.reanchor('B', revisionOf(writer.record) - 1)
)
const tombstone = step('tombstone', ['tombstone'], (writer) => writer.tombstone())

/** What looking at a name sees: which file is there. The checkpoint is never changed in place. */
function looksAtName(target: string): readonly Observable[] {
  for (const name of ['active', 'sealed', 'checkpoint', 'tombstone'] as const) {
    if (path.basename(target) === NAMES[name]) return [name]
  }
  return EVERYTHING
}

/** Where the view and a record differ, for the rows the view holds; null when nowhere. */
function difference(view: HostThreadLogView, record: ChatRecord): string | null {
  const { messages, runs, ...shell } = record
  if (view.revision !== revisionOf(record)) return `revision ${view.revision}`
  if (!isDeepStrictEqual(view.shell, shell)) return 'record without its transcript'
  if (view.messageCount !== messages.length) return 'message count'
  const newest = messages.slice(messages.length - view.messages.length)
  if (!isDeepStrictEqual(view.messages, newest)) return 'messages'
  if (view.runCount !== runs.length) return 'run count'
  for (const held of view.runs) {
    if (!isDeepStrictEqual(held.run, runs[held.index])) return `run ${held.index}`
  }
  return null
}

interface Scenario {
  readonly name: string
  /** Steps before the follower is made. */
  readonly prepare: readonly Step[]
  /** Polls before the racing steps may start, so the follower holds what it opened. */
  readonly warmPolls: number
  /** Steps after those polls, before the racing steps. */
  readonly between?: readonly Step[]
  /** Steps tried at every place among the follower's calls, in this order. */
  readonly racing: readonly Step[]
  /** Polls during which the racing steps may fall. */
  readonly windowPolls: number
  /** Steps after the window, between polls. */
  readonly after: readonly Step[]
  /** Why a schedule may build the view again; any other reason fails it. */
  readonly reseeds: readonly HostThreadLogSeedReason[]
  readonly ends: 'following' | 'absent'
  /** Schedules the search must find at least, so that it cannot shrink unseen. */
  readonly atLeast: number
  /** What must hold over all of its schedules. */
  readonly check?: (summary: Summary) => void
}

interface Outcome {
  readonly trace: readonly boolean[]
  readonly seeds: Readonly<Record<HostThreadLogSeedReason, number>>
}

/** Run one schedule: `choices` says, at each choice met, whether the next racing step runs there. */
async function runSchedule(scenario: Scenario, choices: readonly boolean[]): Promise<Outcome> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  try {
    const writer = new Writer(directory)
    for (const each of scenario.prepare) each.run(writer)
    const trace: boolean[] = []
    let next = 0
    let racing = false
    const choose = (looks: readonly Observable[]): void => {
      while (racing && next < scenario.racing.length) {
        // When no step left changes anything this call looks at, running any
        // of them before the call makes the same schedule as running them
        // after it, so the choice is left to a later call. Otherwise the next
        // step is offered even if it is unseen here, as the one seen must
        // follow it.
        const seen = scenario.racing
          .slice(next)
          .some((each) => each.changes.some((change) => looks.includes(change)))
        if (!seen) return
        const take = trace.length < choices.length ? choices[trace.length] : false
        trace.push(take)
        if (!take) return
        scenario.racing[next++].run(writer)
      }
    }
    // The follower's first looks at a file it has just opened learn what it
    // opened: its identity and type, and a size only a write could change. A
    // step between the open and those looks sees the same as one before the
    // open (a write) or one after them (any other step), so none is offered.
    let justOpened: number | null = null
    const seam: NonNullable<HostThreadLogFollowerOptions['fs']> = {
      constants: fs.constants,
      openSync: (target, flags) => {
        choose(looksAtName(target))
        justOpened = fs.openSync(target, flags)
        return justOpened
      },
      // Measuring a file sees what it holds, and whether it still has a name.
      fstatSync: (fd, options) => {
        if (fd !== justOpened) {
          justOpened = null
          choose(['content', 'links'])
        }
        return fs.fstatSync(fd, options)
      },
      lstatSync: (target, options) => {
        justOpened = null
        choose(looksAtName(target))
        return fs.lstatSync(target, options)
      },
      readSync: (fd, buffer, offset, length, position) => {
        justOpened = null
        return fs.readSync(fd, buffer, offset, length, position)
      },
      closeSync: (fd) => {
        justOpened = null
        fs.closeSync(fd)
      }
    }
    const failures: string[] = []
    /** The lineages the view can still be on. */
    let lineages: number[] = []
    const follower = new HostThreadLogFollower({
      chatId: CHAT,
      directory,
      fs: seam,
      windowMessages: 3,
      windowRuns: 2,
      seedPort: {
        async seed() {
          choose(EVERYTHING)
          const record = appLoad(directory)
          choose(EVERYTHING)
          return record as unknown as HostThreadLogRecord | null
        }
      },
      observer: {
        seeded: (record) => {
          const revision = revisionOf(record)
          lineages = writer.lineages.flatMap((records, index) =>
            isDeepStrictEqual(records.get(revision), record) ? [index] : []
          )
          if (lineages.length === 0) failures.push(`seeded at ${revision} with no lineage's record`)
        },
        applied: () => {
          const view = follower.view()!
          lineages = lineages.filter((index) => {
            const record = writer.lineages[index].get(view.revision)
            return record !== undefined && difference(view, record) === null
          })
          if (lineages.length === 0) failures.push(`at ${view.revision} the view is no lineage's`)
        }
      }
    })
    try {
      for (let poll = 0; poll < scenario.warmPolls; poll += 1) await follower.poll()
      for (const each of scenario.between ?? []) each.run(writer)
      racing = true
      for (let poll = 0; poll < scenario.windowPolls; poll += 1) await follower.poll()
      racing = false
      while (next < scenario.racing.length) scenario.racing[next++].run(writer)
      for (const each of scenario.after) each.run(writer)
      let result = await follower.poll()
      for (let polls = 1; result.status === 'following' && !result.caughtUp; polls += 1) {
        if (polls > 20) throw new Error('the follower never caught up')
        result = await follower.poll()
      }
      const where = `${scenario.name}, schedule ${describeTrace(trace)}`
      expect(failures, where).toEqual([])
      if (scenario.ends === 'absent') {
        expect(result, where).toEqual({ status: 'absent' })
      } else {
        expect(result, where).toMatchObject({
          status: 'following',
          revision: revisionOf(writer.record),
          caughtUp: true,
          stoppedAt: null
        })
        expect(difference(follower.view()!, writer.record), where).toBeNull()
      }
      const stats = follower.stats()
      expect(stats.observerFailures, where).toBe(0)
      return { trace, seeds: stats.seeds }
    } finally {
      follower.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
}

/** The choices at which a racing step ran. */
function describeTrace(trace: readonly boolean[]): string {
  const taken = trace.flatMap((take, index) => (take ? [index] : []))
  return `[${taken.join(', ')}] of ${trace.length}`
}

interface Summary {
  readonly schedules: number
  readonly seeds: Readonly<Record<HostThreadLogSeedReason, number>>
}

/** Every schedule of a scenario, depth first: the last choice not taken is taken next. */
async function explore(scenario: Scenario): Promise<Summary> {
  const seeds = Object.fromEntries(
    HOST_THREAD_LOG_SEED_REASONS.map((reason) => [reason, 0])
  ) as Record<HostThreadLogSeedReason, number>
  let schedules = 0
  let choices: boolean[] = []
  for (;;) {
    const outcome = await runSchedule(scenario, choices)
    schedules += 1
    // The follower and the steps are deterministic: the same choices meet the same choices.
    expect(outcome.trace.slice(0, choices.length)).toEqual(choices)
    for (const reason of HOST_THREAD_LOG_SEED_REASONS) {
      seeds[reason] += outcome.seeds[reason]
      if (reason !== 'cold' && outcome.seeds[reason] > 0 && !scenario.reseeds.includes(reason)) {
        throw new Error(
          `${scenario.name}: reseeded for ${reason}, schedule ${describeTrace(outcome.trace)}`
        )
      }
    }
    let last = outcome.trace.length - 1
    while (last >= 0 && outcome.trace[last]) last -= 1
    if (last < 0) break
    choices = [...outcome.trace.slice(0, last), true]
    if (schedules > 100_000) throw new Error(`${scenario.name}: more schedules than the bound`)
  }
  return { schedules, seeds }
}

/** The checkpoint worker, run on this thread when the test says, and the directory syncs it waits on. */
class Compactor implements CheckpointPreparationPort {
  private readonly jobs: Array<{
    request: CheckpointPreparationRequest
    ready: (value: PreparedCheckpoint) => void
    fail: (error: Error) => void
  }> = []
  private readonly syncs: Array<() => void> = []

  constructor(private readonly directory: string) {}

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
    new Promise<void>((resolve) => this.syncs.push(resolve))

  releaseSync(): void {
    const release = this.syncs.shift()
    if (!release) throw new Error('no directory sync is waiting')
    release()
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 500; turn += 1) {
    if (condition()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`never: ${what}`)
}

/**
 * The steps another process can see the journal take in `directory`: each
 * file made, written, renamed or unlinked under the journal's names.
 * Temporary files are seen only when renamed over a name.
 */
function watchJournal(directory: string): { readonly effects: string[] } {
  const effects: string[] = []
  const roles = new Map<number, string>()
  const written = new Set<number>()
  const role = (target: unknown): string | null => {
    const where = String(target)
    if (path.dirname(where) !== directory) return null
    const name = path.basename(where)
    for (const each of ['checkpoint', 'sealed', 'active', 'tombstone', 'setAside'] as const) {
      if (name === NAMES[each]) return each
    }
    return name.startsWith('.') && name.endsWith('.tmp') ? 'temporary' : null
  }
  const module = fs as unknown as Record<string, (...args: unknown[]) => unknown>
  const real = Object.fromEntries(
    ['openSync', 'writeSync', 'closeSync', 'renameSync', 'unlinkSync', 'ftruncateSync'].map(
      (name) => [name, module[name]]
    )
  )
  vi.spyOn(module, 'openSync').mockImplementation((...args: unknown[]) => {
    const named = role(args[0])
    const existed = fs.existsSync(String(args[0]))
    const fd = real.openSync(...args) as number
    if (named === 'active' || named === 'sealed') {
      roles.set(fd, named)
      if (!existed) effects.push(`create ${named}`)
    }
    return fd
  })
  vi.spyOn(module, 'writeSync').mockImplementation((...args: unknown[]) => {
    if (roles.has(args[0] as number)) written.add(args[0] as number)
    return real.writeSync(...args)
  })
  vi.spyOn(module, 'ftruncateSync').mockImplementation((...args: unknown[]) => {
    const named = roles.get(args[0] as number)
    if (named) effects.push(`truncate ${named}`)
    return real.ftruncateSync(...args)
  })
  vi.spyOn(module, 'closeSync').mockImplementation((...args: unknown[]) => {
    const fd = args[0] as number
    if (written.has(fd)) effects.push(`write ${roles.get(fd)}`)
    roles.delete(fd)
    written.delete(fd)
    return real.closeSync(...args)
  })
  vi.spyOn(module, 'renameSync').mockImplementation((...args: unknown[]) => {
    const from = role(args[0])
    const to = role(args[1])
    const result = real.renameSync(...args)
    if (from !== null || to !== null) effects.push(`rename ${from} ${to}`)
    return result
  })
  vi.spyOn(module, 'unlinkSync').mockImplementation((...args: unknown[]) => {
    const named = role(args[0])
    const result = real.unlinkSync(...args)
    if (named !== null && named !== 'temporary') effects.push(`unlink ${named}`)
    return result
  })
  const promises = fs.promises as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >
  const unlink = promises.unlink
  vi.spyOn(promises, 'unlink').mockImplementation(async (...args: unknown[]) => {
    const named = role(args[0])
    const result = await unlink(...args)
    if (named !== null && named !== 'temporary') effects.push(`unlink ${named}`)
    return result
  })
  syncBuiltinESMExports()
  return { effects }
}

describe('the steps played', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
  })

  it('are the steps the journal takes, in its order, and leave what it leaves', async () => {
    const journalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    const modelDirectory = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    try {
      const compactor = new Compactor(journalDirectory)
      const line = Buffer.byteLength(
        `${JSON.stringify(deriveChatRecordMutation(thread('A', 1), grown(thread('A', 1)), { savedAt: AT }))}\n`
      )
      const journal = createIncrementalChatJournal(journalDirectory, {
        noteDurabilityDebt: () => {},
        checkpointPreparation: compactor,
        syncDirectory: compactor.syncDirectory,
        // A segment's third line passes it: lines are alike in size.
        maxJournalBytes: Math.floor(line * 2.5),
        canRepairOnRead: () => false,
        repairTornTailBeforeAppend: true
      })
      const writer = new Writer(modelDirectory)
      let head = thread('A', 1)
      let clock = Date.parse(AT)
      const append = (): void => {
        const next = grown(head)
        clock += 1000
        journal.append(
          deriveChatRecordMutation(head, next, { savedAt: new Date(clock).toISOString() })
        )
        head = next
      }
      const actions: Array<{
        readonly name: string
        readonly journal: () => void | Promise<void>
        readonly steps: readonly Step[]
      }> = [
        { name: 'first checkpoint', journal: () => journal.initialize(CHAT, head), steps: [begin] },
        { name: 'first append', journal: append, steps: [create, write] },
        { name: 'append', journal: append, steps: [write] },
        { name: 'append past the trigger', journal: append, steps: [write, seal] },
        { name: 'append after rotation', journal: append, steps: [create, write] },
        {
          name: 'the worker folds and the checkpoint is adopted',
          journal: async () => {
            compactor.fold()
            await until(() => compactor.pendingSyncs > 0, 'the adoption waits for its sync')
          },
          steps: [adopt]
        },
        {
          name: 'the sync settles and the sealed segment goes',
          journal: async () => {
            compactor.releaseSync()
            await until(
              () => !fs.existsSync(path.join(journalDirectory, NAMES.sealed)),
              'the sealed segment is unlinked'
            )
            // And the turns its own step takes after the unlink.
            for (let turn = 0; turn < 10; turn += 1) {
              await new Promise((resolve) => setImmediate(resolve))
            }
          },
          steps: [unlinkSealed]
        },
        { name: 'append', journal: append, steps: [write] },
        {
          name: 'checkpoint at the cap',
          journal: () => {
            journal.checkpoint(CHAT, 'bounded', head)
          },
          steps: [checkpointAtCap, unlinkActive]
        },
        { name: 'append after it', journal: append, steps: [create, write] },
        {
          name: 're-anchor',
          journal: () => {
            head = thread('B', revisionOf(head))
            journal.replaceAuthoritativeCheckpoint(CHAT, head)
          },
          steps: [reanchor, unlinkActive]
        },
        { name: 'append after it', journal: append, steps: [create, write] },
        {
          name: 'delete',
          journal: () => journal.delete(CHAT),
          steps: [tombstone, unlinkActive, unlinkCheckpoint]
        }
      ]
      const watched = watchJournal(journalDirectory)
      for (const action of actions) {
        await action.journal()
        for (const each of action.steps) each.run(writer)
        expect(watched.effects.splice(0), action.name).toEqual(writer.effects.splice(0))
        expect(appLoad(modelDirectory), action.name).toEqual(appLoad(journalDirectory))
      }
    } finally {
      removeTemporaryDirectory(journalDirectory)
      removeTemporaryDirectory(modelDirectory)
    }
  })
})

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'a held segment: append, rotate, append to the next',
    prepare: [begin, create, write, write],
    warmPolls: 1,
    racing: [write, seal, create, write],
    windowPolls: 2,
    after: [adopt, unlinkSealed, write],
    reseeds: [],
    ends: 'following',
    atLeast: 220
  },
  {
    name: 'a held segment: rotate, compact, unlink',
    prepare: [begin, create, write, write],
    warmPolls: 1,
    racing: [seal, adopt, unlinkSealed],
    windowPolls: 3,
    after: [create, write],
    reseeds: [],
    ends: 'following',
    atLeast: 80
  },
  {
    name: 'a held sealed segment and its successor: append, compact, unlink, append',
    prepare: [begin, create, write, write, seal, create, write],
    warmPolls: 1,
    racing: [write, adopt, unlinkSealed, write],
    windowPolls: 2,
    after: [],
    reseeds: [],
    ends: 'following',
    atLeast: 60
  },
  {
    name: 'a cold follower: rotate, append to the next',
    prepare: [begin, create, write, write],
    warmPolls: 0,
    racing: [seal, create, write],
    windowPolls: 2,
    after: [adopt, unlinkSealed, write],
    reseeds: [],
    ends: 'following',
    atLeast: 230
  },
  {
    // A seed that has not the line written after it can meet the next segment
    // first, stop at its gap, and must take it up again once the line is read.
    name: 'a cold follower: append, rotate, append to the next',
    prepare: [begin, create, write, write],
    warmPolls: 0,
    racing: [write, seal, create, write],
    windowPolls: 2,
    after: [adopt, unlinkSealed, write],
    reseeds: [],
    ends: 'following',
    atLeast: 1400
  },
  {
    name: 'a cold follower while a compaction waits: compact, unlink, append',
    prepare: [begin, create, write, write, seal, create, write],
    warmPolls: 0,
    racing: [adopt, unlinkSealed, write],
    windowPolls: 2,
    after: [],
    reseeds: [],
    ends: 'following',
    atLeast: 420
  },
  {
    name: 'a segment the follower may never open: made, appended, rotated, compacted, unlinked',
    prepare: [begin],
    warmPolls: 1,
    racing: [create, write, seal, adopt, unlinkSealed],
    windowPolls: 1,
    after: [create, write],
    // Only when the segment was gone before the follower opened it.
    reseeds: ['checkpoint-passed'],
    ends: 'following',
    atLeast: 340,
    check: (summary) => {
      expect(summary.seeds['checkpoint-passed']).toBeGreaterThan(0)
      expect(summary.seeds['checkpoint-passed']).toBeLessThan(summary.schedules)
    }
  },
  {
    name: 'a checkpoint at the cap folds a held segment, unlinks it, and the next starts',
    prepare: [begin, create, write, write],
    warmPolls: 1,
    racing: [write, checkpointAtCap, unlinkActive, create, write],
    windowPolls: 2,
    after: [],
    reseeds: [],
    ends: 'following',
    atLeast: 530
  },
  {
    name: 'the thread is re-anchored to another lineage at the same revision',
    prepare: [begin, create, write, write],
    warmPolls: 1,
    racing: [reanchor, unlinkActive, create, write],
    windowPolls: 2,
    after: [write],
    reseeds: ['lineage'],
    ends: 'following',
    atLeast: 270,
    check: (summary) => expect(summary.seeds.lineage).toBe(summary.schedules)
  },
  {
    name: 'the thread is re-anchored below the follower, and that lineage is folded',
    prepare: [begin, create, write, write],
    warmPolls: 1,
    between: [reanchorBelow, unlinkActive, create, write],
    racing: [write, seal, adopt],
    windowPolls: 1,
    after: [create, write],
    reseeds: ['lineage', 'checkpoint-passed'],
    ends: 'following',
    atLeast: 660,
    check: (summary) => expect(summary.seeds.lineage).toBeGreaterThan(0)
  },
  {
    name: 'the thread is deleted',
    prepare: [begin, create, write],
    warmPolls: 1,
    racing: [tombstone, unlinkActive, unlinkCheckpoint],
    windowPolls: 2,
    after: [],
    reseeds: [],
    ends: 'absent',
    atLeast: 36
  }
]

describe('each place a step of the app can fall among the calls of a poll', () => {
  for (const scenario of SCENARIOS) {
    it(
      scenario.name,
      async () => {
        const summary = await explore(scenario)
        expect(summary.schedules).toBeGreaterThanOrEqual(scenario.atLeast)
        scenario.check?.(summary)
      },
      120_000
    )
  }
})
