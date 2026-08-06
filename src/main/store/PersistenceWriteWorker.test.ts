/**
 * Item 6 — durable write off the main thread.
 *
 * These tests exist because the failure mode of this change is SILENT. A slow
 * write is visible; a write that lands out of order overwrites a chat with its
 * own older content and nothing reports it. So each test asserts the
 * user-visible end state (what bytes are actually on disk afterwards) rather
 * than that some internal call happened — an assertion about call order can be
 * satisfied by a queue that still corrupts the file.
 *
 * Every guarantee here was falsified before being trusted: see the FALSIFIED
 * note on each test for the mutation that turns it red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  PersistenceWriteQueue,
  isUtilityWriteEnabled,
  serializeForDurableWrite,
  writeSerializedDurably,
  type PersistenceWriteChannel,
  type PersistenceWriteJobMessage,
  type PersistenceWriteWorkerMessage
} from './PersistenceWriteWorker'

/**
 * Stands in for the utilityProcess. Holds jobs until the test releases them, so
 * a test can park the queue in the exact state a real stall/crash produces.
 * Writes through the real primitive so on-disk state is genuine.
 */
class FakeWriteWorker {
  readonly received: PersistenceWriteJobMessage[] = []
  killed = false
  private messageHandler: ((message: PersistenceWriteWorkerMessage) => void) | null = null
  private exitHandler: ((code: number) => void) | null = null
  private pending: PersistenceWriteJobMessage[] = []

  channel(): PersistenceWriteChannel {
    return {
      post: (message) => {
        this.received.push(message)
        this.pending.push(message)
      },
      onMessage: (handler) => {
        this.messageHandler = handler
      },
      onExit: (handler) => {
        this.exitHandler = handler
      },
      kill: () => {
        this.killed = true
        // A killed worker never completes its pending jobs.
        this.pending = []
      }
    }
  }

  /** Perform the oldest pending job for real, then ACK it. */
  ackNext(): void {
    const job = this.pending.shift()
    if (!job) return
    const timings = writeSerializedDurably(job.filePath, job.serialized)
    this.messageHandler?.({ type: 'ack', jobId: job.jobId, timings })
  }

  ackAll(): void {
    while (this.pending.length > 0) this.ackNext()
  }

  /** ACK a job id the host is not waiting on. */
  ackBogusJobId(jobId: number): void {
    this.messageHandler?.({
      type: 'ack',
      jobId,
      timings: { bytes: 0, writeMs: 0, fsyncMs: 0, renameMs: 0, totalMs: 0 }
    })
  }

  crash(code = 1): void {
    this.pending = []
    this.exitHandler?.(code)
  }
}

let dir: string
let chatPath: string

const payload = (n: number): { revision: number; body: string } => ({
  revision: n,
  body: `revision-${n}`
})

function readRevision(): number {
  return (JSON.parse(fs.readFileSync(chatPath, 'utf-8')) as { revision: number }).revision
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-persistence-write-'))
  chatPath = path.join(dir, 'chats', 'chat-a.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('durable write primitive', () => {
  /**
   * Invariant 1. The whole premise of item 6 is that only the PROCESS changes.
   * If the bytes differ, every chat file rewrites itself on first save and the
   * "no format change" promise is broken.
   *
   * FALSIFIED: dropping the `null, 2` argument from serializeForDurableWrite
   * fails the content assertion.
   */
  it('writes exactly the bytes the main-thread writer would', () => {
    const data = { title: 'Chat', nested: { seats: [1, 2, 3] } }
    writeSerializedDurably(chatPath, serializeForDurableWrite(data))

    expect(fs.readFileSync(chatPath, 'utf-8')).toBe(JSON.stringify(data, null, 2))
    // 0o600 matters: chat records are user-private.
    expect(fs.statSync(chatPath).mode & 0o777).toBe(0o600)
  })

  /**
   * A failed write must leave the destination untouched and no litter behind.
   *
   * The fixture makes the destination an existing non-empty directory, so the
   * sequence gets all the way through temp-create / write / fsync and then
   * fails at the final rename — deliberately, because that is the only window
   * where a non-atomic writer would already have clobbered the destination. A
   * failure at mkdir would prove nothing.
   *
   * The temp-residue assertion is not incidental: unbounded `.tmp` litter in
   * the chats directory is one of the ways this layer has previously filled a
   * user's disk, and disk-full in this app presents as agents hallucinating
   * rather than as a disk error.
   *
   * FALSIFIED: dropping the `fs.unlinkSync(tempPath)` from the catch block
   * leaves a stray `.tmp` and fails the residue assertion.
   */
  it('cleans up its temp file and preserves the destination when a write fails', () => {
    const doomed = path.join(dir, 'occupied')
    fs.mkdirSync(doomed, { recursive: true })
    fs.writeFileSync(path.join(doomed, 'keep.txt'), 'intact', 'utf-8')

    expect(() => writeSerializedDurably(doomed, serializeForDurableWrite(payload(1)))).toThrow()

    expect(fs.readFileSync(path.join(doomed, 'keep.txt'), 'utf-8')).toBe('intact')
    expect(fs.readdirSync(dir).filter((entry) => entry.includes('.tmp'))).toHaveLength(0)
  })
})

