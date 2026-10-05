/**
 * Staged tool detail over every power loss.
 *
 * A thread's files are written without a sync. After a power cut each file
 * keeps a prefix of its writes: what it held at some moment since its last
 * sync, chosen independently of every other file, and each directory keeps
 * its names as at some moment since its last sync. Each scenario lives a
 * thread through a save that stages tool detail, the steps of its batch, the
 * save that swaps the rows for refs, other saves and a user's barrier. After
 * every step it reads back every state a power cut could leave, with the
 * app's own readers: the record as the app and the history worker load it,
 * the tool detail reader and the run-event ledgers.
 *
 * No state may hold a reference whose bytes are missing, in the record or in
 * a checkpoint run event, and no detail the disk held inline may be lost.
 *
 * The files fall into three groups that no reader crosses: the journal, the
 * tool detail and the run events. Each group's states are read once each, and
 * the rules are checked over every combination of the three.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRunEventLine } from '../RunEventStore'
import { CHAT_HISTORY_COMPACTION_GENERATION } from './ChatCompaction'
import {
  prepareChatForPersistence,
  type ChatPersistenceDetailBatch
} from './ChatPersistencePreparation'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import {
  MAX_TERMINAL_TOOL_DETAIL_RUNS_PER_SAVE,
  TOOL_DETAIL_EXTERNALIZATION_GENERATION
} from './ChatToolDetailExternalization'
import { createIncrementalChatJournal, type IncrementalChatJournal } from './IncrementalChatJournal'
import { RunEventLedgerWriter } from './RunEventLedgerWriter'
import { ThreadCatalogueDiskReader } from './ThreadCatalogueDiskReader'
import {
  createThreadDurabilityDebt,
  type ThreadDurabilityDebt,
  type ThreadDurabilityPort,
  type ThreadDurabilitySyncOptions,
  type ThreadDurabilitySyncOutcome
} from './ThreadDurabilityDebt'
import {
  ToolActivityDetailBatchWriter,
  readToolActivityDetailSync,
  type ToolActivityDetailCheckpoint
} from './ToolActivityDetailLedger'
import { createToolActivityDetailStaging } from './ToolActivityDetailStaging'
import type {
  ChatMessage,
  ChatRecord,
  RunEventInput,
  ToolActivity,
  ToolActivityDetailRef
} from './types'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-detail-power-loss-'

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
/** A run that finished with its tool detail still inline: the backlog's case. */
const FINISHED = 'run-1'
/** A run still going, with a sealed tool call too large to keep inline. */
const LIVE = 'run-2'
const READER = { runtimeInstanceId: 'reader', segmented: false }
const AT = '2026-10-05T00:00:00.000Z'
const ENDED = '2026-10-05T00:00:01.000Z'

function finishedTool(): ToolActivity {
  return {
    id: 'tool-finished',
    toolName: 'run_shell_command',
    displayName: 'Ran command',
    category: 'shell',
    status: 'success',
    endedAt: ENDED,
    parameters: { command: 'npm test' },
    resultSummary: 'All tests passed',
    rawResultEvent: { output: 'ok\n'.repeat(20) }
  }
}

function liveTool(): ToolActivity {
  return {
    id: 'tool-live',
    toolName: 'read_file',
    displayName: 'Read file',
    category: 'read',
    status: 'success',
    endedAt: ENDED,
    parameters: { path: 'big.log' },
    resultSummary: 'Read big.log',
    rawResultEvent: { output: 'x'.repeat(70_000) }
  }
}

/** Each tool call's detail, as it was written inline. */
const ORIGINALS = new Map<string, ToolActivity>([
  ['tool-finished', finishedTool()],
  ['tool-live', liveTool()]
])

const toolMessage = (id: string, runId: string, activity: ToolActivity): ChatMessage =>
  ({
    id,
    role: 'assistant',
    content: '',
    timestamp: AT,
    runId,
    toolActivities: [activity]
  }) as ChatMessage

