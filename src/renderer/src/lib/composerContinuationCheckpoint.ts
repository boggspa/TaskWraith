/**
 * Host-owned task-continuation checkpoint for composer suggestions.
 *
 * This is intentionally NOT a transcript summary. In particular, it never
 * reads messages, tool output, warnings, participant prose, the ensemble
 * synthesizer summary, or Foundation Models output. Those surfaces may be
 * useful to display to a person, but they are not authority to prefill what a
 * person should ask next.
 *
 * A future local model may rank the finite actions exposed here. It may not
 * manufacture a new action: every user-facing continuation phrase comes from
 * a user-confirmed active goal and every round fact comes from host state.
 */

import type { ChatRecord, EnsembleRoundState } from '../../../main/store/types'

export type ComposerContinuationRoundState = 'none' | 'completed' | 'partial-success' | 'all-failed'

export type ComposerContinuationPhase = 'none' | 'working' | 'blocked'

export interface ComposerContinuationAction {
  /** Stable reference, never model-authored text. */
  id: string
  /** Safe display text derived only from the active thread goal. */
  text: string
  /** The reason exposed to the user via the composer tooltip. */
  explanation: string
  provenance: 'user-confirmed-active-goal'
}

export interface ComposerContinuationCheckpoint {
  schemaVersion: 1
  /** Stable for this exact goal/round-state snapshot. */
  id: string
  phase: ComposerContinuationPhase
  roundState: ComposerContinuationRoundState
  /** Absent when the thread has no live, user-confirmed active goal. */
  action: ComposerContinuationAction | null
}

/**
 * Build a deliberately narrow replacement checkpoint. The caller may run this
 * on every chat update: it has no side effects and replaces prior state rather
 * than recursively carrying transcript prose forward.
 */
export function buildComposerContinuationCheckpoint(
  chat: ChatRecord | null | undefined
): ComposerContinuationCheckpoint | null {
  if (!chat) return null

  const roundState = roundStateFromChat(chat)
  // Active goals can also be set by agent control actions. Their text is
  // useful for the visible task UI, but cannot steer AutoDraft until a person
  // explicitly reaffirms it through the goal control.
  const goal = chat.activeGoal?.objectiveSource === 'user' ? chat.activeGoal : undefined
  const objective = goal?.status === 'active' ? compactGoalText(goal.objective) : ''
  const action =
    goal && objective
      ? {
          id: `active-goal:${goal.id}`,
          text: `Continue with: ${objective}`,
          explanation:
            'Based on this thread’s user-confirmed goal, not run telemetry or agent output.',
          provenance: 'user-confirmed-active-goal' as const
        }
      : null
  const goalVersion = goal ? `${goal.id}:${goal.updatedAt || goal.createdAt || 'current'}` : 'none'

  return {
    schemaVersion: 1,
    id: `continuation:${chat.appChatId || 'unscoped'}:${goalVersion}:${roundState}`,
    phase: roundState === 'all-failed' ? 'blocked' : action ? 'working' : 'none',
    roundState,
    action
  }
}

/** A hard round failure must remain ahead of a learned continuation preference. */
export function isComposerContinuationHardBlocked(
  checkpoint: ComposerContinuationCheckpoint | null | undefined
): boolean {
  return checkpoint?.roundState === 'all-failed'
}

function roundStateFromChat(chat: ChatRecord): ComposerContinuationRoundState {
  const round = chat.ensemble?.activeRound
  if (!round || round.status === 'running') return 'none'

  const outcome = summariseRoundOutcome(round)
  if (outcome.failures > 0 && outcome.successes === 0) return 'all-failed'
  if (outcome.failures > 0 && outcome.successes > 0) return 'partial-success'
  return outcome.successes > 0 ? 'completed' : 'none'
}

function summariseRoundOutcome(round: EnsembleRoundState): { successes: number; failures: number } {
  const lanes = Object.values(round.lanes || {})
  if (lanes.length > 0) {
    return {
      successes: lanes.filter((lane) => lane.status === 'completed').length,
      failures: lanes.filter((lane) => lane.status === 'failed').length
    }
  }

  return {
    successes: (round.participants || []).filter(
      (participant) => participant.status === 'answered' || participant.status === 'yielded'
    ).length,
    failures: (round.participants || []).filter(
      (participant) => participant.status === 'failed' || participant.status === 'unreachable'
    ).length
  }
}

function compactGoalText(value: string | undefined): string {
  return (value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}
