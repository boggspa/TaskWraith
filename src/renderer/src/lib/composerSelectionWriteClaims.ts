/**
 * Claims over a chat's composer selection while the renderer's optimistic
 * commit is still outstanding.
 *
 * A picker commit is optimistic: `applyChatComposerSelectionPatch` writes the
 * value into the live chat map immediately and the durable write follows
 * through a 200ms-debounced patch IPC. Between those two moments the renderer
 * holds a selection main has never seen, so every delivery main builds in that
 * window carries the PREVIOUS selection while being, by wall clock, newer —
 * `saveChat` stamps `updatedAt = Date.now()` on every unrelated write, and
 * during a run there is one every few hundred milliseconds.
 *
 * `preserveNewerLocalComposerSelection` could only compare those stamps, so
 * the delivery won and the chip snapped back to the previous value. That is
 * the "I picked a model / dragged the reasoning ladder and it reset itself"
 * report: not a refusal and not a race on the write, but a guard that cannot
 * tell "main disagrees" from "main has not been told yet".
 *
 * A claim states the difference explicitly. While one is held, a delivery's
 * account of the selection is ignorance rather than intent and the live slice
 * wins regardless of stamps — the same argument `durableActiveGoalToRestore`
 * makes on the main side for a revision-stale record.
 *
 * Two properties keep the claim honest:
 *
 *  - **Tokens, not booleans.** A settle releases only the exact claim it names.
 *    A pick made while an earlier persist is in flight raises a newer token, so
 *    the older persist's answer cannot release the newer pick's protection.
 *  - **A bounded lease.** The patch IPC is an `ipcRenderer.invoke` into a
 *    handler that waits on the thread-catalogue write gate, and that gate waits
 *    on a held chat with no timeout and no rejection. A blocked gate therefore
 *    settles nothing, ever. An unbounded claim would answer that by showing the
 *    user a selection that is not in effect for as long as the app runs, which
 *    trades a visible revert for a silent lie. The lease expires instead, so
 *    the worst case degrades to exactly the old behaviour and no further.
 */

/**
 * How long an unsettled claim keeps protecting the live selection.
 *
 * Sized against the write it covers, not against the gate that can block it: a
 * normal persist is a transcript-idle await plus one IPC plus a serialized
 * overlay write, comfortably inside a second even on a busy profile. Fifteen
 * seconds is therefore two orders of magnitude of headroom for the path that
 * works, while still bounding the path that cannot — and the only cost of the
 * lease running long is that a main-authored selection change landing inside it
 * is refused once.
 */
export const COMPOSER_SELECTION_CLAIM_TTL_MS = 15_000

interface HeldClaim {
  token: number
  raisedAt: number
}

export class ComposerSelectionWriteClaims {
  private readonly claims = new Map<string, HeldClaim>()
  private nextToken = 1

  constructor(
    private readonly options: {
      now?: () => number
      ttlMs?: number
    } = {}
  ) {}

  /** Claim the chat's selection for the renderer. Returns the claim's token. */
  raise(chatId: string): number {
    const token = this.nextToken++
    this.claims.set(chatId, { token, raisedAt: this.now() })
    return token
  }

  /** The token of the claim currently held for this chat, or null. */
  current(chatId: string): number | null {
    return this.claims.get(chatId)?.token ?? null
  }

  /**
   * Release the named claim. A token that does not name the current claim
   * releases nothing: a newer pick has already superseded it and is waiting on
   * its own persist.
   */
  settle(chatId: string, token: number | null): void {
    if (token === null) return
    if (this.claims.get(chatId)?.token !== token) return
    this.claims.delete(chatId)
  }

  /** Whether an unexpired claim is held for this chat. */
  held(chatId: string): boolean {
    const claim = this.claims.get(chatId)
    if (!claim) return false
    if (this.now() - claim.raisedAt < this.ttlMs()) return true
    this.claims.delete(chatId)
    return false
  }

  /** Drop every claim — used when the renderer tears its patch queue down. */
  clear(): void {
    this.claims.clear()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private ttlMs(): number {
    return this.options.ttlMs ?? COMPOSER_SELECTION_CLAIM_TTL_MS
  }
}
