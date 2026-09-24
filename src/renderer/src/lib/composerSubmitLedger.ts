/**
 * One composer submit per draft revision, per chat.
 *
 * "The same message" is not a timing question and not a content question. It is
 * a message the user has not touched since they last sent it — which is exactly
 * what a mashed Enter or Send button produces, and exactly what neither a
 * debounce nor a text hash gets right:
 *
 *   - A debounce guesses. The 2026-09-11 burst had nine presses spread over six
 *     seconds while the app was unresponsive; any window short enough to admit
 *     a fast second message would have admitted most of those too.
 *   - A text hash refuses a legitimate resend. Typing the same words again
 *     after the box cleared is a new message and must go.
 *
 * `composerDraftState` bumps a per-chat revision on every committed edit, and a
 * submit carries the revision it read. A repeat therefore arrives at a revision
 * this ledger has already accepted and is dropped; anything the user typed in
 * between raises the revision and sends normally.
 *
 * This sits at the single accept point in `handleRun`, BEFORE the branch
 * between dispatch, queue and steer, so all three inherit it — the queue is
 * where the duplicates were most visible ("a tonne of queued and steered copies
 * of the same message"). It is not a busy check and it does not decide where a
 * submit goes; it only answers whether this submit has already been taken.
 *
 * An ignored repeat is silent by design (owner directive 2026-09-11): the user
 * pressing Enter again wants the message sent, not a second thing on screen
 * explaining that it already was.
 */
export class ComposerSubmitLedger {
  private readonly lastAcceptedRevision = new Map<string, number>()

  /**
   * True when this submit is new and should proceed. False when it repeats a
   * revision already taken for this chat.
   *
   * Strictly increasing, so a stale revision arriving late — a submit built
   * before an edit and delivered after it — cannot reopen a message that was
   * already sent.
   *
   * Fails OPEN on a submit it cannot identify: refusing a real message is worse
   * than admitting a duplicate.
   */
  accept(chatId: string | null | undefined, revision: number | null | undefined): boolean {
    if (!chatId || typeof revision !== 'number' || !Number.isFinite(revision)) return true
    const last = this.lastAcceptedRevision.get(chatId)
    if (last !== undefined && revision <= last) return false
    this.lastAcceptedRevision.set(chatId, revision)
    return true
  }

  /**
   * Drop this chat's history. For a chat whose draft store was reset beneath
   * the ledger (history clear, chat deletion), where revisions restart at zero
   * and a retained ceiling would refuse the next real message.
   */
  forget(chatId: string | null | undefined): void {
    if (!chatId) return
    this.lastAcceptedRevision.delete(chatId)
  }

  /** The newest revision taken for this chat, when one has been. */
  lastAccepted(chatId: string | null | undefined): number | undefined {
    if (!chatId) return undefined
    return this.lastAcceptedRevision.get(chatId)
  }
}
