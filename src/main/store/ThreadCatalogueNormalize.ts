import { stripExternalProviderThreadImportContinuity } from '../../shared/externalProviderThreadImport'
import { normalizeEnsembleAuthority } from '../../shared/ensembleAuthority'
import { canonicalizeExternalPathGrantMetadata } from './ExternalPathGrants'
import { normalizeChatWorkflowMode } from './slices/workflowNormalizers'
import { createDefaultEnsembleConfig } from '../EnsembleDefaults'
import { discardForeignEnsembleTurnTransition } from '../EnsembleRuntimeIdentity'
import { resolveActiveGoalForEnsemble } from '../GoalState'
import type { ChatRecord, ProviderId, SideChatLifecycleState } from './types'

function normalizeSideChatLifecycleState(
  value: unknown,
  fallback: SideChatLifecycleState
): SideChatLifecycleState {
  if (value === 'active' || value === 'closed' || value === 'terminated') return value
  return fallback
}

/** Shared record normalization for main and the history reader worker. */
export function normalizeCatalogueChatRecord(
  chat: ChatRecord,
  getDefaultProvider: () => ProviderId | undefined,
  runtimeInstanceId?: string
): ChatRecord {
  chat = stripExternalProviderThreadImportContinuity(chat)
  if (!Array.isArray(chat.messages)) {
    throw new Error('Invalid chat messages: expected an array')
  }
  if (chat.runs !== undefined && !Array.isArray(chat.runs)) {
    throw new Error('Invalid chat runs: expected an array')
  }
  // Host/TUI drafts historically omitted runs and creation time. The Desktop
  // full-record contract requires arrays even before the first run. Keep an
  // unknown historical creation time at zero rather than inventing one.
  const requiredFields = {
    messages: chat.messages,
    runs: chat.runs ?? [],
    createdAt:
      typeof chat.createdAt === 'number' && Number.isFinite(chat.createdAt) && chat.createdAt >= 0
        ? chat.createdAt
        : 0
  }
  const scope = chat.scope === 'global' ? 'global' : 'workspace'
  const chatKind = chat.chatKind === 'ensemble' ? 'ensemble' : 'single'
  const workflowMode = normalizeChatWorkflowMode(chat.workflowMode)
  const parentChatRelation = chat.parentChatId
    ? chat.parentChatRelation === 'sideChat'
      ? 'sideChat'
      : 'subThread'
    : undefined
  const providerMetadata = chat.providerMetadata
    ? canonicalizeExternalPathGrantMetadata(chat.providerMetadata)
    : chat.providerMetadata
  const sideChatContext =
    parentChatRelation === 'sideChat'
      ? {
          createdAt:
            typeof chat.sideChatContext?.createdAt === 'number'
              ? chat.sideChatContext.createdAt
              : chat.createdAt || Date.now(),
          ...(chat.sideChatContext || {}),
          lifecycleState: normalizeSideChatLifecycleState(
            chat.sideChatContext?.lifecycleState,
            chat.archived ? 'terminated' : 'active'
          )
        }
      : chat.sideChatContext
  const ensemble =
    chatKind === 'ensemble'
      ? (() => {
          const defaults = createDefaultEnsembleConfig(chat.provider || getDefaultProvider())
          const stored = chat.ensemble
          const participants =
            Array.isArray(stored?.participants) && stored.participants.length > 0
              ? stored.participants
              : defaults.participants
          const authority = normalizeEnsembleAuthority({
            participants,
            bossmanParticipantId: stored?.bossmanParticipantId ?? defaults.bossmanParticipantId,
            captainParticipantIds:
              stored && Object.prototype.hasOwnProperty.call(stored, 'captainParticipantIds')
                ? stored.captainParticipantIds
                : stored
                  ? undefined
                  : defaults.captainParticipantIds,
            secondInCommandParticipantId:
              stored?.secondInCommandParticipantId ??
              (stored ? undefined : defaults.secondInCommandParticipantId)
          })
          const activeRound = stored?.activeRound
            ? (() => {
                const runtimeOwnedRound = discardForeignEnsembleTurnTransition(
                  stored.activeRound,
                  runtimeInstanceId
                )
                const roundAuthority = normalizeEnsembleAuthority({
                  participants: runtimeOwnedRound.participants.map((participant) => ({
                    id: participant.participantId,
                    order: participant.order
                  })),
                  bossmanParticipantId: runtimeOwnedRound.bossmanParticipantId,
                  captainParticipantIds: runtimeOwnedRound.captainParticipantIds,
                  secondInCommandParticipantId: runtimeOwnedRound.secondInCommandParticipantId
                })
                return {
                  ...runtimeOwnedRound,
                  bossmanParticipantId: roundAuthority.bossmanParticipantId,
                  captainParticipantIds: roundAuthority.captainParticipantIds,
                  secondInCommandParticipantId: roundAuthority.secondInCommandParticipantId
                }
              })()
            : undefined
          return {
            ...defaults,
            ...(stored || {}),
            participants,
            bossmanParticipantId: authority.bossmanParticipantId,
            captainParticipantIds: authority.captainParticipantIds,
            secondInCommandParticipantId: authority.secondInCommandParticipantId,
            ...(activeRound ? { activeRound } : {})
          }
        })()
      : undefined
  const activeGoal =
    chatKind === 'ensemble' ? resolveActiveGoalForEnsemble(chat.activeGoal) : chat.activeGoal
  if (scope === 'global') {
    const { workspaceId: _workspaceId, workspacePath: _workspacePath, ...rest } = chat
    return {
      ...rest,
      ...requiredFields,
      scope,
      chatKind,
      parentChatRelation,
      sideChatContext,
      workflowMode,
      ...(activeGoal ? { activeGoal } : {}),
      ...(ensemble ? { ensemble } : {}),
      providerMetadata
    }
  }
  return {
    ...chat,
    ...requiredFields,
    scope,
    chatKind,
    parentChatRelation,
    sideChatContext,
    workflowMode,
    ...(activeGoal ? { activeGoal } : {}),
    ...(ensemble ? { ensemble } : {}),
    providerMetadata,
    workspaceId: chat.workspaceId || '',
    workspacePath: chat.workspacePath || ''
  }
}
