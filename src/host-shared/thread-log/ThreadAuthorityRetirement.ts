/**
 * Authority retirement for orphaned thread marks.
 *
 * A writer's authority file is the durable mark that separates its
 * unpublished log from a save the Host has already judged. The mark is only
 * meaningful while a writer still owns the thread: when the writer has
 * ended, the mark outlives its reason for existing. The Host may fold
 * whatever the log holds above its full copy and then retire the mark;
 * this module is the policy for that retirement.
 *
 * The orphan pathway is the only one allowed to retire a mark without a
 * live desktop attached. Ordinary routes — record executors, recovery end
 * tokens, the Host write gate — must not borrow this path to skip their own
 * checks. `ORPHAN_RETIREMENT_TOKEN` is the marker that distinguishes the
 * orphan pathway; only the registry's orphan method carries it, and the
 * constant lives here so the type system keeps the binding private.
 *
 * Refinements (per the approved I7 GO):
 *  - Keep admission/hold through authority retirement directory sync; ordinary
 *    adopt behavior is preserved.
 *  - Directory sync failure is uncertain retirement, not durable success.
 *  - Final exact mark/reservation/liveness/erasure checks before adoption
 *    and unlink.
 *  - No worker or production wiring in this slice; the orphan method on the
 *    registry is the seam future preparation will plug into.
 */
import { isSafeChatId } from '../../shared/ChatPath'
import type { ThreadOwnerEpoch } from './ThreadOwnership'

/**
 * Marker that a retirement is on the orphan pathway. Ordinary routes do not
 * carry this token and must not be allowed to gain the live-desktop
 * exemption it implies; the constant lives here and is exported only to
 * the registry's orphan method, never to a general adoption surface.
 */
export const ORPHAN_RETIREMENT_TOKEN = Symbol.for('taskwraith.thread-authority.orphan-retirement')

/**
 * The captured state an orphan retirement must verify before and after the
 * unlink+sync cycle. The witness is captured before the operation and read
 * again after: a successful retirement leaves the file changed or removed,
 * and the witness reports false; a race that recreates an indistinguishable
 * file keeps the witness true.
 */
export interface ThreadAuthorityRetirementObservation {
  /** Reservation the mark was read under. */
  readonly reservation: ThreadOwnerEpoch
  /** Whether the mark file is unchanged from the admission capture. */
  readonly exactMarkWitness: () => boolean
  /** Whether the writer's process has ended. */
  readonly writerEnded: boolean
  /** Whether the catalogue is erasing this thread. */
  readonly erasing: boolean
}

/**
 * One filesystem step that unlinks the mark file (and any `.tmp` sibling a
 * crashed write may have left), then syncs the directory so a power loss
 * cannot resurrect the unlinked name. Throws on any failure; the retirement
 * module treats a throw as uncertain retirement.
 */
export type ThreadAuthorityRetirementRemoveAndSync = () => Promise<void>

/** What the retirement did. */
export type ThreadAuthorityRetirementOutcome =
  | { readonly kind: 'retired' }
  | {
      readonly kind: 'uncertain'
      readonly reason: 'sync_failed' | 'witness_changed' | 'remove_failed'
    }
  | {
      readonly kind: 'busy'
      readonly reason: 'live_writer' | 'damaged' | 'erasing' | 'wrong_token'
    }

/** Context an orphan retirement requires. */
export interface ThreadAuthorityRetirementContext {
  /** Reservation the orphan adoption is committed under. */
  readonly reservation: ThreadOwnerEpoch
  /** State captured at admission, verified again after the sync. */
  readonly observation: ThreadAuthorityRetirementObservation
  /** Combined unlink + sync; throws on any failure. */
  readonly removeAndSync: ThreadAuthorityRetirementRemoveAndSync
}

/**
 * Retire an orphaned authority mark. Pre-conditions are checked first so the
 * directory sync only runs when retirement is otherwise permitted; the sync
 * itself is what makes the retirement durable, and a failed sync is
 * uncertain retirement rather than success. The caller must keep the
 * admission hold open across the call: the in-memory reservation has to
 * outlive the directory sync.
 *
 * Returns `retired` only after the directory sync succeeds and the witness
 * confirms the file is gone or changed. Returns `uncertain` with a specific
 * reason otherwise; the caller decides whether to retry or hold.
 */
export async function retireOrphanThreadAuthority(
  threadId: string,
  context: ThreadAuthorityRetirementContext
): Promise<ThreadAuthorityRetirementOutcome> {
  if (!isSafeChatId(threadId)) return { kind: 'busy', reason: 'damaged' }
  const { observation } = context
  if (
    context.reservation.host !== observation.reservation.host ||
    context.reservation.grant !== observation.reservation.grant
  ) {
    return { kind: 'busy', reason: 'damaged' }
  }
  if (!observation.writerEnded) return { kind: 'busy', reason: 'live_writer' }
  if (observation.erasing) return { kind: 'busy', reason: 'erasing' }
  if (!observation.exactMarkWitness()) return { kind: 'busy', reason: 'damaged' }
  try {
    await context.removeAndSync()
  } catch {
    return { kind: 'uncertain', reason: 'remove_failed' }
  }
  if (observation.exactMarkWitness()) return { kind: 'uncertain', reason: 'witness_changed' }
  return { kind: 'retired' }
}
