/**
 * Typed error classification for ensemble participant dispatch
 * failures. Used by the orchestrator's `runRound()` self-heal path
 * so the transcript surfaces *why* a participant was skipped rather
 * than a generic "Dispatch failed." line.
 *
 * Origin: Claude/Explorer's introspective feedback in production —
 * when an `ensemble_yield` hit `ECONNREFUSED` on the Gemini MCP
 * socket, the error bubbled as a raw socket error with no hint
 * about whether the panel could self-heal vs. needed user
 * intervention. The full quote from the transcript:
 *
 *   > when my ensemble_yield call hit ECONNREFUSED on the Gemini
 *   > socket last round, the error bubbled as a raw socket error
 *   > rather than a structured "participant unreachable, panel
 *   > will route manually."
 *
 * The orchestrator was already doing the right thing structurally
 * (skip the failed participant, continue with the next in
 * `remaining`), it just wasn't telling the user that's what
 * happened. This module sharpens the diagnostic.
 *
 * Three failure shapes:
 *
 *   - `unreachable` — the participant's provider runtime or MCP
 *     socket couldn't be reached. Includes connection refused,
 *     socket not found (ENOENT), timeout (ETIMEDOUT), and pipe
 *     break (EPIPE). The panel CAN self-heal by routing around.
 *     Hint to user: re-launch the provider's CLI / wait for the
 *     socket to come back / re-enable participant from chip strip.
 *
 *   - `preflight` — runtime-profile / auth / permission gate
 *     refused the dispatch before the stream started. The
 *     participant exists and is reachable, but the configuration
 *     for THIS dispatch was rejected. Hint: check provider auth,
 *     permission preset, runtime profile.
 *
 *   - `unknown` — anything else. Generic fallback so the
 *     orchestrator can still emit a structured note even when the
 *     error doesn't match a known pattern.
 *
 * Pure functions — no React, no IPC. Easy to unit test.
 */

import type { EnsembleParticipant } from './store/types'

/**
 * Known node / posix error codes that classify as "participant
 * unreachable" — the runtime is dead or temporarily unavailable
 * but the participant config itself is sound.
 */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOENT',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTCONN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET'
])

export type DispatchFailureReason =
  | { kind: 'unreachable'; underlyingCode: string }
  | { kind: 'external_path_grant'; message: string }
  | { kind: 'preflight'; message: string }
  | { kind: 'unknown'; message: string }

const EXTERNAL_PATH_GRANT_AUTHORITY_MARKERS = [
  'External path grant does not match this chat, workspace, provider, or run',
  'External path grant provider does not match the dispatched provider',
  'External path grants must be issued by TaskWraith in this app session'
] as const

export function isExternalPathGrantAuthorityMessage(message: string): boolean {
  const normalized = message.trim()
  if (!normalized) return false
  return EXTERNAL_PATH_GRANT_AUTHORITY_MARKERS.some((marker) => normalized.includes(marker))
}

/**
 * Typed wrapper for participant-unreachable failures, intended for
 * provider-adapter dispatch sites that already know they're hitting a
 * dead MCP socket / down provider runtime. The classifier prefers an
 * instance of this class over `.code` / message-substring sniffing so
 * adapter authors don't have to preserve the underlying ErrnoException
 * shape through their wrapping layers — they can construct this
 * directly with the participant + provider context already in hand.
 *
 * Throwing this from `adapter.run(...)` makes the orchestrator's
 * self-heal path emit the structured `unreachable` note without any
 * extra plumbing. The classifier still handles raw Node errors as a
 * fallback so existing code paths keep working.
 */
export class ParticipantUnreachableError extends Error {
  readonly participantId: string
  readonly providerId: string
  readonly underlyingCode: string

  constructor(participantId: string, providerId: string, underlyingCode: string, message?: string) {
    super(message ?? `Participant ${participantId} (${providerId}) unreachable: ${underlyingCode}`)
    this.name = 'ParticipantUnreachableError'
    this.participantId = participantId
    this.providerId = providerId
    this.underlyingCode = underlyingCode
  }
}

/**
 * Classify an arbitrary thrown value (or a `dispatched: false` shape)
 * into one of three known failure modes. Inputs we handle:
 *
 *   - `Error` instances with `.code` matching a known posix code
 *     (Node's `NodeJS.ErrnoException` shape — what `net`, `fs`,
 *     `dgram`, and most adapter-level socket / pipe errors throw)
 *   - `Error` instances whose `.message` contains a recognisable
 *     posix code substring (covers re-thrown errors that lost their
 *     `.code` field but kept the message — common when an error
 *     gets wrapped through `new Error(originalError.message)`)
 *   - Plain objects with `{ code: 'XXX' }` (some adapters wrap)
 *   - Strings (anything else)
 *
 * Defensive: a null / undefined / unrecognised input returns
 * `{ kind: 'unknown', message: '' }` rather than throwing — the
 * caller is already on an error path and shouldn't get a secondary
 * exception from the classifier itself.
 */
