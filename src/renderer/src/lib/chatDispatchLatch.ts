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
 * This latch closes that window by making it VISIBLE, not by refusing anything.
 * A chat holding a claim reads as busy, so `shouldQueueRunBeforeDispatch` sends
 * the next submit to the queue — where a genuinely different second message
 * belongs — instead of letting it race into the same thread. Refusing was the
 * first shape and it was wrong: it silently ate a real second message typed
 * inside the dispatch window. Duplicates are not this module's job; they are
 * refused earlier and by identity, in `ComposerSubmitLedger`.
 *
 * Fails OPEN: a submit that cannot be identified (no chat id, no run id) is
 * never held. A latch that marks a thread busy on nothing is worse than the
 * race it was added to close.
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