/** Revision 1, the thread as the disk holds it safely when a scenario starts. */
function started(withLiveTool: boolean): ChatRecord {
  return {
    appChatId: CHAT,
    title: 'Power loss',
    scope: 'global',
    chatKind: 'single',
    provider: 'claude',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: 1,
    // A recent build compacted its history already; saves change none of its rows.
    unattributedHistoryCompactionGeneration: CHAT_HISTORY_COMPACTION_GENERATION,
    messages: [
      { id: 'message-1', role: 'user', content: 'Run the tests', timestamp: AT },
      toolMessage('message-2', FINISHED, finishedTool()),
      ...(withLiveTool ? [toolMessage('message-3', LIVE, liveTool())] : [])
    ],
    runs: [
      {
        runId: FINISHED,
        startedAt: AT,
        endedAt: ENDED,
        status: 'completed',
        exitCode: 0,
        historyCompactionGeneration: CHAT_HISTORY_COMPACTION_GENERATION
      },
      { runId: LIVE, startedAt: AT, status: 'running' }
    ]
  } as ChatRecord
}

function checkpointInput(
  record: ChatRecord,
  checkpoint: ToolActivityDetailCheckpoint
): RunEventInput {
  return {
    id: `${checkpoint.runId}:tool-activity-detail:${checkpoint.offset}`,
    runId: checkpoint.runId,
    chatId: record.appChatId,
    provider: record.provider,
    kind: 'tool',
    phase: 'artifact',
    source: 'main',
    summary: `Checkpointed ${checkpoint.activityCount} tool activity details`,
    payload: { type: 'tool_activity_detail_checkpoint', schemaVersion: 1, ...checkpoint },
    timestamp: AT
  }
}

/** What one path held at one moment: a file's bytes, a directory's names, or nothing. */
type Held = { file: Buffer } | { directory: string[] } | null

function keyOf(held: Held): string {
  if (held === null) return 'absent'
  if ('file' in held) return `file:${createHash('sha256').update(held.file).digest('hex')}`
  return `directory:${held.directory.join('/')}`
}

/** Everything under a root at every moment, and the last moment each path was made safe. */
class DiskHistory {
  readonly moments: Array<Map<string, Held>> = []
  readonly kinds = new Map<string, 'file' | 'directory'>()
  private readonly safeAt = new Map<string, number>()

  /** Moment 0 is the start, all of it safe. */
  constructor(readonly root: string) {
    this.capture()
  }

  capture(): number {
    const moment = new Map<string, Held>()
    const walk = (relative: string): void => {
      const names = fs.readdirSync(path.join(this.root, relative)).sort()
      moment.set(relative, { directory: names })
      this.kinds.set(relative, 'directory')
      for (const name of names) {
        const child = relative === '.' ? name : `${relative}/${name}`
        const stat = fs.lstatSync(path.join(this.root, child))
        if (stat.isDirectory()) walk(child)
        else if (stat.isFile()) {
          moment.set(child, { file: fs.readFileSync(path.join(this.root, child)) })
          this.kinds.set(child, 'file')
        }
      }
    }
    walk('.')
    this.moments.push(moment)
    return this.moments.length - 1
  }

  /** These paths are synced now: what each holds at this moment is safe from here on. */
  synced(targets: readonly string[]): ThreadDurabilitySyncOutcome[] {
    const moment = this.capture()
    return targets.map((target) => {
      const relative = path.relative(this.root, target) || '.'
      if (!this.moments[moment].has(relative)) return 'missing'
      this.safeAt.set(relative, moment)
      return 'synced'
    })
  }

  /** What a power cut now may leave at a path: each state it had since it was last made safe. */
  candidates(relative: string): Held[] {
    const states = new Map<string, Held>()
    for (let moment = this.safeAt.get(relative) ?? 0; moment < this.moments.length; moment += 1) {
      const held = this.moments[moment].get(relative) ?? null
      states.set(keyOf(held), held)
    }
    return [...states.values()]
  }

  /** Every path under `top`, `top` included, that existed at any moment. */
  under(top: string): string[] {
    return [...this.kinds.keys()].filter((each) => each === top || each.startsWith(`${top}/`))
  }

  latest(relative: string): Held {
    return this.moments[this.moments.length - 1].get(relative) ?? null
  }
}

