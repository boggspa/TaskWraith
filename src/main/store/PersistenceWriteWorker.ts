/**
 * Item 6 — move `saveChat`'s durable write off the Electron main thread.
 *
 * Items 1-5 cut how OFTEN the write path runs (per-chat flush, O(1) index read,
 * lean rows). They did not change WHERE it runs: `writeJson` still performs
 * write + fsync + rename + directory fsync synchronously on main, and a hot
 * chat record can be ~16 MB. A V8 CPU profile cannot see that cost at all — it
 * is blocked-on-syscall wall time, not CPU — which is precisely why it survived
 * five rounds of optimisation.
 *
 * ============================ SAFETY NOTES ================================
 * This is the layer that has previously filled a disk with a 44 GB journal and
 * bricked the app with a 2.75 GB one. Moving fsync off the thread that today
 * serializes it means the ordering guarantee is no longer free. The invariants
 * below are load-bearing; each has a test in PersistenceWriteWorker.test.ts.
 *
 *  1. BYTE-IDENTICAL OUTPUT. `chats/<id>.json` stays authoritative and
 *     unchanged. The worker and the main-thread fallback call the SAME
 *     `writeSerializedDurably` below, so the two cannot drift.
 *  2. ABSOLUTE ORDERING. Writes land in the order `enqueueWrite` was called,
 *     globally and therefore per chatId. The worker drains strictly one job at
 *     a time; the queue never reorders and never overtakes.
 *  3. FAILURE IS ORDERED, NOT DISTRIBUTED. On worker crash / ACK timeout /
 *     protocol violation / queue saturation, THIS MODULE performs the leftover
 *     writes synchronously, in FIFO order, itself. It never hands "you fall
 *     back" to N independent callers, because N independent fallbacks race and
 *     an out-of-order whole-file write is silent history loss.
 *  4. BOUNDED. An unbounded queue in front of fsync is exactly how the 44 GB
 *     artifact happened. At `maxQueueDepth` the queue degrades to synchronous
 *     draining rather than buffering — slower, never lossy.
 *  5. OFF BY DEFAULT. `TASKWRAITH_UTILITY_WRITE=1` opts in. The seam ships dark
 *     and is enabled after profiling.
 *
 * DELIBERATE DEVIATION FROM THE LANE BRIEF (flagged for @SolBoss/@K3Review):
 * the brief said "bound it and coalesce per chatId". This implements the bound
 * but NOT the coalescing, on purpose. Dropping a superseded pending write is
 * only safe if the surviving write is provably newer, and `revision` is not
 * guaranteed monotonic across every caller — picking wrong silently reverts a
 * chat. `saveCoalescer` already coalesces upstream (per-chat, before this
 * queue), so a second coalescing layer buys little and risks history. Strict
 * FIFO with a bounded queue gets the same protection without that failure mode.
 * `revision` is still carried and reported so a later pass can add coalescing
 * deliberately, with its own falsified test.
 */
import * as fs from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Durable write primitive — shared by the worker entry and the main fallback
// ---------------------------------------------------------------------------

/** Phase timings for one durable write, in milliseconds. */
export interface DurableWriteTimings {
  /** utf-8 byte length of the serialized payload. */
  bytes: number
  writeMs: number
  fsyncMs: number
  renameMs: number
  /**
   * Whole durable write. Exceeds the sum of the named phases by the
   * mkdir/open/close/chmod/dir-fsync remainder — that remainder is real
   * durability cost and is deliberately not discarded.
   */
  totalMs: number
}

/**
 * The single serialization point.
 *
 * Two-space pretty printing is load-bearing: it is what is already on every
 * user's disk. `saveChat` serializes ONCE on main and hands the string to the
 * queue — moving the write off-thread must not silently double the JSON cost
 * it was meant to remove.
 */
