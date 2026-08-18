/**
 * OllamaLocalAdmissionGate — how many distinct local models may be in flight.
 *
 * A fan-out dispatches every seat at once, which is correct for hosted
 * providers: the lanes are independent and the remote side scales. Local seats
 * are not independent. They share one runner and one pool of VRAM, so N local
 * lanes do not run N ways — they take turns, and the taking of turns is the
 * expensive part. Each turn that arrives for a model that is not resident
 * evicts one that is, and the load/evict churn costs far more than the
 * inference it surrounds. A sixteen-seat round on a two-model machine spends
 * most of its wall clock moving weights.
 *
 * So this gate does not limit concurrency for its own sake. It limits how many
 * DISTINCT models are in flight, which is the same thing Ollama's own
 * `OLLAMA_MAX_LOADED_MODELS` counts, so that an admitted model stays resident
 * long enough to be used before something displaces it.
 *
 * Three properties earn their keep:
 *
 * - **Unknown capacity means unbounded.** Construct it with `capacity:
 *   undefined` (what `OllamaCapacityProbe` returns when the host declares
 *   nothing) and every acquire resolves synchronously. A host with room for
 *   twenty models must behave exactly as it did before this file existed;
 *   the gate is opt-in by evidence, never by default.
 * - **Distinct models, not requests.** Two lanes wanting a model that is
 *   already admitted both proceed — the second costs no load, so charging it
 *   a slot would serialise work that has no reason to be serial.
 * - **Waiting, not failing.** A lane past capacity waits its turn in FIFO
 *   order. It is not refused, not demoted, and not told to shrink the roster.
 *   A twenty-five seat fan-out on a two-model host is a slow success.
 *
 * Capacity is re-sizable at runtime because the probe's opinion can sharpen
 * mid-round. Raising it drains waiters immediately; lowering it never evicts
 * anything already in flight, which would abort live work to satisfy a number
 * that only just arrived.
 */

/** A held admission. Release exactly once; extra releases are ignored. */
export interface OllamaLocalAdmissionTicket {
  readonly model: string
  release(): void
}

export interface OllamaLocalAdmissionGateOptions {
  /** Max distinct models in flight. `undefined` means unbounded. */
  readonly capacity?: number
}

interface Waiter {
  readonly model: string
  readonly resolve: (ticket: OllamaLocalAdmissionTicket) => void
  readonly reject: (error: Error) => void
  readonly detach: () => void
  settled: boolean
}

function abortError(): Error {
  const error = new Error('Local model admission was aborted before it was granted.')
  error.name = 'AbortError'
  return error
}

export class OllamaLocalAdmissionGate {
  /** Model id -> how many live tickets are sharing that model's slot. */
  private readonly held = new Map<string, number>()
  private readonly waiters: Waiter[] = []
  private capacity?: number

  constructor(options: OllamaLocalAdmissionGateOptions = {}) {
    this.capacity = normalizeCapacity(options.capacity)
  }

  /** Distinct models currently admitted. */
  get inFlight(): number {
    return this.held.size
  }

  /** Requests queued behind capacity. */
  get waiting(): number {
    return this.waiters.length
  }

  /**
   * Re-size the gate.
   *
   * `undefined` restores unbounded admission. Raising capacity drains as many
   * waiters as now fit; lowering it leaves in-flight work alone and simply
   * admits nothing new until the count falls back under the new ceiling.
   */
  setCapacity(capacity?: number): void {
    this.capacity = normalizeCapacity(capacity)
    this.drain()
  }

  /**
   * Wait for room to run `model`, then take a ticket.
   *
   * Resolves immediately when capacity is unknown, when the model is already
   * admitted, or when there is a free slot. Otherwise queues FIFO. Rejects
   * with an `AbortError` if `signal` fires before admission — a queued lane
   * the user cancelled must not hold a place in line.
   */
  acquire(model: string, signal?: AbortSignal): Promise<OllamaLocalAdmissionTicket> {
    if (signal?.aborted) return Promise.reject(abortError())
    if (this.canAdmit(model)) return Promise.resolve(this.admit(model))

    return new Promise<OllamaLocalAdmissionTicket>((resolve, reject) => {
      const waiter: Waiter = {
        model,
        resolve,
        reject,
        settled: false,
        detach: () => signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        if (waiter.settled) return
        waiter.settled = true
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        waiter.detach()
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort)
      this.waiters.push(waiter)
    })
  }

  private canAdmit(model: string): boolean {
    if (this.capacity === undefined) return true
    if (this.held.has(model)) return true
    return this.held.size < this.capacity
  }

  private admit(model: string): OllamaLocalAdmissionTicket {
    this.held.set(model, (this.held.get(model) ?? 0) + 1)
    let released = false
    return {
      model,
      release: () => {
        if (released) return
        released = true
        const remaining = (this.held.get(model) ?? 1) - 1
        if (remaining > 0) this.held.set(model, remaining)
        else this.held.delete(model)
        this.drain()
      }
    }
  }

  /**
   * Admit whoever now fits, oldest first.
   *
   * Strictly FIFO: a waiter for an already-resident model is NOT promoted past
   * an older waiter, even though it could be admitted for free. Cheapest-first
   * would starve a lane whose model never happens to be resident, and a lane
   * that never runs is a round that never finishes.
   */
  private drain(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters[0]
      if (!this.canAdmit(next.model)) break
      this.waiters.shift()
      if (next.settled) continue
      next.settled = true
      next.detach()
      next.resolve(this.admit(next.model))
    }
  }
}

function normalizeCapacity(capacity?: number): number | undefined {
  if (capacity === undefined || !Number.isFinite(capacity)) return undefined
  const floored = Math.trunc(capacity)
  return floored > 0 ? floored : undefined
}
