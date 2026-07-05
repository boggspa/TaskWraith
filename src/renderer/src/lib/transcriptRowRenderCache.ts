import type { ChatMessage, ChatRecord, ChatRun, ProviderId } from '../../../main/store/types'

export interface TranscriptRowRenderSignature {
  rowKey: string
  message: ChatMessage
  messageSignature: string
  boundaryRun?: ChatRun
  chatSignature: string
  providerLabel: string
  provider: ProviderId
  workspacePath?: string
  compactDensity: boolean
  liveActivityViewport?: boolean
  virtualized: boolean
  isGlobal?: boolean
  sideChatSeed: boolean
  highlighted: boolean
  copied: boolean
  pinned: boolean
  feedbackVote: 'up' | 'down' | null
  expandedUser: boolean
  activityExpansionKey: string
  subThreadExpanded: boolean
  fanoutExpanded: boolean
  pendingPlanChoiceKey: string
  pendingAgentQuestionsKey: string
  assistantRunModelKey: string
  renameContinuityKey: string
  auxiliaryKey: string
  revealKey: string
  callbackRefs: readonly unknown[]
}

function stableJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value) || ''
  } catch {
    return String(value)
  }
}

export function transcriptChatRenderSignature(chat: ChatRecord | null | undefined): string {
  if (!chat) return ''
  const participants =
    chat.ensemble?.participants?.map((participant) => ({
      id: participant.id,
      role: participant.role,
      provider: participant.provider,
      model: participant.model,
      pooledAgentId: participant.pooledAgentId,
      pooledAgentIdentity: participant.pooledAgentIdentity || null
    })) || []
  return stableJson({
    appChatId: chat.appChatId,
    chatKind: chat.chatKind,
    provider: chat.provider,
    scope: chat.scope,
    workspacePath: chat.workspacePath,
    agentIdentities: chat.providerMetadata?.agentIdentities || null,
    pooledAgentId: chat.providerMetadata?.pooledAgentId || null,
    pooledAgentIdentity: chat.providerMetadata?.pooledAgentIdentity || null,
    participants
  })
}

export function transcriptMessageRenderSignature(message: ChatMessage): string {
  return stableJson(message)
}

export function transcriptRowRenderSignatureEqual(
  prev: TranscriptRowRenderSignature,
  next: TranscriptRowRenderSignature
): boolean {
  if (prev.rowKey !== next.rowKey) return false
  if (prev.messageSignature !== next.messageSignature) return false
  if (prev.boundaryRun !== next.boundaryRun) return false
  if (prev.chatSignature !== next.chatSignature) return false
  if (prev.providerLabel !== next.providerLabel) return false
  if (prev.provider !== next.provider) return false
  if (prev.workspacePath !== next.workspacePath) return false
  if (prev.compactDensity !== next.compactDensity) return false
  if (prev.liveActivityViewport !== next.liveActivityViewport) return false
  if (prev.virtualized !== next.virtualized) return false
  if (prev.isGlobal !== next.isGlobal) return false
  if (prev.sideChatSeed !== next.sideChatSeed) return false
  if (prev.highlighted !== next.highlighted) return false
  if (prev.copied !== next.copied) return false
  if (prev.pinned !== next.pinned) return false
  if (prev.feedbackVote !== next.feedbackVote) return false
  if (prev.expandedUser !== next.expandedUser) return false
  if (prev.activityExpansionKey !== next.activityExpansionKey) return false
  if (prev.subThreadExpanded !== next.subThreadExpanded) return false
  if (prev.fanoutExpanded !== next.fanoutExpanded) return false
  if (prev.pendingPlanChoiceKey !== next.pendingPlanChoiceKey) return false
  if (prev.pendingAgentQuestionsKey !== next.pendingAgentQuestionsKey) return false
  if (prev.assistantRunModelKey !== next.assistantRunModelKey) return false
  if (prev.renameContinuityKey !== next.renameContinuityKey) return false
  if (prev.auxiliaryKey !== next.auxiliaryKey) return false
  if (prev.revealKey !== next.revealKey) return false
  if (prev.callbackRefs.length !== next.callbackRefs.length) return false
  for (let i = 0; i < prev.callbackRefs.length; i += 1) {
    if (prev.callbackRefs[i] !== next.callbackRefs[i]) return false
  }
  return true
}
