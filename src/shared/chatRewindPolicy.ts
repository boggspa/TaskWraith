/**
 * Rewind-from-message policy.
 *
 * "Edit an older user message and re-send" restarts the conversation from that
 * message: the live run and everything chained to it stops, the transcript tail
 * is dropped, and the edited prompt is dispatched again. It is deliberately a
 * TRANSCRIPT + LIFECYCLE operation — it never reverts a file mutation, never
 * touches git, never changes seats, and never clears the blackboard, goal, or
 * todos.
 *
 * This module holds the one contested policy decision in that feature: whether
 * re-sending should also re-fire a round's opening scout fan-out. It is
 * intentionally pure — no main/renderer imports, no I/O, no store types — so
 * both processes can classify a rewind target identically, and so the policy
 * can be flipped in one line if the product answer changes.
 */

/**
 * What the edited message was, in lifecycle terms.
 *
 * - `chat-opening`: the literal first row of the transcript — the prompt the
 *   whole chat was founded on. This is the ONLY case that re-fires the scout
 *   fan-out (see {@link shouldRefireOpeningScoutFanout}).
 * - `round-opening`: the first user prompt of a LATER ensemble round.
 *   Correcting it invalidates that round's premise, but the chat's premise and
 *   the scouting done for it still stand.
 * - `mid-round-steer`: a user message injected into an already-running round.
 *   The round's premise still stands; only the steer changes.
 * - `solo-turn`: a user turn in a non-ensemble chat. There is no fan-out wave
 *   to reconsider.
 *
 * `chat-opening` and `round-opening` are kept as separate members deliberately.
 * Collapsing them would make the type lie about a later round's opening prompt,
 * and it is precisely the boundary between them that the fan-out policy turns
 * on — so the policy stays a one-line change in EITHER direction.
 */
export type RewindKind =
  | 'chat-opening'
  | 'round-opening'
  | 'mid-round-steer'
  | 'solo-turn'

/**
 * The minimum a transcript row must expose to be classified. Kept structural
 * rather than importing `ChatMessage` so this stays free of store types and
 * cheap to test.
 */
export interface RewindTranscriptRow {
  readonly id: string
  readonly role: string
  /** Round this row belongs to, when the transcript records one. */
  readonly roundId?: string | null
}

export interface ClassifyRewindTargetInput {
  /** Canonical transcript order. */
  readonly messages: readonly RewindTranscriptRow[]
  /** Id of the user message the human edited. */
  readonly messageId: string
  /** False for a solo chat; a solo chat has no scout wave to reconsider. */
  readonly isEnsemble: boolean
}

export type ClassifyRewindTargetResult =
  | { readonly ok: true; readonly kind: RewindKind; readonly index: number }
  | { readonly ok: false; readonly reason: 'not-found' | 'not-user-message' }

/**
 * Locate the edited message and decide what kind of rewind it is.
 *
 * A row is `round-opening` when no EARLIER user row shares its round id — i.e.
 * it is the prompt that opened that round. This is derived from transcript
 * order rather than trusted from a caller-supplied flag, because the caller
 * that most wants to rewind (the renderer) is the one least able to prove which
 * prompt started a round.
 *
 * Rows with no round id in an ensemble chat are treated as belonging to the
 * same "unrouted" group, so the first of them still reads as round-opening.
 * That is the pre-round/legacy-transcript case and matches what the user sees:
 * the prompt at the top of the transcript.
 */
export function classifyRewindTarget(
  input: ClassifyRewindTargetInput
): ClassifyRewindTargetResult {
  const { messages, messageId, isEnsemble } = input
  const index = messages.findIndex((message) => message?.id === messageId)
  if (index < 0) return { ok: false, reason: 'not-found' }

  const target = messages[index]
  if (target.role !== 'user') return { ok: false, reason: 'not-user-message' }

  // A solo chat has no rounds and no fan-out wave, so the distinction below is
  // meaningless there. Report it plainly rather than inventing a round.
  if (!isEnsemble) return { ok: true, kind: 'solo-turn', index }

  // The literal top of the transcript. Not "the first user row" — index 0, so a
  // chat that opens with a system row cannot be mistaken for a chat-opening
  // rewind and quietly re-fire a scout wave.
  if (index === 0) return { ok: true, kind: 'chat-opening', index }

  const targetRound = target.roundId ?? null
  for (let cursor = 0; cursor < index; cursor += 1) {
    const earlier = messages[cursor]
    if (earlier?.role !== 'user') continue
    if ((earlier.roundId ?? null) === targetRound) {
      // An earlier user prompt already opened this round, so the edited row is
      // a steer inside it.
      return { ok: true, kind: 'mid-round-steer', index }
    }
  }
  return { ok: true, kind: 'round-opening', index }
}

/**
 * THE CONTESTED PREDICATE.
 *
 * Whether re-sending the edited message should also re-fire the round's opening
 * scout fan-out.
 *
 * Current policy (contract v1.1, after two independent reviewers narrowed the
 * original call): ONLY a corrected `chat-opening` prompt re-fires the scout
 * wave. That is the user's stated exception — a significant error in the very
 * first prompt, where the scouts' entire premise turned out to be wrong.
 *
 * A later round's opening prompt does NOT re-fire it. Re-scouting there would
 * discard correct work done under a premise that still holds, and the user
 * explicitly excluded "every rewind" from the exception.
 *
 * `fanoutEnabled` is the chat's own fan-out setting: a rewind must never turn
 * fan-out ON for a chat that does not use it.
 *
 * If the product answer changes, change THIS RETURN and nothing else. No other
 * module may re-derive this decision. Reverting to the wider v1 policy is
 * exactly one line:
 *   return (kind === 'chat-opening' || kind === 'round-opening') && fanoutEnabled
 */
export function shouldRefireOpeningScoutFanout(
  kind: RewindKind,
  fanoutEnabled: boolean
): boolean {
  return kind === 'chat-opening' && fanoutEnabled
}

/**
 * Whether re-sending the edited message must stop work that is currently in
 * flight. Always true: the user asked for a restart from that point, and a run
 * that survives the rewind would append rows into the tail that was just cut.
 *
 * Exposed as a named predicate so the ordering guarantee (cancel BEFORE
 * truncate) has something to assert against.
 */
export function rewindRequiresCancellation(_kind: RewindKind): boolean {
  return true
}

/**
 * Chat state a rewind must never touch.
 *
 * The user's constraint was explicit: transcript and lifecycle only. The
 * `/clear` truncation path (`buildTruncatedChatRecordForErasure`) drops every
 * one of these keys, which is exactly why a rewind must not reuse it.
 */
export const REWIND_PRESERVED_CHAT_KEYS = [
  'ensemble',
  'activeGoal',
  'chatTodos',
  'roundSummaries',
  'escalationSignals'
] as const
