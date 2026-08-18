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
  'This Ensemble participant run already settled — make no further tool calls and end your turn.'

/**
 * Returned by ensemble control-surface tools when the calling run was
 * finalized by a host/tool decision (yield accepted, seat skipped or
 * re-summoned, wakeup scheduled) while its provider process is still
 * streaming. Without an explicit stop instruction the model flails against
 * the dead route until the transport reaper cuts it (observed: 2.5 minutes
 * of retried control calls in ChipTown chat 75d1d780).
 */
export const ENSEMBLE_SUPERSEDED_RUN_TOOL_MESSAGE =
  "This run's turn is already over — the round has moved on. Make no further tool calls and end your turn now."

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
    // Name BOTH advertised spellings of the control front door. It is
    // `ensemble_control` on v2+ MCP profiles and `ensemble_bossman_control` on
    // v1/pinned ones, so naming one strands the other half of the fleet with an
    // instruction it cannot follow — the seat then spins on rejected yields.
    // The bounded fall-back is stated too, so a seat that genuinely cannot call
    // either tool stops retrying and just ends its turn.
    const controlToolHint =
      'Call whichever control tool this session lists — `ensemble_control` or ' +
      '`ensemble_bossman_control`'
    const message =
      input.outcome.requirement === 'tagged_intervention'
        ? `The active Boss/Captain must make a targeted interstitial routing decision for pass ${input.outcome.pass} before yielding. ` +
          `${controlToolHint} with skip_intervention to preserve the queue, or yield/fan out to a specific participant or role. ` +
          'If neither control tool is listed for you, end your turn — the host preserves the queue after a bounded number of attempts.'
        : `The active Boss/Captain must make an explicit routing decision for Continuous pass ${input.outcome.pass} before yielding. ` +
          `${controlToolHint} with select_participants or skip_intervention, or yield to a specific participant/role. ` +
          'If neither control tool is listed for you, end your turn — the host preserves the queue after a bounded number of attempts.'
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
    // blocked_status has a host-supported recovery the model cannot guess:
    // queue the seat for the NEXT pass instead of retrying the yield. Name
    // both advertised control-tool spellings (same doctrine as the
    // authority-routing message above) so no profile is stranded.
    const rejectionGuidance =
      routing.reason === 'blocked_status'
        ? ' The target seat is not routable in this pass (disabled, unreachable, mid fan-out, or no longer pending).' +
          ' To hand work to it anyway, call whichever control tool this session lists — `ensemble_control` or' +
          ' `ensemble_bossman_control` — with select_participants to queue it for the next pass, then end your turn.' +
          ' Do not retry the same yield.'
        : ''
    return {
      ...base,
      ok: false,
      error: routing.reason,
      message: `Yield target was not routed (${routing.reason}).${rejectionGuidance}`,
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
