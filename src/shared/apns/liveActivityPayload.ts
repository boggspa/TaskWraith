/**
 * Live Activity push payloads.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CONTAINMENT RULE, READ THIS FIRST
 *
 * A Live Activity's content-state CANNOT be end-to-end encrypted. ActivityKit
 * decodes the push payload itself and hands the struct to the widget process —
 * there is no Notification-Service-Extension hook to decrypt in, the way there
 * is for an alert push (see pushSeal.ts / NotificationService.swift).
 *
 * So everything below is readable by Apple, and — once the Tier-2 relay gateway
 * lands — by the relay operator too. That is a strict downgrade from the alert
 * path, where only ciphertext leaves the Mac.
 *
 * `buildLiveActivityContentState` is therefore a WHITELIST, not a mapper: it
 * copies named primitives out of its input and drops everything else. Passing a
 * whole task card through it leaks nothing, because nothing unnamed survives.
 * The mirror of this rule lives in TWRunActivity.swift's `makeContentState`.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Node-builtin-free: this is imported by the main process AND the relay
 * gateway, and the gateway runs outside Electron.
 */

/** Mirrors `TWRunPhase` in TWRunActivity.swift. */
export const LIVE_ACTIVITY_PHASES = [
  'running',
  'awaitingApproval',
  'awaitingQuestion',
  'complete',
  'failed',
  'cancelled'
] as const
export type LiveActivityPhase = (typeof LIVE_ACTIVITY_PHASES)[number]

export const TERMINAL_LIVE_ACTIVITY_PHASES: readonly LiveActivityPhase[] = [
  'complete',
  'failed',
  'cancelled'
]

/** Mirrors `TWRunActivityLimits.maxSeats`. ActivityKit rejects an oversized
 *  content-state outright, so the cap is enforced on BOTH sides rather than
 *  trusted to whoever builds the payload. */
export const MAX_LIVE_ACTIVITY_SEATS = 8

export interface LiveActivitySeat {
  provider: string
  phase: LiveActivityPhase
}

/** Byte-for-byte the JSON shape of Swift's `TWRunActivityState`. */
export interface LiveActivityContentState {
  phase: LiveActivityPhase
  /** UNIX seconds. NOT an ISO string and NOT a `Date`-encoded double — see the
   *  comment on `startedAtUnix` in TWRunActivity.swift. Getting this wrong puts
   *  the on-device timer 31 years out with no error anywhere. */
  startedAtUnix: number
  filesChanged: number
  additions: number
  deletions: number
  seats: LiveActivitySeat[]
}

export type LiveActivityEvent = 'start' | 'update' | 'end'

export interface LiveActivityPushPayload {
  event: LiveActivityEvent
  contentState: LiveActivityContentState
  /** apns-collapse-id. The opaque per-activity ref, never a threadId. */
  collapseId: string
  /** Drives priority and the optional alert. */
  needsUser: boolean
  /** Unix seconds after which the widget shows its out-of-contact treatment.
   *  Omit and a delivered-then-abandoned activity ticks forever. */
  staleAtUnix?: number
  /** `end` only: unix seconds at which iOS clears the activity. */
  dismissAtUnix?: number
  /** `start` only: the immutable attributes, and the Swift type name that
   *  ActivityKit matches them against. */
  attributes?: LiveActivityAttributes
}

export interface LiveActivityPalette {
  accent: number
  success: number
  failure: number
  attention: number
}

/** Mirrors `TWRunActivityConfig`. */
export interface LiveActivityAttributes {
  provider: string
  archetype: string
  palette: LiveActivityPalette
  activityRef: string
}

/** MUST equal the Swift struct name — ActivityKit matches on it verbatim and
 *  silently drops a start push whose type it does not recognise. */
export const LIVE_ACTIVITY_ATTRIBUTES_TYPE = 'TWRunActivityAttributes'

function clampCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function coercePhase(value: unknown): LiveActivityPhase {
  return LIVE_ACTIVITY_PHASES.includes(value as LiveActivityPhase)
    ? (value as LiveActivityPhase)
    : 'running'
}

/**
 * THE ONLY WAY to build a content state. Named primitives in, named primitives
 * out — a caller physically cannot pass a thread title or a file path through
 * it, because nothing it does not name survives.
 */
export function buildLiveActivityContentState(input: {
  phase: unknown
  startedAtUnix: unknown
  filesChanged?: unknown
  additions?: unknown
  deletions?: unknown
  seats?: readonly { provider?: unknown; phase?: unknown }[]
}): LiveActivityContentState {
  const startedAtUnix =
    typeof input.startedAtUnix === 'number' && Number.isFinite(input.startedAtUnix)
      ? Math.floor(input.startedAtUnix)
      : 0
  return {
    phase: coercePhase(input.phase),
    startedAtUnix,
    filesChanged: clampCount(input.filesChanged),
    additions: clampCount(input.additions),
    deletions: clampCount(input.deletions),
    seats: (input.seats ?? []).slice(0, MAX_LIVE_ACTIVITY_SEATS).map((seat) => ({
      // A provider id is a PRODUCT name ("codex"), not user content. Coerced to
      // a string so a malformed projection cannot smuggle an object through.
      provider: typeof seat.provider === 'string' ? seat.provider : 'ensemble',
      phase: coercePhase(seat.phase)
    }))
  }
}

export function isTerminalLiveActivityPhase(phase: LiveActivityPhase): boolean {
  return TERMINAL_LIVE_ACTIVITY_PHASES.includes(phase)
}

/**
 * The `aps` dictionary Apple expects for a Live Activity push.
 *
 * `timestamp` is REQUIRED and is how iOS orders updates. Two pushes with the
 * same timestamp, or one that arrives with an older timestamp than the state
 * already on screen, are DISCARDED — so a caller that reuses a cached "now"
 * across a burst silently loses every update after the first.
 */
export function buildLiveActivityApsBody(
  payload: LiveActivityPushPayload,
  nowSeconds: number
): string {
  const aps: Record<string, unknown> = {
    timestamp: nowSeconds,
    event: payload.event,
    'content-state': payload.contentState,
    // A waiting run outranks a merely-running one when several activities
    // compete for the Dynamic Island.
    'relevance-score': payload.needsUser ? 2 : 1
  }
  if (typeof payload.staleAtUnix === 'number') {
    aps['stale-date'] = Math.floor(payload.staleAtUnix)
  }
  if (payload.event === 'end' && typeof payload.dismissAtUnix === 'number') {
    aps['dismissal-date'] = Math.floor(payload.dismissAtUnix)
  }
  if (payload.event === 'start') {
    if (!payload.attributes) {
      throw new Error('buildLiveActivityApsBody: a start event requires attributes')
    }
    aps['attributes-type'] = LIVE_ACTIVITY_ATTRIBUTES_TYPE
    aps.attributes = payload.attributes
    // A push-STARTED activity is invisible until something draws it, and iOS
    // requires an alert on start so the user knows why a card appeared.
    aps.alert = {
      title: 'TaskWraith',
      body: payload.needsUser ? 'A run needs you.' : 'A run started.'
    }
  }
  return JSON.stringify({ aps })
}
