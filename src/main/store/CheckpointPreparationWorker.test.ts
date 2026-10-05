import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { electronUtilityProcess } from '../host/HostThreadRecordTransferTransport'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { prepareCheckpoint } from './CheckpointPreparationCore'
import {
  checkpointFileReference,
  type CheckpointPreparationReply,
  type CheckpointPreparationRequest,
  type CheckpointPreparationSource
} from './CheckpointPreparationProtocol'
import {
  CheckpointPreparationWorker,
  checkpointPreparationReservationBytes,
  DEFAULT_CHECKPOINT_PREPARATION_BUDGET_BYTES,
  isCheckpointPreparationWorkerEnabled,
  type CheckpointPreparationProcess
} from './CheckpointPreparationWorker'
import type { ChatRecord } from './types'

vi.mock('../host/HostThreadRecordTransferTransport', () => ({
  electronUtilityProcess: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }
})

/** The prefix of the one folder this file makes in the system's temporary folder. */
const TEMPORARY_PREFIX = 'itp-checkpoint-worker-'

/** Remove, with all it holds, the folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(made: string): void {
  const temporary = tmpdir()
  const prefix = temporary + path.sep + TEMPORARY_PREFIX
  if (
    made === temporary ||
    !made.startsWith(prefix) ||
    made.length <= prefix.length ||
    path.dirname(made) !== temporary
  )
    throw new Error(`Refusing to remove ${made}: not the folder this file made`)
  fs.rmSync(made, { recursive: true, force: true })
}

let directory: string
let entryPath: string
let actualFs: typeof import('node:fs')
beforeAll(async () => {
  actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
  directory = fs.mkdtempSync(path.join(tmpdir(), TEMPORARY_PREFIX))
  entryPath = path.join(directory, 'checkpointPreparationWorker.cjs')
  await build({
    entryPoints: ['src/main/workers/checkpointPreparationWorker.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: entryPath,
    logLevel: 'silent'
  })
})
afterAll(() => removeTemporaryDirectory(directory))
afterEach(() => {
  vi.mocked(fs.fsyncSync).mockImplementation(actualFs.fsyncSync)
  vi.mocked(electronUtilityProcess).mockReset()
})

function fixture(id = 'chat-1', preparation?: CheckpointPreparationWorker) {
  const baseDir = fs.mkdtempSync(path.join(directory, 'journal-'))
  const journal = createIncrementalChatJournal(baseDir, { checkpointPreparation: preparation })
  const before: ChatRecord = {
    appChatId: id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    persistenceRevision: 1,
    messages: [
      { id: 'message', role: 'assistant', content: 'before', timestamp: '2026-09-24T00:00:00Z' }
    ],
    runs: []
  }
  const after = structuredClone(before)
  after.persistenceRevision = 2
  after.updatedAt = 2
  after.messages[0].content = 'after 🧵\n' + 'x'.repeat(100_000)
  journal.initialize(id, before)
  journal.append(deriveChatRecordMutation(before, after))
  const source: CheckpointPreparationSource = {
    chatId: id,
    revision: 2,
    savedAt: '2026-09-24T00:00:00Z',
    checkpoint: checkpointFileReference(path.join(baseDir, `${id}.checkpoint.json`)),
    journal: checkpointFileReference(path.join(baseDir, `${id}.mutations.jsonl`))
  }
  return { baseDir, journal, before, after, source }
}

describe('checkpoint preparation process', () => {
  it('integrates the real child with journal adoption and recovery', async () => {
    const preparation = new CheckpointPreparationWorker({ entryPath })
    const { journal, baseDir, after } = fixture('integrated', preparation)
    await expect(journal.checkpointDeferred!('integrated')).resolves.toBe('checkpointed')
    expect(preparation.stats()).toEqual({ activeJobs: 0, reservedBytes: 0 })
    expect(createIncrementalChatJournal(baseDir).replay('integrated').record).toEqual(after)
    expect(fs.readdirSync(baseDir)).toEqual(['integrated.checkpoint.json'])
  })

  it('is opt-in with an exact 1', () => {
    expect(isCheckpointPreparationWorkerEnabled({})).toBe(false)
    expect(isCheckpointPreparationWorkerEnabled({ TASKWRAITH_CHECKPOINT_WORKER: 'true' })).toBe(
      false
    )
    expect(isCheckpointPreparationWorkerEnabled({ TASKWRAITH_CHECKPOINT_WORKER: '1' })).toBe(true)
  })

  it('replays a captured source in a real child and returns only a bounded descriptor', async () => {
    const { source, after } = fixture()
    const worker = new CheckpointPreparationWorker({ entryPath })
    const job = worker.start(source)!
    try {
      const prepared = await job.result
      const bytes = fs.readFileSync(job.output.path)
      expect(JSON.parse(bytes.toString()).record).toEqual(after)
      expect(prepared).toEqual({
        chatId: 'chat-1',
        revision: 2,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        identity: checkpointFileReference(job.output.path).identity
      })
      expect(JSON.stringify(prepared).length).toBeLessThan(600)
      expect(worker.stats().activeJobs).toBe(1) // custody survives process exit
    } finally {
      job.release()
    }
    expect(worker.stats()).toEqual({ activeJobs: 0, reservedBytes: 0 })
    expect(fs.existsSync(job.output.path)).toBe(false)
  })

  it('admits two independent jobs and refuses saturation before making any temp', async () => {
    const a = fixture('a')
    const b = fixture('b')
    const worker = new CheckpointPreparationWorker({ entryPath, maxJobs: 2 })
    const first = worker.start(a.source)!
    const second = worker.start(b.source)!
    const before = fs.readdirSync(a.baseDir)
    expect(worker.start(a.source)).toBeNull()
    expect(fs.readdirSync(a.baseDir)).toEqual(before)
    try {
      await Promise.all([first.result, second.result])
    } finally {
      first.release()
      second.release()
    }
    expect(worker.stats().reservedBytes).toBe(0)
  })

  it('refuses byte saturation without opening or copying the source', () => {
    const { source, baseDir } = fixture()
    const before = fs.readdirSync(baseDir)
    const worker = new CheckpointPreparationWorker({ entryPath, maxReservedBytes: 1 })
    expect(worker.start(source)).toBeNull()
    expect(fs.readdirSync(baseDir)).toEqual(before)
    expect(worker.stats()).toEqual({ activeJobs: 0, reservedBytes: 0 })
  })

  it('releases the empty output reservation when process creation throws', () => {
    const { source, baseDir } = fixture()
    const before = fs.readdirSync(baseDir)
    const worker = new CheckpointPreparationWorker({
      spawn: () => {
        throw new Error('spawn failed')
      }
    })
    expect(() => worker.start(source)).toThrow('spawn failed')
    expect(worker.stats()).toEqual({ activeJobs: 0, reservedBytes: 0 })
    expect(fs.readdirSync(baseDir)).toEqual(before)
  })

  it('never reports ready when the prepared output cannot be fsynced', () => {
    const { source, baseDir } = fixture()
    const outputPath = path.join(baseDir, 'sync-failure.tmp')
    fs.writeFileSync(outputPath, '')
    const request = {
      ...source,
      output: checkpointFileReference(outputPath),
      maxOutputBytes: 1024 * 1024
    }
    vi.mocked(fs.fsyncSync).mockImplementation(() => {
      throw new Error('fsync failed')
    })
    expect(() => prepareCheckpoint(request)).toThrow('fsync failed')
    expect(checkpointFileReference(source.journal.path)).toEqual(source.journal)
    expect(checkpointFileReference(source.checkpoint.path)).toEqual(source.checkpoint)
    fs.unlinkSync(outputPath)
  })

  it.each(['torn', 'gap', 'wrong-head'] as const)(
    'rejects %s source evidence before producing a ready result',
    (variant) => {
      const { source, baseDir } = fixture()
      if (variant === 'torn') fs.appendFileSync(source.journal.path, '{')
      if (variant === 'gap') {
        const batch = JSON.parse(fs.readFileSync(source.journal.path, 'utf8'))
        batch.baseRevision = 3
        batch.revision = 4
        fs.writeFileSync(source.journal.path, JSON.stringify(batch) + '\n')
      }
      const outputPath = path.join(baseDir, 'invalid-source.tmp')
      fs.writeFileSync(outputPath, '')
      const request = {
        ...source,
        revision: variant === 'wrong-head' ? 5 : 2,
        journal: checkpointFileReference(source.journal.path),
        output: checkpointFileReference(outputPath),
        maxOutputBytes: 1024 * 1024
      }
      expect(() => prepareCheckpoint(request)).toThrow(
        variant === 'torn' ? 'torn' : variant === 'gap' ? 'revision gap' : 'head changed'
      )
      expect(fs.statSync(outputPath).size).toBe(0)
    }
  )

  it('cleans a cancelled job immediately and holds capacity until its child exits', async () => {
    const { source } = fixture()
    const worker = new CheckpointPreparationWorker({ entryPath })
    const job = worker.start(source)!
    const rejected = expect(job.result).rejects.toThrow('cancelled')
    job.cancel()
    expect(fs.existsSync(job.output.path)).toBe(false)
    await rejected
    await expect.poll(() => worker.stats().activeJobs).toBe(0)
  })

  it('keeps the journal after process failure and starts a fresh process next time', async () => {
    const { source } = fixture()
    const crashEntry = path.join(directory, 'crash.cjs')
    fs.writeFileSync(crashEntry, 'process.exit(42)')
    const failing = new CheckpointPreparationWorker({ entryPath: crashEntry })
    const job = failing.start(source)!
    try {
      await expect(job.result).rejects.toThrow('exited without a result')
    } finally {
      job.release()
    }
    expect(failing.stats().activeJobs).toBe(0)
    expect(checkpointFileReference(source.journal.path)).toEqual(source.journal)
    const replacement = new CheckpointPreparationWorker({ entryPath }).start(source)!
    try {
      await expect(replacement.result).resolves.toMatchObject({ revision: 2 })
    } finally {
      replacement.release()
    }
  })

  it.each(['cancelled', 'deadline'] as const)(
    'retires a utility process that spawns after its job was %s',
    async (reason) => {
      const { source } = fixture()
      let spawned = false
      const child = Object.assign(new EventEmitter(), {
        postMessage: vi.fn(),
        kill: vi.fn(() => spawned)
      })
      vi.mocked(electronUtilityProcess).mockReturnValue({ fork: () => child })
      const worker = new CheckpointPreparationWorker({ entryPath, deadlineMs: 5 })
      const job = worker.start(source)!
      const rejected = expect(job.result).rejects.toThrow(reason)
      if (reason === 'cancelled') job.cancel()
      await rejected
      job.release()
      expect(fs.existsSync(job.output.path)).toBe(false)
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(worker.stats().activeJobs).toBe(1)

      spawned = true
      child.emit('spawn')
      expect(child.kill).toHaveBeenCalledTimes(2)
      expect(worker.stats().activeJobs).toBe(1)
      child.emit('exit', 0)
      expect(worker.stats()).toEqual({ activeJobs: 0, reservedBytes: 0 })
      expect(checkpointFileReference(source.journal.path)).toEqual(source.journal)
    }
  )

  it('times out a hung child without a synchronous preparation fallback', async () => {
    const { source } = fixture()
    const hungEntry = path.join(directory, 'hung.cjs')
    fs.writeFileSync(hungEntry, 'setInterval(() => {}, 1000)')
    const worker = new CheckpointPreparationWorker({ entryPath: hungEntry, deadlineMs: 50 })
    const job = worker.start(source)!
    try {
      await expect(job.result).rejects.toThrow('deadline')
    } finally {
      job.release()
    }
    await expect.poll(() => worker.stats().activeJobs).toBe(0)
    expect(checkpointFileReference(source.journal.path)).toEqual(source.journal)
  })

  it('rejects a changed source, a missing output and output overflow without recreating paths', () => {
    const { source, baseDir } = fixture()
    const outputPath = path.join(baseDir, 'prepared.tmp')
    fs.writeFileSync(outputPath, '')
    const request = { ...source, output: checkpointFileReference(outputPath), maxOutputBytes: 16 }
    expect(() => prepareCheckpoint(request)).toThrow('byte budget')
    fs.unlinkSync(outputPath)
    expect(() => prepareCheckpoint(request)).toThrow()
    expect(fs.existsSync(outputPath)).toBe(false)
    fs.writeFileSync(outputPath, '')
    const next = {
      ...request,
      output: checkpointFileReference(outputPath),
      maxOutputBytes: 1024 * 1024
    }
    fs.appendFileSync(source.journal.path, '\n')
    expect(() => prepareCheckpoint(next)).toThrow('changed before')
    expect(fs.statSync(outputPath).size).toBe(0)
  })
})

const MiB = 1024 * 1024

/** A child that folds on this thread when the test says so, and exits when the pool kills it. */
class HeldProcess implements CheckpointPreparationProcess {
  request: CheckpointPreparationRequest | null = null
  private reply: ((reply: CheckpointPreparationReply) => void) | null = null
  private exit: (() => void) | null = null
  private exited = false

