import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { isEnsembleRoundDispatchLive } from '../../../shared/ensembleRoundLifecycle'
import { TASKWRAITH_CLOSEOUT_KIND } from '../../../shared/taskWraithCloseout'
import {
  MAX_CHAT_POPOUT_ROUND_EXPANSION_ENTRIES,
  normalizeChatPopoutRoundExpansion,
  type ChatPopoutRoundExpansionSnapshot
} from '../../../shared/chatPopoutTransfer'
import { groupEnsembleMessagesByRound } from './ensembleRoundGrouping'
import type { TranscriptGroupedMessageRange } from './transcriptToolMessageGrouping'

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
 * stays expanded until its TaskWraith close-out row exists; every older
 * or close-out-backed round collapses. While a round is active, all
 * completed rounds collapse. The user can override any completed round
 * via `manualRoundExpansion`.
 */

export const ENSEMBLE_ROUND_HEADER_KIND = 'ensembleRoundHeader'

export type RoundExpansionByChatId = ReadonlyMap<string, ReadonlyMap<string, boolean>>

// Session-only external store. TranscriptPanel intentionally swaps between
// separate welcome/transcript trees, so component-local state is destroyed by
// a chat -> welcome -> chat navigation. Keeping this tiny immutable snapshot
// outside either tree preserves reading context across those remounts and lets
// simultaneous transcript panes observe the same disclosure state.
let sessionRoundExpansionSnapshot: RoundExpansionByChatId = new Map()
const sessionRoundExpansionListeners = new Set<() => void>()

export function getSessionRoundExpansionSnapshot(): RoundExpansionByChatId {
  return sessionRoundExpansionSnapshot
}

export function subscribeSessionRoundExpansion(listener: () => void): () => void {
  sessionRoundExpansionListeners.add(listener)
  return () => sessionRoundExpansionListeners.delete(listener)
}

export function setSessionRoundExpanded(chatId: string, roundId: string, expanded: boolean): void {
  sessionRoundExpansionSnapshot = updateRoundExpansionForChat(
    sessionRoundExpansionSnapshot,
    chatId,
    roundId,
    expanded
  )
  for (const listener of sessionRoundExpansionListeners) listener()
}

export function captureSessionRoundExpansionForChat(
  chatId: string
): ChatPopoutRoundExpansionSnapshot {
  const entries = Array.from(sessionRoundExpansionSnapshot.get(chatId) ?? [])
  return entries
    .slice(-MAX_CHAT_POPOUT_ROUND_EXPANSION_ENTRIES)
    .map(([roundId, expanded]) => ({ roundId, expanded }))
}

export function hydrateSessionRoundExpansionForChat(chatId: string, value: unknown): boolean {
  const normalized = normalizeChatPopoutRoundExpansion(value)
  if (!normalized) return false
  const current = sessionRoundExpansionSnapshot.get(chatId)
  const currentEntries = Array.from(current ?? [])
  const unchanged =
    currentEntries.length === normalized.length &&
    normalized.every(
      (entry, index) =>
        currentEntries[index]?.[0] === entry.roundId &&
        currentEntries[index]?.[1] === entry.expanded
    )
  if (unchanged || (!current && normalized.length === 0)) return false

  const next = new Map(sessionRoundExpansionSnapshot)
  if (normalized.length === 0) {
    next.delete(chatId)
  } else {
    next.set(chatId, new Map(normalized.map((entry) => [entry.roundId, entry.expanded] as const)))
  }
  sessionRoundExpansionSnapshot = next
  for (const listener of sessionRoundExpansionListeners) listener()
  return true
}

export function roundExpansionForChat(
  expansionByChatId: RoundExpansionByChatId,
  chatId: string | null
): ReadonlyMap<string, boolean> {
  return (chatId ? expansionByChatId.get(chatId) : undefined) ?? new Map()
}

export function updateRoundExpansionForChat(
  expansionByChatId: RoundExpansionByChatId,
  chatId: string,
  roundId: string,
  expanded: boolean
): Map<string, ReadonlyMap<string, boolean>> {
  const next = new Map(expansionByChatId)
  const chatExpansion = new Map(next.get(chatId) ?? [])
  chatExpansion.set(roundId, expanded)
  next.set(chatId, chatExpansion)
  return next
}

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
  /** Model-aware participant attribution for brand-spoof accents. Optional so
   * synthetic headers restored from older renderer sessions still render. */
  attributions?: EnsembleRoundHeaderAttribution[]
  /** Count of body messages in the round (excludes the round prompt). */
  bodyMessageCount: number
  /** Synthesizer summary for the round, when available. */
  summary: string | null
  /** First line of the round's user prompt, for the collapsed preview. */
  promptPreview: string | null
}

