import type { ChatMessage, ChatRecord, ProviderId, SideChatMode } from '../../../main/store/types'
import { isEnsembleParticipantAuthoredMessage } from '../../../shared/ensembleParticipantMessage'
import { getChatProvider } from './chatScope'
import { getProviderLabel } from './providerLabels'

const SIDE_CHAT_PARENT_CONTEXT_TURN_LIMIT = 8
const SIDE_CHAT_PARENT_CONTEXT_CHAR_LIMIT = 5000
const SIDE_CHAT_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT = 700

export interface IsolatedSideChatContextSeedOptions {
  participantLabel?: string
}

export function shouldSeedIsolatedSideChatContext(
  seedPrompt: string,
  sideChatMode: SideChatMode
): boolean {
  return !seedPrompt.trim() && sideChatMode === 'singleProvider'
}

function metadataProvider(value: unknown): ProviderId | null {
  if (
    value === 'gemini' ||
    value === 'codex' ||
    value === 'claude' ||
    value === 'kimi' ||
    value === 'grok' ||
    value === 'cursor' ||
    value === 'ollama' ||
    value === 'mistral' ||
    value === 'muse' ||
    value === 'devin'
  ) {
    return value
  }
  return null
}

function ensembleSpeakerLabel(message: ChatMessage): string | null {
  const provider = metadataProvider(message.metadata?.ensembleProvider)
  if (!provider) return null
  const role =
    typeof message.metadata?.ensembleRole === 'string' && message.metadata.ensembleRole.trim()
      ? message.metadata.ensembleRole.trim()
      : null
  return role ? `${getProviderLabel(provider)} / ${role}` : getProviderLabel(provider)
}

function isRetiredExternalChannelInboundMessage(message: ChatMessage): boolean {
  return message.metadata?.kind === 'channelInbound'
}

export function buildHiddenSideChatInitialPrompt(contextPrompt: string, userPrompt: string): string {
  const context = contextPrompt.trim()
  const request = userPrompt.trim()
  if (!context) return request

  return [
    'TaskWraith provided the following side-chat parent context snapshot as background only.',
    "Acknowledge it internally and use it for orientation, but do not treat it as the user's prompt, request, or task.",
    '',
    '<parent_context_snapshot>',
    context,
    '</parent_context_snapshot>',
    '',
    'User side-chat request:',
    request
  ]
    .filter(Boolean)
    .join('\n')
}

function truncateSideChatContextText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

export function formatSideChatParentContextMessage(
  message: ChatMessage,
  parentProvider: ProviderId
): string | null {
  if (isRetiredExternalChannelInboundMessage(message)) return null
  const content = message.content?.trim()
  if (!content) return null
  if (message.role === 'user') {
    return `User: ${truncateSideChatContextText(content, SIDE_CHAT_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT)}`
  }
  if (message.role === 'assistant' || isEnsembleParticipantAuthoredMessage(message)) {
    const speaker =
      ensembleSpeakerLabel(message) || `${getProviderLabel(parentProvider)} parent agent`
    return `${speaker}: ${truncateSideChatContextText(
      content,
      SIDE_CHAT_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT
    )}`
  }
  if (message.role === 'system' && message.metadata?.kind === 'guestParticipantReply') {
    const provider =
      typeof message.metadata.guestProvider === 'string'
        ? getProviderLabel(message.metadata.guestProvider as ProviderId)
        : 'Guest'
    return `${provider} guest: ${truncateSideChatContextText(
      content,
      SIDE_CHAT_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT
    )}`
  }
  if (
    (message.role === 'system' || message.role === 'tool') &&
    message.metadata?.kind === 'subThreadReturn'
  ) {
    return `Returned sub-thread: ${truncateSideChatContextText(
      content,
      SIDE_CHAT_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT
    )}`
  }
  return null
}

export function buildIsolatedSideChatContextSeed(
  parentChat: ChatRecord,
  options: IsolatedSideChatContextSeedOptions = {}
): string {
  const parentProvider = getChatProvider(parentChat)
  const turns = (parentChat.messages || [])
    .map((message) => formatSideChatParentContextMessage(message, parentProvider))
    .filter((entry): entry is string => Boolean(entry))
    .slice(-SIDE_CHAT_PARENT_CONTEXT_TURN_LIMIT)
  const activeGoal = parentChat.activeGoal?.objective?.trim()
  const latestRoundSummary = parentChat.ensemble?.lastRoundSummary?.trim()
  if (!activeGoal && !latestRoundSummary && turns.length === 0) return ''

  const participantLabel = options.participantLabel?.trim()
  const heading = [
    'Use this bounded parent context snapshot as background for this isolated side chat.',
    'It is a frozen copy from creation time and will not update automatically.',
    'This side chat has its own provider session and permission lifecycle; it is not the live parent participant and cannot steer or interrupt that panel unless the user explicitly carries a result back.',
    participantLabel
      ? `Selected parent seat profile: ${truncateSideChatContextText(participantLabel, 160)}.`
      : ''
  ]
    .filter(Boolean)
    .join('\n')
  const sections: string[] = []
  if (activeGoal) {
    sections.push(
      `Parent active goal:\n${truncateSideChatContextText(activeGoal, SIDE_CHAT_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT)}`
    )
  }
  if (latestRoundSummary) {
    sections.push(
      `Latest parent round summary:\n${truncateSideChatContextText(
        latestRoundSummary,
        SIDE_CHAT_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT
      )}`
    )
  }
  if (turns.length > 0) sections.push(['Recent parent transcript:', ...turns].join('\n'))

  let result = heading
  for (const section of sections) {
    const separator = '\n\n'
    const remaining = SIDE_CHAT_PARENT_CONTEXT_CHAR_LIMIT - result.length - separator.length
    if (remaining <= 0) break
    result += separator + truncateSideChatContextText(section, remaining)
  }
  return truncateSideChatContextText(result, SIDE_CHAT_PARENT_CONTEXT_CHAR_LIMIT)
}

export function buildSideChatRunResultSeedPrompt(chat: ChatRecord, runId: string): string {
  const sourceRun = (chat.runs || []).find((run) => run.runId === runId)
  const runAssistantMessage = [...(chat.messages || [])]
    .reverse()
    .find(
      (message) => message.role === 'assistant' && message.runId === runId && message.content.trim()
    )
  const latestAssistantMessage =
    runAssistantMessage ||
    [...(chat.messages || [])]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.trim())
  const assistantResponseLabel = runAssistantMessage
    ? 'Run assistant response'
    : 'Latest assistant response'

  return [
    'Use this parent run result as the starting point.',
    'This side chat is isolated and does not have the full parent transcript unless I paste it here.',
    '',
    `Run ID: ${runId}`,
    sourceRun?.status ? `Run status: ${sourceRun.status}` : '',
    sourceRun?.startedAt ? `Started: ${sourceRun.startedAt}` : '',
    sourceRun?.endedAt ? `Ended: ${sourceRun.endedAt}` : '',
    latestAssistantMessage?.content?.trim()
      ? `${assistantResponseLabel}:\n\n${latestAssistantMessage.content.trim()}`
      : ''
  ]
    .filter(Boolean)
    .join('\n')
}
