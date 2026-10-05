/**
 * Seeds for the Host's thread log followers, loaded in a worker thread: the
 * worker opens the thread's checkpoint, parses it, reads the log after it and
 * cuts the follower's window (`loadThreadLog`). Only that window comes back,
 * as a structured copy, so the Host loop pays for the copy and nothing else:
 * no read, no parse, no apply.
 *
 * One worker, started at the first seed, answers one load at a time. Its heap
 * is capped, so a load whose objects outgrow it ends the worker rather than
 * the Host: what was asked of it fails, and the next seed starts another. The
 * cap cannot stop one allocation too large for the process, which ends the
 * Host as it would on the Host's own thread; the journal keeps a checkpoint
 * under 128 MiB, and a line under its record. It never keeps the Host running
 * by itself.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker, type WorkerOptions } from 'node:worker_threads'

import type {
  HostThreadLogRecord,
  HostThreadLogSeedPort,
  HostThreadLogSeedRequest,
  HostThreadLogWindowSeed
} from './HostThreadLogFollower'
import type {
  HostThreadLogLoadMessage,
  HostThreadLogLoadReply,
  HostThreadLogLoadTimings
} from './HostThreadLogLoad'

/**
 * Heap the worker may use by default. Loading a 32 MiB checkpoint of long
 * messages peaked near 105 MB of heap; rows of many small objects take more.
 * This leaves room for the largest the journal writes (128 MiB) while keeping
 * a runaway load from taking the machine.
 */
export const HOST_THREAD_LOG_SEED_WORKER_HEAP_MB = 1536

const ENTRY_FILE = 'HostThreadLogSeedWorkerEntry.js'

/** The compiled worker entry beside this module, as the Host build emits it. */
export function hostThreadLogSeedWorkerEntryPath(): string {
  return join(__dirname, ENTRY_FILE)
}

export interface HostThreadLogWorkerSeedOptions {
  /** The journal's directory: `<profile>/chat-journal-v2`. */
  readonly directory: string
  /** The compiled worker entry. */
  readonly entryPath: string
  /** Defaults to {@link HOST_THREAD_LOG_SEED_WORKER_HEAP_MB}. */
  readonly maxHeapMb?: number
  /** Milliseconds, for timings. */
  readonly now?: () => number
  /** Test seam; production starts a `worker_threads` Worker. */
  readonly createWorker?: (entryPath: string, options: WorkerOptions) => Worker
}

export interface HostThreadLogWorkerSeedTimes {
  readonly count: number
  readonly totalMs: number
  readonly maxMs: number
  readonly lastMs: number
}

export interface HostThreadLogWorkerSeedStats {
  readonly port: 'worker'
  readonly asked: number
  readonly windows: number
  readonly records: number
  readonly absent: number
  readonly failures: number
  readonly workerStarts: number
  readonly workerExits: number
  readonly pending: number
  /** From asking to the answer, by the Host's clock: the worker's load, the copy and any wait. */
  readonly seedMs: HostThreadLogWorkerSeedTimes
  /** Summed over every load the worker answered, by its own clock. */
  readonly worker: {
    readonly checkpointMs: number
    readonly checkpoints: number
    readonly followMs: number
    readonly applyMs: number
    readonly batches: number
    readonly cutMs: number
    readonly maxTotalMs: number
  }
  readonly checkpointBytes: { readonly last: number; readonly max: number }
  /** Why the last worker that ended did, when it said. */
  readonly lastError: string | null
}

interface Waiting {
  readonly resolve: (seed: HostThreadLogRecord | HostThreadLogWindowSeed | null) => void
  readonly reject: (error: Error) => void
  readonly askedAt: number
}

