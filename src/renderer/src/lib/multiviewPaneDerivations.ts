import type { ChatRecord, ProviderId } from '../../../main/store/types'
import { collectChatMediaRefs } from '../components/ChatMediaPanel'
import { buildChatTokenTally } from './threadTokenTally'
import { countMessagesWithPinnedMetadata } from './pinnedMessages'
import { deriveChatRunCompleteNotice } from './chatRunDisplay'
import { isEnsembleActiveRoundDispatchLive } from './chatBusyState'
import { estimateLiveOutputTokensFromChars } from './liveOutputTokens'
import { createChatWalkCache, noWalkDepsEqual } from './chatWalkCache'
import {
  isContextWindowProviderId,
  resolveContextWindow,
  formatContextTokens
} from './contextWindows'
import {
  buildParticipantContextRows,
  contextPercent,
  currentContextTokenLimit,
  currentContextUsage,
  liveOutputTokensForParticipant,
  type ContextMeterModel
} from './contextMeter'
import type { RendererProviderRates } from './providerRateEstimate'

interface PaneLiveOutputDeps {
  isRunning: boolean
  runId: string | null
}

export interface PaneContextTelemetryDeps {
  provider: ProviderId
  modelId?: string
  focusedParticipantId?: string
  liveOutputTokens: number
  isRunning: boolean
  resolveOllamaContextLength: (modelId?: string | null) => number | undefined
}

export interface PaneContextTelemetry {
  usedPercent: number
  label: string
  meter: ContextMeterModel
}

/**
 * Count only output that still belongs to the pane's live run or live
 * ensemble round. Completed-run transcript content must not inflate the
 * in-flight context estimate.
 */
export function derivePaneLiveOutputTokens(chat: ChatRecord, deps: PaneLiveOutputDeps): number {
  if (!deps.isRunning) return 0
  const activeRunIds = new Set(
    (chat.runs || [])
      .filter((run) => !run.endedAt || run.status === 'running' || run.status === 'queued')
      .map((run) => run.runId)
      .filter((runId): runId is string => Boolean(runId))
  )
  if (activeRunIds.size === 0 && deps.runId) {
    activeRunIds.add(deps.runId)
  }
  const activeRoundStartedAt = isEnsembleActiveRoundDispatchLive(chat.ensemble?.activeRound)
    ? Date.parse(chat.ensemble!.activeRound!.startedAt || '')
    : Number.NaN
  let liveChars = 0
  for (const message of chat.messages || []) {
    if (message.role !== 'assistant') continue
    if (message.runId && activeRunIds.has(message.runId)) {
      liveChars += message.content?.length || 0
      continue
    }
    if (Number.isFinite(activeRoundStartedAt)) {
      const messageTime = Date.parse(message.timestamp || '')
      if (Number.isFinite(messageTime) && messageTime >= activeRoundStartedAt) {
        liveChars += message.content?.length || 0
      }
    }
  }
  return estimateLiveOutputTokensFromChars(liveChars)
}

export function derivePaneContextTelemetry(
  chat: ChatRecord,
  deps: PaneContextTelemetryDeps
): PaneContextTelemetry {
  const fallbackUsage = currentContextUsage(chat.runs || [], {
    liveOutputTokens: deps.liveOutputTokens,
    isRunning: deps.isRunning,
    messages: chat.messages || []
  })
  const liveOllamaContextLength =
    deps.provider === 'ollama' ? deps.resolveOllamaContextLength(deps.modelId) : undefined
  const fallbackWindowTokens = resolveContextWindow(
    isContextWindowProviderId(deps.provider) ? deps.provider : undefined,
    deps.modelId,
    currentContextTokenLimit(chat.runs || []),
    liveOllamaContextLength
  )
  const liveParticipantId =
    deps.isRunning && isEnsembleActiveRoundDispatchLive(chat.ensemble?.activeRound)
      ? chat.ensemble?.activeRound?.activeParticipantId
      : undefined
  const participantRows =
    chat.chatKind === 'ensemble'
      ? buildParticipantContextRows(chat.runs || [], chat.ensemble?.participants || [], {
          participantId: liveParticipantId,
          outputTokens: liveOutputTokensForParticipant(
            chat.runs || [],
            chat.messages || [],
            liveParticipantId,
            estimateLiveOutputTokensFromChars
          ),
          resolveWindowTokens: (participant) =>
            participant.provider === 'ollama'
              ? deps.resolveOllamaContextLength(participant.model)
              : undefined,
          messages: chat.messages || []
        })
      : undefined
  const focusedRow = participantRows?.find((row) => row.id === deps.focusedParticipantId)
  const usage = focusedRow ? focusedRow.usage : fallbackUsage
  const usedTokens = focusedRow?.usedTokens ?? fallbackUsage?.contextTokens ?? 0
  const windowTokens = focusedRow?.windowTokens ?? fallbackWindowTokens
  const usedPercent = focusedRow?.percent ?? contextPercent(usedTokens, windowTokens)
  const displayProvider = focusedRow?.provider ?? deps.provider
  const displayModelId = focusedRow?.modelId ?? deps.modelId

  return {
    usedPercent,
    label: `${formatContextTokens(usedTokens)} / ${formatContextTokens(windowTokens)} context`,
    meter: {
      solo: {
        id: 'solo',
        provider: displayProvider,
        modelId: displayModelId,
        usedTokens,
        windowTokens,
        percent: usedPercent,
        ...(usage ? { usage } : {})
      },
      participants: participantRows,
      focusedId: focusedRow?.id
    }
  }
}

export const cachedPaneTokenTally = createChatWalkCache(
  (chat, deps: { providerRates: RendererProviderRates }) =>
    buildChatTokenTally(chat.runs || [], { providerRates: deps.providerRates }),
  (a, b) => a.providerRates === b.providerRates
)

export const cachedPanePinnedCount = createChatWalkCache(
  (chat) => countMessagesWithPinnedMetadata(chat.messages),
  noWalkDepsEqual
)

export const cachedPaneMediaRefs = createChatWalkCache(
  (chat, deps: { attachments: Parameters<typeof collectChatMediaRefs>[1] }) =>
    collectChatMediaRefs(chat, deps.attachments, []),
  (a, b) => a.attachments === b.attachments
)

export const cachedPaneRunCompleteNotice = createChatWalkCache(
  (chat, deps: { isRunning: boolean }) => deriveChatRunCompleteNotice(chat, deps.isRunning),
  (a, b) => a.isRunning === b.isRunning
)

export const cachedPaneLiveOutputTokens = createChatWalkCache(
  derivePaneLiveOutputTokens,
  (a, b) => a.isRunning === b.isRunning && a.runId === b.runId
)

export const cachedPaneContextTelemetry = createChatWalkCache(
  derivePaneContextTelemetry,
  (a, b) =>
    a.provider === b.provider &&
    a.modelId === b.modelId &&
    a.focusedParticipantId === b.focusedParticipantId &&
    a.liveOutputTokens === b.liveOutputTokens &&
    a.isRunning === b.isRunning &&
    a.resolveOllamaContextLength === b.resolveOllamaContextLength
)
