/**
 * An old thread with a backlog of 1,000 finished runs whose tool detail was
 * never moved out, as it presents itself when it is next used. Its saves
 * stage the backlog 25 runs at a time; the backlog reaches the disk through
 * background syncs that no barrier pays, and a barrier the user sits in pays
 * the thread's own debt alone. The port is the real one over file calls that
 * finish only when the test says, and everything is counted in syncs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHAT_HISTORY_COMPACTION_GENERATION } from './ChatCompaction'
import { prepareChatForPersistence } from './ChatPersistencePreparation'
import {
  MAX_TERMINAL_TOOL_DETAIL_RUNS_PER_SAVE,
  TOOL_DETAIL_EXTERNALIZATION_GENERATION
} from './ChatToolDetailExternalization'
import { RunEventLedgerWriter } from './RunEventLedgerWriter'
import { createThreadDurabilityDebt, type ThreadDurabilityDebt } from './ThreadDurabilityDebt'
import {
  createThreadDurabilityDebtFs,
  type ThreadDurabilityDebtFs,
  type ThreadDurabilityDebtFsCalls
} from './ThreadDurabilityDebtFs'
import {
  readToolActivityDetailSync,
  type ToolActivityDetailCheckpoint
} from './ToolActivityDetailLedger'
import {
  createToolActivityDetailStaging,
  type ToolActivityDetailStaging
} from './ToolActivityDetailStaging'
import type { ChatRecord, RunEventInput, ToolActivity } from './types'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-detail-backlog-'

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

type Done = (error: NodeJS.ErrnoException | null) => void

/** File calls whose syncs finish only when the test says; opens and closes finish at once. */
class HeldCalls implements ThreadDurabilityDebtFsCalls {
  readonly constants = { O_RDONLY: 0, O_RDWR: 2 }
  /** Every path whose sync started, in order. */
  started: string[] = []
  private nextFd = 100
  private paths = new Map<number, string>()
  private syncs: Array<{ path: string; done: Done }> = []

  open(
    target: string,
    _flags: number,
    callback: (error: NodeJS.ErrnoException | null, fd: number) => void
  ): void {
    const fd = this.nextFd
    this.nextFd += 1
    this.paths.set(fd, target)
    queueMicrotask(() => callback(null, fd))
  }

  fsync(fd: number, callback: Done): void {
    const target = this.paths.get(fd)!
    this.started.push(target)
    this.syncs.push({ path: target, done: callback })
  }

  close(fd: number, callback: Done): void {
    this.paths.delete(fd)
    queueMicrotask(() => callback(null))
  }

  syncing(): number {
    return this.syncs.length
  }

