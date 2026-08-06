/**
 * The two durable transcript rows an `ask_user_question` leaves behind: the
 * `agentQuestion` marker (what was asked) and the `agentQuestionReply` row
 * (what the user chose). Together they are the whole input to
 * `buildAgentQuestionTombstone` — the settled card in the transcript.
 *
 * WHY MAIN HAS TO WRITE THESE. The marker used to be renderer-only
 * (`App.tsx onAgentQuestionRequested`), and `agentQuestionMarkerAnchor.ts` says
 * as much: "Main never learns about it". While the question is PENDING that is
 * survivable, because `anchorPendingAgentQuestionMarkers` re-appends the marker
 * from the live ref on every merge — which is why the live card always looked
 * fine. The moment the user answers, the question stops being pending, the
 * rescue stops, and the next authoritative `chat-updated` from main (which
 * never carried the marker) drops it. With no marker there is no tombstone, so
 * the entire question-and-answer record vanished from the transcript.
 *
 * MEASURED on the owner's real chats, 2026-08-06: two ensemble transcripts held
 * eleven `agentQuestionReply` rows between them and NOT ONE marker, while solo
 * chats kept both. Every one of those replies was also missing its
 * `ensembleRoundId` — the renderer stamps that off the marker, so its absence
 * is the marker already being gone at answer time. Under fan-out main flushes
 * once per lane, so the renderer's 200ms debounced `saveChat` essentially never
 * won that race.
 *
 * Main is the store, so a row it writes cannot lose that race. These builders
 * are pure and shared so the behaviour is testable without booting Electron,
 * and they reuse the ids the renderer's writers already use, which keeps both
 * sides idempotent against each other.
 */

import type { ChatMessage, ProviderId } from '../main/store/types'
import { getProviderLabel } from './providerLabels'

/** The fields of a pending question the transcript rows are built from — the
 *  subset of `RemoteQuestionRecord` that survives into the chat. */
export interface AgentQuestionTranscriptRecord {
  questionId: string
  question: string
  options?: string[]
  context?: string
  provider?: ProviderId
  /** ISO ask time. Becomes the marker's timestamp, so the settled card can
   *  report when the question was put to the user. */
  createdAt: string
}

export interface AgentQuestionReplyInput {
  questionId: string
  answer: string
  isCustom: boolean
  /** ISO answer time. Becomes the reply's timestamp and, through it, the
   *  `answeredAt` stamp the settled card prefers. */
  answeredAt: string
}

export function agentQuestionMarkerId(questionId: string): string {
  return `agent-question-${questionId}`
}

export function agentQuestionReplyId(questionId: string): string {
  return `agent-question-reply-${questionId}`
}

/** The marker's one-line body. Only a fallback for the settled card (which
 *  reads `metadata.agentQuestion`), but it is what the row itself reads as
 *  before the card mounts, so it stays identical to the renderer's wording. */
export function agentQuestionHeaderLine(
  provider: ProviderId | undefined,
  hasOptions: boolean
): string {
  return agentQuestionHeaderLineFor(provider ? getProviderLabel(provider) : 'Agent', hasOptions)
}

/**
 * The same line for an asker the writer could not name.
 *
 * Both writers know only the provider — neither is the orchestrator, so neither
 * holds the participant — which is why the stored line says "Claude asked you to
 * pick an option:" even in a fifty-seat round where six seats are Claude. The
 * transcript CAN resolve the seat (from the run behind the marker), so it
 * rebuilds the line naming it.
 *
 * Rebuilt from the same inputs rather than patched over the stored string: the
 * asker's name is interpolated into two different sentences, and string-matching
 * one of them back out is the kind of thing that silently stops working the day
 * the wording changes.
 */
export function agentQuestionHeaderLineFor(asker: string, hasOptions: boolean): string {
  return hasOptions ? `${asker} asked you to pick an option:` : `${asker} asked you a question:`
}

