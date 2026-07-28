/**
 * Dispatch-slot governor for Pi's Cerebras upstream.
 *
 * Cerebras project keys enforce a small requests-per-minute window (5 RPM on
 * the tiers observed) in addition to TPM reservation accounting, and the pi
 * CLI retries a failing request internally in a fast burst — observed live
 * 2026-07-28 as four attempts in 17 seconds, i.e. one failing turn can burn
 * the whole window and every request after it in the same minute dies with a
 * body-less 429. This module hands out RESERVED dispatch slots on one shared
 * timeline: concurrent callers (ensemble seats fan out simultaneously through
 * the same runPiProvider choke-point) serialize instead of stampeding, and an
 * observed 429 imposes a full-window backoff floor before the next slot.
 *
 * Pure and clock-injectable. The main-process singleton is consulted only for
 * `cerebras/*` models; other Pi upstreams are never delayed.
 */

export const PI_CEREBRAS_RATE_WINDOW_MS = 60_000

/** Reserved dispatch slots per window — one below Cerebras's 5-RPM project
 * limit so pi's own internal retries and ensemble health probes have headroom
 * inside the same minute. */
export const PI_CEREBRAS_RPM_SLOTS = 4

/** After an observed 429, hold the next dispatch until a full window has
 * passed — partial waits just re-burn the exhausted window. */
export const PI_CEREBRAS_429_BACKOFF_MS = 60_000

/** Never park a dispatch longer than this. A stampede larger than the cap
 * should surface the provider's own 429 (and its enriched explanation)
 * rather than queue minutes of silent latency. */
export const PI_CEREBRAS_MAX_HOLD_MS = 90_000

export interface PiCerebrasRateGovernorOptions {
  windowMs?: number
  slotsPerWindow?: number
  backoffMs?: number
  maxHoldMs?: number
}

export class PiCerebrasRateGovernor {
  private slots: number[] = []
  private backoffUntil = 0
  private readonly windowMs: number
  private readonly slotsPerWindow: number
  private readonly backoffMs: number
  private readonly maxHoldMs: number

  constructor(options: PiCerebrasRateGovernorOptions = {}) {
    this.windowMs = options.windowMs ?? PI_CEREBRAS_RATE_WINDOW_MS
    this.slotsPerWindow = options.slotsPerWindow ?? PI_CEREBRAS_RPM_SLOTS
    this.backoffMs = options.backoffMs ?? PI_CEREBRAS_429_BACKOFF_MS
    this.maxHoldMs = options.maxHoldMs ?? PI_CEREBRAS_MAX_HOLD_MS
  }

  /** Reserve the next dispatch slot. Records the reservation immediately so
   * concurrent callers chain onto later slots; returns how long the caller
   * must wait before actually dispatching (0 = go now). */
  reserveDispatchSlot(at: number = Date.now()): { waitMs: number } {
    this.prune(at)
    let target = Math.max(at, this.backoffUntil)
    if (this.slots.length >= this.slotsPerWindow) {
      const windowAnchor = this.slots[this.slots.length - this.slotsPerWindow]
      target = Math.max(target, windowAnchor + this.windowMs)
    }
    const waitMs = Math.min(Math.max(target - at, 0), this.maxHoldMs)
    // Record the moment the dispatch will actually fire (the cap can pull it
    // earlier than the computed target — record reality, not the ideal).
    this.slots.push(at + waitMs)
    this.slots.sort((a, b) => a - b)
    return { waitMs }
  }

  /** An upstream 429 was observed: floor the next slot a full window out. */
  note429(at: number = Date.now()): void {
    this.backoffUntil = Math.max(this.backoffUntil, at + this.backoffMs)
  }

  /** Non-reserving preview of the current hold (diagnostics/tests). */
  peekHoldMs(at: number = Date.now()): number {
    this.prune(at)
    let target = Math.max(at, this.backoffUntil)
    if (this.slots.length >= this.slotsPerWindow) {
      const windowAnchor = this.slots[this.slots.length - this.slotsPerWindow]
      target = Math.max(target, windowAnchor + this.windowMs)
    }
    return Math.min(Math.max(target - at, 0), this.maxHoldMs)
  }

  private prune(at: number): void {
    const cutoff = at - this.windowMs
    // Future reservations are never pruned; only slots a full window old.
    this.slots = this.slots.filter((slot) => slot > cutoff)
  }
}
