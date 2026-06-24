/**
 * 1.0.4-AK — `ensemble_continue` MCP control tool handler.
 *
 * The participant calls this once they've completed a turn AND want
 * the ensemble to continue (or end) without waiting for the user.
 * Three modes via `acceptanceStatus`:
 *
 *   - `'inProgress'` — queue exactly ONE follow-up prompt as a fresh
 *     round. Reuses the existing `runtime.queuedPrompts` FIFO.
 *   - `'complete'` — acceptance criteria reported met. Transition the
 *     Work Session to `'completed'`, do NOT queue, finalise.
 *   - `'blocked'` — pause the Work Session. The next user
 *     interaction (Resume button or fresh prompt) re-arms it.
 *
 * This module is intentionally side-effect free at the surface — it
 * takes a `deps` interface and returns a structured result. The
 * dispatcher in `src/main/index.ts` wires `getChat` / `saveChat` /
 * `queuePromptForOrchestrator` callbacks and posts the result back
 * to the MCP envelope. Side-effect isolation keeps the regression
 * suite unit-testable without booting Electron.
 *
 * Critical safety: this handler MUST NOT bypass
 * `EffectiveRunPermissions`. It only manipulates the queue + the
 * Work Session lifecycle status. Each queued round still goes
 * through the normal dispatch path (including per-participant
 * permission resolution) when the orchestrator picks it up.
 */
import type {
  ChatRecord,
  EnsembleConfig,
  ProviderId,
  WorkSessionConfig,
  WorkSessionStatus
} from './store/types'

/** Allowed values for the `acceptanceStatus` arg. */
export type EnsembleContinueAcceptance = 'inProgress' | 'complete' | 'blocked'

export interface EnsembleContinueArgs {
  /** What the calling participant accomplished this turn. Logged
   * into the transcript as a status row. */
  summary?: string
  /** Prompt to seed the next round. Required when
   * `acceptanceStatus === 'inProgress'`. Ignored otherwise. */
  nextPrompt?: string
  /** Optional @-mention of the next speaker. The orchestrator's
   * existing alias resolver promotes the named participant. */
  target?: string
  /** Free-text reason logged to the transcript. */
  reason?: string
  /** Lifecycle decision — see module doc. */
  acceptanceStatus?: EnsembleContinueAcceptance
}

export interface EnsembleContinueDeps {
  /** Lookup the current chat record. Returns `null` when no
   * matching chat — handler returns a structured error. */
  getChat(chatId: string): ChatRecord | null
  /** Persist the chat. Called when the Work Session status
   * transitions (active → completed / paused / etc.). */
  saveChat(chat: ChatRecord): void
  /** Enqueue a follow-up prompt as a fresh round. Wraps the
   * existing orchestrator-side `runtime.queuedPrompts.push`
   * with a check for an active runtime — when no runtime
   * exists, returns false. */
  queueFollowUpPrompt(chatId: string, prompt: string): boolean
  /** Used by `roundsUsed` budget tracking — which provider just
   * called this tool. */
  callingProvider: ProviderId
  /** The calling participant's id, sourced from the runtime
   * context. Used for the allowed-participants gate. */
  callingParticipantId: string
}

export interface EnsembleContinueResult {
  ok: boolean
  /** New Work Session status after this call. */
  status: WorkSessionStatus
  /** Human-readable message logged into the transcript as a
   * status row. */
  message: string
  /** `true` when a follow-up prompt was successfully queued. */
  queued: boolean
  /** Set when `ok === false`; categorises the failure. */
  error?:
    | 'no_active_work_session'
    | 'participant_not_allowed'
    | 'work_session_manager_required'
    | 'continuation_already_queued'
    | 'missing_next_prompt'
    | 'invalid_acceptance_status'
    | 'budget_exhausted'
    | 'no_progress'
    | 'queue_failed'
    | 'unknown_chat'
}

/**
 * How many times a single participant may queue a BYTE-IDENTICAL
 * continuation (same `nextPrompt` + `summary`) in a row before the
 * handler refuses and ends the Work Session as "no progress". The
 * Nth identical attempt is refused, so up to N-1 identical
 * continuations dispatch. Kept small: a real continuation changes
 * its next step as work advances, so verbatim repetition is the
 * signature of a stuck loop, not legitimate iteration.
 */
export const MAX_IDENTICAL_CONTINUATIONS = 2

/**
 * Process an `ensemble_continue` invocation. Pure-ish: returns the
 * decision + persists the chat through `deps.saveChat`. Does NOT
 * trigger the next round directly — the orchestrator picks up
 * queued prompts on its own loop.
 */
