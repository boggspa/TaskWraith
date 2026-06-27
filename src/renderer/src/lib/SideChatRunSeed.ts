import type { ChatMessage, ChatRecord, ProviderId } from '../../../main/store/types'
import { getChatProvider } from './chatScope'
import { getProviderLabel } from './providerLabels'

const SIDE_CHAT_PARENT_CONTEXT_TURN_LIMIT = 8
const SIDE_CHAT_PARENT_CONTEXT_CHAR_LIMIT = 5000
const SIDE_CHAT_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT = 700

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
  const content = message.content?.trim()
  if (!content) return null
  if (message.role === 'user') {
    return `User: ${truncateSideChatContextText(content, SIDE_CHAT_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT)}`
  }
  if (message.role === 'assistant') {
    return `${getProviderLabel(parentProvider)} parent agent: ${truncateSideChatContextText(
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

export function buildIsolatedSideChatContextSeed(parentChat: ChatRecord): string {
  const parentProvider = getChatProvider(parentChat)
  const turns = (parentChat.messages || [])
    .map((message) => formatSideChatParentContextMessage(message, parentProvider))
    .filter((entry): entry is string => Boolean(entry))
    .slice(-SIDE_CHAT_PARENT_CONTEXT_TURN_LIMIT)
  if (turns.length === 0) return ''
  const heading =
    'Use this lightweight parent context snapshot as background for this isolated side chat. It was copied when the side chat was created and will not update automatically.'
  const lines: string[] = []
  let remaining = SIDE_CHAT_PARENT_CONTEXT_CHAR_LIMIT - heading.length
  for (const turn of turns) {
    if (remaining <= 0) break
    const next = truncateSideChatContextText(turn, remaining)
    lines.push(next)
    remaining -= next.length + 2
  }
  if (lines.length === 0) return ''
  return [heading, '', 'Parent context snapshot:', ...lines].join('\n')
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
