/**
 * A run-event ledger told to leave syncing to the thread's barrier. An append
 * then only writes, whatever kind of event it is, and says what the disk is
 * owed for it and for which run. The second half runs it over a model of a
 * power loss.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRunEventLine, verifyRunEventHashChain } from '../RunEventStore'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import { readRunEventLedgerHead } from './RunEventLedgerHead'
import {
  RunEventLedgerWriter,
  type RunEventLedgerAppendOptions,
  type RunEventLedgerWriterOptions
} from './RunEventLedgerWriter'
import {
  createThreadDurabilityDebt,
  type NoteThreadDurabilityDebt,
  type ThreadDurabilityDebt,
  type ThreadDurabilityDebtNote
} from './ThreadDurabilityDebt'
import { readToolActivityDetailSync } from './ToolActivityDetailLedger'
import { createToolActivityDetailStaging } from './ToolActivityDetailStaging'
import type { ChatRecord, RunEventInput, RunEventRecord, ToolActivity } from './types'
import {
  countSyncs,
  watchCrashDisk,
  type CrashDisk,
  type SyncCount
} from './unsyncedWriteCrashDisk.testutil'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-run-events-unsynced-'

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
const RUN = 'run-1'

/** Event `index` of a run. Ids and times are fixed so two writers given the same events write the same bytes. */
function event(index: number, overrides: Partial<RunEventInput> = {}): RunEventInput {
  return {
    id: `event-${index}`,
    runId: RUN,
    chatId: CHAT,
    kind: 'provider_raw',
    phase: 'raw',
    source: 'provider',
    payload: { data: `output ${index}\n` },
    timestamp: '2026-10-04T00:00:00.000Z',
    ...overrides
  }
}

const lifecycle = (index: number, overrides: Partial<RunEventInput> = {}): RunEventInput =>
  event(index, { kind: 'lifecycle', phase: 'control', payload: { state: 'running' }, ...overrides })

/** A run of events with every kind of sync point in it: strict, lifecycle and each 25th. */
function mixed(count: number): Array<[RunEventInput, RunEventLedgerAppendOptions]> {
  return Array.from({ length: count }, (_unused, offset) => {
    const index = offset + 1
    if (index % 7 === 0) return [event(index), { durability: 'strict' }]
    if (index % 6 === 0) return [lifecycle(index), {}]
    return [event(index), {}]
  })
}

function recordsIn(file: string): RunEventRecord[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map(parseRunEventLine)
    .filter((record): record is RunEventRecord => record !== null)
}