/** Every choice of one state per path. */
function* combinations(choices: Array<[string, Held[]]>): Generator<Map<string, Held>> {
  if (choices.length === 0) {
    yield new Map()
    return
  }
  const [[relative, states], ...rest] = choices
  for (const tail of combinations(rest)) {
    for (const held of states) yield new Map([[relative, held], ...tail])
  }
}

const assignmentKey = (assignment: Map<string, Held>): string =>
  [...assignment].map(([relative, held]) => `${relative}=${keyOf(held)}`).join('|')

/** A port whose syncs wait until the scenario lets them run. */
class HeldPort {
  readonly classes: string[] = []
  private waiting: Array<{
    target: string
    resolve: (outcome: ThreadDurabilitySyncOutcome) => void
  }> = []

  constructor(private readonly history: DiskHistory) {}

  syncFile = (target: string, options?: ThreadDurabilitySyncOptions) => this.ask(target, options)
  syncDirectory = (target: string, options?: ThreadDurabilitySyncOptions) =>
    this.ask(target, options)

  /** Run every sync waiting now: what each path holds now is safe. */
  async release(): Promise<void> {
    const now = this.waiting.splice(0)
    const outcomes = this.history.synced(now.map((each) => each.target))
    now.forEach((each, index) => each.resolve(outcomes[index]))
    await new Promise((resolve) => setImmediate(resolve))
  }

  waitingNow(): number {
    return this.waiting.length
  }

  private ask(target: string, options?: ThreadDurabilitySyncOptions) {
    this.classes.push(options?.background ? 'background' : options?.urgent ? 'urgent' : 'normal')
    return new Promise<ThreadDurabilitySyncOutcome>((resolve) =>
      this.waiting.push({ target, resolve })
    )
  }
}

/** A row of a record as one state of the journal loads it. */
interface Row {
  ref?: ToolActivityDetailRef
  activity: ToolActivity
}

type Step =
  | { kind: 'save'; adds?: 'live tool' }
  | { kind: 'sync' }
  | { kind: 'user barrier' }
  | { kind: 'raw output' }

const SAVE: Step = { kind: 'save' }
const SYNC: Step = { kind: 'sync' }
const USER: Step = { kind: 'user barrier' }

interface Report {
  /** States read back, by group, and combinations checked. */
  states: { journal: number; detail: number; events: number; combinations: number }
  /** Combinations whose record held a ref, and that held a row inline. */
  withRefs: number
  inline: number
  /** Each rule broken, with the step after which it could happen. */
  violations: string[]
  /** Saves after which the record had swapped rows for refs. */
  swaps: number
}

/**
 * Live one thread through the steps, `staged` with tool detail staged, or
 * `owed` with it written as the switch had it before: the ref handed back at
 * once, the bytes owed to the run, the line written in the same save.
 */
