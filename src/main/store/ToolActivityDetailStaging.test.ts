/**
 * Tool detail staged across saves: a row stays inline until the bytes it would
 * reference, every name on the path to them and its checkpoint run event are
 * synced, and only a later save swaps it for a ref. The port's syncs settle
 * only when the test says, so each step of a batch can be looked at.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRunEventLine } from '../RunEventStore'
import { RunEventLedgerWriter } from './RunEventLedgerWriter'
import type {
  ThreadDurabilityDebtNote,
  ThreadDurabilitySyncOptions,
  ThreadDurabilitySyncOutcome
} from './ThreadDurabilityDebt'
import {
  TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME,
  ToolActivityDetailBatchWriter,
  readToolActivityDetailSync,
  type ToolActivityDetailCheckpoint
} from './ToolActivityDetailLedger'
import {
  TOOL_DETAIL_STAGING_FIRST_BACKOFF_MS,
  TOOL_DETAIL_STAGING_LONGEST_BACKOFF_MS,
  TOOL_DETAIL_STAGING_OUTSTANDING,
  createToolActivityDetailStaging,
  type ToolActivityDetailStaging
} from './ToolActivityDetailStaging'
import type {
  ChatRecord,
  RunEventInput,
  RunEventRecord,
  ToolActivity,
  ToolActivityDetailRef
} from './types'
import { countSyncs, type SyncCount } from './unsyncedWriteCrashDisk.testutil'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-detail-staging-'

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

type Outcome = ThreadDurabilitySyncOutcome | Error

/** A port whose syncs settle only when the test says. Paths are named relative to the root. */
class HeldPort {
  /** Every request, in order, as `file:<path>` or `directory:<path>`. */
  readonly asked: string[] = []
  /** The class each request was asked at, in the same order. */
  readonly classes: string[] = []
  private waiting: Array<{
    name: string
    resolve: (outcome: ThreadDurabilitySyncOutcome) => void
    reject: (error: unknown) => void
  }> = []

  constructor(private readonly root: string) {}

  syncFile = (target: string, options?: ThreadDurabilitySyncOptions) =>
    this.ask('file', target, options)
  syncDirectory = (target: string, options?: ThreadDurabilitySyncOptions) =>
    this.ask('directory', target, options)

  pending(): string[] {
    return this.waiting.map((each) => each.name)
  }

  /** Settle every request waiting now, as `outcomes` says or else as synced, and let the batch go on. */
  async settle(outcomes: Record<string, Outcome> = {}): Promise<void> {
    for (const each of this.waiting.splice(0)) {
      const outcome = outcomes[each.name] ?? 'synced'
      if (outcome instanceof Error) each.reject(outcome)
      else each.resolve(outcome)
    }
    await flush()
  }

  /** Settle step after step until nothing waits. */
  async drain(): Promise<void> {
    while (this.waiting.length > 0) await this.settle()
  }

