import fs from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { DurabilityFlusherPorts, DurabilitySyncTicket } from './MainDurabilityFlusher'

interface Operation {
  generation: number
  fd: number
  words: Int32Array
  shared: SharedArrayBuffer
  complete(error?: Error): void
  done: boolean
}

/** One worker, one outstanding syscall, no payload queue. Shared completion
 * permits a strict main-thread join without waiting on a JS message callback.
 * A timed-out join refuses further operations and retains the fd pin until
 * shared completion or asynchronously confirmed worker termination.
 */
export class MainDurabilityFsyncAdapter implements DurabilityFlusherPorts {
  private readonly worker: Worker
  private operation?: Operation
  private generation = 0
  private poisoned?: Error
  private stopped = false
  private poll?: ReturnType<typeof setTimeout>

  constructor(
    options: { entryPath: string; joinTimeoutMs?: number },
    private readonly joinTimeoutMs = options.joinTimeoutMs ?? 5000
  ) {
    if (!Number.isFinite(joinTimeoutMs) || joinTimeoutMs <= 0)
      throw new Error('Invalid join timeout')
    this.worker = new Worker(options.entryPath, {
      // Main owns every fd. Worker exit must never auto-close one.
      trackUnmanagedFds: false,
      execArgv: []
    })
    this.worker.on('message', (generation) => {
      if (generation === this.operation?.generation) this.consume()
    })
    // These callbacks are supplementary; joinSync never depends on them.
    this.worker.on('error', (error) => {
      this.poisoned = error
    })
    this.worker.on('exit', (code) => {
      this.stopped = true
      this.poisoned ??= new Error(`Durability worker exited (${code})`)
      const operation = this.operation
      if (operation) this.finish(operation, this.poisoned)
    })
  }

  now(): number {
    return performance.now()
  }

  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs)
  }

  clearTimer(timer: unknown): void {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  }

  fsync(fd: number, complete: (error?: Error) => void): DurabilitySyncTicket {
    this.available()
    if (this.operation) throw new Error('A durability fsync is already outstanding')
    const identity = fs.fstatSync(fd, { bigint: true })
    const shared = new SharedArrayBuffer(528)
    const words = new Int32Array(shared, 0, 4)
    // Each operation owns its shared buffer. Reuse or wrap cannot alias it.
    this.generation = (this.generation % 0x7ffffffe) + 1
    Atomics.store(words, 1, this.generation)
    if (Atomics.compareExchange(words, 0, 0, 1) !== 0) throw new Error('Invalid durability slot')
    const operation: Operation = {
      generation: this.generation,
      fd,
      words,
      shared,
      complete,
      done: false
    }
    this.operation = operation
    try {
      this.worker.postMessage({
        fd,
        dev: String(identity.dev),
        ino: String(identity.ino),
        generation: operation.generation,
        shared
      })
    } catch (error) {
      // No syscall was submitted; no fd pin needs to survive this refusal.
      this.operation = undefined
      throw error
    }
    this.armPoll()
    return { joinSync: () => this.join(operation) }
  }

  fsyncSync(fd: number): void {
    this.available()
    if (this.operation) throw new Error('Join outstanding durability fsync first')
    fs.fsyncSync(fd)
  }

  close(fd: number): void {
    if (this.operation?.fd === fd) throw new Error('Durability descriptor is pinned')
    fs.closeSync(fd)
  }

  /** Await termination before releasing pins. Never use this promise to satisfy
   * a synchronous join: its callback needs the main event loop.
   */
  async dispose(): Promise<void> {
    this.poisoned ??= new Error('Durability adapter disposed')
    await this.worker.terminate()
    this.stopped = true
    if (this.operation) this.finish(this.operation, this.poisoned)
    if (this.poll) clearTimeout(this.poll)
    this.poll = undefined
  }

  private available(): void {
    if (this.poisoned) throw this.poisoned
    if (this.stopped) throw new Error('Durability worker stopped')
  }

  private join(operation: Operation): void {
    const deadline = performance.now() + this.joinTimeoutMs
    while (!operation.done) {
      if (this.consume(operation)) return
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        this.poisoned = new Error(
          'Durability synchronous join timed out; descriptor remains pinned'
        )
        throw this.poisoned
      }
      const state = Atomics.load(operation.words, 0)
      if (state === 1 || state === 2) Atomics.wait(operation.words, 0, state, remaining)
    }
  }

  private consume(operation = this.operation): boolean {
    if (!operation || operation.done) return true
    if (operation !== this.operation || Atomics.load(operation.words, 1) !== operation.generation) {
      this.poisoned = new Error('Durability operation generation changed')
      return false
    }
    const state = Atomics.load(operation.words, 0)
    if (state !== 3 && state !== 4) return false
    const error =
      state === 4
        ? new Error(
            Buffer.from(operation.shared, 16, Atomics.load(operation.words, 2)).toString('utf8')
          )
        : undefined
    this.finish(operation, error)
    return true
  }

  private finish(operation: Operation, error?: Error): void {
    if (operation.done) return
    operation.done = true
    if (this.operation === operation) this.operation = undefined
    if (this.poll) clearTimeout(this.poll)
    this.poll = undefined
    operation.complete(error)
  }

  private armPoll(): void {
    this.poll = setTimeout(() => {
      this.poll = undefined
      if (!this.consume()) this.armPoll()
    }, 5)
  }
}
