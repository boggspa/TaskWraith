/**
 * Live mid-turn steering for the Pi seat — delivery EVIDENCE, not delivery hope.
 *
 * Pi is the only provider in the fleet whose transport can accept an
 * interjection while a turn is already running: `pi --mode rpc` holds stdin
 * open for the whole turn, so a `{type:'steer'}` JSONL frame written mid-turn
 * is transport-legal (see `piSteerCommand` in ./PiRpc). What pi's RUNTIME does
 * with such a frame was unverified until the 2026-07-29 live probe against
 * pi 0.82.1 (real binary, local mock upstream — no spend). Findings, all of
 * which this module exists to encode:
 *
 *  1. MID-TOOL — a steer written while a tool call is executing is delivered
 *     at the tool boundary: pi ends the turn, then opens a NEW turn whose
 *     first message is the steer text as a plain `user` message positioned
 *     after the tool result. The model sees it on the next LLM call.
 *  2. MID-FINAL-TEXT — a steer written while the FINAL assistant text is
 *     streaming (a turn with no tool calls left, heading for `stop`) is still
 *     delivered: pi opens an EXTRA turn for it rather than dropping it. This
 *     is stronger than pi's own docs, which promise delivery only "after the
 *     current assistant turn finishes executing its tool calls".
 *  3. POST-SETTLE — THE LANDMINE. A steer written after `agent_settled` is
 *     still acked `{"type":"response","command":"steer","success":true}` and
 *     still appears in a `queue_update`, but is NEVER delivered: no further
 *     turn runs, and the message dies with the process on stdin EOF. **The
 *     `success:true` ack is an ACCEPTANCE receipt, not a DELIVERY receipt.**
 *     Treating the ack as delivery would strand the user's interjection
 *     silently — the same vacuous-pass class as the 401-settles-as-success
 *     bug that the Pi seat shipped with (see PiRpc's turn_end comment).
 *  4. No corruption anywhere. Session-backed runs (`--session-dir` +
 *     `--session-id`) persist the steer as an ordinary `user` message in
 *     correct chronological position; the durable session file stays clean and
 *     the process still exits 0 on stdin EOF.
 *
 * Because of (3), delivery is confirmed ONLY by watching pi's own
 * `queue_update` events: pi emits the full pending steering queue whenever it
 * changes, and drains an entry (emitting a queue_update without it) at the
 * exact moment it starts the user message that carries it. A tracked entry is
 * therefore delivered when it has been seen IN the queue and then seen GONE
 * from it. Anything still pending when the run ends was never delivered and
 * must fall back to the ordinary turn-boundary path.
 */

/** Pi's `queue_update` payload: the FULL pending queues, re-emitted on change. */
export interface PiSteerQueueSnapshot {
  steering: string[]
  followUp: string[]
}

/**
 * Recognize a `queue_update` line. Returns null for every other line shape so
 * callers can feed the raw pi JSONL stream in without pre-filtering.
 */
export function parsePiQueueUpdate(json: unknown): PiSteerQueueSnapshot | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const record = json as Record<string, unknown>
  if (record.type !== 'queue_update') return null
  const steering = Array.isArray(record.steering)
    ? record.steering.filter((entry): entry is string => typeof entry === 'string')
    : []
  const followUp = Array.isArray(record.followUp)
    ? record.followUp.filter((entry): entry is string => typeof entry === 'string')
    : []
  return { steering, followUp }
}

interface PiLiveSteerPendingEntry {
  entryId: string
  text: string
  /**
   * Whether this entry was ever observed sitting in pi's steering queue.
   * Delivery requires seen-then-gone; an entry that is never seen queued (a
   * write that silently failed, or a frame pi rejected) must NEVER be inferred
   * delivered from its absence. Fail-closed, matching the Pi seat's
   * fail-closed configured-probe posture.
   */
  observedQueued: boolean
}

/**
 * Per-run tracker for steer frames written into a live pi turn.
 *
 * One instance per spawned pi process, fed every `queue_update` seen on that
 * process's stdout. Pure and clock-free: callers own the registry bookkeeping
 * and timestamps.
 */
export class PiLiveSteerTracker {
  private pending: PiLiveSteerPendingEntry[] = []

  /** Record a steer frame that has just been written to pi's stdin. */
  registerPending(entryId: string, text: string): void {
    if (!entryId || !text) return
    if (this.pending.some((entry) => entry.entryId === entryId)) return
    this.pending.push({ entryId, text, observedQueued: false })
  }

  get hasPending(): boolean {
    return this.pending.length > 0
  }

  /** Entry ids still awaiting delivery evidence, oldest first. */
  pendingEntryIds(): string[] {
    return this.pending.map((entry) => entry.entryId)
  }

  /**
   * Fold one `queue_update` and return the entry ids pi has now DELIVERED
   * (oldest first). Entries still queued, or never yet seen queued, are
   * retained.
   *
   * Pi drains its steering queue FIFO, so when several tracked entries carry
   * identical text the survivors are the NEWEST — the remaining queue slots are
   * therefore assigned newest-first, leaving the oldest to be reported drained.
   */
  observeQueueUpdate(snapshot: PiSteerQueueSnapshot): string[] {
    if (this.pending.length === 0) return []
    const remainingByText = new Map<string, number>()
    for (const text of snapshot.steering) {
      remainingByText.set(text, (remainingByText.get(text) ?? 0) + 1)
    }
    const delivered = new Set<string>()
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const entry = this.pending[index]
      const remaining = remainingByText.get(entry.text) ?? 0
      if (remaining > 0) {
        remainingByText.set(entry.text, remaining - 1)
        entry.observedQueued = true
        continue
      }
      if (entry.observedQueued) delivered.add(entry.entryId)
    }
    if (delivered.size === 0) return []
    const deliveredIds = this.pending
      .filter((entry) => delivered.has(entry.entryId))
      .map((entry) => entry.entryId)
    this.pending = this.pending.filter((entry) => !delivered.has(entry.entryId))
    return deliveredIds
  }

  /**
   * Terminal sweep: entry ids that never earned delivery evidence. These must
   * be left undelivered in the steering registry so the ordinary turn-boundary
   * path still carries them — this is the finding-3 loss window.
   */
  takeUndelivered(): string[] {
    const ids = this.pending.map((entry) => entry.entryId)
    this.pending = []
    return ids
  }
}

/**
 * Production gate. Live steering is enabled by default after end-to-end
 * delivery-evidence coverage; an explicit false value remains an emergency
 * kill switch. Every refused or unconfirmed attempt still falls back to the
 * durable turn-boundary path.
 */
export function piLiveSteerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.TASKWRAITH_PI_LIVE_STEER?.trim().toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off'
}