describe('a run-event ledger that leaves syncing to the thread barrier', () => {
  let root: string
  let runEventsDir: string
  let runArtifactsDir: string
  let ledger: string
  let syncs: SyncCount
  let notes: Array<[string, ThreadDurabilityDebtNote]>
  const note: NoteThreadDurabilityDebt = (chatId, debt) => {
    notes.push([chatId, debt])
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    runEventsDir = path.join(root, 'run-events')
    runArtifactsDir = path.join(root, 'run-artifacts')
    ledger = path.join(runEventsDir, `${RUN}.jsonl`)
    syncs = countSyncs()
    notes = []
  })

  afterEach(() => {
    syncs.dispose()
    vi.restoreAllMocks()
    removeTemporaryDirectory(root)
  })

  const writer = (options: Partial<RunEventLedgerWriterOptions> = {}): RunEventLedgerWriter =>
    new RunEventLedgerWriter({
      runEventsDir,
      runArtifactsDir,
      noteDurabilityDebt: note,
      ...options
    })
  const owedFile = (run = RUN): [string, ThreadDurabilityDebtNote] => [
    CHAT,
    { file: path.join(runEventsDir, `${run}.jsonl`), owner: 'run-events', run }
  ]
  const owedDirectory = (directory: string, run = RUN): [string, ThreadDurabilityDebtNote] => [
    CHAT,
    { directory, run }
  ]

  it('writes a long run of events, strict, lifecycle and every 25th among them, without one sync', () => {
    const moments: string[] = []
    const unsynced = writer({ residualObserver: (counter) => moments.push(counter) })
    const written = mixed(120).map(([input, options]) => unsynced.append(input, options))

    expect(syncs.issued).toEqual([])
    expect(moments).toEqual([])
    expect(recordsIn(ledger)).toEqual(written)
    expect(written.map((record) => record.sequence)).toEqual(
      Array.from({ length: 120 }, (_unused, index) => index + 1)
    )
    expect(verifyRunEventHashChain(recordsIn(ledger))).toBe(true)
  })

  it('a writer that syncs issues one for each strict event, each lifecycle event and each 25th', () => {
    const synced = writer({ noteDurabilityDebt: undefined })
    for (const [input, options] of mixed(120)) synced.append(input, options)

    // 17 strict, 18 lifecycle that are not also strict, and events 25, 50, 75 and 100.
    expect(syncs.issued).toHaveLength(17 + 18 + 4)
    expect(notes).toEqual([])
  })

  it('notes the file of the run for every event, and each directory in which its first event made a name', () => {
    const unsynced = writer()

    unsynced.append(event(1))
    expect(notes).toEqual([owedDirectory(root), owedFile(), owedDirectory(runEventsDir)])

    notes.length = 0
    unsynced.append(lifecycle(2))
    unsynced.append(event(3), { durability: 'strict' })
    expect(notes).toEqual([owedFile(), owedFile()])

    // A second run adds a name to the directory the first one made.
    notes.length = 0
    unsynced.append(event(1, { runId: 'run-2' }), { durability: 'strict' })
    expect(notes).toEqual([owedFile('run-2'), owedDirectory(runEventsDir, 'run-2')])
    expect(syncs.issued).toEqual([])
  })

  it('writes the same bytes as a writer that syncs, through a torn tail and a missing final newline', () => {
    const elsewhere = path.join(root, 'synced')
    const synced = new RunEventLedgerWriter({
      runEventsDir: path.join(elsewhere, 'run-events'),
      runArtifactsDir: path.join(elsewhere, 'run-artifacts')
    })
    const other = path.join(elsewhere, 'run-events', `${RUN}.jsonl`)
    const unsynced = writer()
    const both = (index: number, options: RunEventLedgerAppendOptions = {}): void => {
      synced.append(index % 2 ? event(index) : lifecycle(index), options)
      unsynced.append(index % 2 ? event(index) : lifecycle(index), options)
    }
    /** Damage both ledgers the same way, and make both writers look at the file again. */
    const damage = (change: (file: string) => void): void => {
      for (const file of [other, ledger]) change(file)
      synced.forgetHead(RUN)
      unsynced.forgetHead(RUN)
    }

    both(1)
    both(2, { durability: 'strict' })
    damage((file) => fs.appendFileSync(file, '{"schemaVersion":1,"sequence":3,"runI'))
    both(3)
    damage((file) => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trimEnd()))
    both(4)
    both(5, { durability: 'strict' })

    expect(fs.readFileSync(ledger)).toEqual(fs.readFileSync(other))
    expect(recordsIn(ledger).map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(verifyRunEventHashChain(recordsIn(ledger))).toBe(true)
    expect(notes.filter(([, debt]) => 'file' in debt)).toHaveLength(5)
  })

  it('syncs an event that names no thread as it always did, and owes nothing for it', () => {
    const elsewhere = path.join(root, 'synced')
    const synced = new RunEventLedgerWriter({
      runEventsDir: path.join(elsewhere, 'run-events'),
      runArtifactsDir: path.join(elsewhere, 'run-artifacts')
    })
    const unthreaded = (index: number): RunEventInput => event(index, { chatId: undefined })
    const run = (target: RunEventLedgerWriter): string[] => {
      syncs.issued.length = 0
      target.append(unthreaded(1), { durability: 'strict' })
      target.append(lifecycle(2, { chatId: undefined }))
      target.append(unthreaded(3))
      target.append(event(4, { chatId: '' }), { durability: 'strict' })
      return [...syncs.issued]
    }
    const moments: string[] = []

    const expected = run(synced)
    const issued = run(writer({ residualObserver: (counter) => moments.push(counter) }))

    expect(expected.length).toBeGreaterThanOrEqual(3)
    expect(issued).toEqual(expected)
    expect(moments).toEqual(['strictRunEventFsyncs', 'strictRunEventFsyncs'])
    expect(notes).toEqual([])
  })

  it('fails an append whose write fails, owes nothing for the event and does not move the head', () => {
    const unsynced = writer()
    const first = unsynced.append(event(1))
    notes.length = 0
    const close = vi.spyOn(fs, 'closeSync')
    const realWrite = fs.writeFileSync.bind(fs)
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((fd, data) => {
      realWrite(fd, String(data).slice(0, 40))
      throw new Error('partial write failure')
    })

    expect(() => unsynced.append(event(2), { durability: 'strict' })).toThrow(
      'partial write failure'
    )
    expect(close).toHaveBeenCalledOnce()
    expect(notes).toEqual([])
    write.mockRestore()

    const second = unsynced.append(event(2))
    expect(second).toMatchObject({ sequence: 2, previousHash: first.hash })
    expect(recordsIn(ledger)).toEqual([first, second])
    expect(verifyRunEventHashChain(recordsIn(ledger))).toBe(true)
    expect(notes).toEqual([owedFile()])
    expect(syncs.issued).toEqual([])
  })

  it('notes the folders the raw output of a run makes, and nothing for the output itself', () => {
    const unsynced = writer()
    const raw = { storeRawEvents: true }

    const first = unsynced.append(event(1), raw)
    expect(first.artifacts).toHaveLength(1)
    expect(notes).toEqual([
      owedDirectory(root),
      owedDirectory(runArtifactsDir),
      owedDirectory(root),
      owedFile(),
      owedDirectory(runEventsDir)
    ])

    notes.length = 0
    unsynced.append(event(2), raw)
    unsynced.append(event(3, { kind: 'provider_error', payload: { error: 'failed\n' } }), raw)
    expect(notes).toEqual([owedFile(), owedFile()])

    // Another run makes its own folder beside the first.
    notes.length = 0
    unsynced.append(event(1, { runId: 'run-2' }), raw)
    expect(notes).toEqual([
      owedDirectory(runArtifactsDir, 'run-2'),
      owedFile('run-2'),
      owedDirectory(runEventsDir, 'run-2')
    ])
    expect(fs.readFileSync(path.join(runArtifactsDir, RUN, 'stdout.log'), 'utf8')).toBe(
      'output 1\noutput 2\n'
    )
    expect(syncs.issued).toEqual([])
  })

  it('notes nothing for raw output when the event names no thread, or when it was not asked to', () => {
    const raw = { storeRawEvents: true }
    writer().append(event(1, { chatId: undefined }), raw)
    writer({ noteDurabilityDebt: undefined }).append(event(1, { runId: 'run-2' }), raw)

    expect(notes).toEqual([])
    expect(fs.existsSync(path.join(runArtifactsDir, RUN, 'stdout.log'))).toBe(true)
    expect(fs.existsSync(path.join(runArtifactsDir, 'run-2', 'stdout.log'))).toBe(true)
  })

  it('leaves the flusher out of it when it is given one as well', () => {
    const flusher = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (fd, complete) => {
        fs.fsyncSync(fd)
        complete()
        return { joinSync: () => {} }
      },
      fsyncSync: (fd) => fs.fsyncSync(fd),
      close: (fd) => fs.closeSync(fd)
    })
    const opened = vi.spyOn(flusher, 'open')
    const unsynced = writer({ durabilityFlusher: flusher })

    unsynced.append(event(1), { durability: 'strict' })
    unsynced.append(lifecycle(2))
    unsynced.drainDurabilitySync()

    expect(opened).not.toHaveBeenCalled()
    expect(syncs.issued).toEqual([])
    expect(notes).toEqual([
      owedDirectory(root),
      owedFile(),
      owedDirectory(runEventsDir),
      owedFile()
    ])
  })
})

