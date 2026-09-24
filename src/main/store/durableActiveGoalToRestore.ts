import type { ActiveGoal, ChatRecord } from './types'
import { chatPersistenceRevision } from '../../shared/rendererChatTranscriptMutation'

/**
 * Decide whether a whole-record save is silently deleting a goal it never saw.
 *
 * `saveChat` is last-write-wins over the whole record, and `activeGoal` is not
 * in either path's main-owned preserve list, so ANY save built from a snapshot
 * taken before the goal was written deletes the key — with no error, an
 * accepted result, and a revision bump. Reported repeatedly as "the goal keeps
 * unsetting after I set it": the renderer's own defence
 * (`preserveNewerLocalActiveGoal`) is scoped to the lifetime of the goal's
 * `saveChat` promise, so once that settles the goal-less delivery is
 * authoritative and the panel falls back to the editor with the draft still in
 * the box. `b65bdfb14` closed the renderer half of this and deliberately left
 * the store half open; this is the store half.
 *
 * `ActiveGoal` is optional with no null form, so a deliberate Clear and a
 * clobber are the SAME shape on the wire — absence. They are only separable by
 * `persistenceRevision`, which main owns and advances monotonically per save.
 * An incoming record whose revision is behind the durable one was derived from
 * a state that predates the stored goal, so its silence is ignorance, not an
 * opinion; at or above the durable revision the caller demonstrably saw the
 * goal and its omission is a real Clear. Deliberately NOT a timestamp
 * comparison: `chat.updatedAt` is bumped by every unrelated save and
 * `activeGoal.updatedAt` is a different clock authored elsewhere, which is the
 * exact pair of wrong clocks the renderer guard was reverted for reading.
 *
 * A missing or malformed incoming revision reads as 0 and therefore as stale:
 * a record that cannot prove it descends from the current durable state does
 * not get to delete a goal by omission.
 *
 * The cost is bounded and self-correcting: a Clear authored against a base
 * that has since fallen behind is refused, the restored goal is broadcast at
 * the new revision, and the next Clear — now on a matching revision — lands.
 * One extra click in the stale case, against a defect where the goal could
 * never be made to stick at all.
 *
 * Returns the goal to splice back in, or `undefined` when the caller's record
 * is authoritative and must pass through untouched.
 */
export function durableActiveGoalToRestore(
  incoming: ChatRecord,
  previous: ChatRecord | null | undefined
): ActiveGoal | undefined {
  const durable = previous?.activeGoal
  if (!durable) return undefined
  // The caller carries its own goal: a set, an edit, or a lifecycle advance.
  // Whole-record authorship of a goal is legitimate and always wins.
  if (incoming.activeGoal) return undefined
  if (chatPersistenceRevision(incoming) >= chatPersistenceRevision(previous)) return undefined
  return durable
}