export function buildAgentQuestionMarkerMessage(input: {
  record: AgentQuestionTranscriptRecord
  runId?: string
  ensembleRoundId?: string | null
}): ChatMessage {
  const { record } = input
  const options = record.options?.length ? record.options : undefined
  return {
    id: agentQuestionMarkerId(record.questionId),
    role: 'system',
    content: agentQuestionHeaderLine(record.provider, Boolean(options)),
    timestamp: record.createdAt,
    ...(input.runId ? { runId: input.runId } : {}),
    metadata: {
      kind: 'agentQuestion',
      questionId: record.questionId,
      ...(record.provider ? { ensembleProvider: record.provider } : {}),
      agentQuestion: record.question,
      ...(options ? { agentQuestionOptions: options } : {}),
      ...(record.context ? { agentQuestionContext: record.context } : {}),
      // Round id ONLY. A fan-out lane's question is a round-level decision
      // record, and `ensembleLaneId`/`ensembleParticipantId` are exactly what
      // would sink it into the collapsible fan-out viewport instead — see the
      // pin in `ensembleFanoutViewportGroups.test.ts`.
      ...(input.ensembleRoundId ? { ensembleRoundId: input.ensembleRoundId } : {})
    }
  }
}

export function buildAgentQuestionReplyMessage(input: {
  reply: AgentQuestionReplyInput
  ensembleRoundId?: string | null
}): ChatMessage {
  const { reply } = input
  return {
    id: agentQuestionReplyId(reply.questionId),
    role: 'user',
    content: reply.answer,
    timestamp: reply.answeredAt,
    metadata: {
      kind: 'agentQuestionReply',
      questionId: reply.questionId,
      respondedToMessageId: agentQuestionMarkerId(reply.questionId),
      isCustomAnswer: reply.isCustom,
      // Inherited from the marker, never invented: an unstamped reply used to
      // split its round into two mislabelled headers.
      ...(input.ensembleRoundId ? { ensembleRoundId: input.ensembleRoundId } : {})
    }
  }
}

function roundIdOfMessage(message: ChatMessage | undefined): string | null {
  const value = message?.metadata?.ensembleRoundId
  return typeof value === 'string' && value ? value : null
}

/**
 * Append the marker, or return null when the row is already there.
 *
 * Null rather than the unchanged array on purpose: the caller has to decide
 * whether to save and broadcast, and "nothing changed" must not cost a write.
 */
export function appendAgentQuestionMarker(
  messages: readonly ChatMessage[],
  record: AgentQuestionTranscriptRecord,
  options: { runId?: string; ensembleRoundId?: string | null } = {}
): ChatMessage[] | null {
  const markerId = agentQuestionMarkerId(record.questionId)
  if (messages.some((message) => message.id === markerId)) return null
  return [
    ...messages,
    buildAgentQuestionMarkerMessage({
      record,
      ...(options.runId ? { runId: options.runId } : {}),
      ensembleRoundId: options.ensembleRoundId ?? null
    })
  ]
}

/**
 * Append the reply, or return null when it is already there.
 *
 * The round id is read back off the marker in `messages`, matching both
 * existing reply writers. A reply with no marker to inherit from is still
 * written — `groupEnsembleMessagesByRound` adopts unstamped replies into the
 * open round rather than letting the bare answer float between two headers.
 */
export function appendAgentQuestionReply(
  messages: readonly ChatMessage[],
  reply: AgentQuestionReplyInput
): ChatMessage[] | null {
  const replyId = agentQuestionReplyId(reply.questionId)
  if (messages.some((message) => message.id === replyId)) return null
  const markerId = agentQuestionMarkerId(reply.questionId)
  const marker = messages.find((message) => message.id === markerId)
  return [
    ...messages,
    buildAgentQuestionReplyMessage({ reply, ensembleRoundId: roundIdOfMessage(marker) })
  ]
}
