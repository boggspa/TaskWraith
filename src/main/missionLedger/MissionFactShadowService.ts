import type {
  ActiveGoal,
  ChatMessage,
  ChatRecord,
  WorkspaceBoardCard,
  WorkspaceBoardDefinition,
  WorkspaceBoardProvenance
} from '../store/types'
import {
  MissionFactLedgerCorruptError,
  type MissionFactInput,
  type MissionFactPayload,
  type MissionFactReplay,
  type MissionFactRecord,
  type MissionPlanState
} from './MissionFactLedger'
import {
  deriveLegacyBoardMissionFactBatch,
  deriveLegacyMissionFactBatch,
  missionWorkItemStatusFromLegacyBoardColumn,
  type LegacyBoardMissionSnapshot,
  type LegacyPlanMissionObservation
} from './LegacyMissionFactReconciler'

export interface MissionFactLedgerPort {
  read(missionId: string): MissionFactReplay
  append(input: MissionFactInput, options?: { expectedLastSequence?: number }): MissionFactRecord
}

export interface MissionFactShadowObservationReport {
  readonly missionId?: string
  readonly surface: 'chat' | 'board'
  readonly appendedKinds: readonly MissionFactPayload['kind'][]
  readonly lastSequence: number
  readonly skippedReason?: 'no-active-goal' | 'mission-unresolved' | 'uncorrelated-board'
}

export interface WorkspaceBoardShadowObservationInput {
  readonly board: WorkspaceBoardDefinition
  /** Prior board identity when the board-level provenance itself changed. */
  readonly previousBoard?: WorkspaceBoardDefinition
  readonly cards: readonly WorkspaceBoardCard[]
  /** Cards removed by the just-committed mutation. They identify which mission
   * owns a now-empty board scope and supply deletion provenance. */
  readonly removedCards?: readonly WorkspaceBoardCard[]
  readonly resolveChatById: (chatId: string) => ChatRecord | null | undefined
  readonly resolveChatByMissionId?: (missionId: string) => ChatRecord | null | undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function timestampMs(value: string | undefined): number | null {
  const ms = Date.parse(value || '')
  return Number.isFinite(ms) ? ms : null
}

function activeGoalReason(goal: ActiveGoal): string | undefined {
  if (goal.status === 'blocked') return goal.blockedReason || goal.lastStatusReason
  if (goal.status === 'completed') return goal.completedSummary || goal.lastStatusReason
  if (goal.status === 'paused') return goal.lastStatusReason
  return undefined
}

function latestPlanObservation(
  chat: ChatRecord,
  goal: ActiveGoal
): LegacyPlanMissionObservation | undefined {
  const goalCreatedMs = timestampMs(goal.createdAt)
  let latest:
    | {
        message: ChatMessage
        plan: MissionPlanState
        messageMs: number
      }
    | undefined
  for (const message of chat.messages || []) {
    if (message.role !== 'assistant') continue
    const metadata = message.metadata as Record<string, unknown> | undefined
    const rawPlan = metadata?.proposedPlan as Record<string, unknown> | undefined
    if (!rawPlan) continue
    const title = stringValue(rawPlan.title)
    const body = stringValue(rawPlan.body)
    const status = rawPlan.status
    const messageMs = timestampMs(message.timestamp)
    if (
      !title ||
      !body ||
      (status !== 'pending' && status !== 'approved' && status !== 'dismissed') ||
      messageMs === null ||
      (goalCreatedMs !== null && messageMs < goalCreatedMs)
    ) {
      continue
    }
    if (!latest || messageMs >= latest.messageMs) {
      const artifactPath = stringValue(rawPlan.artifactPath)
      latest = {
        message,
        messageMs,
        plan: {
          planId: message.id,
          title,
          body,
          status,
          ...(artifactPath ? { artifactPath } : {})
        }
      }
    }
  }
  if (!latest) return undefined
  const run = latest.message.runId
    ? chat.runs.find((candidate) => candidate.runId === latest?.message.runId)
    : undefined
  const metadata = latest.message.metadata as Record<string, unknown> | undefined
  return {
    state: 'present',
    plan: latest.plan,
    observedAt: latest.message.timestamp,
    provenance: {
      actor: latest.plan.status === 'pending' ? 'agent' : 'user',
      chatId: chat.appChatId,
      ...(chat.workspaceId ? { workspaceId: chat.workspaceId } : {}),
      ...(latest.message.runId ? { runId: latest.message.runId } : {}),
      ...(stringValue(metadata?.ensembleParticipantId)
        ? { participantId: stringValue(metadata?.ensembleParticipantId) }
        : run?.ensembleParticipantId
          ? { participantId: run.ensembleParticipantId }
          : {}),
      ...(stringValue(metadata?.ensembleRoundId)
        ? { roundId: stringValue(metadata?.ensembleRoundId) }
        : run?.ensembleRoundId
          ? { roundId: run.ensembleRoundId }
          : {}),
      ...(run?.provider ? { provider: run.provider } : {})
    }
  }
}

function provenanceFromBoard(
  provenance: WorkspaceBoardProvenance | undefined,
  fallback: { workspaceId?: string; chatId?: string }
) {
  return {
    actor: provenance?.actor || ('system' as const),
    ...(fallback.chatId ? { chatId: fallback.chatId } : {}),
    ...(fallback.workspaceId ? { workspaceId: fallback.workspaceId } : {}),
    ...(provenance?.runId ? { runId: provenance.runId } : {}),
    ...(provenance?.provider ? { provider: provenance.provider } : {})
  }
}

function newestAt(values: readonly (string | undefined)[], fallback: string): string {
  let winner = fallback
  let winnerMs = timestampMs(fallback) ?? 0
  for (const value of values) {
    const ms = timestampMs(value)
    if (value && ms !== null && ms >= winnerMs) {
      winner = value
      winnerMs = ms
    }
  }
  return winner
}

interface CorrelatedBoardCard {
  readonly card: WorkspaceBoardCard
  readonly missionId: string
  readonly chat?: ChatRecord
}

export class MissionFactShadowService {
  constructor(private readonly repository: MissionFactLedgerPort) {}