async function live(
  root: string,
  flow: 'staged' | 'owed',
  steps: readonly Step[],
  options: { liveToolFromStart?: boolean } = {}
): Promise<Report> {
  const liveToolFromStart = options.liveToolFromStart ?? true
  const journalDir = path.join(root, 'chat-journal-v2')
  const runArtifactsDir = path.join(root, 'run-artifacts')
  const runEventsDir = path.join(root, 'run-events')
  // A profile in use for a while: its folders, and the Host's copy at revision 1.
  for (const directory of [journalDir, runArtifactsDir, runEventsDir, path.join(root, 'chats')]) {
    fs.mkdirSync(directory)
  }
  let persisted = started(liveToolFromStart)
  fs.writeFileSync(path.join(root, 'chats', `${CHAT}.json`), JSON.stringify(persisted))
  const instant: ThreadDurabilityPort = {
    syncFile: async (target) => history.synced([target])[0],
    syncDirectory: async (target) => history.synced([target])[0]
  }
  const debt: ThreadDurabilityDebt = createThreadDurabilityDebt({ port: instant })
  const journal: IncrementalChatJournal = createIncrementalChatJournal(journalDir, {
    noteDurabilityDebt: debt.note
  })
  journal.initialize(CHAT, persisted)
  const history = new DiskHistory(root)
  /** The tool calls whose detail the disk has held safely, inline or behind a ref. */
  const held = new Map<string, ToolActivity>()
  const hold = (record: ChatRecord): void => {
    for (const message of record.messages) {
      for (const activity of message.toolActivities ?? []) {
        held.set(activity.id, ORIGINALS.get(activity.id)!)
      }
    }
  }
  hold(persisted)

  const port = new HeldPort(history)
  const events = new RunEventLedgerWriter({
    runEventsDir,
    runArtifactsDir,
    noteDurabilityDebt: debt.note
  })
  const staging = createToolActivityDetailStaging({
    runArtifactsDir,
    port,
    appendRunEvent: (input) => events.appendStaged(input),
    checkpointInput
  })
  const owedBatch = (): ChatPersistenceDetailBatch<ToolActivityDetailCheckpoint> => {
    const writer = new ToolActivityDetailBatchWriter(runArtifactsDir)
    return {
      stage: (runId, activity) => writer.stage(runId, activity),
      commit: () =>
        writer.writeUnsynced().map(({ checkpoint, filePath }) => {
          debt.note(CHAT, { file: filePath, owner: 'detail', run: checkpoint.runId })
          debt.note(CHAT, { directory: path.dirname(filePath), run: checkpoint.runId })
          debt.note(CHAT, { directory: runArtifactsDir, run: checkpoint.runId })
          return checkpoint
        })
    }
  }

  const report: Report = {
    states: { journal: 0, detail: 0, events: 0, combinations: 0 },
    withRefs: 0,
    inline: 0,
    violations: [],
    swaps: 0
  }
  let messages = 0
  const save = (adds?: 'live tool'): void => {
    messages += 1
    const input = structuredClone(persisted)
    input.messages.push({
      id: `message-user-${messages}`,
      role: 'user',
      content: `Follow-up ${messages}`,
      timestamp: AT
    } as ChatMessage)
    if (adds) input.messages.push(toolMessage('message-3', LIVE, liveTool()))
    const prepared = prepareChatForPersistence({
      chat: input,
      previous: persisted,
      authoredTranscriptEligible: false,
      createDetailBatch: () => (flow === 'staged' ? staging.batch(input) : owedBatch()),
      readArchivedDetail: (ref) => readToolActivityDetailSync(runArtifactsDir, ref),
      persistDetailCheckpoint: (checkpoint) => {
        if (flow === 'staged') throw new Error('A staged batch has no checkpoint for the save')
        events.append(checkpointInput(input, checkpoint), { durability: 'strict' })
      },
      maxTerminalRunsPerPass: MAX_TERMINAL_TOOL_DETAIL_RUNS_PER_SAVE
    })
    const next: ChatRecord = {
      ...prepared.chat,
      persistenceRevision: (persisted.persistenceRevision ?? 0) + 1,
      updatedAt: (persisted.persistenceRevision ?? 0) + 1
    }
    journal.append(deriveChatRecordMutation(persisted, next))
    persisted = next
    if (next.messages.some((message) => message.toolActivities?.some((each) => each.detailRef))) {
      report.swaps += 1
    }
  }

  /** Read every state of a group once, rebuilt from the history in a folder of its own. */
  const rebuild = <T>(
    top: string,
    assignment: Map<string, Held>,
    read: (directory: string) => T
  ): T => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    try {
      const write = (relative: string): void => {
        const state = assignment.has(relative)
          ? assignment.get(relative)!
          : history.latest(relative)
        const target = path.join(directory, relative)
        if (history.kinds.get(relative) === 'directory') {
          fs.mkdirSync(target)
          const names = state && 'directory' in state ? state.directory : []
          for (const name of names) write(`${relative}/${name}`)
        } else {
          // A name that survived without its bytes comes back empty.
          fs.writeFileSync(target, state && 'file' in state ? state.file : Buffer.alloc(0))
        }
      }
      write(top)
      return read(directory)
    } finally {
      removeTemporaryDirectory(directory)
    }
  }

  const journals = new Map<string, Map<string, Row> | string>()
  const details = new Map<string, Map<string, boolean>>()
  const ledgers = new Map<string, ToolActivityDetailCheckpoint[]>()

  const loadJournal = (assignment: Map<string, Held>): Map<string, Row> | string =>
    rebuild('chat-journal-v2', assignment, (directory) => {
      fs.mkdirSync(path.join(directory, 'chats'))
      const copy = history.latest(`chats/${CHAT}.json`)
      fs.writeFileSync(
        path.join(directory, 'chats', `${CHAT}.json`),
        copy && 'file' in copy ? copy.file : ''
      )
      let record: ChatRecord | undefined
      try {
        record = new ThreadCatalogueDiskReader({ profilePath: directory, ...READER }).read(
          CHAT
        )?.chat
      } catch (error) {
        return `the record does not load: ${(error as Error).message}`
      }
      if (!record) return 'the record does not load'
      const rows = new Map<string, Row>()
      for (const message of record.messages) {
        for (const activity of message.toolActivities ?? []) {
          rows.set(activity.id, { ref: activity.detailRef, activity })
        }
      }
      return rows
    })

  const refKey = (ref: ToolActivityDetailRef): string =>
    `ref:${ref.runId}:${ref.activityId}:${ref.offset}:${ref.byteLength}:${ref.sha256}`
  const segmentKey = (checkpoint: ToolActivityDetailCheckpoint): string =>
    `segment:${checkpoint.relativePath}:${checkpoint.offset}:${checkpoint.byteLength}:${checkpoint.sha256}`

  /** Whether each ref reads back its activity, and each segment its bytes, in one state of the detail. */
  const readDetail = (
    assignment: Map<string, Held>,
    refs: Map<string, ToolActivityDetailRef>,
    segments: Map<string, ToolActivityDetailCheckpoint>
  ): Map<string, boolean> =>
    rebuild('run-artifacts', assignment, (directory) => {
      const answers = new Map<string, boolean>()
      for (const [key, ref] of refs) {
        const read = readToolActivityDetailSync(path.join(directory, 'run-artifacts'), ref)
        const expected = ORIGINALS.get(ref.activityId)
        answers.set(key, read !== null && JSON.stringify(read) === JSON.stringify(expected))
      }
      for (const [key, checkpoint] of segments) {
        const file = path.join(directory, 'run-artifacts', checkpoint.relativePath)
        let bytes = Buffer.alloc(0)
        if (fs.existsSync(file)) bytes = fs.readFileSync(file)
        const slice = bytes.subarray(checkpoint.offset, checkpoint.offset + checkpoint.byteLength)
        answers.set(
          key,
          slice.length === checkpoint.byteLength &&
            createHash('sha256').update(slice).digest('hex') === checkpoint.sha256
        )
      }
      return answers
    })

  const readLedgers = (assignment: Map<string, Held>): ToolActivityDetailCheckpoint[] =>
    rebuild('run-events', assignment, (directory) => {
      const found: ToolActivityDetailCheckpoint[] = []
      const folder = path.join(directory, 'run-events')
      for (const name of fs.readdirSync(folder)) {
        for (const line of fs.readFileSync(path.join(folder, name), 'utf8').split('\n')) {
          const payload = parseRunEventLine(line)?.payload as
            | (ToolActivityDetailCheckpoint & { type?: string })
            | undefined
          if (payload?.type === 'tool_activity_detail_checkpoint') found.push(payload)
        }
      }
      return found
    })

  /** Every state a power cut now could leave, read back and checked. */
  const powerCut = (after: string): void => {
    for (const stable of ['.', 'chats', `chats/${CHAT}.json`]) {
      expect(history.candidates(stable)).toHaveLength(1)
    }
    const group = (top: string): Map<string, Held>[] => [
      ...combinations(history.under(top).map((each) => [each, history.candidates(each)]))
    ]
    const journalStates = group('chat-journal-v2').map((assignment) => {
      const key = assignmentKey(assignment)
      if (!journals.has(key)) {
        journals.set(key, loadJournal(assignment))
        report.states.journal += 1
      }
      return journals.get(key)!
    })
    const ledgerStates = group('run-events').map((assignment) => {
      const key = assignmentKey(assignment)
      if (!ledgers.has(key)) {
        ledgers.set(key, readLedgers(assignment))
        report.states.events += 1
      }
      return ledgers.get(key)!
    })
    const refs = new Map<string, ToolActivityDetailRef>()
    for (const rows of journalStates) {
      if (typeof rows === 'string') continue
      for (const row of rows.values()) if (row.ref) refs.set(refKey(row.ref), row.ref)
    }
    const segments = new Map<string, ToolActivityDetailCheckpoint>()
    for (const checkpoints of ledgerStates) {
      for (const checkpoint of checkpoints) segments.set(segmentKey(checkpoint), checkpoint)
    }
    const detailStates = group('run-artifacts').map((assignment) => {
      const key = assignmentKey(assignment)
      let answers = details.get(key)
      const missing = [...refs.keys(), ...segments.keys()].some((each) => !answers?.has(each))
      if (!answers || missing) {
        if (!answers) report.states.detail += 1
        answers = new Map([...(answers ?? []), ...readDetail(assignment, refs, segments)])
        details.set(key, answers)
      }
      return answers
    })

    const broken = new Set<string>()
    for (const rows of journalStates) {
      for (const answers of detailStates) {
        for (const checkpoints of ledgerStates) {
          report.states.combinations += 1
          if (typeof rows === 'string') {
            broken.add(rows)
            continue
          }
          let anyRef = false
          for (const row of rows.values()) {
            if (row.ref) {
              anyRef = true
              if (!answers.get(refKey(row.ref))) {
                broken.add(`a reference whose bytes are missing (${row.activity.id})`)
              }
            } else report.inline += 1
          }
          if (anyRef) report.withRefs += 1
          for (const [id, expected] of held) {
            const row = rows.get(id)
            const kept = row?.ref
              ? answers.get(refKey(row.ref)) === true
              : row !== undefined &&
                JSON.stringify(row.activity.parameters) === JSON.stringify(expected.parameters) &&
                JSON.stringify(row.activity.rawResultEvent) ===
                  JSON.stringify(expected.rawResultEvent)
            if (!kept) broken.add(`detail the disk held is lost (${id})`)
          }
          for (const checkpoint of checkpoints) {
            if (!answers.get(segmentKey(checkpoint))) {
              broken.add(`a checkpoint run event whose bytes are missing (${checkpoint.runId})`)
            }
          }
        }
      }
    }
    for (const rule of broken) report.violations.push(`after ${after}: ${rule}`)
  }

  powerCut('the start')
  for (const [index, step] of steps.entries()) {
    const name = `step ${index + 1} (${step.kind}${step.kind === 'save' && step.adds ? ', adding the live tool call' : ''})`
    if (step.kind === 'save') save(step.adds)
    else if (step.kind === 'sync') await port.release()
    else if (step.kind === 'user barrier') {
      await debt.barrier(CHAT, { threadOnly: true, urgent: true })
      hold(persisted)
    } else {
      // A run's raw output makes its folder without a sync, owing it to the run.
      events.append(
        {
          id: 'raw-1',
          runId: LIVE,
          chatId: CHAT,
          kind: 'provider_raw',
          phase: 'raw',
          source: 'provider',
          payload: { data: 'reading big.log\n' },
          timestamp: AT
        },
        { storeRawEvents: true }
      )
    }
    history.capture()
    powerCut(name)
  }
  // Every sync a batch asked for ran within the steps.
  expect(port.waitingNow()).toBe(0)
  expect(port.classes.every((each) => each === 'background')).toBe(true)
  if (flow === 'staged') {
    expect(staging.snapshot()).toMatchObject({ outstanding: 0, batches: { failed: 0 } })
  }
  const stamped = persisted.runs.find((run) => run.runId === FINISHED)
  if (report.swaps > 0) {
    expect(stamped?.toolDetailExternalizationGeneration).toBe(
      TOOL_DETAIL_EXTERNALIZATION_GENERATION
    )
  }
  return report
}