  post(request: CheckpointPreparationRequest): void {
    this.request = request
  }
  onMessage(listener: (reply: CheckpointPreparationReply) => void): void {
    this.reply = listener
  }
  onExit(listener: () => void): void {
    this.exit = listener
  }
  onError(): void {
    // A held child never fails to start.
  }
  kill(): void {
    if (this.exited) return
    this.exited = true
    this.exit?.()
  }
  fold(): void {
    this.reply!({ ok: true, prepared: prepareCheckpoint(this.request!) })
  }
}

const sourceBytes = (source: CheckpointPreparationSource): number =>
  source.checkpoint.identity.size + source.journal.identity.size

/** The same source, said to hold `bytes`: admission reads the sizes alone. */
const sized = (
  source: CheckpointPreparationSource,
  bytes: number
): CheckpointPreparationSource => ({
  ...source,
  journal: {
    ...source.journal,
    identity: { ...source.journal.identity, size: bytes - source.checkpoint.identity.size }
  }
})

describe('admission to the checkpoint preparation pool', () => {
  const spawn = (): HeldProcess => new HeldProcess()

  it('reserves each fold the peak its child was measured at: 100 MiB and nine times its source', () => {
    const { source } = fixture()
    const worker = new CheckpointPreparationWorker({ spawn })
    const job = worker.start(source)!
    job.result.catch(() => {})

    expect(checkpointPreparationReservationBytes(sourceBytes(source))).toBe(
      100 * MiB + 9 * sourceBytes(source)
    )
    expect(worker.stats()).toEqual({
      activeJobs: 1,
      reservedBytes: 100 * MiB + 9 * sourceBytes(source)
    })
    job.cancel()
    expect(worker.stats()).toEqual({ activeJobs: 0, reservedBytes: 0 })
  })

  it('runs two folds of up to 31 MiB of source together within the default budget of 768 MiB, and one of 32 MiB alone', () => {
    const a = fixture('a').source
    const b = fixture('b').source
    expect(DEFAULT_CHECKPOINT_PREPARATION_BUDGET_BYTES).toBe(768 * MiB)
    const worker = new CheckpointPreparationWorker({ spawn })

    const both = [worker.start(sized(a, 31 * MiB)), worker.start(sized(b, 31 * MiB))]
    expect(both.every((job) => job !== null)).toBe(true)
    for (const job of both) {
      job!.result.catch(() => {})
      job!.cancel()
    }

    const first = worker.start(sized(a, 32 * MiB))!
    first.result.catch(() => {})
    expect(worker.start(sized(b, 32 * MiB))).toBeNull()
    expect(worker.admits(sized(b, 32 * MiB))).toBe(true)
    first.cancel()
    expect(worker.stats()).toEqual({ activeJobs: 0, reservedBytes: 0 })
  })

  it('never admits an empty source, one that holds more than 64 MiB, or one whose reservation alone passes the budget', () => {
    const { source } = fixture()
    const worker = new CheckpointPreparationWorker({ spawn })
    expect(worker.admits(sized(source, 64 * MiB))).toBe(true)
    expect(worker.admits(sized(source, 64 * MiB + 1))).toBe(false)
    expect(worker.start(sized(source, 64 * MiB + 1))).toBeNull()
    expect(worker.admits({ ...source, chatId: '../escape' })).toBe(false)
    expect(worker.admits(sized(source, 0))).toBe(false)

    const reservation = checkpointPreparationReservationBytes(sourceBytes(source))
    const exact = new CheckpointPreparationWorker({ spawn, maxReservedBytes: reservation })
    const short = new CheckpointPreparationWorker({ spawn, maxReservedBytes: reservation - 1 })
    expect(exact.admits(source)).toBe(true)
    expect(short.admits(source)).toBe(false)
    expect(short.start(source)).toBeNull()
    expect(worker.stats()).toEqual({ activeJobs: 0, reservedBytes: 0 })
  })

  it('tells its listeners when a reservation returns: once its child has exited and its caller released it', async () => {
    const a = fixture('a').source
    const b = fixture('b').source
    const children: HeldProcess[] = []
    const worker = new CheckpointPreparationWorker({
      maxJobs: 1,
      spawn: () => {
        const child = new HeldProcess()
        children.push(child)
        return child
      }
    })
    let heard = 0
    const room: Array<ReturnType<CheckpointPreparationWorker['stats']>> = []
    const stop = worker.onCapacity(() => {
      heard += 1
      room.push(worker.stats())
    })

    const first = worker.start(a)!
    expect(worker.start(b)).toBeNull()
    children[0].fold()
    await first.result
    expect(heard).toBe(0)
    first.release()
    expect(heard).toBe(1)
    // The room is there when they hear of it.
    expect(room).toEqual([{ activeJobs: 0, reservedBytes: 0 }])

    const second = worker.start(b)!
    second.result.catch(() => {})
    stop()
    second.cancel()
    expect(heard).toBe(1)
  })

  it('stops each subscription alone, and a listener that throws stops neither the others nor the release', () => {
    const { source } = fixture()
    const worker = new CheckpointPreparationWorker({ spawn })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let heard = 0
      const listener = (): void => {
        heard += 1
      }
      worker.onCapacity(() => {
        throw new Error('a listener failed')
      })
      const stopFirst = worker.onCapacity(listener)
      worker.onCapacity(listener)
      stopFirst()

      const job = worker.start(source)!
      job.result.catch(() => {})
      job.cancel()

      expect(heard).toBe(1)
      expect(errors).toHaveBeenCalledTimes(1)
      expect(worker.stats()).toEqual({ activeJobs: 0, reservedBytes: 0 })
    } finally {
      errors.mockRestore()
    }
  })
})
