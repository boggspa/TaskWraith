/**
 * The wait at the places that report a moment as done, now that a save does
 * not sync: before a reply says a message was accepted, before an agent is
 * told a decision, before work that follows a run's end starts.
 *
 * A save that contains a moment takes a ticket on the thread's barrier
 * (`ChatDurabilityTickets`); the place that reports the moment waits for the
 * chat's tickets here first. Two waits:
 * - the user's moments (a message, a decision, a destructive change), for the
 *   places the user sits in. Their barriers are urgent, and a run's final
 *   record, whose barrier is not, is never waited for there;
 * - a run's end, for work that follows it: every ticket of the chat.
 * A chat with nothing to wait for gets `null` at once, so a site that is
 * synchronous stays synchronous.
 *
 * Bounded. Nothing the user does may wait without a bound, so a wait ends at
 * `DURABLE_MOMENT_GATE_BOUND_MS` whatever the barrier is doing: the action
 * goes ahead, the wait is counted as overdue, and the barrier keeps running
 * and settles its ticket later. The bound: a sync costs 4 to 5 ms a path on
 * this machine with other writers on the volume (36152cea4), one finished run
 * owes about seven paths, and the layer's exits ask for user-facing waits
 * under 50 ms and a run's end under 250 ms at the 95th percentile. One second
 * is twenty times the first and four times the second, so only a stalled disk
 * reaches it, and it is the most a user should sit in a sending state for a
 * wait they cannot see.
 *
 * A barrier that rejects is the disk refusing a sync. The wait rejects with
 * that error, and the site lets it surface as its own persistence failure
 * does: a reply that throws, a dispatch that fails, a delivery that is not
 * made. Nothing here retries, and a site must never retry a dispatch because
 * a wait threw. `settleUserMoment` is for the sites whose persistence failure
 * is logged while the action goes ahead (an answer handed to an agent): it
 * logs the refusal and resolves. A refusal that comes after the bound, when
 * the action has already gone ahead, can only be counted and logged.
 *
 * The store installs one gate while barrier durability is on. With none
 * installed every wait is `null`: with the switch off nothing waits and
 * nothing changes.
 *
 * Memory: one timer and two callbacks per wait in progress.
 */
import { USER_DURABILITY_MOMENTS, type ChatDurabilityMoment } from '../store/ChatDurabilityTickets'

/** The longest a moment's place waits for its barrier before the action goes ahead. */
export const DURABLE_MOMENT_GATE_BOUND_MS = 1_000

/** The chat's tickets, as `ChatDurabilityTickets` keeps them. */
export interface DurableMomentSource {
  /** Whether the chat has a ticket of these moments to wait for, cover or report. */
  holds(chatId: string, moments?: readonly ChatDurabilityMoment[]): boolean
  awaitChat(chatId: string, moments?: readonly ChatDurabilityMoment[]): Promise<void>
}

export interface DurableMomentGateSnapshot {
  /** Waits that had something to wait for. */
  waits: number
  /** Of those, the ones the bound ended: the action went ahead while the barrier kept running. */
  overdue: number
  /** Waits whose barrier failed, before the bound or after it. */
  rejected: number
  /** From each wait's start to its end, the barrier settling or the bound: summed and at its longest. */
  waitMsTotal: number
  longestWaitMs: number
}

export interface DurableMomentGateOptions {
  source: DurableMomentSource
  boundMs?: number
  /** Milliseconds. */
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Where a refusal nobody else hears of is reported. */
  log?: (message: string, error: unknown) => void
}

export class DurableMomentGate {
  private readonly source: DurableMomentSource
  private readonly boundMs: number
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly log: (message: string, error: unknown) => void
  private waits = 0
  private overdue = 0
  private rejected = 0
  private waitMsTotal = 0
  private longestWaitMs = 0
  private lateRefusalLogged = false

  constructor(options: DurableMomentGateOptions) {
    const bound = options.boundMs ?? DURABLE_MOMENT_GATE_BOUND_MS
    if (!Number.isFinite(bound) || bound <= 0) throw new Error('Invalid durable moment bound')
    this.source = options.source
    this.boundMs = bound
    this.now = options.now ?? (() => performance.now())
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.log = options.log ?? ((message, error) => console.error(message, error))
  }

