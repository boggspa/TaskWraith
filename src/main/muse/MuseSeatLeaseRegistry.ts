import { resolve } from 'node:path'

/**
 * Which run currently holds each durable Muse seat home, in this main process.
 *
 * A durable seat is keyed by chat and participant (`museSeatStatePath`), so one
 * thread has exactly one seat, and the attach in `createMuseIsolatedHome` is
 * destructive by design: it reduces the seat to session continuity so a turn
 * can never inherit the previous turn's credentials, trust grants or MCP broker
 * token. That is correct for turns that follow one another and catastrophic for
 * turns that overlap — the second attach deletes the credentials the first is
 * still launching with.
 *
 * Measured 2026-09-11: nine runs dispatched into one chat inside 611ms all
 * attached the same seat. Eight died on `missing meta credentials: run muse
 * login or set META_API_KEY`; the ninth tripped the continuity assertion on a
 * `model-catalog` directory a live seat had written mid-scrub. Nothing in the
 * failure named the cause — Muse reports it as a `provider_warning`, which the
 * transcript does not render — so all the user saw was nine identical
 * "Provider exited with code 1." cards.
 *
 * Refusing the overlap is what makes the attach scrub safe to keep. It is not a
 * throttle: a refusal names the holder and the caller falls back or reports it,
 * and every other chat's seat is untouched. In-process only, so a main restart
 * clears every claim — correct, because no seat can still be held by a run from
 * a process that no longer exists.
 */
export class MuseSeatLeaseRegistry {
  private readonly runIdBySeatPath = new Map<string, string>()

  /**
   * Claim `seatPath` for `runId`. Throws when a different run holds it.
   *
   * The message never names the path: a seat path is route data and belongs
   * only in keyed launch-environment evidence, never in text that reaches a
   * warning, a transcript row or a log.
   */
  acquire(seatPath: string, runId: string): void {
    const key = resolve(seatPath)
    const holder = this.runIdBySeatPath.get(key)
    if (holder && holder !== runId) {
      throw new Error(
        `This chat's Muse seat is already in use by run ${holder}. TaskWraith runs one Muse turn per thread at a time, because attaching the seat reduces it to session continuity and would strip the running turn's credentials.`
      )
    }
    this.runIdBySeatPath.set(key, runId)
  }

  /**
   * Release `seatPath` if `runId` is the holder. A release from a run that no
   * longer holds it is a no-op, so a late teardown cannot free the claim a
   * newer turn has since taken.
   */
  release(seatPath: string, runId: string): void {
    const key = resolve(seatPath)
    if (this.runIdBySeatPath.get(key) !== runId) return
    this.runIdBySeatPath.delete(key)
  }

  /** The run currently holding this seat, when there is one. */
  holder(seatPath: string): string | undefined {
    return this.runIdBySeatPath.get(resolve(seatPath))
  }
}

/** Process-wide registry. One main process owns every durable seat it attaches. */
export const museSeatLeases = new MuseSeatLeaseRegistry()