export function classifyDispatchError(error: unknown): DispatchFailureReason {
  if (error === null || error === undefined) {
    return { kind: 'unknown', message: '' }
  }

  // Highest-precedence: typed wrapper from a provider adapter. When
  // the adapter site knows the failure is socket-level (ECONNREFUSED
  // on a dead MCP bridge etc.) it can throw a ParticipantUnreachable
  // directly and skip the `.code` / message-substring dance below.
  if (error instanceof ParticipantUnreachableError) {
    return { kind: 'unreachable', underlyingCode: error.underlyingCode }
  }

  // Node Errno shape: `{ message, code: 'ECONNREFUSED', errno, syscall }`.
  // The `.code` field is the most reliable signal because it
  // survives `Error.captureStackTrace` and most wrapping helpers.
  const errnoCode =
    typeof (error as { code?: unknown }).code === 'string'
      ? ((error as { code?: string }).code as string)
      : ''
  if (errnoCode && UNREACHABLE_CODES.has(errnoCode)) {
    return { kind: 'unreachable', underlyingCode: errnoCode }
  }

  // Message-substring fallback for errors that have been wrapped
  // and lost their `.code`. We only match the canonical caps form
  // (`ECONNREFUSED` not `connection refused`) to avoid false
  // positives on natural-language messages.
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  for (const code of UNREACHABLE_CODES) {
    if (message.includes(code)) {
      return { kind: 'unreachable', underlyingCode: code }
    }
  }

  // Stale/mismatched secondary-workspace grants — never treat as a soft
  // seat skip; the orchestrator remints or pauses for an explicit grant.
  if (message && isExternalPathGrantAuthorityMessage(message)) {
    return { kind: 'external_path_grant', message }
  }

  // Preflight / auth / permission failures don't have a posix code
  // but DO have a meaningful message. Categorise these as preflight
  // so the user knows it's a config-side rather than runtime-side
  // failure.
  if (message) {
    return { kind: 'preflight', message }
  }

  return { kind: 'unknown', message: '' }
}

/**
 * Format the transcript system note for a participant-unreachable
 * dispatch failure. Used by the orchestrator at the failed-dispatch
 * branch in `runRound()` to surface the failure mode to the user
 * instead of a generic "Dispatch failed." line.
 *
 *   - `unreachable`: `"⚠ Codex / Worker unreachable (ECONNREFUSED).
 *     Skipping for this round — re-launch the provider CLI or
 *     re-enable from the chip strip."`
 *   - `preflight`: `"⚠ Codex / Worker dispatch failed: <message>.
 *     Skipping for this round."`
 *   - `unknown`: `"⚠ Codex / Worker dispatch failed. Skipping for
 *     this round."`
 */
/**
 * 1.0.4-AR6 — every health-category note now carries a
 * `[participant-health]` tag prefix so the user can scan a long
 * transcript and group all the panel's health signals at a glance.
 * Pre-AR6 the notes were tagged only with `⚠` — distinguishable from
 * normal content but indistinguishable from each other vs. other
 * warning categories (rate-limit warnings, dispatch warnings,
 * scout-pass warnings). The shared tag makes consolidated
 * downstream rendering (collapsed health drawer, etc.) trivial: a
 * future renderer can simply group by tag prefix without parsing
 * the body text.
 *
 * Exported because the orchestrator uses the same tag when emitting
 * the round-end "all unreachable" follow-up so the consolidated
 * health summary reads as one block.
 */
export const PARTICIPANT_HEALTH_TAG = '[participant-health]'

export function formatDispatchFailureNote(
  participant: EnsembleParticipant,
  reason: DispatchFailureReason
): string {
  const who = participantNoteLabel(participant)

  if (reason.kind === 'unreachable') {
    return (
      `${PARTICIPANT_HEALTH_TAG} ⚠ ${who} unreachable (${reason.underlyingCode}). ` +
      `Skipping for this round — re-launch the provider CLI or ` +
      `re-enable from the chip strip when the socket is back.`
    )
  }
  if (reason.kind === 'external_path_grant') {
    const trimmed = reason.message.replace(/[.!?\s]+$/u, '')
    return (
      `${PARTICIPANT_HEALTH_TAG} ⚠ ${who} needs workspace access: ${trimmed}. ` +
      `Waiting for you to approve (or dismiss) the grant prompt — seats are not skipped.`
    )
  }
  if (reason.kind === 'preflight') {
    // Trim trailing punctuation so the joined sentence reads
    // cleanly — agent-emitted error messages often end with "." or
    // "!" already, and the appended ". Skipping..." would look
    // like a typo.
    const trimmed = reason.message.replace(/[.!?\s]+$/u, '')
    return `${PARTICIPANT_HEALTH_TAG} ⚠ ${who} dispatch failed: ${trimmed}. Skipping for this round.`
  }
  return `${PARTICIPANT_HEALTH_TAG} ⚠ ${who} dispatch failed. Skipping for this round.`
}

