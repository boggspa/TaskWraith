import type {
  CodexClientLifecycleQueue,
  CodexClientLifecycleQueueSlot
} from './CodexClientLifecycleQueue'
import type {
  CodexClientRunCohortLease,
  CodexClientRunCohortRegistry
} from './CodexClientRunCohort'

export interface CodexClientWaiterLifecycleGrant {
  readonly kind: 'lifecycle'
  release(): void
}

export type CodexClientWaiterGrant<T> =
  | CodexClientWaiterLifecycleGrant
  | { readonly kind: 'cohort'; readonly lease: CodexClientRunCohortLease<T> }

export interface CodexClientWaiterDescription {
  readonly ownerId: string
  readonly compatibilityKey: string | null
  readonly seq: number
  readonly intent: 'exclusive' | 'compatible'
}

interface Waiter<T> extends CodexClientWaiterDescription {
  state: 'queued' | 'joining' | 'settled'
  cancelRequested: boolean
  readonly signal?: AbortSignal
  readonly slot: CodexClientLifecycleQueueSlot
  readonly abortWait: AbortController
  readonly detachAbort: () => void
  readonly resolve: (grant: CodexClientWaiterGrant<T> | null) => void
  readonly reject: (error: unknown) => void
}

export interface CodexClientWaiterQueueDependencies<T> {
  readonly lifecycleQueue: () => Pick<CodexClientLifecycleQueue, 'enqueue'>
  readonly cohorts: () => CodexClientRunCohortRegistry<T>
  /** Never reopen a cohort whose exact lifecycle ownership was lost. */
  readonly canReopen: (resource: T) => boolean
}

/**
 * Ordered compatible batches layered over the existing lifecycle FIFO.
 *
 * A joined/cancelled waiter's slot is released through the FIFO's cancellation
 * barrier: later destructive work still waits for the current lifecycle owner.
 * Only the leading compatible group may join. The first incompatible/exclusive
 * waiter closes admission to providers and neutral borrowers, so new traffic
 * cannot indefinitely extend the cohort that this waiter needs to drain.
 *
 * This is scheduling bookkeeping only. It never starts, retargets or retains
 * a client, and final-owner teardown remains the cohort registry's job.
 */
export class CodexClientWaiterQueue<T> {
  private nextSequence = 0
  private readonly pending: Waiter<T>[] = []
  private refreshing = false
  private refreshAgain = false

  constructor(private readonly deps: CodexClientWaiterQueueDependencies<T>) {}

  async acquireCompatible(
    ownerId: string,
    compatibilityKey: string,
    signal?: AbortSignal
  ): Promise<CodexClientWaiterGrant<T> | null> {
    const owner = exactIdentity(ownerId, 'owner')
    const key = exactIdentity(compatibilityKey, 'compatibility key')
    if (signal?.aborted) return null
    this.refresh()
    // Normal compatible arrivals need no FIFO slot or retained promise chain.
    // Refresh first so older eligible waiters are enrolled before this arrival.
    if (this.pending.length === 0) {
      const lease = this.deps.cohorts().tryJoin(owner, key)
      if (lease) return { kind: 'cohort', lease }
    }
    return this.enqueue(owner, 'compatible', key, signal)
  }

  async acquireExclusive(
    ownerId: string,
    signal?: AbortSignal
  ): Promise<CodexClientWaiterLifecycleGrant | null> {
    const owner = exactIdentity(ownerId, 'owner')
    if (signal?.aborted) return null
    const grant = await this.enqueue(owner, 'exclusive', null, signal)
    if (grant?.kind === 'cohort') {
      throw new Error('An exclusive Codex waiter cannot join a cohort.')
    }
    return grant
  }

  /** Call synchronously after cohort.open(), before returning its owner lease. */
  cohortOpened(): void {
    this.refresh()
  }

  snapshot(): readonly CodexClientWaiterDescription[] {
    return this.pending.map(({ ownerId, compatibilityKey, seq, intent }) => ({
      ownerId,
      compatibilityKey,
      seq,
      intent
    }))
  }