  observeChatTransition(
    previous: ChatRecord | null | undefined,
    next: ChatRecord
  ): MissionFactShadowObservationReport[] {
    const reports: MissionFactShadowObservationReport[] = []
    const priorGoal = previous?.activeGoal
    if (priorGoal && priorGoal.id !== next.activeGoal?.id) {
      let replay = this.requireValidReplay(priorGoal.id)
      if (!replay.projection && previous) {
        reports.push(this.observeChat(previous))
        replay = this.requireValidReplay(priorGoal.id)
      }
      if (
        replay.projection &&
        replay.projection.status !== 'completed' &&
        replay.projection.status !== 'cancelled' &&
        replay.projection.status !== 'failed'
      ) {
        const observedAt = Number.isFinite(next.updatedAt)
          ? new Date(next.updatedAt).toISOString()
          : new Date().toISOString()
        reports.push(
          this.appendBatch('chat', priorGoal.id, replay, [
            {
              missionId: priorGoal.id,
              timestamp: observedAt,
              provenance: {
                surface: 'goal',
                actor: 'system',
                sourceId: priorGoal.id,
                chatId: next.appChatId,
                ...(next.workspaceId ? { workspaceId: next.workspaceId } : {})
              },
              payload: {
                kind: 'mission_status_set',
                status: 'cancelled',
                reason: 'Legacy active goal was cleared or replaced.'
              }
            }
          ])
        )
      }
    }
    reports.push(this.observeChat(next))
    return reports
  }

  observeChat(chat: ChatRecord): MissionFactShadowObservationReport {
    const goal = chat.activeGoal
    if (!goal) {
      return {
        surface: 'chat',
        appendedKinds: [],
        lastSequence: 0,
        skippedReason: 'no-active-goal'
      }
    }
    const replay = this.requireValidReplay(goal.id)
    const batch = deriveLegacyMissionFactBatch(replay.projection, {
      goal: {
        missionId: goal.id,
        objective: goal.objective,
        status: goal.status,
        reason: activeGoalReason(goal),
        observedAt: goal.updatedAt,
        provenance: {
          actor:
            goal.objectiveSource === 'user'
              ? 'user'
              : goal.objectiveSource === 'agent'
                ? 'agent'
                : 'system',
          chatId: chat.appChatId,
          ...(chat.workspaceId ? { workspaceId: chat.workspaceId } : {}),
          ...(chat.ensemble?.activeRound?.roundId
            ? { roundId: chat.ensemble.activeRound.roundId }
            : {}),
          provider: goal.provider
        },
        statusProvenance: {
          actor: 'system',
          chatId: chat.appChatId,
          ...(chat.workspaceId ? { workspaceId: chat.workspaceId } : {}),
          ...(chat.ensemble?.activeRound?.roundId
            ? { roundId: chat.ensemble.activeRound.roundId }
            : {}),
          provider: goal.provider
        }
      },
      plan: latestPlanObservation(chat, goal)
    })
    return this.appendBatch('chat', goal.id, replay, batch)
  }

