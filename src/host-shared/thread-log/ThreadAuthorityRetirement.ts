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
 * The retirement policy itself — admission, guarded unlink+sync, sync-debt
 * retry and release — lives in
 * `host-runtime/HostThreadOwnershipReservations`, which mints the opaque
 * reservation handle this module's outcome type describes. Refinements
 * (per the approved I7 GO):
 *  - Keep admission/hold through authority retirement directory sync; ordinary
 *    adopt behavior is preserved.
 *  - Retirement runs under an opaque reservation minted by the registry; the
 *    reservation re-validates the mark, writer liveness, profile authority
 *    and erasure generation at every pre/post check, and carries the
 *    catalogue's erasing state instead of a hardcoded false.
 *  - Directory sync failure is uncertain retirement, not durable success.
 *  - Final exact mark/reservation/liveness/erasure checks before adoption
 *    and unlink.
 */
/**
 * Marker that a retirement is on the orphan pathway. Ordinary routes do not
 * carry this token and must not be allowed to gain the live-desktop
 * exemption it implies; the constant lives here and is exported only to
 * the registry's orphan method, never to a general adoption surface.
 */
export const ORPHAN_RETIREMENT_TOKEN = Symbol.for('taskwraith.thread-authority.orphan-retirement')

/** What the retirement did. */
export type ThreadAuthorityRetirementOutcome =
  | { readonly kind: 'retired' }
  | {
      readonly kind: 'uncertain'
      readonly reason: 'sync_failed' | 'witness_changed'
    }
  | {
      readonly kind: 'busy'
      readonly reason: 'live_writer' | 'damaged' | 'erasing' | 'wrong_token'
    }