  private enqueue(
    ownerId: string,
    intent: 'exclusive' | 'compatible',
    compatibilityKey: string | null,
    signal?: AbortSignal
  ): Promise<CodexClientWaiterGrant<T> | null> {
    const slot = this.deps.lifecycleQueue().enqueue()
    const abortWait = new AbortController()
    return new Promise((resolve, reject) => {
      const onAbort = (): void => this.cancel(waiter)
      const waiter: Waiter<T> = {
        ownerId,
        compatibilityKey,
        seq: ++this.nextSequence,
        intent,
        state: 'queued',
        cancelRequested: false,
        signal,
        slot,
        abortWait,
        detachAbort: () => signal?.removeEventListener('abort', onAbort),
        resolve,
        reject
      }
      this.pending.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      let waiting: Promise<boolean>
      try {
        waiting = slot.waitUntilAcquired(abortWait.signal)
      } catch (error) {
        this.fail(waiter, error)
        return
      }
      void waiting.then(
        (acquired) => {
          if (waiter.state !== 'queued') return
          if (!acquired || signal?.aborted) {
            this.cancel(waiter)
            return
          }
          this.detach(waiter)
          let released = false
          resolve({
            kind: 'lifecycle',
            release: () => {
              if (released) return
              released = true
              slot.release()
              this.refresh()
            }
          })
          this.refresh()
        },
        (error) => this.fail(waiter, error)
      )
      if (signal?.aborted) this.cancel(waiter)
      else this.refresh()
    })
  }

  private detach(waiter: Waiter<T>): void {
    waiter.state = 'settled'
    waiter.detachAbort()
    const index = this.pending.indexOf(waiter)
    if (index !== -1) this.pending.splice(index, 1)
  }

  private cancelSlot(waiter: Waiter<T>): void {
    waiter.abortWait.abort()
    // Also releases a slot that acquired just before the abort callback. The
    // original FIFO decides whether immediate release is safe.
    waiter.slot.release()
  }

  private cancel(waiter: Waiter<T>): void {
    if (waiter.state === 'joining') {
      waiter.cancelRequested = true
      return
    }
    if (waiter.state !== 'queued') return
    this.detach(waiter)
    this.cancelSlot(waiter)
    waiter.resolve(null)
    this.refresh()
  }

  private fail(waiter: Waiter<T>, error: unknown): void {
    if (waiter.state === 'settled') return
    this.detach(waiter)
    this.cancelSlot(waiter)
    waiter.reject(error)
    this.refresh()
  }

  private join(waiter: Waiter<T>): boolean {
    waiter.state = 'joining'
    try {
      const lease = this.deps.cohorts().tryJoin(waiter.ownerId, waiter.compatibilityKey!)
      if (!lease) {
        waiter.state = 'queued'
        if (waiter.cancelRequested || waiter.signal?.aborted) this.cancel(waiter)
        return false
      }
      const cancelled = waiter.cancelRequested || waiter.signal?.aborted
      this.detach(waiter)
      this.cancelSlot(waiter)
      if (cancelled) {
        // A synchronous abort during a join must not strand the new owner.
        void lease.release().then(() => waiter.resolve(null), waiter.reject)
      } else {
        waiter.resolve({ kind: 'cohort', lease })
      }
      return true
    } catch (error) {
      this.fail(waiter, error)
      return true
    }
  }

  private refresh(): void {
    if (this.refreshing) {
      this.refreshAgain = true
      return
    }
    this.refreshing = true
    try {
      do {
        this.refreshAgain = false
        this.refreshCohort()
      } while (this.refreshAgain)
    } finally {
      this.refreshing = false
    }
  }

  private refreshCohort(): void {
    const cohorts = this.deps.cohorts()
    const active = cohorts.admissionState()
    if (!active) return
    const head = this.pending[0]
    if (
      head &&
      (head.intent === 'exclusive' || head.compatibilityKey !== active.compatibilityKey)
    ) {
      cohorts.stopAccepting()
      return
    }
    if (!active.accepting && !this.deps.canReopen(active.resource)) return
    if (!cohorts.reopenAdmission()) return
    while (this.pending.length > 0) {
      const waiter = this.pending[0]
      if (waiter.intent !== 'compatible' || waiter.compatibilityKey !== active.compatibilityKey) {
        cohorts.stopAccepting()
        break
      }
      if (waiter.signal?.aborted) {
        this.cancel(waiter)
        continue
      }
      if (!this.join(waiter)) break
    }
  }
}

function exactIdentity(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error('Codex waiter requires an exact ' + label + '.')
  return normalized
}
