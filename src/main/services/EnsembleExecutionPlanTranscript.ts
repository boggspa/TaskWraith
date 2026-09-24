import {
  ensembleAuthorityRoleLabel,
  normalizeEnsembleAuthorityRole,
  type LegacyEnsembleAuthorityRole
} from '../../shared/ensembleAuthority'
import {
  EXECUTION_PLAN_CHANGE_KIND,
  type ExecutionPlanChangePayload
} from '../../shared/executionPlanChange'
import type { ChatMessage } from '../store/types'

export interface BuildExecutionPlanChangeInput {
  /** Already normalized by the orchestrator (`normalizeBossmanText`). */
  planSummary: string
  authorityRole: LegacyEnsembleAuthorityRole
  actorParticipantId?: string
  changedAt: string
  roundId?: string
  /** The plan being replaced; omitted for the round's first plan. */
  previousSummary?: string
  phase?: string
  ownerParticipantIds?: string[]
  /** Display labels resolved at emit so replay needs no roster lookup. */
  ownerLabels?: string[]
  blockers?: string[]
  doneCriteria?: string
}

export interface BuiltExecutionPlanChangeTranscriptEvent {
  content: string
  metadata: NonNullable<ChatMessage['metadata']>
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function optionalTextArray(value: string[] | undefined): string[] | undefined {
  const entries = (value || []).map((entry) => entry.trim()).filter(Boolean)
  return entries.length > 0 ? entries : undefined
}

/**
 * Builds the durable structured promotion and its plaintext fallback for an
 * authoritative `set_round_plan`. The caller passes both to appendRoundStatus,
 * keeping persistence and checkpoint ownership in the orchestrator — the same
 * split as `buildContinuationHopsAdvanceTranscriptEvent`.
 */
export function buildExecutionPlanChangeTranscriptEvent(
  input: BuildExecutionPlanChangeInput
): BuiltExecutionPlanChangeTranscriptEvent {
  const actor = normalizeEnsembleAuthorityRole(input.authorityRole) || 'boss'
  const actorParticipantId = optionalText(input.actorParticipantId)
  const previousSummary = optionalText(input.previousSummary)
  const phase = optionalText(input.phase)
  const doneCriteria = optionalText(input.doneCriteria)
  const ownerParticipantIds = optionalTextArray(input.ownerParticipantIds)
  const ownerLabels = optionalTextArray(input.ownerLabels)
  const blockers = optionalTextArray(input.blockers)
  const payload: ExecutionPlanChangePayload = {
    summary: input.planSummary,
    actor,
    ...(actorParticipantId ? { actorParticipantId } : {}),
    changedAt: input.changedAt,
    // Re-stating the same plan is not an update; without a real predecessor
    // the row must not grow a "was" line.
    ...(previousSummary && previousSummary !== input.planSummary ? { previousSummary } : {}),
    ...(phase ? { phase } : {}),
    ...(ownerParticipantIds ? { ownerParticipantIds } : {}),
    ...(ownerLabels ? { ownerLabels } : {}),
    ...(blockers ? { blockers } : {}),
    ...(doneCriteria ? { doneCriteria } : {})
  }

  return {
    content: `${ensembleAuthorityRoleLabel(actor)} set the execution plan: ${input.planSummary}`,
    metadata: {
      kind: EXECUTION_PLAN_CHANGE_KIND,
      ...(input.roundId ? { ensembleRoundId: input.roundId } : {}),
      executionPlanChange: payload
    }
  }
}
