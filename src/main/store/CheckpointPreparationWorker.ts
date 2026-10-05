import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { electronUtilityProcess } from '../host/HostThreadRecordTransferTransport'
import {
  MAX_CHECKPOINT_PREPARATION_SOURCE_BYTES,
  activePreparedCheckpointPaths,
  checkpointFileReference,
  type CheckpointPreparationJob,
  type CheckpointPreparationPort,
  type CheckpointPreparationReply,
  type CheckpointPreparationRequest,
  type CheckpointPreparationSource,
  type PreparedCheckpoint
} from './CheckpointPreparationProtocol'

const MiB = 1024 * 1024
/** The default pool keeps its existing source limit; barrier durability opts in to more. */
const DEFAULT_MAX_SOURCE_BYTES = 64 * MiB

/**
 * What a fold is reserved: its child's peak resident memory as measured, a
 * fixed 100 MiB and nine times its source. Measured on macOS arm64 with 11,
 * 23, 47 and 63 MiB of source: 172, 247, 450 to 487, and 577 MiB.
 */
export function checkpointPreparationReservationBytes(sourceBytes: number): number {
  return 100 * MiB + 9 * sourceBytes
}

/**
 * The most the pool's folds may be reserved at once: two of up to 31 MiB of
 * source each, or one of up to the 64 MiB a source may hold.
 */
export const DEFAULT_CHECKPOINT_PREPARATION_BUDGET_BYTES = 768 * MiB

export function isCheckpointPreparationWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.TASKWRAITH_CHECKPOINT_WORKER === '1'
}

export interface CheckpointPreparationProcess {
  post(request: CheckpointPreparationRequest): void
  onMessage(listener: (reply: CheckpointPreparationReply) => void): void
  onExit(listener: () => void): void
  onError(listener: (error: Error) => void): void
  kill(): void
}

function spawnPreparationProcess(entryPath: string): CheckpointPreparationProcess {
  const utility = electronUtilityProcess()
  if (utility) {
    const child = utility.fork(entryPath, [], { serviceName: 'taskwraith-checkpoint-preparation' })
    let killRequested = false
    // Electron cannot kill a utility process before it has a PID. Retain
    // cancellation/deadline intent and retire it as soon as spawning finishes.
    child.on('spawn', () => {
      if (killRequested) child.kill()
    })
    return {
      post: (request) => child.postMessage(request),
      onMessage: (listener) => {
        child.on('message', (reply) => listener(reply as CheckpointPreparationReply))
      },
      onExit: (listener) => {
        child.on('exit', listener)
      },
      onError: () => {},
      kill: () => {
        killRequested = true
        child.kill()
      }
    }
  }
  if (process.versions.electron)
    throw new Error('Checkpoint preparation requires an Electron utility process')
  const child = fork(entryPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] })
  return {
    post: (request) => {
      child.send(request)
    },
    onMessage: (listener) => {
      child.on('message', (reply) => listener(reply as CheckpointPreparationReply))
    },
    onExit: (listener) => {
      child.once('close', listener)
    },
    onError: (listener) => {
      child.once('error', listener)
    },
    kill: () => {
      child.kill()
    }
  }
}

export type CheckpointPreparationFailureCode =
  | 'spawn'
  | 'post'
  | 'deadline'
  | 'process'
  | 'reply'
  | 'cancelled'

export interface CheckpointPreparationWorkerSnapshot {
  /** Reservations remain held until both child exit and output-custody release. */
  activeJobs: number
  reservedBytes: number
  started: number
  completed: number
  /** Failed admitted attempts, including a spawn failure before a child exists. */
  failed: number
  deadlineExceeded: number
  cancelled: number
  /** One reason per refused start; pure admits() probes change no counters. */
  refusals: {
    invalidSource: number
    sourceTooLarge: number
    jobOverBudget: number
    slotsBusy: number
    aggregateBusy: number
  }
  lastFailureCode: CheckpointPreparationFailureCode | null
}

