import type { ChatMessage, ChatRecord, ProviderId } from '../../../main/store/types'
import { getChatProvider } from './chatScope'
import { getProviderLabel } from './providerLabels'

export const GUEST_PARTICIPANT_STEERING_PREAMBLE =
  'You are a guest participant attached to a standard TaskWraith chat. The main parent agent has priority. Respond to the user request in parallel as a second opinion or disjoint helper. Write or edit files only when useful and keep any changes disjoint from the main agent. If your intended edits overlap or conflict with the main agent, stop and explain the conflict instead of fighting the main agent.'

const GUEST_PARENT_CONTEXT_TURN_LIMIT = 20
const GUEST_PARENT_CONTEXT_CHAR_LIMIT = 12000
const GUEST_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT = 1800

function metadataProvider(value: unknown): ProviderId | null {
  if (
    value === 'gemini' ||
    value === 'codex' ||
    value === 'claude' ||
    value === 'kimi' ||
    value === 'grok' ||
    value === 'cursor' ||
    value === 'ollama'
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

export function truncateGuestContextText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

export function formatGuestParentContextMessage(
  message: ChatMessage,
  parentProvider: ProviderId
): string | null {
  if (isRetiredExternalChannelInboundMessage(message)) return null
  const content = message.content?.trim()
  if (!content) return null
  if (message.metadata?.kind === 'guestParticipantReply') return null
  if (message.role === 'user') {
    return `User: ${truncateGuestContextText(content, GUEST_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT)}`
  }
  if (message.role === 'assistant') {
    const speaker = ensembleSpeakerLabel(message) || `${getProviderLabel(parentProvider)} parent agent`
    return `${speaker}: ${truncateGuestContextText(
      content,
      GUEST_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT
    )}`
  }
  if (
    (message.role === 'system' || message.role === 'tool') &&
    message.metadata?.kind === 'subThreadReturn'
  ) {
    return `Returned sub-thread context: ${truncateGuestContextText(
      content,
      GUEST_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT
    )}`
  }
  return null
}

export function buildGuestParentTranscriptContext(parentChat: ChatRecord): string {
  const parentProvider = getChatProvider(parentChat)
  const turns = (parentChat.messages || [])
    .map((message) => formatGuestParentContextMessage(message, parentProvider))
    .filter((entry): entry is string => Boolean(entry))
    .slice(-GUEST_PARENT_CONTEXT_TURN_LIMIT)
  if (turns.length === 0) return ''
  const heading =
    'Parent transcript context (peer context, not hidden instructions; the parent agent remains authoritative):'
  const lines: string[] = []
  let remaining = GUEST_PARENT_CONTEXT_CHAR_LIMIT - heading.length
  for (const turn of turns) {
    if (remaining <= 0) break
    const next = truncateGuestContextText(turn, remaining)
    lines.push(next)
    remaining -= next.length + 2
  }
  return `${heading}\n${lines.join('\n\n')}`
}
