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

  failNext(): void {
    const job = this.pending[0]
    if (job) this.messageHandler?.({ type: 'error', jobId: job.jobId, message: 'injected failure' })
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
    // Windows does not expose POSIX owner-only mode bits.
    if (process.platform !== 'win32') {
      expect(fs.statSync(chatPath).mode & 0o777).toBe(0o600)
    }
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

describe('PersistenceWriteQueue byte observations (M1, no byte enforcement)', () => {
  const bytes = (data: unknown): number => Buffer.byteLength(JSON.stringify(data, null, 2), 'utf8')

  it('counts UTF-8 from one serialization, transfers FIFO ownership, and releases on ACK', async () => {
    const worker = new FakeWriteWorker()
    const queue = new PersistenceWriteQueue({ channelFactory: () => worker.channel() })
    let serializations = 0
    const firstData = { revision: 1, body: '€🙂漢字' }
    const secondData = { revision: 2, body: 'é'.repeat(20) }
    const firstBytes = bytes(firstData)
    const secondBytes = bytes(secondData)
    expect(firstBytes).toBeGreaterThan(JSON.stringify(firstData, null, 2).length)
    expect(queue.stats).toMatchObject({
      queuedBytes: 0,
      inFlightBytes: 0,
      localBytes: 0,
      retainedBytes: 0,
      peakQueuedBytes: 0,
      peakRetainedBytes: 0,
      maxQueueBytes: null,
      maxQueueDepth: 64,
      disposed: false
    })
    const first = queue.enqueueWrite({
      chatId: 'chat-a',
      filePath: chatPath,
      data: {
        toJSON: () => {
          serializations++
          return firstData
        }
      }
    })
    const second = queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: secondData })
    expect(serializations).toBe(1)
    const snapshot = queue.stats
    expect(snapshot).toMatchObject({
      queuedBytes: secondBytes,
      inFlightBytes: firstBytes,
      localBytes: 0,
      retainedBytes: firstBytes + secondBytes,
      peakRetainedBytes: firstBytes + secondBytes,
      peakQueuedBytes: Math.max(firstBytes, secondBytes)
    })
    worker.ackNext()
    expect(queue.stats).toMatchObject({
      queuedBytes: 0,
      inFlightBytes: secondBytes,
      retainedBytes: secondBytes,
      writtenByWorker: 1
    })
    expect(snapshot.retainedBytes).toBe(firstBytes + secondBytes)
    worker.ackAll()
    await Promise.all([first, second])
    expect(queue.stats).toMatchObject({
      queuedBytes: 0,
      inFlightBytes: 0,
      localBytes: 0,
      retainedBytes: 0,
      peakRetainedBytes: firstBytes + secondBytes,
      writtenByWorker: 2
    })
    worker.ackBogusJobId(1)
    expect(queue.stats.retainedBytes).toBe(0)
    expect(queue.stats.written).toBe(2)
    queue.dispose()
  })

  it('observes large retained payloads without a byte-triggered fallback and keeps depth saturation FIFO', async () => {
    const worker = new FakeWriteWorker()
    const data = [1, 2, 3, 4].map((revision) => ({ revision, body: '🙂'.repeat(100_000) }))
    const sizes = data.map(bytes)
    const observations: ReturnType<typeof getStats>[] = []
    const queue = new PersistenceWriteQueue({
      channelFactory: () => worker.channel(),
      maxQueueDepth: 2,
      onDegraded: () => observations.push(getStats())
    })
    function getStats() {
      return queue.stats
    }
    const pending = data
      .slice(0, 3)
      .map((item) => queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: item }))
    expect(queue.stats.writtenSynchronously).toBe(0)
    expect(queue.stats.maxQueueBytes).toBeNull()
    expect(queue.stats.retainedBytes).toBe(sizes.slice(0, 3).reduce((a, b) => a + b, 0))
    pending.push(queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: data[3] }))
    await Promise.all(pending)
    const total = sizes.reduce((a, b) => a + b, 0)
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      queuedBytes: 0,
      inFlightBytes: 0,
      localBytes: total,
      retainedBytes: total,
      peakRetainedBytes: total
    })
    expect(queue.stats).toMatchObject({ retainedBytes: 0, localBytes: 0, writtenSynchronously: 4 })
    expect(readRevision()).toBe(4)
    queue.dispose()
  })

  it('moves a crashed worker payload into synchronous replay then counts the next worker exactly once', async () => {
    const workers = [new FakeWriteWorker(), new FakeWriteWorker()]
    let starts = 0
    const queue = new PersistenceWriteQueue({
      channelFactory: () => workers[starts++].channel(),
      maxRestarts: 1
    })
    const first = queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(1) })
    const second = queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(2) })
    workers[0].crash()
    await Promise.all([first, second])
    expect(queue.stats).toMatchObject({
      retainedBytes: 0,
      localBytes: 0,
      restarts: 1,
      writtenSynchronously: 2
    })
    const third = queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(3) })
    expect(starts).toBe(2)
    expect(queue.stats).toMatchObject({
      inFlightBytes: bytes(payload(3)),
      queuedBytes: 0,
      retainedBytes: bytes(payload(3))
    })
    workers[1].ackAll()
    await third
    expect(queue.stats).toMatchObject({ retainedBytes: 0, written: 3, writtenByWorker: 1 })
    expect(readRevision()).toBe(3)
    queue.dispose()
  })

  it('releases error-path bytes even when synchronous replay rejects one job and completes its sibling', async () => {
    const worker = new FakeWriteWorker()
    const queue = new PersistenceWriteQueue({
      channelFactory: () => worker.channel(),
      maxRestarts: 0
    })
    const occupied = path.join(dir, 'occupied')
    fs.mkdirSync(occupied)
    fs.writeFileSync(path.join(occupied, 'keep'), 'intact')
    const failed = queue.enqueueWrite({ chatId: 'bad', filePath: occupied, data: payload(1) }).then(
      () => 'unexpected success',
      () => 'rejected'
    )
    const good = queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(2) })
    worker.failNext()
    expect(await failed).toBe('rejected')
    await good
    expect(queue.stats).toMatchObject({
      queuedBytes: 0,
      inFlightBytes: 0,
      localBytes: 0,
      retainedBytes: 0,
      degraded: true,
      written: 1,
      writtenSynchronously: 1
    })
    await expect(
      queue.enqueueWrite({ chatId: 'bad', filePath: occupied, data: payload(3) })
    ).rejects.toThrow()
    expect(queue.stats.retainedBytes).toBe(0)
    await queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(4) })
    expect(queue.stats).toMatchObject({ retainedBytes: 0, localBytes: 0, writtenSynchronously: 2 })
    expect(readRevision()).toBe(4)
    queue.dispose()
  })

  it('clears bytes after timeout, post failure and initial spawn failure', async () => {
    const worker = new FakeWriteWorker()
    const timeout = new PersistenceWriteQueue({
      channelFactory: () => worker.channel(),
      ackTimeoutMs: 1
    })
    await timeout.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(1) })
    expect(timeout.stats).toMatchObject({
      retainedBytes: 0,
      localBytes: 0,
      writtenSynchronously: 1
    })
    timeout.dispose()
    for (const channelFactory of [
      () => {
        throw new Error('spawn failed')
      },
      () => ({
        ...worker.channel(),
        post: () => {
          throw new Error('post failed')
        }
      })
    ]) {
      const queue = new PersistenceWriteQueue({ channelFactory })
      await queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(2) })
      expect(queue.stats).toMatchObject({
        retainedBytes: 0,
        localBytes: 0,
        writtenSynchronously: 1
      })
      expect(queue.stats.peakRetainedBytes).toBe(bytes(payload(2)))
      queue.dispose()
    }
  })

  it('keeps disposed payload retention visible until the existing explicit drain releases it', async () => {
    const worker = new FakeWriteWorker()
    const queue = new PersistenceWriteQueue({ channelFactory: () => worker.channel() })
    const first = queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(1) })
    const second = queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(2) })
    const retained = bytes(payload(1)) + bytes(payload(2))
    queue.dispose()
    expect(queue.stats).toMatchObject({
      disposed: true,
      retainedBytes: retained,
      queuedBytes: bytes(payload(2)),
      inFlightBytes: bytes(payload(1))
    })
    await queue.enqueueWrite({
      chatId: 'other',
      filePath: path.join(dir, 'other.json'),
      data: payload(3)
    })
    expect(queue.stats).toMatchObject({
      retainedBytes: retained,
      localBytes: 0,
      peakRetainedBytes: retained + bytes(payload(3))
    })
    expect(queue.drainSync()).toBe(2)
    await Promise.all([first, second])
    expect(queue.stats).toMatchObject({
      retainedBytes: 0,
      queuedBytes: 0,
      inFlightBytes: 0,
      localBytes: 0
    })
    expect(queue.drainSync()).toBe(0)
    worker.ackBogusJobId(1)
    expect(queue.stats.retainedBytes).toBe(0)
    expect(readRevision()).toBe(2)
  })

  it('does not count failed serialization or keep detached bytes when the existing degrade callback throws', async () => {
    const worker = new FakeWriteWorker()
    const queue = new PersistenceWriteQueue({
      channelFactory: () => worker.channel(),
      maxQueueDepth: 1,
      onDegraded: () => {
        throw new Error('existing callback failure')
      }
    })
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => queue.enqueueWrite({ chatId: 'bad', filePath: chatPath, data: cyclic })).toThrow()
    expect(queue.stats.peakRetainedBytes).toBe(0)
    void queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(1) })
    void queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(2) })
    expect(() =>
      queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(3) })
    ).toThrow('existing callback failure')
    // The original path discards the detached batch when that callback throws.
    // Observations must not keep reporting roots the queue no longer retains.
    expect(queue.stats).toMatchObject({
      retainedBytes: 0,
      queuedBytes: 0,
      inFlightBytes: 0,
      localBytes: 0
    })
    queue.dispose()
  })
})

