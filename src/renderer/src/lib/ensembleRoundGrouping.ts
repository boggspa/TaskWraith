import type { ChatMessage, ChatRecord } from '../../../main/store/types'

/**
 * 1.0.4-AV1 — Round-as-card transcript grouping.
 *
 * Pre-AV1 the Ensemble transcript was a flat list of bubbles
 * (user prompt → participant A turn → participant B turn → ...)
 * which made long sessions hard to scan. AT8 added a synthesizer
 * summary per round; AV1 builds on that by grouping messages
 * into "round cards" the renderer can render collapsed-by-default
 * with the synthesizer summary as the header.
 *
 * This module is the DATA LAYER — a pure grouping pass over a
 * chat's message list that splits sequential round messages
 * into groups, leaving non-ensemble or unclassified messages
 * inline. The renderer integration (a `<EnsembleRoundCard>`
 * wrapper component + a transcript-renderer hook) ships
 * separately in 1.0.5 since the transcript renderer is
 * intentionally a single high-test-coverage surface and a
 * staged rollout avoids regressing the existing message-bubble
 * paths.
 *
 * Why ship the data layer in 1.0.4 anyway: the grouping rules
 * MUST agree with how the orchestrator stamps messages, and
 * landing it here together pins the contract. A future renderer
 * change is then a single-file integration that imports this
 * helper.
 *
 * Grouping rule:
 *   - A message belongs to a "round group" if its
 *     `metadata.ensembleRoundId` is set.
 *   - Sequential messages with the SAME `ensembleRoundId` form
 *     one group. A different roundId (or a missing roundId)
 *     opens a new entry — group breaks happen at the round
 *     boundary.
 *   - Non-ensemble chats fall through to a flat list (every
 *     message is a single-entry "message" item).
 *
 * Why we don't merge non-sequential same-id messages: a future
 * Steer/Resume could in principle re-open an earlier round.
 * Treating non-adjacent same-id messages as one group would
 * silently merge them with whatever happened in between, which
 * is the wrong default for a visual transcript.
 */

export interface FlatMessageItem {
  type: 'message'
  message: ChatMessage
}

export interface RoundGroupItem {
  type: 'round-group'
  /** Round id stamped on every message in the group. */
  roundId: string
  /** Messages in the group, in the order they appear in the
   * source chat. The first message is typically the
   * `ensembleRoundPrompt` user message; subsequent ones are
   * the participant turns + status messages. */
  messages: ChatMessage[]
  /** Convenience read of the synthesizer summary that pairs
   * with this round, if available on the chat. The renderer
   * uses this as the card header. `null` when no summary
   * exists yet (round in flight, no synthesizer configured,
   * or AT8's orchestrator capture hasn't fired). */
  summary: string | null
}

export type EnsembleTranscriptItem = FlatMessageItem | RoundGroupItem

export function groupEnsembleMessagesByRound(
  chat: ChatRecord | null | undefined
): EnsembleTranscriptItem[] {
  if (!chat || chat.chatKind !== 'ensemble') {
    // Non-ensemble: every message is its own flat item. Keeps
    // the renderer iteration shape identical to the pre-AV1
    // chat.messages.map path.
    return (chat?.messages || []).map((message) => ({ type: 'message' as const, message }))
  }

  const items: EnsembleTranscriptItem[] = []
  const messages = chat.messages || []
  let i = 0
  while (i < messages.length) {
    const message = messages[i]
    const roundId = extractRoundId(message)
    if (!roundId) {
      items.push({ type: 'message', message })
      i += 1
      continue
    }
    // Collect a run of consecutive messages with the same
    // roundId. Adjacency only — a roundId change ends the
    // group; non-adjacent same-id messages would start a new
    // group entry. An UNSTAMPED `agentQuestionReply` row is
    // adopted into the open group: historical reply writers
    // never stamped `ensembleRoundId`, and without adoption the
    // reply splits its round into two headers with the naked
    // answer bubble floating between them. The reply answers a
    // question asked in this round, so it belongs to it.
    const group: ChatMessage[] = []
    while (
      i < messages.length &&
      (extractRoundId(messages[i]) === roundId || isAdoptableQuestionReply(messages[i]))
    ) {
      group.push(messages[i])
      i += 1
    }
    items.push({
      type: 'round-group',
      roundId,
      messages: group,
      // The synthesizer summary lives on `chat.ensemble.lastRoundSummary`.
      // For the MOST RECENT completed round, this is the summary; for
      // older rounds we don't yet persist per-round summaries (1.0.5
      // follow-up), so they get `null`. Renderer falls back to a
      // generic "Round" header.
      summary: pickRoundSummary(chat, roundId)
    })
  }
  return items
}

function extractRoundId(message: ChatMessage): string | null {
  const metadata = message.metadata as Record<string, unknown> | undefined
  const value = metadata?.ensembleRoundId
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Unstamped answer row eligible for adoption into the open round group. */
function isAdoptableQuestionReply(message: ChatMessage): boolean {
  return message.metadata?.kind === 'agentQuestionReply' && !extractRoundId(message)
}

function pickRoundSummary(chat: ChatRecord, roundId: string): string | null {
  const ensemble = chat.ensemble
  if (!ensemble) return null
  const historical = ensemble.roundSummaries?.[roundId]?.summary
  if (typeof historical === 'string' && historical.trim()) {
    return historical.trim()
  }
  const activeRoundId = ensemble.activeRound?.roundId
  if (activeRoundId === roundId && typeof ensemble.lastRoundSummary === 'string') {
    return ensemble.lastRoundSummary.trim() || null
  }
  return null
}