  /** Let the sync that has run longest finish. */
  async finish(): Promise<void> {
    const sync = this.syncs.shift()
    if (!sync) throw new Error('no sync is in flight')
    sync.done(null)
    await settle()
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const CHAT = 'chat-old'
const RUNS = 1_000
const AT = '2026-10-05T00:00:00.000Z'

function detail(runId: string): ToolActivity {
  return {
    id: `tool-${runId}`,
    toolName: 'run_shell_command',
    displayName: 'Ran command',
    category: 'shell',
    status: 'success',
    endedAt: AT,
    parameters: { command: `npm test -- ${runId}` },
    resultSummary: `${runId} passed`,
    rawResultEvent: { output: `output of ${runId}\n`.repeat(8) }
  }
}

/**
 * A thread whose every run finished long ago, its tool detail still inline.
 * `compacted`: a recent build has compacted its history already, as it does
 * once for every thread it saves, so a save changes none of its rows.
 */
function backlog(compacted = true): ChatRecord {
  const runs = Array.from({ length: RUNS }, (_unused, index) => `run-${index}`)
  const generation = compacted ? CHAT_HISTORY_COMPACTION_GENERATION : undefined
  return {
    appChatId: CHAT,
    title: 'An old thread',
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: 1,
    unattributedHistoryCompactionGeneration: generation,
    messages: runs.map((runId, index) => ({
      id: `message-${index}`,
      role: 'assistant',
      content: 'Ran the tests.',
      timestamp: AT,
      runId,
      toolActivities: [detail(runId)]
    })),
    runs: runs.map((runId) => ({
      runId,
      startedAt: AT,
      endedAt: AT,
      status: 'completed',
      exitCode: 0,
      historyCompactionGeneration: generation
    }))
  } as ChatRecord
}

function checkpointInput(
  record: ChatRecord,
  checkpoint: ToolActivityDetailCheckpoint
): RunEventInput {
  return {
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

describe('a thread with a 1,000-run backlog of tool detail', () => {
  let root: string
  let runArtifactsDir: string
  let segment: string
  let calls: HeldCalls
  let port: ThreadDurabilityDebtFs
  let debt: ThreadDurabilityDebt
  let events: RunEventLedgerWriter
  let staging: ToolActivityDetailStaging
  let record: ChatRecord
  let saves: number

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    runArtifactsDir = path.join(root, 'run-artifacts')
    const runEventsDir = path.join(root, 'run-events')
    // A profile in use for a while: its folders are there already.
    for (const directory of [runArtifactsDir, runEventsDir, path.join(root, 'chat-journal-v2')]) {
      fs.mkdirSync(directory)
    }
    segment = path.join(root, 'chat-journal-v2', `${CHAT}.mutations.jsonl`)
    calls = new HeldCalls()
    port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin', maxInFlight: 2 })
    debt = createThreadDurabilityDebt({ port })
    // The run events of a thread under barrier durability: an ordinary append owes its barrier.
    events = new RunEventLedgerWriter({
      runEventsDir,
      runArtifactsDir,
      noteDurabilityDebt: debt.note
    })
    staging = createToolActivityDetailStaging({
      runArtifactsDir,
      port,
      appendRunEvent: (input) => events.appendStaged(input),
      checkpointInput
    })
    record = backlog()
    saves = 0
  })

  afterEach(() => {
    removeTemporaryDirectory(root)
  })

  /** One save: prepare the record with the staged batch, and owe its journal line to the thread. */
  const save = (): void => {
    const current = record
    const prepared = prepareChatForPersistence({
      chat: current,
      previous: current,
      authoredTranscriptEligible: false,
      createDetailBatch: () => staging.batch(current),
      readArchivedDetail: (ref) => readToolActivityDetailSync(runArtifactsDir, ref),
      persistDetailCheckpoint: () => {
        throw new Error('A staged batch has no checkpoint for the save to persist')
      },
      maxTerminalRunsPerPass: MAX_TERMINAL_TOOL_DETAIL_RUNS_PER_SAVE
    })
    expect(prepared.externalizationFailed).toBe(false)
    record = prepared.chat
    debt.note(CHAT, { file: segment, owner: 'journal' })
    saves += 1
  }
  const stamped = (): number =>
    record.runs.filter(
      (run) => run.toolDetailExternalizationGeneration === TOOL_DETAIL_EXTERNALIZATION_GENERATION
    ).length
  /** Save, and let every sync the save set off finish, until every run is stamped. */
  const drain = async (): Promise<void> => {
    while (stamped() < RUNS) {
      save()
      await settle()
      while (calls.syncing() > 0) await calls.finish()
      expect(saves).toBeLessThanOrEqual(2 * (RUNS / MAX_TERMINAL_TOOL_DETAIL_RUNS_PER_SAVE) + 2)
    }
  }

  it('lets a user’s barrier pay only the thread’s own debt while the backlog waits in the background', async () => {
    save()
    await settle()
    // The first 25 runs' segments wait for background syncs, two of them started.
    expect(port.snapshot()).toMatchObject({
      inFlight: 2,
      queuedBackground: MAX_TERMINAL_TOOL_DETAIL_RUNS_PER_SAVE - 2,
      queuedNormal: 0
    })

    // The thread's idle barrier is running when the user's is raised. The user's
    // asks for the journal beside it, and joins the idle one's sync, not started.
    const idle = debt.barrier(CHAT)
    await settle()
    const startedBefore = calls.started.length
    let completions = 0
    let userDone = false
    const user = debt.barrier(CHAT, { threadOnly: true, urgent: true }).then(() => {
      userDone = true
    })
    await settle()
    while (!userDone) {
      await calls.finish()
      completions += 1
    }
    await Promise.all([idle, user])

    // The two syncs that had started, then the journal: nothing of the backlog.
    expect(completions).toBe(3)
    expect(calls.started.slice(startedBefore, startedBefore + 1)).toEqual([segment])
    expect(debt.snapshot()).toMatchObject({
      owners: {
        journal: { noted: 1, synced: 1 },
        detail: { noted: 0, synced: 0 },
        'run-events': { noted: 0, synced: 0 },
        directory: { noted: 0, synced: 0 }
      },
      waits: { urgent: { count: 1, aheadMost: 2 }, normal: { count: 1, aheadMost: 2 } }
    })
    expect(stamped()).toBe(0)
  })

  // Full-backlog integrity checks retain CI's 30 s budget on local runs too.
  it('drains and verifies every backlog detail', { timeout: 30_000 }, async () => {
    await drain()

    // A save stages 25 runs and the save after their batch takes their refs.
    expect(saves).toBe(2 * (RUNS / MAX_TERMINAL_TOOL_DETAIL_RUNS_PER_SAVE))
    const work = staging.snapshot()
    expect(work).toMatchObject({
      batches: { committed: RUNS / MAX_TERMINAL_TOOL_DETAIL_RUNS_PER_SAVE, failed: 0 },
      rows: { staged: RUNS, swapped: RUNS, passedOver: 0 },
      checkpointEvents: RUNS,
      outstanding: 0,
      readyRefs: 0
    })
    // Every sync of the backlog went through the background class; none was the thread's debt.
    expect(port.snapshot()).toMatchObject({
      started: work.syncs.files + work.syncs.directories,
      startedBackground: work.syncs.files + work.syncs.directories,
      startedUrgent: 0
    })
    expect(debt.snapshot().owners).toMatchObject({
      detail: { noted: 0 },
      'run-events': { noted: 0 },
      directory: { noted: 0 }
    })

    for (const message of record.messages) {
      const [activity] = message.toolActivities!
      expect(activity.parameters).toBeUndefined()
      expect(activity.rawResultEvent).toBeUndefined()
      expect(readToolActivityDetailSync(runArtifactsDir, activity.detailRef!)).toEqual(
        detail(message.runId!)
      )
    }

    // What the thread owes its barrier at the end is its journal line, and nothing else.
    const paid = debt.barrier(CHAT)
    await settle()
    expect(calls.started.at(-1)).toBe(segment)
    await calls.finish()
    await paid
    expect(calls.syncing()).toBe(0)
    expect(debt.snapshot().owners.journal.synced).toBe(1)
    expect(port.snapshot()).toMatchObject({
      started: work.syncs.files + work.syncs.directories + 1,
      startedBackground: work.syncs.files + work.syncs.directories
    })
  })

  it('restages compacted history and preserves its records', { timeout: 30_000 }, async () => {
    record = backlog(false)
    await drain()

    // The first save compacts the whole history after staging, which changes
    // the first 25 rows: their first batch names bytes they no longer have.
    expect(saves).toBe(2 * (RUNS / MAX_TERMINAL_TOOL_DETAIL_RUNS_PER_SAVE) + 1)
    expect(staging.snapshot()).toMatchObject({
      batches: { committed: RUNS / MAX_TERMINAL_TOOL_DETAIL_RUNS_PER_SAVE + 1, failed: 0 },
      rows: { staged: RUNS + MAX_TERMINAL_TOOL_DETAIL_RUNS_PER_SAVE, swapped: RUNS },
      readyRefs: 0
    })
    const last = record.runs.at(-1)!.runId
    for (const message of record.messages) {
      const { detailRef, ...kept } = message.toolActivities![0]
      const archived = readToolActivityDetailSync(runArtifactsDir, detailRef!)
      // What the archive holds is the row as the record held it: compacted,
      // but for the thread's last run, which compaction leaves alone.
      expect(archived).toMatchObject({ ...kept, parameters: detail(message.runId!).parameters })
      expect(archived!.rawResultEvent).toEqual(
        message.runId === last ? detail(last).rawResultEvent : undefined
      )
    }
  })
})
