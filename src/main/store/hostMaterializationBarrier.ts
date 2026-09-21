/**
 * Durability-barrier policy for the Host-routed chat persistence path.
 *
 * WHY THIS EXISTS: `barrierChatRecordPersist` used to force a full Host
 * compatibility materialization before every drain. On a large thread
 * (~19.2 MB, 13,334 messages) that re-serialized the entire record into a
 * fresh transfer artifact per barrier even when the staged delta since the
 * last materialization was a few bytes, and even when a fresh artifact for
 * the current revision was already published and merely in flight. The
 * incremental journal (chat-journal-v2, IncrementalChatPersistence) is the
 * durable authority; the Host materialization is a compatibility projection,
 * so a barrier's crash-recovery obligation is the journal, not the artifact.
 *
 * CONTRACT (what a barrier now guarantees):
 *  1. The journal delta for the current revision is fsynced before the
 *     barrier resolves. `awaitJournalDurability` waits out the deferred
 *     streaming append flush (immediate appends — every approval/terminal
 *     boundary — were fsynced synchronously at save time). This is the
 *     participant-dispatch crash guarantee: a crash after the barrier still
 *     replays the current revision from the journal. The gate orders only
 *     the RESOLUTION, never the drain: the materialize/drain path starts
 *     immediately so a barrier cannot serialize behind an unrelated
 *     deferred fsync, and an unacknowledged journal flush rejects
 *     fail-closed.
 *  2. No duplicate full-record re-serialization. The staged checkpoint is
 *     enqueued only when it is not already covered by a fresh artifact:
 *     with a submission in flight the barrier drains instead of forcing a
 *     second whole-record artifact for the same chain, and with nothing
 *     staged the barrier is a drain-only no-op. A staged-but-unsubmitted
 *     record is enqueued exactly once, then drained.
 *  3. Everything already enqueued drains through the compatibility
 *     coordinator's barrier, sharing its join, error-surfacing and
 *     revision-conflict healing semantics.
 */

export interface HostMaterializationBarrierDeps {
  /** Await the journal fsync of the current revision's appended delta. */
  readonly awaitJournalDurability: (chatId: string) => Promise<void>
  readonly compatibility: {
    /** True when staged or submitted work exists for the chat. */
    readonly hasUnconfirmed: (chatId: string) => boolean
    /** True when a checkpoint is already enqueued/in flight for the chat. */
    readonly hasSubmitted: (chatId: string) => boolean
    /** Materialize (if needed) and durably drain the chat's Host lane. */
    readonly barrier: (chatId: string) => Promise<void>
  }
  /** Enqueue the staged compatibility checkpoint; returns whether enqueued. */
  readonly materialize: (chatId: string) => boolean
  /** Drop the shutdown-diagnostic unconfirmed marker once the drain settles clean. */
  readonly clearUnconfirmed: (chatId: string) => void
}

export function createHostMaterializationBarrier(
  deps: HostMaterializationBarrierDeps
): (chatId: string) => Promise<void> {
  if (
    !deps ||
    typeof deps.awaitJournalDurability !== 'function' ||
    typeof deps.materialize !== 'function' ||
    typeof deps.clearUnconfirmed !== 'function' ||
    !deps.compatibility ||
    typeof deps.compatibility.hasUnconfirmed !== 'function' ||
    typeof deps.compatibility.hasSubmitted !== 'function' ||
    typeof deps.compatibility.barrier !== 'function'
  ) {
    throw new TypeError(
      'Host materialization barrier requires journal, materialization and drain ports.'
    )
  }

  return (chatId: string): Promise<void> => {
    // Journal fsync gate: the barrier must not resolve until the current
    // revision's delta is durable, and an unacknowledged deferred flush
    // rejects fail-closed. The gate orders only the resolution — the
    // materialize/drain path below starts immediately.
    const journalDurability = deps.awaitJournalDurability(chatId)
    // Skip the full re-materialization when a fresh artifact already covers
    // the current revision: a checkpoint in flight covers the chain
    // (enqueueing again would only chain a second whole-record artifact
    // behind it), and with nothing staged there is nothing to enqueue. Only
    // an uncovered staged record is materialized once.
    if (deps.compatibility.hasUnconfirmed(chatId) && !deps.compatibility.hasSubmitted(chatId)) {
      deps.materialize(chatId)
    }
    const drain = deps.compatibility.barrier(chatId).then(() => {
      if (!deps.compatibility.hasUnconfirmed(chatId)) deps.clearUnconfirmed(chatId)
    })
    return Promise.all([journalDurability, drain]).then(() => undefined)
  }
}
