/**
 * Authoritative seat-change transcript row — shared vocabulary + coalescing
 * (owner spec 2026-08-05). Lives in shared because BOTH processes need it:
 * main's EnsembleOrchestrator coalesces and persists the rows; the renderer's
 * SeatChangeRow needs the window constant to tell a living (still-rolling)
 * row from a settled tombstone. A renderer value-import from main is the
 * cross-process edge `guard:architecture` forbids.
 *
 * Coalescing: rapid roster adjustments to the SAME participant within the
 * window collapse into one living row — the stale row is removed, and the
 * fresh row lands at the newest transcript position carrying the ORIGINAL
 * before-state (so the collapsed row's expansion shows what the seat was
 * before the whole flurry, and a remount rolls the full journey once). The
 * window slides from the LATEST adjustment — a user flicking through configs
 * gets the full window from each tweak to keep tweaking.
 *
 * Tombstoning: anything outside the window is permanent history. A later
 * change to the same participant creates a NEW row; the old one is never
 * touched again. Row-count invariance per coalesced update (lose exactly one
 * row, gain exactly one row) is the transcript-stability contract — the
 * augmentation lanes rely on it.
 */
export const SEAT_CHANGE_COALESCE_WINDOW_MS = 120_000

/** One side of an authoritative seat change (before/after) — the fields the
 * transcript row renders with the composer's own chip vocabulary. */
export interface SeatChangeSeatState {
  provider: string
  model: string
  /** Participant role at this side of the change — rendered right-aligned in
   * the provider accent so same-model panels stay tellable apart. */
  role?: string
  /** 1-based roster position, rendered as the "#N" prefix on the role (the
   * approval-modal @Role #N vocabulary). */
  seatNumber?: number
  reasoningEffort?: string
  permissionPresetId?: string
  /** Chat-level workspace grant count at emit time (the permission chip's
   * "N grants" suffix). */
  grantsCount?: number
}

export interface SeatChangePayload {
  participantId: string
  /** Human seat label at emit time (role or provider). */
  label: string
  before: SeatChangeSeatState
  after: SeatChangeSeatState
  /** ISO timestamp of the LATEST coalesced adjustment. */
  appliedAt: string
}

/** Structural slice of ChatMessage the coalescer needs — keeps this module
 * free of main-process imports. */
export interface SeatChangeCarrierMessage {
  metadata?: {
    seatChange?: SeatChangePayload
  }
}

export interface SeatChangeCoalesceResult<T extends SeatChangeCarrierMessage> {
  /** Messages with the superseded in-window row removed (copied array either
   * way, matching the caller's spread-then-append idiom). */
  messages: T[]
  /** The payload to append: `before` inherited from the superseded row when
   * one coalesced, verbatim otherwise. */
  payload: SeatChangePayload
}

/**
 * Pure coalescing step: find the newest seat-change row for the same
 * participant, and — iff its latest adjustment is inside the sliding window —
 * remove it and inherit its `before`. Rows for other participants, rows
 * outside the window, and malformed rows are never touched.
 */
export function coalesceSeatChangeMessages<T extends SeatChangeCarrierMessage>(
  messages: readonly T[],
  next: SeatChangePayload,
  nowMs: number
): SeatChangeCoalesceResult<T> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]?.metadata?.seatChange
    if (!candidate || candidate.participantId !== next.participantId) continue
    const appliedAtMs = Date.parse(candidate.appliedAt ?? '')
    if (!Number.isFinite(appliedAtMs) || nowMs - appliedAtMs > SEAT_CHANGE_COALESCE_WINDOW_MS) {
      // Newest row for this participant is already a tombstone — stop looking.
      break
    }
    return {
      messages: [...messages.slice(0, index), ...messages.slice(index + 1)],
      payload: { ...next, before: candidate.before }
    }
  }
  return { messages: [...messages], payload: next }
}