  private ask(
    kind: 'file' | 'directory',
    target: string,
    options?: ThreadDurabilitySyncOptions
  ): Promise<ThreadDurabilitySyncOutcome> {
    const name = `${kind}:${path.relative(this.root, target) || '.'}`
    this.asked.push(name)
    this.classes.push(options?.urgent ? 'urgent' : options?.background ? 'background' : 'normal')
    return new Promise((resolve, reject) => this.waiting.push({ name, resolve, reject }))
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function chat(chatId = CHAT): ChatRecord {
  return { appChatId: chatId, workspaceId: 'workspace-1', provider: 'codex' } as ChatRecord
}

function activity(id: string, output = `output of ${id}`): ToolActivity {
  return {
    id,
    toolName: 'run_shell_command',
    displayName: 'Ran command',
    category: 'shell',
    status: 'success',
    endedAt: '2026-10-05T00:00:01.000Z',
    parameters: { command: `printf ${id}` },
    resultSummary: output,
    rawResultEvent: { output }
  }
}

/** The checkpoint run event a save appends for a segment. */
function checkpointInput(
  record: ChatRecord,
  checkpoint: ToolActivityDetailCheckpoint
): RunEventInput {
  return {
    id: `${checkpoint.runId}:checkpoint:${checkpoint.offset}`,
    runId: checkpoint.runId,
    chatId: record.appChatId,
    workspaceId: record.workspaceId,
    provider: record.provider,
    kind: 'tool',
    phase: 'artifact',
    source: 'main',
    summary: `Checkpointed ${checkpoint.activityCount} tool activity details`,
    payload: { type: 'tool_activity_detail_checkpoint', schemaVersion: 1, ...checkpoint },
    timestamp: '2026-10-05T00:00:00.000Z'
  }
}

function eventsIn(file: string): RunEventRecord[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map(parseRunEventLine)
    .filter((record): record is RunEventRecord => record !== null)
}

describe('tool detail staged across saves', () => {
  let root: string
  let runArtifactsDir: string
  let runEventsDir: string
  let port: HeldPort
  let events: RunEventLedgerWriter
  let notes: Array<[string, ThreadDurabilityDebtNote]>
  let syncs: SyncCount
  let clock: number
  let staging: ToolActivityDetailStaging

  const make = (options: { maxOutstanding?: number } = {}): ToolActivityDetailStaging =>
    createToolActivityDetailStaging({
      runArtifactsDir,
      port,
      appendRunEvent: (input) => events.appendStaged(input),
      checkpointInput,
      now: () => clock,
      ...options
    })

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    runArtifactsDir = path.join(root, 'run-artifacts')
    runEventsDir = path.join(root, 'run-events')
    port = new HeldPort(root)
    notes = []
    // A writer that leaves syncing to a barrier: a staged append must note nothing to it.
    events = new RunEventLedgerWriter({
      runEventsDir,
      runArtifactsDir,
      noteDurabilityDebt: (chatId, debt) => notes.push([chatId, debt])
    })
    syncs = countSyncs()
    clock = 1_000
    staging = make()
  })

  afterEach(() => {
    syncs.dispose()
    vi.restoreAllMocks()
    removeTemporaryDirectory(root)
  })

  const detailFile = (run: string): string =>
    path.join(runArtifactsDir, run, TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME)
  const ledger = (run: string): string => path.join(runEventsDir, `${run}.jsonl`)
  /** One save: stage each activity for its run, then commit. */
  const save = (
    staged: Array<[string, ToolActivity]>,
    chatId = CHAT
  ): Array<ToolActivityDetailRef | null> => {
    const batch = staging.batch(chat(chatId))
    const refs = staged.map(([run, detail]) => batch.stage(run, detail))
    expect(batch.commit()).toEqual([])
    return refs
  }

  it('keeps a row inline, and hands its ref to a later save only once bytes, folders and checkpoint are synced', async () => {
    const detail = activity('tool-1')
    expect(save([['run-1', detail]])).toEqual([null])
    // Written, not synced: on the calling thread nothing synced at all.
    expect(fs.existsSync(detailFile('run-1'))).toBe(true)
    expect(syncs.issued).toEqual([])
    expect(port.pending()).toEqual([
      `file:run-artifacts/run-1/${TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME}`
    ])

    // Each step of the batch: no save gets the ref until the last is done.
    expect(save([['run-1', detail]])).toEqual([null])
    await port.settle()
    expect(port.pending()).toEqual([
      'directory:run-artifacts/run-1',
      'directory:run-artifacts',
      'directory:.'
    ])
    expect(fs.existsSync(ledger('run-1'))).toBe(false)
    expect(save([['run-1', detail]])).toEqual([null])
    await port.settle()
    // The checkpoint is appended once the detail is safe, then synced in its turn.
    expect(eventsIn(ledger('run-1')).map((record) => record.payload)).toEqual([
      expect.objectContaining({ type: 'tool_activity_detail_checkpoint', offset: 0 })
    ])
    expect(port.pending()).toEqual(['file:run-events/run-1.jsonl'])
    expect(save([['run-1', detail]])).toEqual([null])
    await port.settle()
    expect(port.pending()).toEqual(['directory:.', 'directory:run-events'])
    expect(save([['run-1', detail]])).toEqual([null])
    await port.settle()
    expect(port.pending()).toEqual([])

    const [ref] = save([['run-1', detail]])
    expect(ref).toMatchObject({ runId: 'run-1', activityId: 'tool-1', offset: 0 })
    expect(readToolActivityDetailSync(runArtifactsDir, ref!)).toEqual(detail)
    expect(port.classes.every((each) => each === 'background')).toBe(true)
    expect(syncs.issued).toEqual([])
    expect(notes).toEqual([])
    expect(staging.snapshot()).toMatchObject({
      outstanding: 0,
      readyRefs: 0,
      batches: { committed: 1, durable: 1, failed: 0, dropped: 0 },
      rows: { swapped: 1, staged: 1, passedOver: 4 },
      checkpointEvents: 1
    })
  })

  it('asks for every directory on the path to each segment, once each, folders that were there already included', async () => {
    // A run's raw output made its folder without a sync, before any detail.
    fs.mkdirSync(path.join(runArtifactsDir, 'run-1'), { recursive: true })
    fs.writeFileSync(path.join(runArtifactsDir, 'run-1', 'stdout.log'), 'output\n')
    save([
      ['run-1', activity('tool-1')],
      ['run-2', activity('tool-2')],
      ['run-1', activity('tool-3')]
    ])
    await port.settle()

    expect(port.pending()).toEqual([
      'directory:run-artifacts/run-1',
      'directory:run-artifacts/run-2',
      'directory:run-artifacts',
      'directory:.'
    ])
  })

  it('passes over a row without serializing it while the thread has a batch outstanding', async () => {
    save([['run-1', activity('tool-1')]])
    let reads = 0
    const watched = activity('tool-2')
    Object.defineProperty(watched, 'rawResultEvent', {
      enumerable: true,
      get: () => {
        reads += 1
        return { output: 'output of tool-2' }
      }
    })

    expect(save([['run-1', watched]])).toEqual([null])
    expect(reads).toBe(0)
    expect(port.asked).toHaveLength(1)
    expect(staging.snapshot()).toMatchObject({ rows: { staged: 1, passedOver: 1 } })

    await port.drain()
    expect(save([['run-1', watched]])).toEqual([null])
    expect(reads).toBeGreaterThan(0)
    expect(staging.snapshot()).toMatchObject({ rows: { staged: 2 }, outstanding: 1 })
  })

  it(`admits at most ${TOOL_DETAIL_STAGING_OUTSTANDING} batches outstanding across threads`, async () => {
    for (let index = 1; index <= TOOL_DETAIL_STAGING_OUTSTANDING + 1; index += 1) {
      save([[`run-${index}`, activity(`tool-${index}`)]], `chat-${index}`)
    }
    expect(staging.snapshot()).toMatchObject({
      outstanding: TOOL_DETAIL_STAGING_OUTSTANDING,
      rows: { staged: TOOL_DETAIL_STAGING_OUTSTANDING, passedOver: 1 }
    })
    expect(fs.existsSync(detailFile(`run-${TOOL_DETAIL_STAGING_OUTSTANDING + 1}`))).toBe(false)

    await port.drain()
    const last = TOOL_DETAIL_STAGING_OUTSTANDING + 1
    save([[`run-${last}`, activity(`tool-${last}`)]], `chat-${last}`)
    expect(staging.snapshot()).toMatchObject({ outstanding: 1 })
    expect(fs.existsSync(detailFile(`run-${last}`))).toBe(true)
  })

  it('gives a ref only for the bytes it names, and stages an activity that changed again', async () => {
    save([['run-1', activity('tool-1')]])
    await port.drain()

    const changed = activity('tool-1', 'a longer output, written after the first')
    expect(save([['run-1', changed]])).toEqual([null])
    expect(staging.snapshot()).toMatchObject({ readyRefs: 0, outstanding: 1 })
    await port.drain()

    const [ref] = save([['run-1', changed]])
    expect(readToolActivityDetailSync(runArtifactsDir, ref!)).toEqual(changed)
    expect(ref!.offset).toBeGreaterThan(0)
  })

  it('gives the same ref to an activity met twice in one save, and spends it only when the save commits', async () => {
    save([['run-1', activity('tool-1')]])
    await port.drain()

    const unfinished = staging.batch(chat())
    const first = unfinished.stage('run-1', activity('tool-1'))
    expect(unfinished.stage('run-1', activity('tool-1'))).toBe(first)
    // A save that never commits, as one whose preparation threw, spends nothing.
    expect(staging.snapshot().readyRefs).toBe(1)

    const [again] = save([['run-1', activity('tool-1')]])
    expect(again).toEqual(first)
    expect(staging.snapshot()).toMatchObject({ readyRefs: 0, threads: 0 })
  })

  it('keeps the refs of one durable batch a thread has not used, and drops them when its next is durable', async () => {
    save([
      ['run-1', activity('tool-1')],
      ['run-1', activity('tool-2')]
    ])
    await port.drain()
    expect(staging.snapshot().readyRefs).toBe(2)

    // The next save no longer holds those rows; it stages others.
    save([['run-2', activity('tool-3')]])
    expect(staging.snapshot().readyRefs).toBe(2)
    await port.drain()

    expect(staging.snapshot()).toMatchObject({ readyRefs: 1, threads: 1 })
    expect(save([['run-1', activity('tool-1')]])).toEqual([null])
  })

  it('starts nothing for a save that stages nothing new', () => {
    const batch = staging.batch(chat())
    expect(batch.commit()).toEqual([])
    expect(batch.stage('run-1', activity('tool-1'))).toBeNull()
    expect(batch.commit()).toEqual([])
    expect(port.asked).toEqual([])
    expect(staging.snapshot()).toMatchObject({ threads: 0, batches: { committed: 0 } })
  })

  describe('a batch that fails', () => {
    const fileOf = (run: string): string =>
      `file:run-artifacts/${run}/${TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME}`

    it(`never gives its refs, and lets the thread stage again after ${TOOL_DETAIL_STAGING_FIRST_BACKOFF_MS} ms, doubling to ${TOOL_DETAIL_STAGING_LONGEST_BACKOFF_MS}`, async () => {
      /** Fail the batch outstanding, then count the milliseconds until a save stages again. */
      const failThenWait = async (run: string): Promise<number> => {
        expect(staging.snapshot().outstanding).toBe(1)
        await port.settle({ [fileOf(run)]: new Error('EIO: i/o error, fsync') })
        expect(port.pending()).toEqual([])
        // Never usable, and not stageable again until the backoff is over.
        const failedAt = clock
        let waited = 0
        while (save([[run, activity(run)]])[0] === null && staging.snapshot().outstanding === 0) {
          waited += 1
          clock = failedAt + waited
        }
        return waited
      }
      expect(save([['run-1', activity('run-1')]])).toEqual([null])
      const backoffs: number[] = []
      for (let failure = 0; failure < 8; failure += 1) backoffs.push(await failThenWait('run-1'))

      expect(backoffs).toEqual([100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000])
      expect(staging.snapshot()).toMatchObject({ batches: { failed: 8, durable: 0 }, readyRefs: 0 })

      // A batch that is durable ends the backoff: the next failure waits the first one again.
      await port.drain()
      expect(staging.snapshot().batches.durable).toBe(1)
      expect(save([['run-1', activity('run-1')]])[0]).not.toBeNull()
      expect(save([['run-2', activity('run-2')]])).toEqual([null])
      expect(await failThenWait('run-2')).toBe(TOOL_DETAIL_STAGING_FIRST_BACKOFF_MS)
    })

    it('fails when a sync finds its path gone, file or directory', async () => {
      save([['run-1', activity('tool-1')]])
      await port.settle({ [fileOf('run-1')]: 'missing' })
      clock += TOOL_DETAIL_STAGING_FIRST_BACKOFF_MS
      save([['run-1', activity('tool-1')]])
      await port.settle()
      await port.settle({ 'directory:run-artifacts/run-1': 'missing' })

      expect(port.pending()).toEqual([])
      expect(fs.existsSync(ledger('run-1'))).toBe(false)
      expect(staging.snapshot()).toMatchObject({ batches: { failed: 2 }, readyRefs: 0 })
    })

    it('fails when its checkpoint cannot be appended, or its ledger synced', async () => {
      const append = vi.spyOn(events, 'appendStaged').mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device, write')
      })
      save([['run-1', activity('tool-1')]])
      await port.settle()
      await port.settle()
      expect(append).toHaveBeenCalledOnce()
      expect(port.pending()).toEqual([])

      clock += TOOL_DETAIL_STAGING_FIRST_BACKOFF_MS
      save([['run-1', activity('tool-1')]])
      await port.settle()
      await port.settle()
      await port.settle({ 'file:run-events/run-1.jsonl': new Error('EIO: i/o error, fsync') })

      expect(port.pending()).toEqual([])
      expect(staging.snapshot()).toMatchObject({ batches: { failed: 2 }, readyRefs: 0 })
    })

    it('throws from the commit whose write fails, and backs off', () => {
      vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device, write')
      })
      const batch = staging.batch(chat())
      batch.stage('run-1', activity('tool-1'))

      expect(() => batch.commit()).toThrow('ENOSPC')
      expect(port.asked).toEqual([])
      expect(staging.snapshot()).toMatchObject({ outstanding: 0, batches: { failed: 1 } })
      expect(save([['run-1', activity('tool-1')]])).toEqual([null])
      expect(staging.snapshot().outstanding).toBe(0)
    })

    it('throws from the commit when the run’s file changed after the save staged, and writes nothing to it', () => {
      const batch = staging.batch(chat())
      expect(batch.stage('run-1', activity('tool-1'))).toBeNull()
      // Another writer adds to the run's file between the save's stage and its commit.
      fs.mkdirSync(path.dirname(detailFile('run-1')), { recursive: true })
      fs.writeFileSync(detailFile('run-1'), 'another writer\n')

      expect(() => batch.commit()).toThrow('Tool detail artifact changed while staging run run-1')
      expect(fs.readFileSync(detailFile('run-1'), 'utf8')).toBe('another writer\n')
      expect(port.asked).toEqual([])
      expect(staging.snapshot()).toMatchObject({
        outstanding: 0,
        batches: { committed: 0, failed: 1 }
      })
    })
  })

  describe('a thread that goes away', () => {
    it('is forgotten on erasure: its running batch appends nothing and is ignored when it ends', async () => {
      save([['run-1', activity('tool-1')]])
      staging.forget(CHAT)
      await port.drain()

      expect(fs.existsSync(ledger('run-1'))).toBe(false)
      expect(staging.snapshot()).toMatchObject({
        threads: 0,
        outstanding: 0,
        readyRefs: 0,
        batches: { dropped: 1, durable: 0 }
      })
      // The thread can stage afresh if it is ever saved again.
      expect(save([['run-1', activity('tool-1')]])).toEqual([null])
      expect(staging.snapshot().outstanding).toBe(1)
    })

    it('forgets every thread at a global clear', async () => {
      save([['run-1', activity('tool-1')]], 'chat-1')
      save([['run-2', activity('tool-2')]], 'chat-2')
      await port.settle()
      staging.forgetAll()
      await port.drain()

      expect(staging.snapshot()).toMatchObject({ threads: 0, batches: { dropped: 2 } })
    })

    it('is abandoned at quit: nothing more is staged, and what runs is not waited for', async () => {
      save([['run-1', activity('tool-1')]])
      await port.settle()
      staging.abandon()
      expect(save([['run-2', activity('tool-2')]])).toEqual([null])
      await port.drain()

      expect(fs.existsSync(ledger('run-1'))).toBe(false)
      expect(fs.existsSync(detailFile('run-2'))).toBe(false)
      expect(staging.snapshot()).toMatchObject({ threads: 0, batches: { dropped: 1 } })
    })
  })

  it('writes the bytes and checkpoints a writer that syncs writes', async () => {
    const elsewhere = path.join(root, 'synced', 'run-artifacts')
    const staged: Array<[string, ToolActivity]> = [
      ['run-1', activity('tool-1')],
      ['run-2', activity('tool-2')],
      ['run-1', activity('tool-3')]
    ]
    const synced = new ToolActivityDetailBatchWriter(elsewhere)
    const syncedRefs = staged.map(([run, detail]) => synced.stage(run, detail))
    const checkpoints = synced.commit()

    save(staged)
    await port.drain()
    const refs = save(staged)

    expect(refs).toEqual(syncedRefs)
    for (const run of ['run-1', 'run-2']) {
      expect(fs.readFileSync(detailFile(run))).toEqual(
        fs.readFileSync(path.join(elsewhere, run, TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME))
      )
    }
    const appended = [...eventsIn(ledger('run-1')), ...eventsIn(ledger('run-2'))]
    expect(appended.map((record) => record.payload)).toEqual(
      checkpoints.map((checkpoint) => checkpointInput(chat(), checkpoint).payload)
    )
  })
})
