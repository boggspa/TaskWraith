/**
 * Settled `ask_user_question` cards — the "tombstone" a question leaves behind
 * once it has been answered or skipped.
 *
 * WHY THIS EXISTS: the live `AgentQuestionCard` unmounts the moment the question
 * leaves `pendingAgentQuestions`, and the synthetic marker it was anchored to
 * carries only a generic header line as its `content` ("Codex asked you to pick
 * an option:"). The question text, its options and its context live in
 * `metadata` and were rendered by nothing. Worse, a marker that is no longer
 * pending satisfies `plainSystemNoticeMessage`, so the super-group fold swept
 * the whole exchange into a one-liner — "System · 2 system notices". The record
 * of what the agent asked and what the user chose disappeared.
 *
 * Nothing new is persisted for this: every field below already sits in
 * `chat.messages`, written at ask time and at answer time. This module only
 * reads it back.
 *
 * Pure on purpose — the component graph is not importable from lib tests.
 */

import type { ChatMessage } from '../../../main/store/types'

export type AgentQuestionOutcome = 'answered' | 'skipped'

export interface AgentQuestionTombstone {
  questionId: string
  question: string
  context?: string
  options: string[]
  /** The chosen option, or the free text the user typed. Absent when skipped. */
  answer?: string
  /** True when the answer was typed rather than picked, so the card can show it
   *  as its own line instead of hunting for a matching option. */
  isCustomAnswer: boolean
  outcome: AgentQuestionOutcome
  askedAt?: string
  answeredAt?: string
  /** Transcript id of the user-reply row this tombstone now speaks for, so the
   *  caller can stop rendering it twice. Absent when skipped. */
  replyMessageId?: string
}

export function isAgentQuestionMarker(msg: ChatMessage): boolean {
  return msg.role === 'system' && msg.metadata?.kind === 'agentQuestion'
}

export function isAgentQuestionReply(msg: ChatMessage): boolean {
  return msg.metadata?.kind === 'agentQuestionReply'
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * Index replies by the marker they answered.
 *
 * Keyed on `respondedToMessageId` with `questionId` as the fallback, because the
 * former is what the reply writer stamps but older rows may only carry the
 * latter. Last write wins: a duplicate reply id cannot exist (the append is
 * idempotent on message id), so a collision would only ever be a re-send.
 */
export function indexAgentQuestionReplies(
  messages: readonly ChatMessage[]
): Map<string, ChatMessage> {
  const byMarker = new Map<string, ChatMessage>()
  for (const msg of messages) {
    if (!isAgentQuestionReply(msg)) continue
    const marker = stringOrUndefined(msg.metadata?.respondedToMessageId)
    if (marker) byMarker.set(marker, msg)
    const questionId = stringOrUndefined(msg.metadata?.questionId)
    // Also key on `agent-question-<id>`, the marker id shape the writer uses, so
    // a reply that predates `respondedToMessageId` still resolves.
    if (questionId) byMarker.set(`agent-question-${questionId}`, msg)
  }
  return byMarker
}

/**
 * Build the settled card for a marker. Returns null when this is not a question
 * marker at all.
 *
 * The caller must NOT call this for a question that is still pending — the live
 * card owns that state, and a tombstone rendered alongside it would offer a
 * frozen copy of a question the user can still answer.
 */
export function buildAgentQuestionTombstone(
  marker: ChatMessage,
  repliesByMarkerId: ReadonlyMap<string, ChatMessage>
): AgentQuestionTombstone | null {
  if (!isAgentQuestionMarker(marker)) return null
  const metadata = marker.metadata || {}
  const question = stringOrUndefined(metadata.agentQuestion)
  // No question text means a marker from a build that predates it being
  // stamped. Falling back to the header line is better than an empty card,
  // because the header at least names who asked.
  const resolvedQuestion = question || stringOrUndefined(marker.content) || 'Question'
  const rawOptions = metadata.agentQuestionOptions
  const options = Array.isArray(rawOptions)
    ? rawOptions.filter((option): option is string => typeof option === 'string')
    : []
  const reply = repliesByMarkerId.get(marker.id)
  const answer = reply ? stringOrUndefined(reply.content) : undefined

  return {
    questionId: stringOrUndefined(metadata.questionId) || marker.id,
    question: resolvedQuestion,
    ...(stringOrUndefined(metadata.agentQuestionContext)
      ? { context: stringOrUndefined(metadata.agentQuestionContext) }
      : {}),
    options,
    ...(answer ? { answer } : {}),
    // A typed answer that happens to equal an option is still treated as
    // custom only if the writer said so — the flag is authoritative.
    isCustomAnswer: reply?.metadata?.isCustomAnswer === true,
    // Skipped covers BOTH dismissal and the 24-minute timeout. Neither appends
    // a message, so they are indistinguishable here, and both mean the same
    // thing to the reader: no answer reached the agent.
    outcome: answer ? 'answered' : 'skipped',
    ...(stringOrUndefined(marker.timestamp) ? { askedAt: marker.timestamp } : {}),
    ...(reply && stringOrUndefined(reply.timestamp) ? { answeredAt: reply.timestamp } : {}),
    ...(reply ? { replyMessageId: reply.id } : {})
  }
}

/**
 * Reply rows now spoken for by a tombstone, so the transcript can stop
 * rendering the answer twice.
 *
 * `pendingMarkerIds` is excluded deliberately: while a question is still open
 * there is no tombstone to carry the answer, so nothing may be suppressed.
 */
export function suppressedAgentQuestionReplyIds(
  messages: readonly ChatMessage[],
  pendingMarkerIds: ReadonlySet<string>
): Set<string> {
  const suppressed = new Set<string>()
  const replies = indexAgentQuestionReplies(messages)
  for (const msg of messages) {
    if (!isAgentQuestionMarker(msg)) continue
    if (pendingMarkerIds.has(msg.id)) continue
    const reply = replies.get(msg.id)
    if (reply) suppressed.add(reply.id)
  }
  return suppressed
}

/** Row-cache signature contribution. Any field the card renders has to appear
 *  here or the cached element outlives a change to it. */
export function agentQuestionTombstoneKey(
  tombstone: AgentQuestionTombstone | null,
  suppressedReply: boolean
): string {
  if (!tombstone) return suppressedReply ? 'reply-hidden' : ''
  return [
    tombstone.outcome,
    tombstone.answer ?? '',
    tombstone.isCustomAnswer ? 'custom' : 'preset',
    tombstone.options.join('\u001f'),
    suppressedReply ? 'hidden' : 'shown'
  ].join('|')
}