/** The worker's loads, as a seed port. */
export class HostThreadLogWorkerSeed implements HostThreadLogSeedPort {
  private readonly directory: string
  private readonly entryPath: string
  private readonly maxHeapMb: number
  private readonly now: () => number
  private readonly createWorker: (entryPath: string, options: WorkerOptions) => Worker
  private worker: Worker | null = null
  private readonly waiting = new Map<number, Waiting>()
  private nextId = 1
  private closed = false
  private asked = 0
  private windows = 0
  private records = 0
  private absent = 0
  private failures = 0
  private workerStarts = 0
  private workerExits = 0
  private seedMs = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 }
  private workerTimes = {
    checkpointMs: 0,
    checkpoints: 0,
    followMs: 0,
    applyMs: 0,
    batches: 0,
    cutMs: 0,
    maxTotalMs: 0
  }
  private checkpointBytes = { last: 0, max: 0 }
  private lastError: string | null = null

  constructor(options: HostThreadLogWorkerSeedOptions) {
    this.directory = options.directory
    this.entryPath = options.entryPath
    this.maxHeapMb = options.maxHeapMb ?? HOST_THREAD_LOG_SEED_WORKER_HEAP_MB
    if (!Number.isSafeInteger(this.maxHeapMb) || this.maxHeapMb < 1) {
      throw new RangeError('Thread log seed worker: maxHeapMb must be a whole number of at least 1')
    }
    this.now = options.now ?? (() => performance.now())
    this.createWorker =
      options.createWorker ?? ((file, workerOptions) => new Worker(file, workerOptions))
  }

  seed(
    request: HostThreadLogSeedRequest
  ): Promise<HostThreadLogRecord | HostThreadLogWindowSeed | null> {
    if (this.closed) return Promise.reject(new Error('Thread log seed worker is closed'))
    this.asked += 1
    const id = this.nextId++
    let worker: Worker
    try {
      worker = this.start()
    } catch (error) {
      this.failures += 1
      return Promise.reject(error)
    }
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, askedAt: this.now() })
      // A worker with a load to answer keeps the process up until it answers.
      worker.ref()
      const message: HostThreadLogLoadMessage = {
        id,
        directory: this.directory,
        chatId: request.chatId,
        ...(request.window ? { window: request.window } : {})
      }
      worker.postMessage(message)
    })
  }

  stats(): HostThreadLogWorkerSeedStats {
    return {
      port: 'worker',
      asked: this.asked,
      windows: this.windows,
      records: this.records,
      absent: this.absent,
      failures: this.failures,
      workerStarts: this.workerStarts,
      workerExits: this.workerExits,
      pending: this.waiting.size,
      seedMs: { ...this.seedMs },
      worker: { ...this.workerTimes },
      checkpointBytes: { ...this.checkpointBytes },
      lastError: this.lastError
    }
  }

  /** End the worker. What is pending fails; seeds asked for after fail too. */
  async close(): Promise<void> {
    this.closed = true
    const worker = this.worker
    this.worker = null
    this.failAll(new Error('Thread log seed worker is closed'))
    if (worker) await worker.terminate()
  }

  private start(): Worker {
    if (this.worker) return this.worker
    const worker = this.createWorker(this.entryPath, {
      resourceLimits: { maxOldGenerationSizeMb: this.maxHeapMb }
    })
    this.workerStarts += 1
    worker.unref()
    worker.on('message', (reply: HostThreadLogLoadReply) => this.answer(worker, reply))
    // An error, a heap past its cap among them, ends the worker; its exit fails what was asked of it.
    worker.on('error', (error: unknown) => {
      this.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 200)
    })
    worker.on('exit', (code) => this.ended(worker, code))
    this.worker = worker
    return worker
  }

  private answer(worker: Worker, reply: HostThreadLogLoadReply): void {
    const waiting = this.waiting.get(reply?.id)
    if (!waiting) return
    this.waiting.delete(reply.id)
    if (this.waiting.size === 0) worker.unref()
    const took = this.now() - waiting.askedAt
    this.seedMs = {
      count: this.seedMs.count + 1,
      totalMs: this.seedMs.totalMs + took,
      maxMs: Math.max(this.seedMs.maxMs, took),
      lastMs: took
    }
    if (!reply.ok) {
      this.failures += 1
      waiting.reject(new Error(reply.message))
      return
    }
    const result = reply.result
    if (result.kind === 'absent') {
      this.absent += 1
      waiting.resolve(null)
      return
    }
    this.noteTimings(result.timings)
    if (result.kind === 'window') {
      this.windows += 1
      waiting.resolve(result.seed)
    } else {
      this.records += 1
      waiting.resolve(result.record)
    }
  }

  private noteTimings(timings: HostThreadLogLoadTimings): void {
    const times = this.workerTimes
    this.workerTimes = {
      checkpointMs: times.checkpointMs + timings.checkpointMs,
      checkpoints: times.checkpoints + timings.checkpoints,
      followMs: times.followMs + timings.followMs,
      applyMs: times.applyMs + timings.applyMs,
      batches: times.batches + timings.batches,
      cutMs: times.cutMs + timings.cutMs,
      maxTotalMs: Math.max(times.maxTotalMs, timings.totalMs)
    }
    this.checkpointBytes = {
      last: timings.checkpointBytes,
      max: Math.max(this.checkpointBytes.max, timings.checkpointBytes)
    }
  }

  private ended(worker: Worker, code: number): void {
    if (this.worker !== worker) return
    this.worker = null
    this.workerExits += 1
    const why = this.lastError === null ? '' : `: ${this.lastError}`
    this.failAll(new Error(`Thread log seed worker ended (exit ${code}${why}); ask again`))
  }

  private failAll(error: Error): void {
    for (const waiting of this.waiting.values()) {
      this.failures += 1
      waiting.reject(error)
    }
    this.waiting.clear()
  }
}

/**
 * A seed port over the worker, or null when its compiled entry is not there
 * (the Host run from source), so the caller seeds some other way.
 */
export function createHostThreadLogWorkerSeed(
  options: Omit<HostThreadLogWorkerSeedOptions, 'entryPath'> & { readonly entryPath?: string }
): HostThreadLogWorkerSeed | null {
  const entryPath = options.entryPath ?? hostThreadLogSeedWorkerEntryPath()
  if (!existsSync(entryPath)) return null
  return new HostThreadLogWorkerSeed({ ...options, entryPath })
}
