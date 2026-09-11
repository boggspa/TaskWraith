/**
 * One composer submit per chat may be mid-dispatch at a time.
 *
 * `handleRun` decides between queueing and dispatching by asking whether the
 * chat is busy, and a chat only becomes busy once `executeRun` has registered
 * the run in `activeRunsRef` — which is many awaits and a `runAgent` IPC round
 * trip later. Every submit that lands inside that window sees an idle chat and
 * dispatches, so N submits produce N concurrent runs in one thread.
 *
 * Measured 2026-09-11: a held Enter key put NINE Muse runs into one chat in
 * 611ms (dispatch receipts 75ms apart, the macOS key-repeat cadence). All nine
 * attached the same per-chat durable Muse seat home, whose attach scrub reduces
 * the seat to session continuity — so each attach deleted the credentials the
 * previously launched seats were still starting with, and all nine died on
 * `missing meta credentials`. The eight repeats also carried the OS-autocorrected
 * spelling of the prompt, so text equality would not have recognised them.
 *
 * This is deliberately NOT the run queue. Queueing is the answer to "sent while
 * a run is RUNNING" — an ordered second turn the user meant. A submit that
 * arrives while the previous one is still being dispatched is a double-fire,
 * and the honest response is to drop it.
 *
 * Fails OPEN: a submit that cannot be identified (no chat id, no run id) is
 * never blocked. A latch that refuses a real turn is worse than the duplicate
 * it was added to stop.
 */
export class ChatDispatchLatch {
  private readonly runIdByChatId = new Map<string, string>()

  /**
   * Claim `chatId` for `runId`. False when a DIFFERENT run already holds it,
   * which is the caller's signal to drop the submit. Re-claiming with the same
   * run id succeeds, so a retry of one request is not mistaken for a repeat.
   */
  claim(chatId: string | null | undefined, runId: string | null | undefined): boolean {
    if (!chatId || !runId) return true
    const holder = this.runIdByChatId.get(chatId)
    if (holder && holder !== runId) return false
    this.runIdByChatId.set(chatId, runId)
    return true
  }

  /**
   * Release whatever claim `runId` holds. Keyed by RUN, never by chat: a late
   * release from a settled dispatch must not free the claim a newer submit for
   * the same chat has since taken.
   */
  release(runId: string | null | undefined): void {
    if (!runId) return
    for (const [chatId, holder] of this.runIdByChatId) {
      if (holder === runId) this.runIdByChatId.delete(chatId)
    }
  }

  /** The run currently mid-dispatch for this chat, when there is one. */
  holderRunId(chatId: string | null | undefined): string | undefined {
    if (!chatId) return undefined
    return this.runIdByChatId.get(chatId)
  }
}
