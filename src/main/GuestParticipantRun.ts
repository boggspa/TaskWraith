/**
 * Guest-participant turn dispatch — the SINGLE SOURCE shared by the
 * renderer (desktop sends) and the main-process bridge (iOS-origin sends).
 *
 * A solo chat may hold ONE `guestParticipant` (host + 1 guest). On a normal
 * send the host (parent agent) responds first; the guest then responds in
 * its child chat with the host's reply already in context (turn-based), and
 * its final reply is mirrored back into the parent transcript as a
 * `role:'system'` message with `metadata.kind:'guestParticipantReply'`.
 *
 * Before this module the trigger + mirror lived only in the renderer
 * (`App.tsx`), so iOS-origin turns — which run through the bridge's
 * `composerPromptFn`, never the renderer — never fired the guest. These
 * pure helpers let both paths build the guest prompt + the mirrored reply
 * identically. The provider-label function is injected so the module stays
 * free of any renderer/main label-resolution split.
 */

import type { ChatMessage, ChatRecord, ProviderId } from './store/types'

/** Injected provider → display label (renderer `getProviderLabel`, main
 * `providerLabel`). Cosmetic — it only labels the parent agent inside the
 * guest's context block. */
export type ProviderLabelFn = (provider: ProviderId) => string

export const GUEST_PARTICIPANT_STEERING_PREAMBLE =
  'You are a guest participant attached to a standard TaskWraith chat. The main parent agent has priority. Respond to the user request in parallel as a second opinion or disjoint helper. Write or edit files only when useful and keep any changes disjoint from the main agent. If your intended edits overlap or conflict with the main agent, stop and explain the conflict instead of fighting the main agent.'

const GUEST_PARENT_CONTEXT_TURN_LIMIT = 20
const GUEST_PARENT_CONTEXT_CHAR_LIMIT = 12000
const GUEST_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT = 1800

/** Provider stored on the chat record (mirror of the renderer's
 * `getChatProvider`); guest dispatch only ever sees real solo chats that
 * carry a provider, but default defensively. */
function chatProvider(chat: ChatRecord): ProviderId {
  return chat.provider || 'gemini'
}

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

function ensembleSpeakerLabel(
  message: ChatMessage,
  providerLabel: ProviderLabelFn
): string | null {
  const provider = metadataProvider(message.metadata?.ensembleProvider)
  if (!provider) return null
  const role =
    typeof message.metadata?.ensembleRole === 'string' && message.metadata.ensembleRole.trim()
      ? message.metadata.ensembleRole.trim()
      : null
  return role ? `${providerLabel(provider)} / ${role}` : providerLabel(provider)
}

export function truncateGuestContextText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

/** Render one parent-transcript message as a single peer-context line, or
 * null to skip it (empty, or a kind that shouldn't leak into guest context).
 * Prior guest replies are skipped so the guest never re-reads its own output
 * as if it were the parent's. */
export function formatGuestParentContextMessage(
  message: ChatMessage,
  parentProvider: ProviderId,
  providerLabel: ProviderLabelFn
): string | null {
  const content = message.content?.trim()
  if (!content) return null
  if (message.metadata?.kind === 'guestParticipantReply') return null
  if (message.role === 'user') {
    return `User: ${truncateGuestContextText(content, GUEST_PARENT_CONTEXT_MESSAGE_CHAR_LIMIT)}`
  }
  if (message.role === 'assistant') {
    const speaker =
      ensembleSpeakerLabel(message, providerLabel) || `${providerLabel(parentProvider)} parent agent`
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

/** The peer-context block handed to the guest: the tail of the parent
 * transcript (capped by turns + chars), labelled as peer context, never as
 * authoritative instructions. Empty string when there's nothing to show. */
export function buildGuestParentTranscriptContext(
  parentChat: ChatRecord,
  providerLabel: ProviderLabelFn
): string {
  const parentProvider = chatProvider(parentChat)
  const turns = (parentChat.messages || [])
    .map((message) => formatGuestParentContextMessage(message, parentProvider, providerLabel))
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

/** Compose the full guest prompt: steering preamble + parent-transcript peer
 * context (turn-based: when built after the host finalizes, this already
 * carries the host's reply) + the user's request. */
export function buildGuestParticipantPrompt(args: {
  parentChat: ChatRecord
  userText: string
  providerLabel: ProviderLabelFn
}): string {
  return [
    GUEST_PARTICIPANT_STEERING_PREAMBLE,
    buildGuestParentTranscriptContext(args.parentChat, args.providerLabel),
    `Current user request:\n${args.userText}`
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Build the parent-transcript mirror message for a finished guest run, or
 * null when the guest produced no content / the reply was already mirrored
 * (deduped by `guestRunId`). The shape matches the renderer's
 * `appendGuestParticipantReplyToParent` so projection/rendering is identical
 * on every surface. */
export function buildGuestParticipantReplyMessage(args: {
  parentChat: ChatRecord
  guestChatId: string
  runId: string
  provider: ProviderId
  model: string
  role: string
  content: string
}): ChatMessage | null {
  const trimmed = args.content.trim()
  if (!trimmed) return null
  const alreadyReturned = (args.parentChat.messages || []).some(
    (message) =>
      message.metadata?.kind === 'guestParticipantReply' &&
      message.metadata?.guestRunId === args.runId
  )
  if (alreadyReturned) return null
  return {
    id: `guest-return-${args.runId}`,
    role: 'system',
    content: trimmed,
    timestamp: new Date().toISOString(),
    runId: args.runId,
    metadata: {
      kind: 'guestParticipantReply',
      guestChatId: args.guestChatId,
      guestProvider: args.provider,
      guestModel: args.model,
      guestRole: args.role,
      guestRunId: args.runId,
      parentChatId: args.parentChat.appChatId
    }
  }
}
