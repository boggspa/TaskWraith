/**
 * The chip strip's whole-record Ensemble commit, and the shared retry that
 * makes any Ensemble panel save survive the canonical revision fence.
 *
 * `EnsembleParticipantsAboveRow` hands back a complete `ChatRecord` (its
 * `buildPersistedChat` already normalized order, cap and authority), so this
 * commit is a replace rather than a patch — it deliberately does not share the
 * `updateChatById` funnel, whose 200 ms debounce and draft-conflict skip belong
 * to transcript-shaped writes.
 *
 * TWO defences, for two different failures that look identical on screen:
 *
 *  1. THE REVERT. The record is live in the renderer the instant it is set here
 *     and durable only once `saveChat` answers; every delivery main builds in
 *     between carries the PREVIOUS roster while being, by wall clock, newer.
 *     The claim covers that window — see `ensembleRosterWriteClaims.ts` for why
 *     a stamp cannot answer it and `chatUpdateRenderMerge.ts` for where the
 *     claim is consumed.
 *
 *  2. THE REFUSAL, below. `ChatService.saveChatInternal` compares the clone's
 *     `persistenceRevision` against canonical and, on any mismatch, returns the
 *     canonical record WITHOUT writing — the whole clone is dropped as stale.
 *     That fence is right about transcripts: a renderer snapshot is not a
 *     patch, and merging one blindly would erase newer runs, receipts and
 *     session state. It is wrong about intent. Main advances the revision on
 *     every write of its own (during a run, every few hundred milliseconds),
 *     so an ordinary panel edit is routinely refused for no reason the user can
 *     see, and the claim above then expires over a value that never landed.
 *     Reported as "my model selection keeps being rejected and reverting back
 *     to the original".
 *
 * Main cannot fix this alone: without the renderer's base record there is no
 * honest three-way merge, which is exactly what its comment says. The renderer
 * CAN, because it knows which slice it authored. So a refusal is answered
 * rather than swallowed: re-apply the authored slice onto the canonical record
 * main just handed back and save again. Canonical keeps its newer transcript,
 * runs, round state and per-seat runtime bookkeeping; the user's edit lands.
 * See `shared/ensembleAuthoredSlice.ts` for the split.
 */
import type { ChatRecord } from '../../../main/store/types'
import {
  carriesEnsembleAuthoredSlice,
  rebaseEnsembleAuthoredSlice
} from '../../../shared/ensembleAuthoredSlice'
import type { EnsembleRosterWriteClaims } from './ensembleRosterWriteClaims'
import { withEnsembleWriteClaim } from './ensembleWriteClaimScope'

/**
 * How many times a refused save is rebased and re-issued.
 *
 * Bounded because the retry competes with main's own write cadence: under a
 * busy run each attempt can be refused by a revision that advanced again while
 * it was in flight, and an unbounded loop would answer that by saving forever.
 * Three attempts clear the ordinary case (one interleaved main write, rarely
 * two) while keeping the pathological case finite — and the worst outcome of
 * giving up is exactly today's behaviour, no worse.
 */
export const ENSEMBLE_SAVE_REBASE_ATTEMPTS = 3

export interface EnsembleAuthoredSaveOutcome {
  chat: ChatRecord
  accepted: boolean
}

export interface EnsembleAuthoredSaveDeps {
  /**
   * Writes the record and reports canonical's answer AND whether it took the
   * write. The flag is what separates "main dropped my edit" from "main
   * accepted it and normalized it" — guessing from content instead would put
   * the retry in a fight with the normalizer it can only lose.
   */
  saveChat: (chat: ChatRecord) => Promise<EnsembleAuthoredSaveOutcome | null | undefined>
  /** Applied to every record this lands, so the renderer's caches follow the
   *  rebased revision instead of pinning the refused one. */
  onRebased?: (chat: ChatRecord) => void
  attempts?: number
}

/**
 * Save `record`, and if the canonical answer shows the Ensemble slice did not
 * land, rebase that slice onto the answer and save again.
 *
 * Resolves with the last canonical record seen. A save that main accepted, or
 * whose slice canonical already carries, issues exactly one write — the retry
 * only ever costs anything when the user's edit was actually dropped.
 */
export async function saveChatPreservingEnsembleIntent(
  record: ChatRecord,
  deps: EnsembleAuthoredSaveDeps
): Promise<ChatRecord | null> {
  const attempts = Math.max(1, deps.attempts ?? ENSEMBLE_SAVE_REBASE_ATTEMPTS)
  let authored = record
  let canonical: ChatRecord | null = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const answer = await deps.saveChat(authored)
    if (!answer) return canonical
    canonical = answer.chat
    // Accepted is the end of it. Whatever canonical did to the record after
    // taking it — normalizing authority, clamping a cap — is main's business
    // and re-forcing the pre-normalized slice over it would be a fight, not a
    // fix.
    if (answer.accepted) return canonical
    // Refused, but not at the user's expense: canonical already carries the
    // slice (someone else made the same change, or this is an echo of an
    // earlier attempt). Nothing to rebase.
    if (carriesEnsembleAuthoredSlice(canonical, authored)) return canonical
    const rebased = rebaseEnsembleAuthoredSlice(canonical, authored)
    if (!rebased) return canonical
    authored = rebased
    deps.onRebased?.(rebased)
  }
  return canonical
}

