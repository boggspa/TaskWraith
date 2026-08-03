import type {
  EnsembleYieldOutcome,
  EnsembleYieldRejectReason,
  EnsembleYieldRouteAction
} from './EnsembleYieldRouting'

export type EnsembleYieldToolResult = {
  ok: boolean
  tool: 'ensemble_yield'
  reason?: string
  target?: string
  message?: string
  error?: EnsembleYieldRejectReason
  action?: EnsembleYieldRouteAction | 'held_for_active_fanout'
  targetParticipantId?: string
  activeLaneCount?: number
  eligibleManagerParticipantIds?: string[]
  suggestedAliases?: string[]
}

export const ENSEMBLE_YIELD_NO_ACTIVE_RUN_MESSAGE =
  'No active Ensemble participant run matches this yield call.'
export const ENSEMBLE_YIELD_ALREADY_SETTLED_MESSAGE =
  'This Ensemble participant run already settled; no further routing action is required.'

export function buildEnsembleYieldToolResult(input: {
  outcome: EnsembleYieldOutcome
  reason?: string
  target?: string
}): EnsembleYieldToolResult {
  const base = {
    tool: 'ensemble_yield' as const,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.target ? { target: input.target } : {})
  }

  if (input.outcome.kind === 'no_active_run') {
    return {
      ...base,
      ok: false,
      message: ENSEMBLE_YIELD_NO_ACTIVE_RUN_MESSAGE,
      error: 'no_active_run'
    }
  }

  if (input.outcome.kind === 'already_settled') {
    return {
      ...base,
      ok: true,
      message: ENSEMBLE_YIELD_ALREADY_SETTLED_MESSAGE
    }
  }

  if (input.outcome.kind === 'fanout_handoff_held') {
    return {
      ...base,
      ok: true,
      action: 'held_for_active_fanout',
      message: input.outcome.message,
      activeLaneCount: input.outcome.activeLaneCount,
      eligibleManagerParticipantIds: input.outcome.eligibleManagerParticipantIds,
      ...(input.outcome.suggestedAliases.length
        ? { suggestedAliases: input.outcome.suggestedAliases }
        : {})
    }
  }

  if (input.outcome.kind === 'authority_routing_decision_required') {
    const message =
      input.outcome.requirement === 'tagged_intervention'
        ? `The active Boss/Captain must make a targeted interstitial routing decision for pass ${input.outcome.pass} before yielding. ` +
          'Use skip_intervention to preserve the queue, or yield/fan out to a specific participant or role.'
        : `The active Boss/Captain must make an explicit routing decision for Continuous pass ${input.outcome.pass} before yielding. ` +
          'Use ensemble_control select_participants or skip_intervention, or yield to a specific participant/role.'
    return {
      ...base,
      ok: false,
      message,
      error: 'authority_routing_decision_required'
    }
  }

  const routing = input.outcome.routing
  if (!routing) {
    return { ...base, ok: true }
  }

  if (!routing.ok) {
    return {
      ...base,
      ok: false,
      error: routing.reason,
      message: `Yield target was not routed (${routing.reason}).`,
      ...(routing.suggestedAliases?.length
        ? { suggestedAliases: routing.suggestedAliases }
        : {})
    }
  }

  return {
    ...base,
    ok: true,
    action: routing.action,
    ...(routing.targetParticipantId ? { targetParticipantId: routing.targetParticipantId } : {})
  }
}
