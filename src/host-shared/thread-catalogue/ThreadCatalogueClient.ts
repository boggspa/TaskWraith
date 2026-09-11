import type { ThreadCatalogueReaderOptions } from './ThreadCatalogueWitness'
import type { ThreadCatalogueProjection } from './ThreadCatalogue'
import type { ThreadCatalogueQuery, ThreadCatalogueOwner } from '../../shared/threadCatalogueTypes'
export type {
  ThreadCatalogueQuery,
  ThreadCatalogueOwner,
  ThreadCatalogueOpenResult
} from '../../shared/threadCatalogueTypes'
/**
 * Per-request budget for every history query that crosses this client.
 *
 * Named because a recovery hold's expiry must be sized against THIS budget:
 * the recovery controller and `ThreadCatalogueHostRecovery` both await this
 * client, not the shorter `HostProjectionClient` one.
 */
export const THREAD_CATALOGUE_REQUEST_TIMEOUT_MS = 150_000

/**
 * Which lane a request takes inside the worker.
 *
 * `background` is an opt-in for whole-corpus repair, whose only caller today is
 * the post-paint history recovery drain. It rides the ENVELOPE rather than the
 * query, because `decodeThreadCatalogueReadQuery` is a strict allowlist that
 * rebuilds each query field-by-field and would silently eat an unknown key on
 * the Host path. Absent means foreground, so nothing that predates this changes.
 */
export type ThreadCatalogueRequestPriority = 'foreground' | 'background'

export interface ThreadCatalogueQueryOptions {
  priority?: ThreadCatalogueRequestPriority
}

export interface ThreadCatalogueProcessPort {
  postMessage(value: unknown): void
  on(event: 'message', listener: (value: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  terminate(): void | Promise<unknown>
}

export type ThreadCatalogueEvent =
  | { type: 'changed'; projection: ThreadCatalogueProjection }
  | { type: 'removed'; chatId: string }
  | { type: 'progress'; total: number; indexed: number; failed: number }

/** Transport-only client. No catalogue, SQLite or canonical-history reader is imported here. */
export class ThreadCatalogueClient {
  private disposeFlight: Promise<void> | null = null
  private readonly exited = new WeakSet<ThreadCatalogueProcessPort>()
  private nextId = 0
  private closed = false
  private stopping = false
  private initializing!: Promise<void>
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartFlight: Promise<void> | null = null
  private cancelRestart: (() => void) | null = null
  private restartAttempts = 0
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private readonly listeners = new Set<(event: ThreadCatalogueEvent) => void>()

  constructor(
    private port: ThreadCatalogueProcessPort,
    private readonly options: {
      reader: ThreadCatalogueReaderOptions
      decoderPath: string
      owner: ThreadCatalogueOwner
      restart?: () => ThreadCatalogueProcessPort
      restartDelayMs?: number
    }
  ) {
    this.connect(port)
  }

  get ready(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('History worker is shut down'))
    return this.closed && this.restartFlight ? this.restartFlight : this.initializing
  }
  get available(): boolean {
    return !this.closed && !this.stopping
  }

  private connect(port: ThreadCatalogueProcessPort): void {
    this.port = port
    this.closed = false
    port.on('message', (message) => {
      if (this.port === port) this.receive(message)
    })
    port.on('error', () => {
      if (this.port === port) this.fail(new Error('History worker failed'))
    })
    port.on('exit', () => {
      this.exited.add(port)
      if (this.port === port) this.fail(new Error('History worker exited'))
    })
    this.initializing = this.call({
      method: 'initialize',
      reader: this.options.reader,
      decoderPath: this.options.decoderPath,
      owner: this.options.owner,
      sourceAuthorityPid: process.pid
    }).then(() => undefined)
    void this.initializing.catch((error) => {
      if (this.port === port) this.fail(error)
    })
  }

  subscribe(listener: (event: ThreadCatalogueEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async query<T = unknown>(
    query: ThreadCatalogueQuery,
    options: ThreadCatalogueQueryOptions = {}
  ): Promise<T> {
    await this.ready
    return this.call(query, THREAD_CATALOGUE_REQUEST_TIMEOUT_MS, options.priority) as Promise<T>
  }

  private call(
    query: unknown,
    timeoutMs = THREAD_CATALOGUE_REQUEST_TIMEOUT_MS,
    priority?: ThreadCatalogueRequestPriority
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('History worker is unavailable'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('History request timed out'))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        // Only a BACKGROUND request carries the field. Foreground envelopes stay
        // byte-identical to what every existing caller has always sent, and a
        // reader that predates this — an older external Host on the same wire —
        // sees exactly the message it already understands.
        this.port.postMessage(priority === 'background' ? { id, query, priority } : { id, query })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error('History request failed'))
      }
    })
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const message = value as {
      id?: number
      ok?: boolean
      value?: unknown
      error?: string
      event?: ThreadCatalogueEvent
    }
    if (message.event) {
      for (const listener of this.listeners) listener(message.event)
      return
    }
    const pending = this.pending.get(message.id ?? -1)
    if (!pending) return
    this.pending.delete(message.id!)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.value)
    else pending.reject(new Error(message.error || 'History query failed'))
  }

  private fail(error: Error): void {
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.stopping || !this.options.restart || this.restartFlight) return
    const old = this.port
    const delay = Math.min(
      10_000,
      (this.options.restartDelayMs ?? 250) * 2 ** Math.min(6, this.restartAttempts++)
    )
    let cancel!: () => void
    const flight = new Promise<void>((resolve, reject) => {
      cancel = () => reject(new Error('History restart cancelled'))
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        void (async () => {
          await this.terminate(old)
          if (this.stopping) throw new Error('History worker is shut down')
          this.connect(this.options.restart!())
          await this.initializing
          this.restartAttempts = 0
        })().then(resolve, reject)
      }, delay)
      this.restartTimer.unref?.()
    })
    this.cancelRestart = cancel
    this.restartFlight = flight
    void flight
      .catch(() => undefined)
      .finally(() => {
        if (this.restartFlight !== flight) return
        this.restartFlight = null
        this.cancelRestart = null
        if (this.closed) this.scheduleRestart()
      })
  }

  private async terminate(port: ThreadCatalogueProcessPort): Promise<void> {
    if (this.exited.has(port)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(() => port.terminate()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('History worker termination is unconfirmed')),
            5000
          )
          timer.unref?.()
        })
      ])
    } catch (error) {
      if (!this.exited.has(port)) throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  dispose(): Promise<void> {
    return (this.disposeFlight ??= this.performDispose())
  }

  private async performDispose(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
      this.cancelRestart?.()
    }
    const flight = this.restartFlight
    try {
      if (!this.closed) await this.call({ method: 'close' }, 2000)
    } catch {
      /* The disposable reader still terminates below. Canonical writers drain separately. */
    } finally {
      this.fail(new Error('History worker shut down'))
      this.listeners.clear()
      await this.terminate(this.port)
      await flight?.catch(() => undefined)
    }
  }
}