type SourceRefusal = 'invalidSource' | 'sourceTooLarge' | 'jobOverBudget'

/**
 * Bounded, payload-free admission. Rejection leaves the durable journal for a later idle pass.
 *
 * Each job is a child process of its own. `start` takes one while fewer than
 * `maxJobs` (2) run and the reservations of those running and this one stay
 * within `maxReservedBytes` (768 MiB), a reservation being the child's
 * measured peak (`checkpointPreparationReservationBytes`). Otherwise it
 * returns null and makes nothing. The default source limit is 64 MiB; an
 * explicit pool may admit up to the shared parent/child ceiling. A
 * reservation returns when its child has exited and its caller released it,
 * and `onCapacity` listeners hear of each one.
 */
export class CheckpointPreparationWorker implements CheckpointPreparationPort {
  private active = 0
  private bytes = 0
  private readonly capacityListeners = new Set<() => void>()
  private readonly counts = {
    started: 0,
    completed: 0,
    failed: 0,
    deadlineExceeded: 0,
    cancelled: 0
  }
  private readonly refusals = {
    invalidSource: 0,
    sourceTooLarge: 0,
    jobOverBudget: 0,
    slotsBusy: 0,
    aggregateBusy: 0
  }
  private lastFailureCode: CheckpointPreparationFailureCode | null = null