describe.skipIf(process.platform === 'win32')(
  'what a power loss leaves of a run-event ledger that does not sync',
  () => {
    let root: string
    let runEventsDir: string
    let ledger: string
    let disk: CrashDisk
    let debt: ThreadDurabilityDebt

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
      runEventsDir = path.join(root, 'run-events')
      ledger = path.join(runEventsDir, `${RUN}.jsonl`)
      disk = watchCrashDisk(root)
      debt = createThreadDurabilityDebt({ port: disk.port })
    })

    afterEach(() => {
      disk.dispose()
      removeTemporaryDirectory(root)
    })

    const writer = (options: Partial<RunEventLedgerWriterOptions> = {}): RunEventLedgerWriter =>
      new RunEventLedgerWriter({
        runEventsDir,
        runArtifactsDir: path.join(root, 'run-artifacts'),
        noteDurabilityDebt: debt.note,
        ...options
      })

    it('keeps every event a barrier covered and loses the events after it', async () => {
      const unsynced = writer()
      const first = unsynced.append(event(1))
      const second = unsynced.append(lifecycle(2))
      const third = unsynced.append(event(3), { durability: 'strict' })
      await debt.barrier(CHAT)
      unsynced.append(lifecycle(4))
      unsynced.append(event(5), { durability: 'strict' })

      expect(disk.issued).toEqual([])
      expect(disk.paid).toEqual([
        `file:run-events/${RUN}.jsonl`,
        'directory:.',
        'directory:run-events'
      ])
      disk.powerLoss()

      expect(recordsIn(ledger)).toEqual([first, second, third])
      expect(readRunEventLedgerHead(ledger)).toEqual({ sequence: 3, hash: third.hash })
      // A writer started after the loss carries the chain on from what is left.
      const next = writer().append(event(4))
      expect(next).toMatchObject({ sequence: 4, previousHash: third.hash })
      expect(verifyRunEventHashChain(recordsIn(ledger))).toBe(true)
    })

    it('loses the whole ledger, and the directory made for it, when no barrier was raised', () => {
      const unsynced = writer()
      unsynced.append(event(1), { durability: 'strict' })
      unsynced.append(lifecycle(2))

      disk.powerLoss()

      expect(fs.existsSync(runEventsDir)).toBe(false)
      expect(readRunEventLedgerHead(ledger)).toBeNull()
      // The run starts again at the beginning of its chain.
      expect(writer().append(event(1))).toMatchObject({ sequence: 1 })
    })

    it('a writer that syncs keeps a strict event, name and all', () => {
      const synced = writer({ noteDurabilityDebt: undefined })
      const strict = synced.append(event(1), { durability: 'strict' })

      disk.powerLoss()

      expect(recordsIn(ledger)).toEqual([strict])
    })

    it('makes the folder a run was given by its raw output safe for the detail staged into it later', async () => {
      const runArtifactsDir = path.join(root, 'run-artifacts')
      const events = writer()
      events.append(event(1), { storeRawEvents: true })
      const detail: ToolActivity = {
        id: 'tool-1',
        toolName: 'run_shell_command',
        displayName: 'Ran command',
        category: 'shell',
        status: 'success',
        rawResultEvent: { output: 'done' }
      }
      const chat = { appChatId: CHAT, messages: [], runs: [] } as unknown as ChatRecord
      const staging = createToolActivityDetailStaging({
        runArtifactsDir,
        port: disk.port,
        appendRunEvent: (input) => events.appendStaged(input),
        checkpointInput: (_chat, checkpoint) => ({
          ...event(2, { kind: 'tool', phase: 'artifact', source: 'main' }),
          payload: { type: 'tool_activity_detail_checkpoint', sha256: checkpoint.sha256 }
        })
      })
      const first = staging.batch(chat)
      expect(first.stage(RUN, detail)).toBeNull()
      first.commit()
      await vi.waitFor(() => expect(staging.snapshot().batches.durable).toBe(1))
      // No barrier: the staging's own syncs made the folder safe, and the detail in it.
      const next = staging.batch(chat)
      const ref = next.stage(RUN, detail)!
      next.commit()

      disk.powerLoss()

      expect(readToolActivityDetailSync(runArtifactsDir, ref)).toEqual(detail)
      // The raw output was never owed. Its name came back with the folder's
      // other names; its bytes did not.
      expect(fs.readFileSync(path.join(runArtifactsDir, RUN, 'stdout.log'), 'utf8')).toBe('')
    })

    it('keeps a second run in the same directory only once a barrier has covered its name', async () => {
      const unsynced = writer()
      unsynced.append(event(1))
      await debt.barrier(CHAT)
      const other = path.join(runEventsDir, 'run-2.jsonl')
      unsynced.append(event(1, { runId: 'run-2' }), { durability: 'strict' })

      disk.powerLoss()
      expect(fs.existsSync(other)).toBe(false)
      expect(fs.existsSync(ledger)).toBe(true)

      const again = writer().append(event(1, { runId: 'run-2' }))
      await debt.barrier(CHAT)
      disk.powerLoss()
      expect(recordsIn(other)).toEqual([again])
    })
  }
)