export interface EnsembleRoundHeaderAttribution {
  participantId: string | null
  provider: string
  role: string | null
  model: string | null
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

function collectAttribution(messages: ChatMessage[]): {
  providers: string[]
  roles: string[]
  attributions: EnsembleRoundHeaderAttribution[]
} {
  const providers: string[] = []
  const roles: string[] = []
  const attributions: EnsembleRoundHeaderAttribution[] = []
  const attributionKeys = new Set<string>()
  for (const message of messages) {
    const provider = metaString(message, 'ensembleProvider')
    if (provider && !providers.includes(provider)) providers.push(provider)
    const role = metaString(message, 'ensembleRole')
    if (role && !roles.includes(role)) roles.push(role)
    if (provider) {
      const participantId = metaString(message, 'ensembleParticipantId')
      const model = metaString(message, 'ensembleModel')
      const attributionKey = participantId || `${provider}\u0000${role || ''}\u0000${model || ''}`
      if (!attributionKeys.has(attributionKey)) {
        attributionKeys.add(attributionKey)
        attributions.push({ participantId, provider, role, model })
      }
    }
  }
  return { providers, roles, attributions }
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
  const { providers, roles, attributions } = collectAttribution(messages)
  const bodyMessageCount = messages.filter((message) => !isRoundPrompt(message)).length
  const data: EnsembleRoundHeaderData = {
    roundId,
    roundIndex,
    roundCount,
    expanded,
    providers,
    roles,
    attributions,
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
  /**
   * Pane-level live run evidence. Used defensively when `activeRound` is stale
   * or missing after cancel/re-seat churn: the latest round must stay flat
   * while new output is live, even if the persisted round snapshot lags.
   */
  hasLiveRunEvidence?: boolean
}

/**
 * Transform the flat display list into a round-card render plan. Returns
 * the input array unchanged (same reference) when the feature is off or
 * the chat is not an ensemble, so non-ensemble transcripts keep their
 * exact pre-existing render path + referential stability.
 */
export function buildEnsembleRoundCardRows(input: BuildEnsembleRoundCardRowsInput): ChatMessage[] {
  const { chat, displayMessages, collapseOlderRounds } = input
  if (!chat || chat.chatKind !== 'ensemble' || !collapseOlderRounds) return displayMessages

  const ranges = buildEnsembleRoundCardRowsWithRanges(input)
  if (
    ranges.length === displayMessages.length &&
    ranges.every(
      (range, index) =>
        range.message === displayMessages[index] &&
        range.startIndex === index &&
        range.endIndex === index + 1
    )
  ) {
    return displayMessages
  }
  return ranges.map((range) => range.message)
}

export function buildEnsembleRoundCardRowsWithRanges(
  input: BuildEnsembleRoundCardRowsInput
): TranscriptGroupedMessageRange[] {
  const {
    chat,
    displayMessages,
    collapseOlderRounds,
    manualRoundExpansion,
    hasLiveRunEvidence = false
  } = input
  if (!chat || chat.chatKind !== 'ensemble' || !collapseOlderRounds) {
    return displayMessages.map((message, index) => ({
      message,
      startIndex: index,
      endIndex: index + 1
    }))
  }

  const items = groupEnsembleMessagesByRound({ ...chat, messages: displayMessages })
  const roundItems = items.filter(
    (item): item is Extract<typeof item, { type: 'round-group' }> => item.type === 'round-group'
  )
  if (roundItems.length === 0) {
    return displayMessages.map((message, index) => ({
      message,
      startIndex: index,
      endIndex: index + 1
    }))
  }

  const roundCount = roundItems.length
  const lastRoundId = roundItems[roundItems.length - 1].roundId
  const activeRound = chat.ensemble?.activeRound
  const activeRoundId = activeRound?.roundId ?? null
  const liveActiveRoundId =
    activeRoundId && isEnsembleRoundDispatchLive(activeRound) ? activeRoundId : null
  const liveFallbackRoundId = hasLiveRunEvidence ? lastRoundId : null
  const hasActiveRound = liveActiveRoundId !== null || liveFallbackRoundId !== null
  const closeoutRoundIds = new Set(
    displayMessages
      .map((message) =>
        message.metadata?.kind === TASKWRAITH_CLOSEOUT_KIND
          ? message.metadata.closeoutRoundId
          : null
      )
      .filter((roundId): roundId is string => typeof roundId === 'string' && roundId.length > 0)
  )

  const out: TranscriptGroupedMessageRange[] = []
  let roundIndex = 0
  let sourceIndex = 0
  for (const item of items) {
    if (item.type === 'message') {
      out.push({ message: item.message, startIndex: sourceIndex, endIndex: sourceIndex + 1 })
      sourceIndex += 1
      continue
    }
    roundIndex += 1
    const { roundId, messages, summary } = item
    const groupStartIndex = sourceIndex
    const groupEndIndex = sourceIndex + messages.length

    // The active round is always rendered flat so streaming output is
    // never hidden behind a collapsed card.
    if (roundId === liveActiveRoundId || roundId === liveFallbackRoundId) {
      for (let index = 0; index < messages.length; index += 1) {
        out.push({
          message: messages[index],
          startIndex: groupStartIndex + index,
          endIndex: groupStartIndex + index + 1
        })
      }
      sourceIndex = groupEndIndex
      continue
    }

    const defaultExpanded =
      !closeoutRoundIds.has(roundId) && !hasActiveRound && roundId === lastRoundId
    const override = manualRoundExpansion.get(roundId)
    const expanded = override === undefined ? defaultExpanded : override

    out.push({
      message: buildRoundHeaderMessage({
        roundId,
        roundIndex,
        roundCount,
        expanded,
        messages,
        summary
      }),
      startIndex: groupStartIndex,
      endIndex: groupEndIndex
    })
    if (expanded) {
      for (let index = 0; index < messages.length; index += 1) {
        out.push({
          message: messages[index],
          startIndex: groupStartIndex + index,
          endIndex: groupStartIndex + index + 1
        })
      }
    }
    sourceIndex = groupEndIndex
  }
  return out
}