  /** For a place the user sits in: the chat's user moments. Null when there is nothing to wait for. */
  userMoment(chatId: string | null | undefined): Promise<void> | null {
    return this.waitFor(chatId, USER_DURABILITY_MOMENTS)
  }

  /** For work that follows a run's end: every ticket of the chat. Null when there is nothing to wait for. */
  runFinal(chatId: string | null | undefined): Promise<void> | null {
    return this.waitFor(chatId, undefined)
  }

  /**
   * Bounds a wait the caller holds already: resolves when `durable` does or
   * at the bound, whichever is first, and rejects when `durable` rejects
   * before the bound.
   */
  bound(durable: Promise<void>): Promise<void> {
    const startedAt = this.now()
    this.waits += 1
    return new Promise<void>((resolve, reject) => {
      let ended = false
      const end = (): void => {
        ended = true
        const waited = Math.max(0, this.now() - startedAt)
        this.waitMsTotal += waited
        this.longestWaitMs = Math.max(this.longestWaitMs, waited)
      }
      const timer = this.setTimer(() => {
        if (ended) return
        end()
        this.overdue += 1
        resolve()
      }, this.boundMs)
      ;(timer as { unref?: () => void } | null)?.unref?.()
      durable.then(
        () => {
          if (ended) return
          this.clearTimer(timer)
          end()
          resolve()
        },
        (error: unknown) => {
          this.rejected += 1
          if (ended) {
            // The action already went ahead at the bound: nobody else hears of this.
            if (!this.lateRefusalLogged) {
              this.lateRefusalLogged = true
              this.log('[durable-moment] the disk refused a sync after its wait had ended', error)
            }
            return
          }
          this.clearTimer(timer)
          end()
          reject(error)
        }
      )
    })
  }

  snapshot(): DurableMomentGateSnapshot {
    return {
      waits: this.waits,
      overdue: this.overdue,
      rejected: this.rejected,
      waitMsTotal: this.waitMsTotal,
      longestWaitMs: this.longestWaitMs
    }
  }

  private waitFor(
    chatId: string | null | undefined,
    moments: readonly ChatDurabilityMoment[] | undefined
  ): Promise<void> | null {
    if (!chatId || !this.source.holds(chatId, moments)) return null
    return this.bound(this.source.awaitChat(chatId, moments))
  }
}

let installed: DurableMomentGate | null = null
let settleRefusalLogged = false

/** The store installs its gate while barrier durability is on, and removes it with null. */
export function installDurableMomentGate(gate: DurableMomentGate | null): void {
  installed = gate
}

/** The installed gate's wait for the user's moments of a chat; null with none installed. */
export function awaitUserMoment(chatId: string | null | undefined): Promise<void> | null {
  return installed?.userMoment(chatId) ?? null
}

/** The installed gate's wait for every ticket of a chat; null with none installed. */
export function awaitRunFinal(chatId: string | null | undefined): Promise<void> | null {
  return installed?.runFinal(chatId) ?? null
}

/** A synchronous reply that waits for the user's moments when there are any. */
export function afterUserMoment<T>(chatId: string | null | undefined, reply: T): T | Promise<T> {
  const waiting = awaitUserMoment(chatId)
  return waiting ? waiting.then(() => reply) : reply
}

/**
 * The wait for the user's moments, for a site that logs a persistence failure
 * and goes ahead: a refusal is logged, once, and the wait resolves.
 */
export function settleUserMoment(
  chatId: string | null | undefined,
  site: string
): Promise<void> | null {
  const waiting = awaitUserMoment(chatId)
  return (
    waiting &&
    waiting.catch((error: unknown) => {
      if (settleRefusalLogged) return
      settleRefusalLogged = true
      console.error(`[durable-moment] the disk refused a sync before ${site}; going ahead`, error)
    })
  )
}

/** The installed gate's counters; null with none installed. */
export function durableMomentGateSnapshot(): DurableMomentGateSnapshot | null {
  return installed?.snapshot() ?? null
}