export function handleEnsembleContinue(
  chatId: string,
  args: EnsembleContinueArgs,
  deps: EnsembleContinueDeps
): EnsembleContinueResult {
  const chat = deps.getChat(chatId)
  if (!chat) {
    return {
      ok: false,
      status: 'idle',
      message: 'ensemble_continue: no chat found for the active run.',
      queued: false,
      error: 'unknown_chat'
    }
  }

  const ensemble = chat.ensemble
  const workSession = ensemble?.workSession
  if (!ensemble || !workSession || !workSession.enabled || workSession.status !== 'active') {
    return {
      ok: false,
      status: workSession?.status || 'idle',
      message:
        'ensemble_continue: no active Work Session. Wait for the user to start one before queueing a continuation.',
      queued: false,
      error: 'no_active_work_session'
    }
  }

  // Allowed-participants gate — null means "all enabled".
  if (
    workSession.allowedParticipantIds !== null &&
    !workSession.allowedParticipantIds.includes(deps.callingParticipantId)
  ) {
    return {
      ok: false,
      status: 'active',
      message: `ensemble_continue: participant ${deps.callingParticipantId} is not in the Work Session's allowed participants list.`,
      queued: false,
      error: 'participant_not_allowed'
    }
  }

  // Defensive default: if the agent omits the field, treat as
  // inProgress (the most common case). If the field is set to a
  // bogus value, reject — we don't want to silently coerce
  // 'success' → 'complete' since the lifecycle semantics differ
  // meaningfully.
  const raw = args.acceptanceStatus
  if (raw !== undefined && raw !== 'complete' && raw !== 'blocked' && raw !== 'inProgress') {
    return {
      ok: false,
      status: 'active',
      message: `ensemble_continue: invalid acceptanceStatus "${raw}". Must be 'inProgress', 'complete', or 'blocked'.`,
      queued: false,
      error: 'invalid_acceptance_status'
    }
  }
  const acceptanceStatus: EnsembleContinueAcceptance = raw ?? 'inProgress'

  if (
    workSession.managerParticipantId &&
    deps.callingParticipantId !== workSession.managerParticipantId &&
    (acceptanceStatus === 'complete' || acceptanceStatus === 'inProgress')
  ) {
    return {
      ok: false,
      status: 'active',
      message: `ensemble_continue: this Work Session is managed by Bossman participant ${workSession.managerParticipantId}. Other participants may report findings, but cannot advance or complete the autonomous loop.`,
      queued: false,
      error: 'work_session_manager_required'
    }
  }

  // --- 'complete' --------------------------------------------------
  if (acceptanceStatus === 'complete') {
    const summary = (args.summary || '').trim()
    const message = summary
      ? `Work Session complete: ${summary}`
      : 'Work Session complete: acceptance criteria met.'
    const updated = transitionWorkSession(ensemble, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      endedReason: summary || 'Acceptance criteria reported met.'
    })
    deps.saveChat({ ...chat, ensemble: updated })
    return { ok: true, status: 'completed', message, queued: false }
  }

  // --- 'blocked' ---------------------------------------------------
  if (acceptanceStatus === 'blocked') {
    const reason = (args.reason || args.summary || '').trim()
    const message = reason
      ? `Work Session paused (blocked): ${reason}`
      : 'Work Session paused (blocked): participant needs user input to continue.'
    const updated = transitionWorkSession(ensemble, {
      status: 'paused',
      endedReason: reason || 'Participant reported blocked.'
    })
    deps.saveChat({ ...chat, ensemble: updated })
    return { ok: true, status: 'paused', message, queued: false }
  }

  // --- 'inProgress' ------------------------------------------------
  const nextPrompt = (args.nextPrompt || '').trim()
  if (!nextPrompt) {
    return {
      ok: false,
      status: 'active',
      message: 'ensemble_continue: `nextPrompt` is required when acceptanceStatus is "inProgress".',
      queued: false,
      error: 'missing_next_prompt'
    }
  }

  // Budget check: roundsUsed[provider] vs. maxRoundsPerProvider. The
  // counter is incremented BELOW (only when we actually queue), so
  // here we check whether THIS queue attempt would exceed.
  const currentUsage = workSession.roundsUsed[deps.callingProvider] || 0
  if (currentUsage >= workSession.maxRoundsPerProvider) {
    const reason = `Round budget reached for ${deps.callingProvider} (${currentUsage}/${workSession.maxRoundsPerProvider}).`
    const updated = transitionWorkSession(ensemble, {
      status: 'limit_reached',
      endedAt: new Date().toISOString(),
      endedReason: reason
    })
    deps.saveChat({ ...chat, ensemble: updated })
    return {
      ok: false,
      status: 'limit_reached',
      message: `ensemble_continue: ${reason}`,
      queued: false,
      error: 'budget_exhausted'
    }
  }

  // Duration budget: startedAt + maxDurationMs vs. now.
  if (workSession.startedAt && workSession.maxDurationMs > 0) {
    const started = new Date(workSession.startedAt).getTime()
    if (Number.isFinite(started) && Date.now() - started >= workSession.maxDurationMs) {
      const elapsedHours = (workSession.maxDurationMs / (1000 * 60 * 60)).toFixed(1)
      const reason = `Duration budget reached (${elapsedHours}h).`
      const updated = transitionWorkSession(ensemble, {
        status: 'limit_reached',
        endedAt: new Date().toISOString(),
        endedReason: reason
      })
      deps.saveChat({ ...chat, ensemble: updated })
      return {
        ok: false,
        status: 'limit_reached',
        message: `ensemble_continue: ${reason}`,
        queued: false,
        error: 'budget_exhausted'
      }
    }
  }

  // Idempotency: refuse to queue a second continuation while one is
  // already pending. Without this guard two participants could each
  // call `ensemble_continue` in the same turn and the orchestrator
  // would dispatch two follow-up rounds.
  const activeRound = ensemble.activeRound
  const alreadyQueued = (activeRound?.queuedPrompts?.length || 0) > 0
  if (alreadyQueued) {
    return {
      ok: false,
      status: 'active',
      message:
        'ensemble_continue: another participant has already queued a continuation this round. Wait for it to dispatch.',
      queued: false,
      error: 'continuation_already_queued'
    }
  }

  // No-progress guard: a participant that keeps queueing the SAME
  // continuation (identical nextPrompt + summary) without doing new
  // work is looping. The per-provider round budget is far too coarse
  // to catch this — it would let the loop run dozens of rounds (and
  // the within-round hop cap resets every round, so it never applies
  // across rounds). Count consecutive byte-identical continuations
  // from the SAME participant and stop once the loop is unmistakable.
  // Scoped per-participant so a legitimate baton-pass that reuses a
  // prompt across DIFFERENT speakers never trips it, and any change to
  // nextPrompt or summary resets the count.
  const continuationSummary = (args.summary || '').trim()
  const signature = JSON.stringify([nextPrompt, continuationSummary])
  const last = workSession.lastContinuation
  const repeatCount =
    last && last.participantId === deps.callingParticipantId && last.signature === signature
      ? last.repeatCount + 1
      : 1
  if (repeatCount > MAX_IDENTICAL_CONTINUATIONS) {
    const reason = `No progress: ${deps.callingParticipantId} queued an identical continuation ${repeatCount} times in a row.`
    const stopped = transitionWorkSession(ensemble, {
      status: 'limit_reached',
      endedAt: new Date().toISOString(),
      endedReason: reason
    })
    deps.saveChat({ ...chat, ensemble: stopped })
    return {
      ok: false,
      status: 'limit_reached',
      message: `ensemble_continue: ${reason} Ending the Work Session — report 'complete' if the acceptance criteria are met, 'blocked' if you need user input, or restate a concrete, DIFFERENT next step.`,
      queued: false,
      error: 'no_progress'
    }
  }

  // Enqueue + bump the counter.
  const queued = deps.queueFollowUpPrompt(chatId, nextPrompt)
  if (!queued) {
    return {
      ok: false,
      status: 'active',
      message:
        'ensemble_continue: orchestrator rejected the queued prompt (no active round runtime found).',
      queued: false,
      error: 'queue_failed'
    }
  }

  const nextRoundsUsed = { ...workSession.roundsUsed }
  nextRoundsUsed[deps.callingProvider] = currentUsage + 1
  const updated: EnsembleConfig = {
    ...ensemble,
    workSession: {
      ...workSession,
      roundsUsed: nextRoundsUsed,
      totalRoundsUsed: workSession.totalRoundsUsed + 1,
      lastContinuation: {
        participantId: deps.callingParticipantId,
        signature,
        repeatCount
      }
    }
  }
  deps.saveChat({ ...chat, ensemble: updated })

  const target = (args.target || '').trim()
  const message = `Work Session continuing${
    target ? ` → @${target}` : ''
  }${continuationSummary ? `: ${continuationSummary}` : ''} (round ${nextRoundsUsed[deps.callingProvider]} of ${workSession.maxRoundsPerProvider} for ${deps.callingProvider})`
  return { ok: true, status: 'active', message, queued: true }
}

/**
 * Apply a partial update to the Work Session config inside an
 * `EnsembleConfig`. Pure helper — caller passes the result back to
 * `deps.saveChat`. Exported for the orchestrator's round-end
 * hard-stop path which also transitions status without going
 * through `ensemble_continue`.
 */
export function transitionWorkSession(
  config: EnsembleConfig,
  patch: Partial<WorkSessionConfig>
): EnsembleConfig {
  const current = config.workSession
  if (!current) return config
  return {
    ...config,
    workSession: {
      ...current,
      ...patch
    }
  }
}