  constructor(
    private readonly options: {
      entryPath?: string
      maxJobs?: number
      maxReservedBytes?: number
      maxSourceBytes?: number
      deadlineMs?: number
      spawn?: (entryPath: string) => CheckpointPreparationProcess
    } = {}
  ) {
    const limit = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > MAX_CHECKPOINT_PREPARATION_SOURCE_BYTES
    ) {
      throw new Error('Invalid checkpoint preparation source limit')
    }
  }

  stats(): CheckpointPreparationWorkerSnapshot {
    return {
      activeJobs: this.active,
      reservedBytes: this.bytes,
      ...this.counts,
      refusals: { ...this.refusals },
      lastFailureCode: this.lastFailureCode
    }
  }

  admits(source: CheckpointPreparationSource): boolean {
    return this.sourceRefusal(source) === null
  }

  private sourceRefusal(source: CheckpointPreparationSource): SourceRefusal | null {
    const sourceBytes = source.checkpoint.identity.size + source.journal.identity.size
    if (
      !/^[A-Za-z0-9_-]{1,256}$/.test(source.chatId) ||
      !Number.isSafeInteger(sourceBytes) ||
      sourceBytes <= 0
    )
      return 'invalidSource'
    if (sourceBytes > (this.options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES))
      return 'sourceTooLarge'
    if (!(checkpointPreparationReservationBytes(sourceBytes) <= this.budgetBytes()))
      return 'jobOverBudget'
    return null
  }

  private countFailure(code: CheckpointPreparationFailureCode): void {
    this.counts.failed++
    if (code === 'deadline') this.counts.deadlineExceeded++
    if (code === 'cancelled') this.counts.cancelled++
    this.lastFailureCode = code
  }

  onCapacity(listener: () => void): () => void {
    // Its own entry, so that each subscription stops only itself.
    const entry = (): void => listener()
    this.capacityListeners.add(entry)
    return () => {
      this.capacityListeners.delete(entry)
    }
  }

  private budgetBytes(): number {
    return this.options.maxReservedBytes ?? DEFAULT_CHECKPOINT_PREPARATION_BUDGET_BYTES
  }

  start(source: CheckpointPreparationSource): CheckpointPreparationJob | null {
    const sourceBytes = source.checkpoint.identity.size + source.journal.identity.size
    const maxOutputBytes = Math.min(128 * 1024 * 1024, sourceBytes * 2 + 4096)
    const reserved = checkpointPreparationReservationBytes(sourceBytes)
    const refused =
      this.sourceRefusal(source) ??
      (this.active >= (this.options.maxJobs ?? 2)
        ? 'slotsBusy'
        : this.bytes + reserved > this.budgetBytes()
          ? 'aggregateBusy'
          : null)
    if (refused) {
      this.refusals[refused]++
      return null
    }

    // Reserve before retaining any output bytes or launching a child. Sources
    // are optimistic references: a concurrent rewrite may make this job stale.
    this.active += 1
    this.bytes += reserved
    const outputPath = path.join(
      path.dirname(source.checkpoint.path),
      `.${source.chatId}.checkpoint-prepared-${process.pid}-${randomUUID()}.tmp`
    )
    let child: CheckpointPreparationProcess
    let output: CheckpointPreparationJob['output']
    try {
      const fd = fs.openSync(outputPath, 'wx', 0o600)
      fs.closeSync(fd)
      output = checkpointFileReference(outputPath)
      activePreparedCheckpointPaths.add(outputPath)
      child = (this.options.spawn ?? spawnPreparationProcess)(
        this.options.entryPath ?? path.join(__dirname, 'checkpointPreparationWorker.js')
      )
    } catch (error) {
      fs.rmSync(outputPath, { force: true })
      activePreparedCheckpointPaths.delete(outputPath)
      this.active -= 1
      this.bytes -= reserved
      this.countFailure('spawn')
      throw error
    }

    this.counts.started++
    let exited = false
    let released = false
    let releaseRequested = false
    let credited = false
    let settled = false
    let reply: CheckpointPreparationReply | undefined
    let resolve!: (prepared: PreparedCheckpoint) => void
    let reject!: (error: Error) => void
    const result = new Promise<PreparedCheckpoint>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    const removeOutput = (): void => {
      try {
        const current = checkpointFileReference(output.path).identity
        if (current.dev === output.identity.dev && current.ino === output.identity.ino)
          fs.unlinkSync(output.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const credit = (): void => {
      if (exited && released && !credited) {
        credited = true
        this.active -= 1
        this.bytes -= reserved
        activePreparedCheckpointPaths.delete(outputPath)
        for (const listener of [...this.capacityListeners]) {
          try {
            listener()
          } catch (error) {
            // A listener's failure is its own; the release that returned the room stands.
            console.error('[checkpoint-preparation] a capacity listener failed', error)
          }
        }
      }
    }
    const fail = (error: Error, code: CheckpointPreparationFailureCode): void => {
      if (!settled) {
        settled = true
        this.countFailure(code)
        reject(error)
      }
      child.kill()
    }
    const timer = setTimeout(
      () => fail(new Error('Checkpoint preparation deadline exceeded'), 'deadline'),
      this.options.deadlineMs ?? 30_000
    )
    timer.unref()
    child.onMessage((value) => {
      if (settled || reply) return
      reply = value
      child.kill()
    })
    child.onError((error) => fail(error, 'process'))
    child.onExit(() => {
      exited = true
      clearTimeout(timer)
      if (!settled) {
        settled = true
        if (reply?.ok) {
          this.counts.completed++
          resolve(reply.prepared)
        } else {
          this.countFailure(reply ? 'reply' : 'process')
          reject(
            new Error(reply?.error ?? 'Checkpoint preparation process exited without a result')
          )
        }
      }
      // Windows may refuse to unlink an open output. The synchronous caller
      // observes that failure; once the child closes, finish custody cleanup.
      if (releaseRequested && !released) {
        try {
          removeOutput()
          released = true
        } catch {
          /* custody and credit remain held */
        }
      }
      credit()
    })
    const release = (): void => {
      releaseRequested = true
      removeOutput()
      released = true
      credit()
    }
    const cancel = (): void => {
      fail(new Error('Checkpoint preparation cancelled'), 'cancelled')
      release()
    }
    try {
      child.post({ ...source, output, maxOutputBytes })
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)), 'post')
    }
    return { output, result, cancel, release }
  }
}
