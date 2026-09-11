/**
 * Hold a write claim across a main-authoritative call.
 *
 * Several Ensemble mutations are not optimistic renderer saves at all: the
 * renderer asks main, main decides, and the renderer applies the answer
 * (`setChatKind`, `requestEnsembleUserRosterMutation`, the live seat-change and
 * boundary preset IPCs). Those looked safe for exactly that reason and are not —
 * main can have BUILT a `chat-updated` delivery before the call and flushed it
 * after, so the renderer applies main's answer and then a frame main prepared
 * while ignorant of it lands on top. The user sees their change revert.
 *
 * A claim states the one thing a wall clock cannot: this write is still in
 * flight, so a delivery that disagrees is ignorant rather than newer. The
 * ordering below is the load-bearing part and matches the whole-record commit
 * path: raise BEFORE the request, and drain deliveries through the still-claimed
 * merge BEFORE releasing, so an in-flight stale frame cannot land in the gap
 * between the answer and the release.
 *
 * The claim is released even when the call throws — a refused switch leaves
 * nothing to protect, and a leaked claim would refuse legitimate main-authored
 * changes for the rest of its lease.
 */
import type { ComposerSelectionWriteClaims } from './composerSelectionWriteClaims'

export interface EnsembleWriteClaimScopeDeps {
  claims: ComposerSelectionWriteClaims | null | undefined
  /**
   * Drain deliveries accepted while the claim was held through the merge that
   * still honours it. Called before the release, never after.
   */
  flushDeliveries: () => void
}

export async function withEnsembleWriteClaim<T>(
  chatId: string,
  deps: EnsembleWriteClaimScopeDeps,
  work: () => Promise<T>
): Promise<T> {
  const token = deps.claims?.raise(chatId) ?? null
  try {
    return await work()
  } finally {
    if (token !== null) {
      deps.flushDeliveries()
      deps.claims?.settle(chatId, token)
    }
  }
}