/** The steps of one batch: its segments, the folders above them, its checkpoints' ledgers and their folder. */
const BATCH: Step[] = [SYNC, SYNC, SYNC, SYNC]

describe.skipIf(process.platform === 'win32')('staged tool detail over every power loss', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  })

  afterEach(() => {
    removeTemporaryDirectory(root)
  })

  /** A scenario in a fresh profile of its own, inside this test's folder. */
  const scenario = (
    flow: 'staged' | 'owed',
    steps: readonly Step[],
    options?: { liveToolFromStart?: boolean }
  ): Promise<Report> => {
    const profile = fs.mkdtempSync(path.join(root, 'profile-'))
    return live(profile, flow, steps, options)
  }

  // A save that stages, the batch's four steps, and the save that swaps; another save
  // anywhere among the steps; a user's barrier nowhere, after the first save or after the last.
  const orders: Array<[string, Step[]]> = []
  for (const extra of [null, 1, 2, 3, 4] as const) {
    const base: Step[] = [SAVE, ...BATCH, SAVE]
    if (extra !== null) base.splice(extra, 0, SAVE)
    orders.push([`another save ${extra === null ? 'nowhere' : `after step ${extra}`}`, base])
  }
  const lives: Array<[string, Step[]]> = []
  for (const [name, steps] of orders) {
    lives.push([`${name}, no user barrier`, steps])
    lives.push([`${name}, a user barrier after the first save`, [SAVE, USER, ...steps.slice(1)]])
    lives.push([`${name}, a user barrier after the last save`, [...steps, USER]])
  }

  it.each(lives)(
    'never leaves a reference without its bytes, nor loses detail the disk held: %s',
    async (_name, steps) => {
      const report = await scenario('staged', steps)

      expect(report.violations).toEqual([])
      expect(report.swaps).toBeGreaterThan(0)
      // The states read include records with refs and records with the rows inline.
      expect(report.withRefs).toBeGreaterThan(0)
      expect(report.inline).toBeGreaterThan(0)
      expect(report.states.detail).toBeGreaterThan(8)
    },
    60_000
  )

  it('keeps a live tool call a user’s barrier made safe inline, through its own batch and swap', async () => {
    const report = await scenario(
      'staged',
      [SAVE, { kind: 'save', adds: 'live tool' }, USER, ...BATCH, SAVE, ...BATCH, SAVE, USER],
      { liveToolFromStart: false }
    )

    expect(report.violations).toEqual([])
    expect(report.swaps).toBeGreaterThan(1)
    expect(report.withRefs).toBeGreaterThan(0)
  }, 60_000)

  it('makes safe the name of a run folder its raw output made without a sync', async () => {
    // The live run's raw output makes its folder after the finished run's batch
    // made the folder above safe, and the live run's batch gives that folder
    // no new name: only syncing every folder on the path makes its name safe.
    const report = await scenario(
      'staged',
      [
        SAVE,
        ...BATCH,
        SAVE,
        { kind: 'raw output' },
        { kind: 'save', adds: 'live tool' },
        ...BATCH,
        SAVE,
        USER
      ],
      { liveToolFromStart: false }
    )

    expect(report.violations).toEqual([])
    expect(report.swaps).toBeGreaterThan(1)
    expect(report.withRefs).toBeGreaterThan(0)
  }, 60_000)

  it('finds both faults when the reference is written with bytes owed to the thread, as before', async () => {
    const report = await scenario('owed', [SAVE, USER])

    expect(report.violations).toEqual(
      expect.arrayContaining([
        'after step 1 (save): a reference whose bytes are missing (tool-finished)',
        'after step 1 (save): detail the disk held is lost (tool-finished)',
        'after step 2 (user barrier): a reference whose bytes are missing (tool-live)',
        'after step 2 (user barrier): detail the disk held is lost (tool-live)'
      ])
    )
  }, 60_000)
})

describe('the power-loss model itself', () => {
  it('lists every choice of one state per path', () => {
    const a: Held = { file: Buffer.from('a') }
    const b: Held = { file: Buffer.from('b') }
    const all = [
      ...combinations([
        ['x', [null, a]],
        ['y', [a, b]]
      ])
    ].map(assignmentKey)

    expect(new Set(all).size).toBe(4)
  })
})
