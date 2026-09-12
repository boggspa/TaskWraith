/**
 * The updateChatById save funnel's conflict gate (App.tsx).
 *
 * `pendingChatDrafts` records a conflict whenever the renderer's live record
 * cannot be advanced cleanly onto a canonical answer — most commonly the
 * 'messages' conflict `rebaseTailTranscript` raises when it fails closed
 * (advanceRendererRecord.ts), which is CONSTANT while a Host-owned round is
 * streaming: every accepted delivery rebuilds the transcript underneath the
 * optimistic copy. The old gate skipped the pending save on ANY conflict, so
 * an Ensemble panel edit made mid-round (orchestration row, seat patch,
 * preset apply) was never even SENT: the roster claim settled in `finally`
 * over a value main never saw, and the next delivery reverted the edit.
 * Reported 2026-09-12 as "UI interaction saves denied or reverted".
 *
 * The split keeps the guard exactly where it is load-bearing and lifts it
 * where it is not:
 *
 *  - A WHOLE-RECORD save (`window.api.saveChat`) persists the renderer clone
 *    verbatim. With a transcript conflict outstanding, that clone's tail is
 *    provably not canonical's, so the skip stays.
 *  - An ENSEMBLE-SLICE save (`saveChatPreservingEnsembleIntent`) is
 *    conflict-safe by construction. A conflicted draft pins the clone's
 *    `persistenceRevision` behind canonical (advanceRendererRecord keeps the
 *    pre-answer revision whenever conflicts exist), so main's revision fence
 *    refuses the first attempt without writing; the helper then rebases ONLY
 *    the user-authored Ensemble slice onto the canonical record — canonical
 *    keeps its newer transcript, runs and round state — and saves that. The
 *    transcript conflict is never pushed, and the user's edit lands.
 */
export type ConflictGatedChatSavePlan = 'skip' | 'whole-record' | 'ensemble-slice'

export function planConflictGatedChatSave(input: {
  /** `pendingChatDrafts.conflicts(chatId)` at the moment the debounced save fires. */
  draftConflicts: readonly string[]
  /** Whether this funnel pass raised an Ensemble roster/chat-kind edit token. */
  ensembleSliceEdit: boolean
}): ConflictGatedChatSavePlan {
  if (input.ensembleSliceEdit) return 'ensemble-slice'
  return input.draftConflicts.length > 0 ? 'skip' : 'whole-record'
}