  observeWorkspaceBoard(
    input: WorkspaceBoardShadowObservationInput
  ): MissionFactShadowObservationReport[] {
    const current = input.cards
      .map((card) => this.correlateBoardCard(input.board, card, input.resolveChatById))
      .filter((item): item is CorrelatedBoardCard => Boolean(item))
    const previousBoard = input.previousBoard || input.board
    const removed = [...(input.previousBoard ? input.cards : []), ...(input.removedCards || [])]
      .map((card) => this.correlateBoardCard(previousBoard, card, input.resolveChatById))
      .filter((item): item is CorrelatedBoardCard => Boolean(item))
    const missionIds = [...new Set([...current, ...removed].map((item) => item.missionId))].sort()
    if (missionIds.length === 0) {
      return [
        {
          surface: 'board',
          appendedKinds: [],
          lastSequence: 0,
          skippedReason: 'uncorrelated-board'
        }
      ]
    }

    const reports: MissionFactShadowObservationReport[] = []
    for (const missionId of missionIds) {
      const relatedCurrent = current.filter((item) => item.missionId === missionId)
      const relatedRemoved = removed.filter((item) => item.missionId === missionId)
      let replay = this.requireValidReplay(missionId)
      if (!replay.projection) {
        const chat =
          relatedCurrent.find((item) => item.chat)?.chat ||
          relatedRemoved.find((item) => item.chat)?.chat ||
          input.resolveChatByMissionId?.(missionId)
        if (chat?.activeGoal?.id === missionId) {
          this.observeChat(chat)
          replay = this.requireValidReplay(missionId)
        }
      }
      if (!replay.projection) {
        reports.push({
          missionId,
          surface: 'board',
          appendedKinds: [],
          lastSequence: 0,
          skippedReason: 'mission-unresolved'
        })
        continue
      }

      const removalProvenance = [...relatedRemoved].sort((left, right) =>
        right.card.updatedAt.localeCompare(left.card.updatedAt)
      )[0]?.card.provenance
      const boardSnapshot: LegacyBoardMissionSnapshot = {
        boardId: input.board.id,
        observedAt: newestAt(
          [...relatedCurrent, ...relatedRemoved].map((item) => item.card.updatedAt),
          input.board.updatedAt
        ),
        provenance: provenanceFromBoard(removalProvenance || input.board.provenance, {
          workspaceId: input.board.workspaceId
        }),
        items: relatedCurrent.map(({ card, chat }) => ({
          item: {
            workItemId: card.id,
            title: card.title,
            status: card.archived
              ? 'archived'
              : missionWorkItemStatusFromLegacyBoardColumn(card.columnId),
            ...(card.body ? { body: card.body } : {}),
            ...(card.blockedReason ? { blockedReason: card.blockedReason } : {}),
            ...(card.nextStep ? { nextStep: card.nextStep } : {}),
            sortOrder: card.sortOrder
          },
          observedAt: card.updatedAt,
          provenance: provenanceFromBoard(card.provenance, {
            workspaceId: card.workspaceId,
            chatId: chat?.appChatId
          })
        }))
      }
      const batch = deriveLegacyBoardMissionFactBatch(replay.projection, missionId, [boardSnapshot])
      reports.push(this.appendBatch('board', missionId, replay, batch))
    }
    return reports
  }

  private appendBatch(
    surface: MissionFactShadowObservationReport['surface'],
    missionId: string,
    replay: MissionFactReplay,
    batch: readonly MissionFactInput[]
  ): MissionFactShadowObservationReport {
    let lastSequence = replay.projection?.lastSequence ?? 0
    const appendedKinds: MissionFactPayload['kind'][] = []
    for (const input of batch) {
      const record = this.repository.append(input, { expectedLastSequence: lastSequence })
      lastSequence = record.sequence
      appendedKinds.push(record.payload.kind)
    }
    return { missionId, surface, appendedKinds, lastSequence }
  }

  private requireValidReplay(missionId: string): MissionFactReplay {
    const replay = this.repository.read(missionId)
    if (!replay.valid) throw new MissionFactLedgerCorruptError(missionId, replay.diagnostics)
    return replay
  }

  private correlateBoardCard(
    board: WorkspaceBoardDefinition,
    card: WorkspaceBoardCard,
    resolveChatById: (chatId: string) => ChatRecord | null | undefined
  ): CorrelatedBoardCard | null {
    if (card.provenance?.sourceKind === 'goal' && card.provenance.sourceId) {
      return { card, missionId: card.provenance.sourceId }
    }
    const chatId =
      card.link?.kind === 'chat'
        ? card.link.id
        : card.provenance?.sourceKind === 'thread'
          ? card.provenance.sourceId
          : board.provenance?.sourceKind === 'thread'
            ? board.provenance.sourceId
            : undefined
    const chat = chatId ? resolveChatById(chatId) : undefined
    if (chat?.activeGoal?.id) return { card, missionId: chat.activeGoal.id, chat }
    if (board.provenance?.sourceKind === 'goal' && board.provenance.sourceId) {
      return { card, missionId: board.provenance.sourceId }
    }
    return null
  }
}
