import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { groupEnsembleMessagesByRound } from './ensembleRoundGrouping'

/**
 * 1.0.5 — Round-as-card renderer integration (the follow-up promised by
 * `ensembleRoundGrouping.ts`). That module is the pure DATA LAYER; this
 * one is the pure RENDER-PLAN layer that sits between it and the
 * transcript renderer.
 *
 * The transcript renderer (`TranscriptPanel`) is virtualised + row-cached
 * off a single FLAT `ChatMessage[]`. Rather than teach virtualization
 * about nested round containers (which would touch every height/measure
 * path), we keep the flat-array contract and express round cards AS
 * messages:
 *
 *   - A synthetic `role: 'system'` "round header" message is injected
 *     before each COMPLETED round's body. It carries everything the
 *     header card needs in `metadata.ensembleRoundHeader`.
 *   - When a round is collapsed, its body messages are dropped from the
 *     list entirely (only the header remains). Expanding re-inserts them.
 *
 * Because the output is still a flat `ChatMessage[]`, the virtualiser,
 * row cache, run-boundary map, and user gutter all keep working unchanged.
 *
 * Active-round handling: the round currently being produced
 * (`chat.ensemble.activeRound.roundId`) is rendered FLAT with no header —
 * it stays fully visible while it streams, so live output is never hidden
 * behind a collapsed card. Only completed rounds become cards.
 *
 * Default collapse: when there is no active round the most-recent round
 * stays expanded; every older round collapses. While a round is active,
 * all completed rounds collapse. The user can override any completed
 * round via `manualRoundExpansion`.
 */

export const ENSEMBLE_ROUND_HEADER_KIND = 'ensembleRoundHeader'

export interface EnsembleRoundHeaderData {
  roundId: string
  /** 1-based index of this round among all rounds in the chat. */
  roundIndex: number
  /** Total number of rounds in the chat. */
  roundCount: number
  /** Whether the round body is currently shown. */
  expanded: boolean
  /** Distinct participant providers that spoke in the round, in order. */
  providers: string[]
  /** Distinct participant roles that spoke in the round, in order. */
  roles: string[]
  /** Count of body messages in the round (excludes the round prompt). */
  bodyMessageCount: number
  /** Synthesizer summary for the round, when available. */
  summary: string | null
  /** First line of the round's user prompt, for the collapsed preview. */
  promptPreview: string | null
}

export function ensembleRoundHeaderId(roundId: string): string {
  return `ensemble-round-header-${roundId}`
}

export function isEnsembleRoundHeaderMessage(message: ChatMessage | null | undefined): boolean {
  return Boolean(
    message && message.role === 'system' && message.metadata?.kind === ENSEMBLE_ROUND_HEADER_KIND
  )
}

export function readEnsembleRoundHeader(
  message: ChatMessage | null | undefined
): EnsembleRoundHeaderData | null {
  if (!isEnsembleRoundHeaderMessage(message)) return null
  const data = message?.metadata?.ensembleRoundHeader
  return data && typeof data === 'object' ? (data as EnsembleRoundHeaderData) : null
}

function metaString(message: ChatMessage, key: string): string | null {
  const value = message.metadata?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isRoundPrompt(message: ChatMessage): boolean {
  return message.metadata?.kind === 'ensembleRoundPrompt' || message.role === 'user'
}

function collectAttribution(messages: ChatMessage[]): { providers: string[]; roles: string[] } {
  const providers: string[] = []
  const roles: string[] = []
  for (const message of messages) {
    const provider = metaString(message, 'ensembleProvider')
    if (provider && !providers.includes(provider)) providers.push(provider)
    const role = metaString(message, 'ensembleRole')
    if (role && !roles.includes(role)) roles.push(role)
  }
  return { providers, roles }
}

function firstPromptPreview(messages: ChatMessage[]): string | null {
  const prompt = messages.find((message) => isRoundPrompt(message))
  const text = (prompt?.content || '').trim()
  if (!text) return null
  const firstLine =
    text
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? text
  return firstLine.length > 160 ? `${firstLine.slice(0, 159)}\u2026` : firstLine
}

function buildRoundHeaderMessage(args: {
  roundId: string
  roundIndex: number
  roundCount: number
  expanded: boolean
  messages: ChatMessage[]
  summary: string | null
}): ChatMessage {
  const { roundId, roundIndex, roundCount, expanded, messages, summary } = args
  const { providers, roles } = collectAttribution(messages)
  const bodyMessageCount = messages.filter((message) => !isRoundPrompt(message)).length
  const data: EnsembleRoundHeaderData = {
    roundId,
    roundIndex,
    roundCount,
    expanded,
    providers,
    roles,
    bodyMessageCount,
    summary: summary && summary.trim() ? summary.trim() : null,
    promptPreview: firstPromptPreview(messages)
  }
  return {
    id: ensembleRoundHeaderId(roundId),
    role: 'system',
    content: '',
    timestamp: messages[0]?.timestamp ?? '',
    metadata: {
      kind: ENSEMBLE_ROUND_HEADER_KIND,
      ensembleRoundId: roundId,
      ensembleRoundHeader: data
    }
  }
}

export interface BuildEnsembleRoundCardRowsInput {
  chat: ChatRecord | null | undefined
  /** Post tool-grouping flat message list the renderer would otherwise map. */
  displayMessages: ChatMessage[]
  /** Settings → General: when false, render the flat transcript unchanged. */
  collapseOlderRounds: boolean
  /** Per-round manual expand/collapse overrides (true = expanded). */
  manualRoundExpansion: ReadonlyMap<string, boolean>
}

/**
 * Transform the flat display list into a round-card render plan. Returns
 * the input array unchanged (same reference) when the feature is off or
 * the chat is not an ensemble, so non-ensemble transcripts keep their
 * exact pre-existing render path + referential stability.
 */
export function buildEnsembleRoundCardRows(input: BuildEnsembleRoundCardRowsInput): ChatMessage[] {
  const { chat, displayMessages, collapseOlderRounds, manualRoundExpansion } = input
  if (!chat || chat.chatKind !== 'ensemble' || !collapseOlderRounds) {
    return displayMessages
  }

  const items = groupEnsembleMessagesByRound({ ...chat, messages: displayMessages })
  const roundItems = items.filter(
    (item): item is Extract<typeof item, { type: 'round-group' }> => item.type === 'round-group'
  )
  if (roundItems.length === 0) return displayMessages

  const roundCount = roundItems.length
  const lastRoundId = roundItems[roundItems.length - 1].roundId
  const activeRoundId = chat.ensemble?.activeRound?.roundId ?? null
  const hasActiveRound = activeRoundId !== null

  const out: ChatMessage[] = []
  let roundIndex = 0
  for (const item of items) {
    if (item.type === 'message') {
      out.push(item.message)
      continue
    }
    roundIndex += 1
    const { roundId, messages, summary } = item

    // The active round is always rendered flat so streaming output is
    // never hidden behind a collapsed card.
    if (hasActiveRound && roundId === activeRoundId) {
      for (const message of messages) out.push(message)
      continue
    }

    const defaultExpanded = !hasActiveRound && roundId === lastRoundId
    const override = manualRoundExpansion.get(roundId)
    const expanded = override === undefined ? defaultExpanded : override

    out.push(
      buildRoundHeaderMessage({ roundId, roundIndex, roundCount, expanded, messages, summary })
    )
    if (expanded) {
      for (const message of messages) out.push(message)
    }
  }
  return out
}
