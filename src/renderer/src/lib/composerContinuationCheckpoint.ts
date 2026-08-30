import type { ChatRecord, EnsembleRoundState } from '../../../main/store/types'

export type ComposerContinuationRoundState = 'none' | 'completed' | 'partial-success' | 'all-failed'
export type ComposerContinuationPhase = 'none' | 'working' | 'blocked' | 'complete'

export interface ComposerContinuationCheckpoint {
  schemaVersion: 2
  /** Renderer invalidation key only; main builds and fingerprints authority. */
  id: string
  /** Stable across assistant/run streaming; title summarizes the first prompt. */
  titleId: string
  phase: ComposerContinuationPhase
  roundState: ComposerContinuationRoundState
  hasUserRequest: boolean
  hasSettledAssistant: boolean
  titleNeedsProposal: boolean
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Cheap renderer invalidation only. This intentionally authorizes nothing:
 * `continuation:propose` re-reads the canonical ChatRecord and builds the
 * bounded semantic evidence snapshot in main.
 */
export function buildComposerContinuationCheckpoint(
  chat: ChatRecord | null | undefined
): ComposerContinuationCheckpoint | null {
  if (!chat) return null
  const roundState = roundStateFromChat(chat)
  const userMessages = (chat.messages || []).filter(
    (message) => message.role === 'user' && Boolean(message.content?.trim())
  )
  const assistantMessages = (chat.messages || []).filter(
    (message) => message.role === 'assistant' && Boolean(message.content?.trim())
  )
  const goal = chat.activeGoal
  const titleSource = chat.threadTitle?.source
  const titleNeedsProposal =
    userMessages.length > 0 && titleSource !== 'user' && titleSource !== 'local-ai'
  const versionMaterial = JSON.stringify({
    chatId: chat.appChatId,
    user: userMessages.map((message) => [message.id, message.content]),
    assistant: assistantMessages.slice(-4).map((message) => [message.id, message.content]),
    goal: goal
      ? [
          goal.id,
          goal.status,
          goal.objectiveSource,
          goal.objective,
          goal.specification?.sourceMessageId,
          goal.specification?.acceptanceCriteria
        ]
      : null,
    todos: Object.entries(chat.chatTodos || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([lane, items]) => [
        lane,
        (items || []).map((item) => [item.id, item.content, item.status, item.goalId])
      ]),
    runs: (chat.runs || [])
      .slice(-8)
      .map((run) => [
        run.runId,
        run.promptMessageId,
        run.status,
        run.endedAt,
        run.warnings?.map((warning) => warning.message),
        run.runDiff
          ? [
              ...run.runDiff.createdFiles,
              ...run.runDiff.modifiedFiles,
              ...run.runDiff.deletedFiles
            ].map((file) => [file.path, file.status])
          : null
      ]),
    round: chat.ensemble?.activeRound
      ? [
          chat.ensemble.activeRound.roundId,
          chat.ensemble.activeRound.status,
          chat.ensemble.activeRound.participants.map((participant) => [
            participant.participantId,
            participant.status
          ])
        ]
      : null,
    summary: chat.ensemble?.lastRoundSummary,
    roster: (chat.ensemble?.participants || []).map((participant) => [
      participant.id,
      participant.enabled,
      participant.role,
      participant.provider,
      participant.model,
      participant.stageRole,
      participant.order
    ]),
    title: [chat.title, chat.threadTitle]
  })
  return {
    schemaVersion: 2,
    id: `continuation-v2:${stableHash(versionMaterial)}`,
    titleId: `continuation-title-v1:${stableHash(
      JSON.stringify({
        chatId: chat.appChatId,
        firstUser: userMessages[0] ? [userMessages[0].id, userMessages[0].content] : null,
        title: [chat.title, chat.threadTitle]
      })
    )}`,
    phase:
      goal?.status === 'completed'
        ? 'complete'
        : roundState === 'all-failed' || goal?.status === 'blocked'
          ? 'blocked'
          : goal?.status === 'active'
            ? 'working'
            : 'none',
    roundState,
    hasUserRequest: userMessages.length > 0,
    hasSettledAssistant: assistantMessages.length > 0,
    titleNeedsProposal
  }
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
