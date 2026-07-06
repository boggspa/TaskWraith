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

const MESSAGE_SIGNATURE_SAMPLE_CHARS = 384

function sampledTextSignature(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  const sample =
    value.length > MESSAGE_SIGNATURE_SAMPLE_CHARS * 2
      ? `${value.slice(0, MESSAGE_SIGNATURE_SAMPLE_CHARS)}\u0000${value.slice(-MESSAGE_SIGNATURE_SAMPLE_CHARS)}`
      : value
  let hash = 2166136261
  let newlines = 0
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index)
    hash ^= code
    hash = Math.imul(hash, 16777619)
    if (code === 10) newlines += 1
  }
  return `${value.length}:${newlines}:${(hash >>> 0).toString(36)}`
}

function primitiveSignature(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return sampledTextSignature(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return sampledTextSignature(stableJson(value).slice(0, MESSAGE_SIGNATURE_SAMPLE_CHARS * 2))
}

function metadataRenderSignature(message: ChatMessage): string {
  const metadata = message.metadata
  if (!metadata) return ''
  const pooledIdentity = metadata.pooledAgentIdentity as
    | { agentId?: unknown; nickname?: unknown; iconKind?: unknown; hue?: unknown }
    | undefined
  return [
    metadata.kind,
    metadata.subThreadId,
    metadata.subThreadProvider,
    metadata.subThreadTitle,
    metadata.parentProvider,
    metadata.delegationPromptPreview,
    primitiveSignature(metadata.delegationPrompt),
    metadata.returnResultToParent,
    metadata.ensembleLaneId,
    metadata.ensembleLaneIntent,
    metadata.ensembleProvider,
    metadata.ensembleRole,
    metadata.ensembleModel,
    metadata.ensembleOrder,
    metadata.guestChatId,
    metadata.guestProvider,
    metadata.guestModel,
    metadata.guestRole,
    metadata.parentChatId,
    metadata.pinnedAt,
    metadata.feedback?.vote,
    metadata.feedback?.reason,
    primitiveSignature(metadata.feedback?.note),
    metadata.proposedPlan?.title,
    primitiveSignature(metadata.proposedPlan?.body),
    metadata.proposedPlan?.status,
    metadata.proposedPlan?.artifactPath,
    metadata.pollId,
    metadata.pooledAgentId,
    pooledIdentity?.agentId,
    pooledIdentity?.nickname,
    pooledIdentity?.iconKind,
    pooledIdentity?.hue,
    Array.isArray(metadata.groupedFanoutMessageIds) ? metadata.groupedFanoutMessageIds.length : '',
    Array.isArray(metadata.groupedToolMessageIds) ? metadata.groupedToolMessageIds.length : '',
    Array.isArray(metadata.ensembleFanoutTranscriptParts)
      ? metadata.ensembleFanoutTranscriptParts.length
      : '',
    Array.isArray(metadata.mediaRefs)
      ? metadata.mediaRefs
          .map(
            (ref: any) =>
              `${ref?.id || ''}:${ref?.mimeType || ''}:${ref?.width || ''}:${ref?.height || ''}`
          )
          .join('|')
      : '',
    Array.isArray(metadata.imagePaths) ? metadata.imagePaths.join('|') : '',
    Array.isArray(metadata.imageThumbnails)
      ? metadata.imageThumbnails
          .map((thumb: any) => `${thumb?.mimeType || ''}:${thumb?.dataBase64?.length || 0}`)
          .join('|')
      : ''
  ].join('\u0001')
}

function diffSummarySignature(diffSummary: any): string {
  if (!diffSummary || typeof diffSummary !== 'object') return ''
  const files = Array.isArray(diffSummary.files) ? diffSummary.files : []
  return [
    diffSummary.additions,
    diffSummary.deletions,
    files.length,
    files
      .slice(0, 16)
      .map(
        (file: any) =>
          `${file?.path || ''}:${file?.status || ''}:${file?.additions ?? ''}:${file?.deletions ?? ''}`
      )
      .join('|')
  ].join(':')
}

function toolActivitySignature(
  activity: NonNullable<ChatMessage['toolActivities']>[number]
): string {
  return [
    activity.id,
    activity.toolName,
    activity.displayName,
    activity.category,
    activity.status,
    activity.startedAt,
    activity.endedAt,
    activity.durationMs,
    primitiveSignature(activity.resultSummary),
    primitiveSignature(activity.outputPreview),
    diffSummarySignature(activity.diffSummary),
    primitiveSignature(activity.parameters),
    activity.workflowSummary ? primitiveSignature(activity.workflowSummary) : '',
    activity.reviewSummary ? primitiveSignature(activity.reviewSummary) : '',
    activity.rawUseEvent ? 'raw-use' : '',
    activity.rawResultEvent ? 'raw-result' : ''
  ].join('\u0002')
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
  const activities = message.toolActivities || []
  return [
    message.id,
    message.role,
    message.timestamp,
    message.runId,
    sampledTextSignature(message.content),
    metadataRenderSignature(message),
    activities.length,
    activities.map(toolActivitySignature).join('\u0003')
  ].join('\u0001')
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