export function serializeForDurableWrite(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

/**
 * Write `serialized` to `filePath` atomically and durably.
 *
 * Mirrors `writeJson` in `store/index.ts` exactly:
 *   mkdir -p → open temp (0o600) → write → fsync → close → rename →
 *   chmod 0o600 → directory fsync
 *
 * Two main-process concerns are deliberately absent because they cannot run in
 * a worker: the `beginPersistenceWrite` probe (reads main-side global state —
 * the worker returns the same phase timings over its ACK instead, so the T3a
 * measurement story survives the move) and `invalidateSettingsFileCache()`
 * (settings-only; this path writes chat records).
 *
 * Throws on failure after cleaning up the temp file, exactly as the
 * main-thread writer does.
 */
export function writeSerializedDurably(filePath: string, serialized: string): DurableWriteTimings {
  const startedAt = performance.now()
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  let fd: number | null = null
  let writeMs = 0
  let fsyncMs = 0
  let renameMs = 0
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fd = fs.openSync(tempPath, 'w', 0o600)

    const beforeWrite = performance.now()
    fs.writeFileSync(fd, serialized, 'utf-8')
    writeMs = performance.now() - beforeWrite

    const beforeFsync = performance.now()
    fs.fsyncSync(fd)
    fsyncMs = performance.now() - beforeFsync

    fs.closeSync(fd)
    fd = null

    const beforeRename = performance.now()
    fs.renameSync(tempPath, filePath)
    renameMs = performance.now() - beforeRename

    try {
      fs.chmodSync(filePath, 0o600)
    } catch {
      // Best effort on filesystems that do not support POSIX modes.
    }
    try {
      const dirFd = fs.openSync(path.dirname(filePath), 'r')
      fs.fsyncSync(dirFd)
      fs.closeSync(dirFd)
    } catch {
      // Directory fsync is best effort on some filesystems.
    }

    return {
      bytes: Buffer.byteLength(serialized, 'utf-8'),
      writeMs,
      fsyncMs,
      renameMs,
      totalMs: performance.now() - startedAt
    }
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Best effort: preserve the original write failure.
      }
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    } catch {
      // Best effort: stale temp files are safer than masking the original failure.
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

export interface PersistenceWriteJobMessage {
  type: 'write'
  jobId: number
  filePath: string
  serialized: string
}

export type PersistenceWriteWorkerMessage =
  | { type: 'ack'; jobId: number; timings: DurableWriteTimings }
  | { type: 'error'; jobId: number; message: string }

// ---------------------------------------------------------------------------
// Channel (injectable so the queue is testable without an Electron host)
// ---------------------------------------------------------------------------

export interface PersistenceWriteChannel {
  post(message: PersistenceWriteJobMessage): void
  onMessage(handler: (message: PersistenceWriteWorkerMessage) => void): void
  onExit(handler: (code: number) => void): void
  kill(): void
}

export type PersistenceWriteChannelFactory = () => PersistenceWriteChannel

/**
 * Default channel: a long-lived `utilityProcess`.
 *
 * Long-lived is the whole point. The repo's other worker seats
 * (`WorkProvenanceWorkerScan`, `ExternalActivityWorkerScan`) fork per query and
 * kill on completion, which is right for a 12-second scan and catastrophic for
 * a per-save write — a fork costs far more than the fsync being avoided. The
 * fork/exit/kill lifecycle below is copied from those seats; the one-shot
 * `Promise` shape around it deliberately is not.
 *
 * `electron` is required lazily so this module stays importable from the worker
 * bundle (which needs the primitives above but must never touch main-only APIs)
 * and from tests running outside Electron.
 */
export function createUtilityProcessChannelFactory(
  workerModulePath: string
): PersistenceWriteChannelFactory {
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { utilityProcess } = require('electron') as typeof import('electron')
    const child = utilityProcess.fork(workerModulePath, [], {
      serviceName: 'taskwraith-persistence-write'
    })
    return {
      post: (message) => child.postMessage(message),
      onMessage: (handler) => {
        child.on('message', (raw: unknown) => handler(raw as PersistenceWriteWorkerMessage))
      },
      onExit: (handler) => {
        child.on('exit', (code: number) => handler(code))
      },
      kill: () => {
        try {
          child.kill()
        } catch {
          // Already exited.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/**
 * Off unless `TASKWRAITH_UTILITY_WRITE=1`. With the flag off `saveChat` keeps
 * its existing synchronous writer untouched, so the default build is
 * byte-for-byte and behaviour-for-behaviour what shipped in b76154222.
 */
export function isUtilityWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.TASKWRAITH_UTILITY_WRITE ?? '').trim() === '1'
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface PersistenceWriteRequest {
  chatId: string
  filePath: string
  /** Serialized exactly once, inside `enqueueWrite`. */
  data: unknown
  /** Carried for diagnostics; see the no-coalescing note in the file header. */
  revision?: number
}

export interface PersistenceWriteQueueOptions {
  channelFactory: PersistenceWriteChannelFactory
  /** Degrade to synchronous draining beyond this many queued jobs. */
  maxQueueDepth?: number
  /** Treat a job as failed if the worker has not ACKed within this long. */
  ackTimeoutMs?: number
  /** Worker respawns allowed before the queue stays synchronous for good. */
  maxRestarts?: number
  onDegraded?: (reason: string) => void
}

export interface PersistenceWriteQueueStats {
  written: number
  writtenByWorker: number
  writtenSynchronously: number
  restarts: number
  degraded: boolean
}

interface QueuedJob {
  jobId: number
  chatId: string
  filePath: string
  serialized: string
  revision?: number
  resolve: () => void
  reject: (error: unknown) => void
}

const DEFAULT_MAX_QUEUE_DEPTH = 64
const DEFAULT_ACK_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESTARTS = 3

export class PersistenceWriteQueue {
  private readonly channelFactory: PersistenceWriteChannelFactory
  private readonly maxQueueDepth: number
  private readonly ackTimeoutMs: number
  private readonly maxRestarts: number
  private readonly onDegraded?: (reason: string) => void

  private channel: PersistenceWriteChannel | null = null
  private queue: QueuedJob[] = []
  private inFlight: QueuedJob | null = null
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  private nextJobId = 1
  private restarts = 0
  /** True once the worker is permanently abandoned for this process. */
  private permanentlySynchronous = false
  private disposed = false

  private written = 0
  private writtenByWorker = 0
  private writtenSynchronously = 0

  constructor(options: PersistenceWriteQueueOptions) {
    this.channelFactory = options.channelFactory
    this.maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS
    this.onDegraded = options.onDegraded
  }

  get stats(): PersistenceWriteQueueStats {
    return {
      written: this.written,
      writtenByWorker: this.writtenByWorker,
      writtenSynchronously: this.writtenSynchronously,
      restarts: this.restarts,
      degraded: this.permanentlySynchronous
    }
  }

  /**
   * Resolve only once the bytes are durable — via the worker, or via this
   * process if the worker could not do it. A durability barrier may therefore
   * await this directly.
   */
  enqueueWrite(request: PersistenceWriteRequest): Promise<void> {
    const serialized = serializeForDurableWrite(request.data)

    if (this.disposed || this.permanentlySynchronous) {
      return this.writeInlineOrdered(request.filePath, serialized)
    }

    // Backpressure. Note this drains rather than bypassing: writing the new job
    // inline while older jobs for the same chat are still queued would let it
    // land FIRST and then be overwritten by stale content.
    if (this.queue.length >= this.maxQueueDepth) {
      this.degrade(`queue saturated at ${this.queue.length} pending writes`, { allowRestart: true })
      return this.writeInlineOrdered(request.filePath, serialized)
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        jobId: this.nextJobId++,
        chatId: request.chatId,
        filePath: request.filePath,
        serialized,
        revision: request.revision,
        resolve,
        reject
      })
      this.pump()
    })
  }

  dispose(): void {
    this.disposed = true
    this.clearAckTimer()
    this.killChannel()
  }

  /**
   * Quit-path barrier: perform every queued job — including the in-flight one
   * whose ACK can no longer be awaited — synchronously, in FIFO order, on this
   * thread. `dispose()` alone kills the channel and DROPS those jobs, which is
   * silent history loss at quit because `flushAllChatSaves` can enqueue
   * barrier writes moments earlier.
   *
   * The channel is killed FIRST so a late worker ACK for the drained in-flight
   * job cannot arrive afterwards and read as a protocol violation. Re-writing
   * a file the worker may have already written is safe: the bytes are
   * identical and the write is atomic.
   */
  drainSync(): number {
    this.clearAckTimer()
    this.killChannel()
    const jobs = this.inFlight ? [this.inFlight, ...this.queue] : [...this.queue]
    this.inFlight = null
    this.queue = []
    for (const job of jobs) {
      try {
        writeSerializedDurably(job.filePath, job.serialized)
        this.written++
        this.writtenSynchronously++
        job.resolve()
      } catch (error) {
        job.reject(error)
      }
    }
    return jobs.length
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Only safe because every degrade path drains the queue before returning, so
   * there is never a pending predecessor when this runs.
   */
  private writeInlineOrdered(filePath: string, serialized: string): Promise<void> {
    try {
      writeSerializedDurably(filePath, serialized)
      this.written++
      this.writtenSynchronously++
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error)
    }
  }

  private pump(): void {
    if (this.disposed || this.permanentlySynchronous) return
    if (this.inFlight || this.queue.length === 0) return

    if (!this.ensureChannel()) {
      // Spawning failed; ensureChannel already degraded and drained.
      return
    }

    const job = this.queue.shift()!
    this.inFlight = job
    this.ackTimer = setTimeout(() => {
      this.degrade(`worker did not ACK job ${job.jobId} within ${this.ackTimeoutMs}ms`, {
        allowRestart: true
      })
    }, this.ackTimeoutMs)
    this.ackTimer.unref?.()

    try {
      this.channel!.post({
        type: 'write',
        jobId: job.jobId,
        filePath: job.filePath,
        serialized: job.serialized
      })
    } catch (error) {
      this.degrade(`failed to post job ${job.jobId}: ${describeError(error)}`, {
        allowRestart: true
      })
    }
  }

  private ensureChannel(): boolean {
    if (this.channel) return true
    try {
      const channel = this.channelFactory()
      channel.onMessage((message) => this.handleWorkerMessage(message))
      channel.onExit((code) => {
        // Only meaningful while we still believe in this channel.
        if (this.channel !== channel) return
        this.channel = null
        this.degrade(`worker exited with code ${code}`, { allowRestart: true })
      })
      this.channel = channel
      return true
    } catch (error) {
      this.degrade(`failed to start worker: ${describeError(error)}`, { allowRestart: false })
      return false
    }
  }

  private handleWorkerMessage(message: PersistenceWriteWorkerMessage): void {
    const job = this.inFlight
    if (!job) return

    // A reply for anything other than the single in-flight job means the
    // worker's FIFO and ours disagree. Ordering is the invariant we cannot
    // verify after the fact, so stop trusting the worker entirely.
    if (!message || typeof message !== 'object' || message.jobId !== job.jobId) {
      this.degrade(
        `protocol violation: expected ACK for job ${job.jobId}, got ${JSON.stringify(message)}`,
        { allowRestart: false }
      )
      return
    }

    if (message.type === 'ack') {
      this.clearAckTimer()
      this.inFlight = null
      this.written++
      this.writtenByWorker++
      job.resolve()
      this.pump()
      return
    }

    if (message.type === 'error') {
      this.degrade(`worker failed job ${job.jobId}: ${message.message}`, { allowRestart: true })
    }
  }

  /**
   * Stop using the worker and finish everything outstanding synchronously, in
   * FIFO order, here. This is the single choke point for every failure mode.
   *
   * The in-flight job is rewritten even though the worker MAY have completed it
   * — the write is idempotent (same bytes, atomic rename), so a redundant write
   * is safe while a skipped one is data loss.
   */
  private degrade(reason: string, options: { allowRestart: boolean }): void {
    this.clearAckTimer()
    // Kill BEFORE the inline drain: a worker rename landing after our own write
    // would resurrect older content for any subsequent job.
    this.killChannel()

    const pending: QueuedJob[] = []
    if (this.inFlight) pending.push(this.inFlight)
    this.inFlight = null
    pending.push(...this.queue)
    this.queue = []

    const canRestart = options.allowRestart && this.restarts < this.maxRestarts
    if (canRestart) {
      this.restarts++
    } else {
      this.permanentlySynchronous = true
    }
    this.onDegraded?.(reason)

    for (const job of pending) {
      try {
        writeSerializedDurably(job.filePath, job.serialized)
        this.written++
        this.writtenSynchronously++
        job.resolve()
      } catch (error) {
        job.reject(error)
      }
    }
  }

  private clearAckTimer(): void {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer)
      this.ackTimer = null
    }
  }

  private killChannel(): void {
    if (!this.channel) return
    const channel = this.channel
    this.channel = null
    try {
      channel.kill()
    } catch {
      // Already exited.
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
