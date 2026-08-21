import { normalizeEnsembleAuthority } from '../shared/ensembleAuthority'
import { gateBlocksActiveGoal } from './ReviewGateScope'
import type {
  ActiveGoalStatus,
  ChatRecord,
  EnsembleBossmanWorkAssignment,
  EnsembleConfig
} from './store/types'

export type EnsembleGoalCompletionAuthority = 'root' | 'assignment' | 'review'

export interface EnsembleGoalLifecycleDecision {
  allowed: boolean
  authority: EnsembleGoalCompletionAuthority
  code?: 'root_authority_required' | 'open_assignments' | 'review_gates'
  message?: string
  blockingAssignmentIds?: string[]
  blockingReviewGateIds?: string[]
}

export function ensembleGoalAuthorityForParticipant(
  config: EnsembleConfig,
  participantId: string
): EnsembleGoalCompletionAuthority {
  const authority = normalizeEnsembleAuthority({
    participants: config.participants,
    bossmanParticipantId: config.bossmanParticipantId,
    captainParticipantIds: config.captainParticipantIds,
    secondInCommandParticipantId: config.secondInCommandParticipantId
  })
  if (
    participantId === authority.bossmanParticipantId ||
    authority.captainParticipantIds.includes(participantId)
  ) {
    return 'root'
  }
  const participant = config.participants.find((candidate) => candidate.id === participantId)
  return participant?.stageRole === 'reviewer' || participant?.stageRole === 'scout'
    ? 'review'
    : 'assignment'
}

export function latestGoalAssignmentForParticipant(
  chat: Pick<ChatRecord, 'activeGoal' | 'ensemble'>,
  participantId: string
): EnsembleBossmanWorkAssignment | null {
  const assignments = chat.ensemble?.bossmanControlState?.assignments || []
  const goalId = chat.activeGoal?.id
  return (
    [...assignments]
      .reverse()
      .find(
        (assignment) =>
          assignment.participantId === participantId &&
          (!assignment.goalId || !goalId || assignment.goalId === goalId) &&
          assignment.status !== 'cancelled'
      ) || null
  )
}

export function decideEnsembleGoalLifecycle(input: {
  chat: Pick<ChatRecord, 'activeGoal' | 'ensemble'>
  participantId: string
  status: ActiveGoalStatus
}): EnsembleGoalLifecycleDecision {
  const config = input.chat.ensemble
  if (!config) return { allowed: true, authority: 'root' }
  const authority = ensembleGoalAuthorityForParticipant(config, input.participantId)
  if (authority !== 'root') {
    return {
      allowed: false,
      authority,
      code: 'root_authority_required',
      message:
        authority === 'review'
          ? 'This seat owns review evidence, not the root Goal lifecycle. Submit the review result and hand it to the Boss/Captain.'
          : 'This seat owns its assigned Goal step, not the root Goal lifecycle. Finish/update the assignment and hand evidence to the Boss/Captain; use ensemble_propose_goal_complete if root authority is unreachable.'
    }
  }
  if (input.status !== 'completed') return { allowed: true, authority }

  return ensembleGoalCompletionReadiness(input.chat)
}

export function ensembleGoalCompletionReadiness(
  chat: Pick<ChatRecord, 'activeGoal' | 'ensemble'>
): EnsembleGoalLifecycleDecision {
  const config = chat.ensemble
  if (!config) return { allowed: true, authority: 'root' }

  const activeGoal = chat.activeGoal
  const blockingAssignments = (config.bossmanControlState?.assignments || []).filter(
    (assignment) =>
      (!assignment.goalId || !activeGoal || assignment.goalId === activeGoal.id) &&
      assignment.status !== 'done' &&
      assignment.status !== 'cancelled'
  )
  if (blockingAssignments.length > 0) {
    return {
      allowed: false,
      authority: 'root',
      code: 'open_assignments',
      blockingAssignmentIds: blockingAssignments.map((assignment) => assignment.id),
      message: `Root Goal completion is blocked by open assignment(s): ${blockingAssignments
        .map((assignment) => assignment.id)
        .join(', ')}.`
    }
  }
  const blockingReviewGates = (config.bossmanControlState?.reviewGates || []).filter((gate) =>
    gateBlocksActiveGoal(gate, activeGoal)
  )
  if (blockingReviewGates.length > 0) {
    return {
      allowed: false,
      authority: 'root',
      code: 'review_gates',
      blockingReviewGateIds: blockingReviewGates.map((gate) => gate.id),
      message: `goal completion blocked by review gate(s): ${blockingReviewGates
        .map((gate) => gate.id)
        .join(', ')}.`
    }
  }
  return { allowed: true, authority: 'root' }
}
