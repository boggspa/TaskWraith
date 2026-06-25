/**
 * Pure state-machine seam for the composer's "Steer" action.
 *
 * Steer is the user-visible name for "interrupt the active turn in this
 * chat and dispatch a new prompt instead". Sibling of "Queue" (which
 * waits passively for the active turn to finish). The renderer wires
 * the UI in `App.tsx`, but the legal transitions and the
 * has-anything-active-run-still-running check live here so they can be
 * unit-tested without booting the whole Electron renderer.
 *
 * Flow:
 *   idle
 *     ─ steer requested ─▶ cancelling (interrupting in-flight turn)
 *                              │
 *                              ├─ active run cleared in time ─▶ dispatching
 *                              │                                    │
 *                              │                                    └─ run dispatched ─▶ idle
 *                              │
 *                              └─ timeout (5s default)        ─▶ failed
 *                                                                   │
 *                                                                   └─ fallback queued ─▶ idle
 *
 * The state itself is a discriminated union keyed by `phase`. Each
 * non-idle state carries the chat id it relates to so callers can pin
 * indicators (e.g. "Steering — interrupting current turn…") to the
 * right composer when several chats are open in the app.
 */

export type SteerPhase = 'idle' | 'cancelling' | 'dispatching' | 'failed'

export interface SteerStateIdle {
  phase: 'idle'
}

export interface SteerStateActive {
  phase: 'cancelling' | 'dispatching'
  chatId: string
  startedAt: number
  /** The runId we asked the main process to cancel, if known. */
  cancelTargetRunId?: string
  /** Optional human-facing message override (defaults to the phase default). */
  message?: string
}

export interface SteerStateFailed {
  phase: 'failed'
  chatId: string
  reason: 'timeout' | 'no-active-run' | 'cancel-failed'
  message: string
}

export type SteerState = SteerStateIdle | SteerStateActive | SteerStateFailed

export const IDLE_STEER_STATE: SteerStateIdle = { phase: 'idle' }

/** Default soft deadline for the "cancel landed" wait, in ms. */
export const DEFAULT_STEER_CANCEL_TIMEOUT_MS = 5_000

/** Default poll cadence for `activeRunsRef.current` cleanup, in ms. */
export const DEFAULT_STEER_POLL_INTERVAL_MS = 80

export interface BeginSteerInput {
  chatId: string
  cancelTargetRunId?: string
  now?: number
}

export function beginSteer(input: BeginSteerInput): SteerStateActive {
  return {
    phase: 'cancelling',
    chatId: input.chatId,
    startedAt: input.now ?? Date.now(),
    cancelTargetRunId: input.cancelTargetRunId
  }
}

export interface TransitionToDispatchingInput {
  prev: SteerState
  chatId: string
  now?: number
}

export function transitionToDispatching(input: TransitionToDispatchingInput): SteerStateActive {
  // Only valid from `cancelling` of the same chat. Anything else is a
  // programming error in App.tsx (e.g. a stale callback firing after
  // the user navigated away). Coerce to a fresh `dispatching` state
  // anchored to the new chat — never silently drop the indicator.
  return {
    phase: 'dispatching',
    chatId: input.chatId,
    startedAt:
      input.prev.phase === 'cancelling' && input.prev.chatId === input.chatId
        ? input.prev.startedAt
        : (input.now ?? Date.now()),
    cancelTargetRunId: input.prev.phase === 'cancelling' ? input.prev.cancelTargetRunId : undefined
  }
}

export interface MarkSteerFailedInput {
  chatId: string
  reason: SteerStateFailed['reason']
  message: string
}

export function markSteerFailed(input: MarkSteerFailedInput): SteerStateFailed {
  return {
    phase: 'failed',
    chatId: input.chatId,
    reason: input.reason,
    message: input.message
  }
}

export function resetSteer(): SteerStateIdle {
  return IDLE_STEER_STATE
}

export interface IsActiveRunClearedInput {
  /** Map-like access to the renderer's `activeRunsRef.current`. */
  hasRunForChat: (chatId: string) => boolean
  chatId: string
}

/**
 * True iff the renderer's `activeRunsRef` no longer holds any context
 * for this chat. The polling loop in `App.tsx` calls this each tick to
 * decide whether to transition out of `cancelling`.
 */
export function isActiveRunCleared(input: IsActiveRunClearedInput): boolean {
  return !input.hasRunForChat(input.chatId)
}

export interface SteerWaitDecisionInput {
  startedAt: number
  now: number
  timeoutMs?: number
  hasRunForChat: (chatId: string) => boolean
  chatId: string
}

export type SteerWaitDecision =
  | { kind: 'continue-waiting' }
  | { kind: 'cancel-landed' }
  | { kind: 'timeout' }

/**
 * Single-tick decision for the steer wait loop. Pulled out so the
 * branching is testable without async timers.
 *
 *   - `cancel-landed`: the active run cleared in time. Caller should
 *     transition to `dispatching` and run `executeRun`.
 *   - `timeout`: the deadline elapsed. Caller should fall back to
 *     `queueRunRequest`, mark steer as failed, and surface an error.
 *   - `continue-waiting`: neither yet. Caller should sleep and re-poll.
 */
export function decideSteerWait(input: SteerWaitDecisionInput): SteerWaitDecision {
  if (isActiveRunCleared({ hasRunForChat: input.hasRunForChat, chatId: input.chatId })) {
    return { kind: 'cancel-landed' }
  }
  const elapsed = input.now - input.startedAt
  const limit = input.timeoutMs ?? DEFAULT_STEER_CANCEL_TIMEOUT_MS
  if (elapsed >= limit) {
    return { kind: 'timeout' }
  }
  return { kind: 'continue-waiting' }
}

export interface SteerIndicatorViewInput {
  state: SteerState
  chatId: string | null | undefined
  providerLabel: string
}

/**
 * Renderer-facing helper: returns the inline indicator text the
 * composer should show, or `null` when nothing should render.
 *
 * Centralised so the copy is consistent between cancelling and
 * dispatching phases without each call site re-deriving it.
 */
export function getSteerIndicatorMessage(input: SteerIndicatorViewInput): string | null {
  if (!input.chatId) return null
  const { state } = input
  if (state.phase === 'idle') return null
  if (state.chatId !== input.chatId) return null
  if (state.phase === 'cancelling') {
    return state.message || `Steering — interrupting current ${input.providerLabel} turn…`
  }
  if (state.phase === 'dispatching') {
    return state.message || `Steering — dispatching new ${input.providerLabel} turn…`
  }
  // `failed` is shown via a raw-log/system-note path in the chat
  // transcript, not the composer indicator, so suppress it here.
  return null
}

export interface IsSteerInFlightInput {
  state: SteerState
  chatId: string | null | undefined
}

/**
 * Convenience predicate for "the Steer button should show the busy
 * spinner for this chat". Returns true while either cancelling or
 * dispatching, false during idle/failed.
 */
export function isSteerInFlight(input: IsSteerInFlightInput): boolean {
  if (!input.chatId) return false
  const { state } = input
  if (state.phase !== 'cancelling' && state.phase !== 'dispatching') return false
  return state.chatId === input.chatId
}