describe('PersistenceWriteQueue', () => {
  it('is off unless TASKWRAITH_UTILITY_WRITE=1', () => {
    expect(isUtilityWriteEnabled({})).toBe(false)
    expect(isUtilityWriteEnabled({ TASKWRAITH_UTILITY_WRITE: '0' })).toBe(false)
    expect(isUtilityWriteEnabled({ TASKWRAITH_UTILITY_WRITE: 'true' })).toBe(false)
    expect(isUtilityWriteEnabled({ TASKWRAITH_UTILITY_WRITE: '1' })).toBe(true)
  })

  /**
   * Invariant 2, happy path. Five saves for one chat must finish as revision 5.
   *
   * FALSIFIED: letting the queue post while a job is already in flight (drop
   * the `if (this.inFlight) return` guard in pump) interleaves the writes and
   * this lands on a lower revision.
   */
  it('lands concurrent writes for one chat in issue order', async () => {
    const worker = new FakeWriteWorker()
    const queue = new PersistenceWriteQueue({ channelFactory: () => worker.channel() })

    const writes = [1, 2, 3, 4, 5].map((n) =>
      queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(n) })
    )
    // The host must keep exactly one job in flight, not fan five at the worker.
    expect(worker.received).toHaveLength(1)
    worker.ackAll()
    await Promise.all(writes)

    expect(readRevision()).toBe(5)
    expect(queue.stats.written).toBe(5)
    expect(queue.stats.writtenByWorker).toBe(5)
    expect(queue.stats.writtenSynchronously).toBe(0)
    queue.dispose()
  })

  /**
   * Invariant 3. A crash must not strand the queue, and the leftover writes
   * must still finish IN ORDER — this module drains them itself rather than
   * asking N callers to retry, because N independent retries race.
   *
   * FALSIFIED: reversing the drain loop in degrade(), or resolving the pending
   * jobs without writing them, lands revision 1 instead of 5.
   */
  it('finishes the queue in order, itself, when the worker crashes mid-drain', async () => {
    const worker = new FakeWriteWorker()
    const reasons: string[] = []
    const queue = new PersistenceWriteQueue({
      channelFactory: () => worker.channel(),
      onDegraded: (reason) => reasons.push(reason)
    })

    const writes = [1, 2, 3, 4, 5].map((n) =>
      queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(n) })
    )
    worker.ackNext() // revision 1 lands via the worker
    worker.crash(9) // 2..5 are still outstanding

    await expect(Promise.all(writes)).resolves.toBeDefined()
    expect(readRevision()).toBe(5)
    expect(queue.stats.written).toBe(5)
    expect(queue.stats.writtenSynchronously).toBe(4)
    expect(reasons[0]).toContain('exited with code 9')
    queue.dispose()
  })

  /**
   * A worker that accepts jobs and never answers is worse than one that dies:
   * nothing surfaces. The ACK deadline converts that silence into a fallback.
   *
   * FALSIFIED: removing the ackTimer in pump() hangs this test instead of
   * resolving.
   */
  it('falls back when the worker accepts a job and never ACKs', async () => {
    const worker = new FakeWriteWorker()
    const queue = new PersistenceWriteQueue({
      channelFactory: () => worker.channel(),
      ackTimeoutMs: 10
    })

    const write = queue.enqueueWrite({
      chatId: 'chat-a',
      filePath: chatPath,
      data: payload(7)
    })
    await write

    expect(readRevision()).toBe(7)
    expect(queue.stats.writtenSynchronously).toBe(1)
    // Killed before the inline write: a late rename from a live worker would
    // resurrect older content underneath the fallback.
    expect(worker.killed).toBe(true)
    queue.dispose()
  })

  /**
   * Invariant 4, and the subtlest hazard in this module. Under saturation the
   * obvious move is "just write this one inline" — which lets the NEWEST write
   * land FIRST and then be overwritten by the older queued ones. Saturation
   * must therefore drain in order and only then write the new job.
   *
   * FALSIFIED: swapping the two statements in the saturation branch so the
   * inline write happens before degrade() lands revision 3, not 4.
   */
  it('drains in order instead of overtaking when the queue saturates', async () => {
    const worker = new FakeWriteWorker()
    const queue = new PersistenceWriteQueue({
      channelFactory: () => worker.channel(),
      maxQueueDepth: 2
    })

    // 1 goes in flight; 2 and 3 fill the queue to its bound.
    const writes = [1, 2, 3].map((n) =>
      queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(n) })
    )
    // 4 arrives against a full queue and must not jump the line.
    writes.push(
      queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(4) })
    )

    await Promise.all(writes)
    expect(readRevision()).toBe(4)
    expect(queue.stats.written).toBe(4)
    queue.dispose()
  })

  /**
   * If the worker ACKs a job we are not waiting on, its FIFO and ours have
   * diverged. Ordering cannot be verified after the fact, so the only safe
   * response is to stop using the worker permanently rather than resynchronise
   * and hope.
   *
   * FALSIFIED: ignoring the jobId mismatch instead of degrading leaves the real
   * job unwritten and the file absent.
   */
  it('permanently stops trusting a worker that ACKs the wrong job', async () => {
    const worker = new FakeWriteWorker()
    const queue = new PersistenceWriteQueue({ channelFactory: () => worker.channel() })

    const write = queue.enqueueWrite({
      chatId: 'chat-a',
      filePath: chatPath,
      data: payload(2)
    })
    worker.ackBogusJobId(4242)
    await write

    expect(readRevision()).toBe(2)
    expect(queue.stats.degraded).toBe(true)
    expect(queue.stats.writtenSynchronously).toBe(1)

    // Subsequent writes stay synchronous — no silent re-promotion.
    await queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(3) })
    expect(readRevision()).toBe(3)
    expect(queue.stats.writtenByWorker).toBe(0)
    queue.dispose()
  })

  /**
   * A durability barrier (`terminal` / `approval` / `history-deletion` /
   * `shutdown`) awaits enqueueWrite directly, so the promise must not resolve
   * before the bytes are durable. Pinned as an end-state assertion: at the
   * moment the promise resolves, the file must already be readable on disk.
   *
   * FALSIFIED: resolving the job on post instead of on ACK fails the read.
   */
  it('resolves only after the bytes are on disk', async () => {
    const worker = new FakeWriteWorker()
    const queue = new PersistenceWriteQueue({ channelFactory: () => worker.channel() })

    let resolvedEarly = false
    const write = queue
      .enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(1) })
      .then(() => {
        resolvedEarly = !fs.existsSync(chatPath)
      })

    expect(fs.existsSync(chatPath)).toBe(false)
    worker.ackAll()
    await write

    expect(resolvedEarly).toBe(false)
    expect(readRevision()).toBe(1)
    queue.dispose()
  })
})