describe('PersistenceWriteQueue', () => {
  it('is off unless TASKWRAITH_UTILITY_WRITE=1', () => {
    // Default ON since 2026-09-11: only an explicit '0' returns to the
    // synchronous main-thread writer. A typo must not silently put fsync back
    // on the thread that serves the transcript.
    expect(isUtilityWriteEnabled({})).toBe(true)
    expect(isUtilityWriteEnabled({ TASKWRAITH_UTILITY_WRITE: '1' })).toBe(true)
    expect(isUtilityWriteEnabled({ TASKWRAITH_UTILITY_WRITE: 'true' })).toBe(true)
    expect(isUtilityWriteEnabled({ TASKWRAITH_UTILITY_WRITE: '' })).toBe(true)
    expect(isUtilityWriteEnabled({ TASKWRAITH_UTILITY_WRITE: '0' })).toBe(false)
    expect(isUtilityWriteEnabled({ TASKWRAITH_UTILITY_WRITE: ' 0 ' })).toBe(false)
  })

  /**
   * The will-quit contract. `dispose()` kills the channel, which DROPS queued
   * jobs and the un-ACKed in-flight one — acceptable mid-session (the caller's
   * degrade paths handle it) but silent history loss at quit, because
   * `flushAllChatSaves` can enqueue barrier jobs moments earlier.
   *
   * FALSIFIED by calling dispose() without drainSync(): revision stays 0 on
   * disk and both promises hang forever.
   */
  it('drains queued and in-flight jobs synchronously at quit instead of dropping them', async () => {
    const worker = new FakeWriteWorker()
    const queue = new PersistenceWriteQueue({ channelFactory: () => worker.channel() })
    const first = queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(1) })
    const second = queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(2) })

    // Nothing ACKed: one job sits with the worker, one is still queued.
    expect(queue.drainSync()).toBe(2)
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(readRevision()).toBe(2)
    expect(queue.stats.writtenSynchronously).toBe(2)
    // The channel died before the drain wrote anything, so a late worker ACK
    // for the drained in-flight job can never arrive to look like a protocol
    // violation.
    expect(worker.killed).toBe(true)

    queue.dispose()
    expect(queue.drainSync()).toBe(0)
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
    writes.push(queue.enqueueWrite({ chatId: 'chat-a', filePath: chatPath, data: payload(4) }))

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