export interface EnsembleRosterCommitDeps {
  /** The renderer's synchronous record cache. */
  chatById: Map<string, ChatRecord>
  setCurrentChat: (updater: (previous: ChatRecord | null) => ChatRecord | null) => void
  setChats: (updater: (previous: ChatRecord[]) => ChatRecord[]) => void
  claims: EnsembleRosterWriteClaims | null | undefined
  saveChat: (chat: ChatRecord) => Promise<EnsembleAuthoredSaveOutcome | null | undefined>
  /**
   * Drain deliveries accepted before the durable answer through the
   * still-claimed merge. Called BEFORE the claim is released so an in-flight
   * stale frame cannot land in the gap between the answer and the release.
   */
  flushDeliveries: () => void
}

export function commitEnsembleRosterChange(
  updatedChat: ChatRecord,
  deps: EnsembleRosterCommitDeps
): void {
  const chatId = updatedChat.appChatId
  const publish = (chat: ChatRecord): void => {
    deps.chatById.set(chatId, chat)
    deps.setCurrentChat((previous) => (previous?.appChatId === chatId ? chat : previous))
    deps.setChats((previous) =>
      previous.map((entry) => (entry.appChatId === chatId ? chat : entry))
    )
  }
  publish(updatedChat)
  // Claim AFTER the optimistic record is live and BEFORE the write is issued:
  // that is exactly the window in which main has not been told yet. It stays
  // held across every rebase attempt, so a delivery landing mid-retry still
  // cannot revert the edit the retry is busy persisting.
  const token = deps.claims?.raise(chatId) ?? null
  void saveChatPreservingEnsembleIntent(updatedChat, {
    saveChat: deps.saveChat,
    // A rebased record carries canonical's revision, so the renderer's caches
    // must follow it. Keeping the refused one would make the NEXT save stale
    // by construction and turn one refusal into a permanent one.
    onRebased: publish
  })
    .catch(() => null)
    .finally(() => {
      if (token === null) return
      deps.flushDeliveries()
      deps.claims?.settle(chatId, token)
    })
}

export interface EnsembleLiveRosterMutationResult {
  ok: boolean
  chat?: ChatRecord | null
  message?: string
}

export interface EnsembleLiveRosterMutationDeps {
  /** The renderer's synchronous record cache. */
  chatById: Map<string, ChatRecord>
  setCurrentChat: (updater: (previous: ChatRecord | null) => ChatRecord | null) => void
  setChats: (updater: (previous: ChatRecord[]) => ChatRecord[]) => void
  claims: EnsembleRosterWriteClaims | null | undefined
  flushDeliveries: () => void
  requestMutation: (chatId: string) => Promise<EnsembleLiveRosterMutationResult>
  onError: (message: string) => void
}

/**
 * The live-round roster lane: add, remove, reorder, Boss/Captain authority and
 * Boss auto-approvals, while a round is dispatching.
 *
 * `commitEnsembleRosterChange` above covers the IDLE branch of the same
 * gestures. This one goes through `requestEnsembleUserRosterMutation` because a
 * running round's roster is main's to change, and it looked safe for exactly
 * that reason: the renderer applies main's own answer rather than an optimistic
 * guess. It is not safe. Main can have BUILT a `chat-updated` delivery before
 * the mutation and flushed it after, so the answer is applied and then a frame
 * prepared in ignorance of it lands on top.
 *
 * Reported 2026-09-11 as "I keep allocating captain to a seat and it keeps
 * reverting my decision", and the same for turning Boss auto-approvals off.
 * Those are `set_authority` and `set_auto_approvals` — this exact lane, and the
 * only roster gestures that had no claim after the idle branch got one.
 */
export async function commitEnsembleLiveRosterMutation(
  chatId: string,
  deps: EnsembleLiveRosterMutationDeps
): Promise<void> {
  try {
    const result = await withEnsembleWriteClaim(
      chatId,
      { claims: deps.claims, flushDeliveries: deps.flushDeliveries },
      () => deps.requestMutation(chatId)
    )
    if (!result.ok) {
      deps.onError(result.message || 'Participant change failed.')
      return
    }
    const updatedChat = result.chat
    if (!updatedChat) return
    deps.chatById.set(updatedChat.appChatId, updatedChat)
    deps.setCurrentChat((previous) =>
      previous?.appChatId === updatedChat.appChatId ? updatedChat : previous
    )
    deps.setChats((previous) =>
      previous.map((entry) => (entry.appChatId === updatedChat.appChatId ? updatedChat : entry))
    )
  } catch (error) {
    deps.onError(error instanceof Error ? error.message : 'Participant change failed.')
  }
}
