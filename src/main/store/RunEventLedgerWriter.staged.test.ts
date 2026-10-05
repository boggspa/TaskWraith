/**
 * A run-event append whose durability is the caller's. It writes the event
 * without a sync and notes nothing against any thread, and says which file it
 * wrote and which directories gained a name, for the caller to sync before
 * anything relies on the event.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRunEventLine, verifyRunEventHashChain } from '../RunEventStore'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import { RunEventLedgerWriter, type RunEventLedgerWriterOptions } from './RunEventLedgerWriter'
import type { NoteThreadDurabilityDebt, ThreadDurabilityDebtNote } from './ThreadDurabilityDebt'
import type { RunEventInput, RunEventRecord } from './types'
import { countSyncs, type SyncCount } from './unsyncedWriteCrashDisk.testutil'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-run-events-staged-'

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
    kind: 'tool',
    phase: 'artifact',
    source: 'main',
    summary: `Checkpointed tool activity detail ${index}`,
    payload: { type: 'tool_activity_detail_checkpoint', offset: index },
    timestamp: '2026-10-05T00:00:00.000Z',
    ...overrides
  }
}

const lifecycle = (index: number): RunEventInput =>
  event(index, { kind: 'lifecycle', phase: 'control', payload: { state: 'running' } })

function recordsIn(file: string): RunEventRecord[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map(parseRunEventLine)
    .filter((record): record is RunEventRecord => record !== null)
}

describe('a staged run-event append', () => {
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

  it('writes without a sync and notes nothing, whether or not the writer leaves syncing to a barrier', () => {
    const moments: string[] = []
    const owing = writer({ residualObserver: (counter) => moments.push(counter) })
    const syncing = writer({
      noteDurabilityDebt: undefined,
      residualObserver: (counter) => moments.push(counter)
    })

    // A writer that syncs would sync each lifecycle event among these, and the 25th.
    const written = Array.from({ length: 30 }, (_unused, offset) => {
      const index = offset + 1
      const input = index % 6 === 0 ? lifecycle(index) : event(index)
      return [
        owing.appendStaged(input).record.sequence,
        syncing.appendStaged({ ...input, runId: 'run-2' }).record.sequence
      ]
    })

    expect(syncs.issued).toEqual([])
    expect(notes).toEqual([])
    expect(moments).toEqual([])
    expect(written).toEqual(Array.from({ length: 30 }, (_unused, index) => [index + 1, index + 1]))
  })

  it('says which ledger it wrote, and each directory in which it made a name', () => {
    const staged = writer()

    expect(staged.appendStaged(event(1))).toMatchObject({
      file: ledger,
      directories: [root, runEventsDir]
    })
    expect(staged.appendStaged(event(2))).toMatchObject({ file: ledger, directories: [] })
    // A second run adds a name to the directory the first one made.
    expect(staged.appendStaged(event(1, { runId: 'run-2' }))).toEqual({
      record: expect.objectContaining({ runId: 'run-2', sequence: 1 }),
      file: path.join(runEventsDir, 'run-2.jsonl'),
      directories: [runEventsDir]
    })
  })

  it('carries on the run’s chain with ordinary appends, in one ledger', () => {
    const both = writer()
    const first = both.append(event(1))
    const second = both.appendStaged(event(2)).record
    const third = both.append(lifecycle(3))
    const fourth = both.appendStaged(event(4)).record

    expect(second).toMatchObject({ sequence: 2, previousHash: first.hash })
    expect(fourth).toMatchObject({ sequence: 4, previousHash: third.hash })
    expect(recordsIn(ledger)).toEqual([first, second, third, fourth])
    expect(verifyRunEventHashChain(recordsIn(ledger))).toBe(true)
  })

  it('writes the bytes an ordinary append writes, through a torn tail and a missing final newline', () => {
    const elsewhere = path.join(root, 'synced')
    const ordinary = new RunEventLedgerWriter({
      runEventsDir: path.join(elsewhere, 'run-events'),
      runArtifactsDir: path.join(elsewhere, 'run-artifacts')
    })
    const other = path.join(elsewhere, 'run-events', `${RUN}.jsonl`)
    const staged = writer()
    const both = (index: number): void => {
      ordinary.append(event(index))
      staged.appendStaged(event(index))
    }
    /** Damage both ledgers the same way, and make both writers look at the file again. */
    const damage = (change: (file: string) => void): void => {
      for (const file of [other, ledger]) change(file)
      ordinary.forgetHead(RUN)
      staged.forgetHead(RUN)
    }

    both(1)
    both(2)
    damage((file) => fs.appendFileSync(file, '{"schemaVersion":1,"sequence":3,"runI'))
    both(3)
    damage((file) => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trimEnd()))
    both(4)

    expect(fs.readFileSync(ledger)).toEqual(fs.readFileSync(other))
    expect(recordsIn(ledger).map((record) => record.sequence)).toEqual([1, 2, 3, 4])
    expect(verifyRunEventHashChain(recordsIn(ledger))).toBe(true)
  })

  it('fails an append whose write fails, and does not move the head', () => {
    const staged = writer()
    const first = staged.appendStaged(event(1)).record
    const close = vi.spyOn(fs, 'closeSync')
    const realWrite = fs.writeFileSync.bind(fs)
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((fd, data) => {
      realWrite(fd, String(data).slice(0, 40))
      throw new Error('partial write failure')
    })

    expect(() => staged.appendStaged(event(2))).toThrow('partial write failure')
    expect(close).toHaveBeenCalledOnce()
    write.mockRestore()

    const second = staged.appendStaged(event(2)).record
    expect(second).toMatchObject({ sequence: 2, previousHash: first.hash })
    expect(recordsIn(ledger)).toEqual([first, second])
    expect(notes).toEqual([])
    expect(syncs.issued).toEqual([])
  })

  it('writes no raw output for the event', () => {
    const staged = writer()
    staged.appendStaged(
      event(1, { kind: 'provider_raw', phase: 'raw', payload: { data: 'output\n' } })
    )

    expect(fs.existsSync(runArtifactsDir)).toBe(false)
    expect(recordsIn(ledger)).toHaveLength(1)
  })

  it('is refused while the writer keeps its ledgers in the durability flusher', () => {
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
    const flushed = writer({ noteDurabilityDebt: undefined, durabilityFlusher: flusher })

    expect(() => flushed.appendStaged(event(1))).toThrow(
      'A staged run-event append is never made through the durability flusher'
    )
    expect(fs.existsSync(ledger)).toBe(false)
  })
})