/**
 * Provider display name — `'codex'` → `'Codex'`. Mirrors the
 * `providerLabel` helper in `EnsemblePrompt.ts` but kept local so
 * this module doesn't take a cross-file dependency for one string.
 */
function providerDisplayName(provider: string): string {
  if (!provider) return ''
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

/**
 * Canonical "Provider / Role" label used in every dispatch-failure
 * transcript note (the generic skip note, the yield-target note, the
 * all-unreachable fallback). Falls back to bare provider name when a
 * participant has no role configured. Exported so the orchestrator
 * can format yield/all-unreachable notes with the same shape.
 */
export function participantNoteLabel(participant: EnsembleParticipant): string {
  const provider = providerDisplayName(participant.provider)
  const role = (participant.role || '').trim()
  return role ? `${provider} / ${role}` : provider
}

/**
 * Yield-target unreachable transcript note. Emitted when a participant
 * called `ensemble_yield(target: ...)` and the resolved target's
 * socket is down. The orchestrator routes past the dead target to the
 * next-in-rotation; this note tells the user WHY we didn't honour the
 * yield. When there's no next participant available, the message
 * gracefully falls back to "returning to user" — the round-end
 * all-unreachable note typically follows in that case anyway.
 */
export function formatYieldTargetUnreachableNote(
  target: EnsembleParticipant,
  underlyingCode: string,
  next: EnsembleParticipant | null
): string {
  const targetLabel = participantNoteLabel(target)
  if (next) {
    const nextLabel = participantNoteLabel(next)
    return (
      `${PARTICIPANT_HEALTH_TAG} ⚠ Yield target ${targetLabel} unreachable (${underlyingCode}). ` +
      `Routing to next participant in rotation (${nextLabel}).`
    )
  }
  return (
    `${PARTICIPANT_HEALTH_TAG} ⚠ Yield target ${targetLabel} unreachable (${underlyingCode}). ` +
    `No further participants — returning to user.`
  )
}

/**
 * Round-end fallback note. Emitted when every dispatch attempt in the
 * round failed with `unreachable` — none of the participants' sockets
 * came up. The chip-strip wording mirrors the recovery hint in
 * `formatDispatchFailureNote` so the user has one place to act
 * regardless of which note they read first.
 */
export function formatAllUnreachableNote(): string {
  return (
    `${PARTICIPANT_HEALTH_TAG} ⚠ No reachable participants left. Returning to user — ` +
    `re-enable participants from the chip strip and resume.`
  )
}

/**
 * 1.0.4-AD — pre-flight probe failure note. Emitted by the orchestrator
 * BEFORE dispatch when `probeParticipant` reports the provider's
 * runtime / socket / binary couldn't be verified. Distinguished from
 * `formatDispatchFailureNote` so the user can see WHEN the failure was
 * caught (round start vs mid-dispatch) and so the wording can mention
 * the specific failure reason captured by the probe (binary path
 * missing, socket not responding, bridge daemon down, etc.).
 *
 *   "⚠ Codex / Worker health check failed: app-server socket
 *    unreachable (ECONNREFUSED). Skipping for this round — re-launch
 *    the provider CLI or re-enable from the chip strip when the
 *    socket is back."
 *
 * When the underlying code is known we surface it after the reason in
 * parentheses (mirroring `formatDispatchFailureNote`'s shape). When
 * only the reason text is available, the code is omitted.
 */
export function formatProbeFailureNote(
  participant: EnsembleParticipant,
  reason: string,
  underlyingCode?: string
): string {
  const who = participantNoteLabel(participant)
  const trimmedReason = (reason || '').replace(/[.!?\s]+$/u, '').trim()
  const codeSuffix = underlyingCode ? ` (${underlyingCode})` : ''
  const reasonText = trimmedReason ? `: ${trimmedReason}${codeSuffix}` : codeSuffix
  return (
    `${PARTICIPANT_HEALTH_TAG} ⚠ ${who} health check failed${reasonText}. ` +
    `Skipping for this round — re-launch the provider CLI or ` +
    `re-enable from the chip strip when the socket is back.`
  )
}
