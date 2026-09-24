import type { ChatRecord, ChatRun, EnsembleRoundState } from '../../../main/store/types'
import {
  closeoutAiSummaryFromMetadata,
  taskWraithRoundCloseoutId,
  taskWraithRunCloseoutId
} from '../../../shared/taskWraithCloseout'
import { deriveChatRunCompleteNotice } from './chatRunDisplay'
import { shouldSuppressRunCompleteSummary } from './runCompleteNotice'
import {
  buildTaskWraithRoundCloseoutMessage,
  buildTaskWraithRunCloseoutMessage,
  isSameTaskWraithCloseout,
  upsertTaskWraithCloseoutMessage,
  type CloseoutAiSummary
} from './taskWraithCloseoutMessage'

/**
 * Close-out authoring for chats that finish while they are NOT the focused
 * chat — a resting Multiview pane. The focused close-out effect in App.tsx is
 * keyed to `currentChat` + the focused run-complete notice, so a round that
 * completes in a resting pane had no author at all: the pane fell back to the
 * bare ephemeral footer card (no Participants/Commits epic stack, no
 * "Worked for …" body) until the chat was projected to host, whose selection
 * re-derived the notice and authored the close-out — the "full card appears
 * only after opening the chat solo" inconsistency.
 *
 * This module is the pure core of the resting-pane author: resolve whether a
 * chat currently deserves a close-out (`resolveRestingChatCloseoutTarget`) and
 * apply it to the chat record (`applyRestingChatCloseout`, an `updateChatById`
 * updater). Both deliberately mirror the focused effect's updater — same
 * builders, same AI-summary reseed rule, same `isSameTaskWraithCloseout`
 * no-op contract — so a chat authored here and later focused converges
 * instead of flapping.
 */

type RoundCloseoutBuilderInput = Parameters<typeof buildTaskWraithRoundCloseoutMessage>[0]

export interface RestingChatCloseoutTarget {
  scope: 'ensembleRound' | 'run'
  closeoutId: string
  /** Completion stamp this close-out describes (round.endedAt / notice time). */
  completedAt: string
  /** Session AI-summary cache key — mirrors the focused effect's keying. */
  aiSummaryKey: string
  /** Once-per-completion guard key for the authoring effect. */
  authoringKey: string
  round?: EnsembleRoundState
  run?: ChatRun
  exitCode?: number
}

const TERMINAL_ROUND_STATUSES = new Set<EnsembleRoundState['status']>([
  'completed',
  'cancelled',
  'failed'
])

function isTerminalRound(
  round: EnsembleRoundState | null | undefined
): round is EnsembleRoundState {
  return Boolean(round && TERMINAL_ROUND_STATUSES.has(round.status))
}

export interface ResolveRestingChatCloseoutDeps {
  isRunning: boolean
  /** Settings gate — pass `settings?.showRunCompleteSummary`. */
  showRunCompleteSummary?: boolean
}

/**
 * Whether `chat` has a finished run/round that deserves a close-out message,
 * independent of which chat is focused. Returns null while the chat is
 * running, when the completion is a deliberate steer handoff, when summaries
 * are disabled, or when there is nothing completed to describe.
 */
export function resolveRestingChatCloseoutTarget(
  chat: ChatRecord | null | undefined,
  deps: ResolveRestingChatCloseoutDeps
): RestingChatCloseoutTarget | null {
  if (!chat?.appChatId) return null
  if (deps.showRunCompleteSummary === false) return null
  // Welcome-state parity with the focused effect: nothing ran, nothing to say.
  if ((chat.messages?.length ?? 0) === 0) return null
  // Focused parity: the focused pipeline routes its notice through
  // deriveVisibleRunCompleteNotice, which hides any notice while the chat is
  // running (a stale terminal round can coexist with a fresh follow-up run).
  if (deps.isRunning) return null
  const notice = deriveChatRunCompleteNotice(chat, deps.isRunning)
  if (!notice || shouldSuppressRunCompleteSummary(notice)) return null

  if (chat.chatKind === 'ensemble') {
    const round = chat.ensemble?.activeRound
    if (!isTerminalRound(round)) return null
    const completedAt = round.endedAt || notice.timestamp
    const closeoutId = taskWraithRoundCloseoutId(round.roundId)
    return {
      scope: 'ensembleRound',
      closeoutId,
      completedAt,
      // A reopened round (Steer/Resume) re-completes under the SAME roundId,
      // so both keys are scoped to this completion's timestamp.
      aiSummaryKey: `${closeoutId}@${completedAt}`,
      authoringKey: `${chat.appChatId}|${closeoutId}|${completedAt}`,
      round
    }
  }

  const runs = chat.runs || []
  const run = notice.runId
    ? runs.find((item) => item.runId === notice.runId)
    : runs[runs.length - 1]
  if (!run?.runId || !run.endedAt) return null
  const closeoutId = taskWraithRunCloseoutId(run.runId)
  return {
    scope: 'run',
    closeoutId,
    completedAt: notice.timestamp,
    // Solo run ids never re-complete, so the cache key is the id alone.
    aiSummaryKey: closeoutId,
    authoringKey: `${chat.appChatId}|${closeoutId}|${notice.timestamp}`,
    run,
    exitCode: notice.exitCode
  }
}

export interface ApplyRestingChatCloseoutDeps {
  childChats?: RoundCloseoutBuilderInput['childChats']
  /** Session AI-summary cache (keyed like the focused effect's map). */
  aiSummaries?: Record<string, CloseoutAiSummary>
}

/**
 * `updateChatById` updater that upserts the close-out described by `target`.
 * Re-resolves the round/run from `source` (the record may have advanced since
 * the target was resolved) and returns `source` unchanged when the completion
 * is gone, superseded, or the rebuilt close-out is identical.
 */
export function applyRestingChatCloseout(
  source: ChatRecord,
  target: RestingChatCloseoutTarget,
  deps: ApplyRestingChatCloseoutDeps = {}
): ChatRecord {
  if (target.scope === 'ensembleRound') {
    const round = source.ensemble?.activeRound
    if (!isTerminalRound(round) || round.roundId !== target.round?.roundId) return source
    const closeoutId = taskWraithRoundCloseoutId(round.roundId)
    const roundCompletedAt = round.endedAt || target.completedAt
    const existing = source.messages.find((message) => message.id === closeoutId)
    const closeout = buildTaskWraithRoundCloseoutMessage({
      chat: source,
      round,
      completedAt: roundCompletedAt,
      childChats: deps.childChats,
      // Same reseed rule as the focused effect: a persisted AI summary only
      // survives into the rebuild when it belongs to THIS completion.
      aiSummary:
        deps.aiSummaries?.[`${closeoutId}@${roundCompletedAt}`] ||
        (existing?.timestamp === roundCompletedAt
          ? closeoutAiSummaryFromMetadata(existing?.metadata)
          : null) ||
        undefined
    })
    if (existing && isSameTaskWraithCloseout(existing, closeout)) return source
    return {
      ...source,
      messages: upsertTaskWraithCloseoutMessage(source.messages, closeout, {
        closeoutRoundId: round.roundId
      }),
      updatedAt: Date.now()
    }
  }

  const run = (source.runs || []).find((item) => item.runId === target.run?.runId)
  if (!run?.runId || !run.endedAt) return source
  const closeoutId = taskWraithRunCloseoutId(run.runId)
  const existing = source.messages.find((message) => message.id === closeoutId)
  const closeout = buildTaskWraithRunCloseoutMessage({
    chat: source,
    run,
    completedAt: target.completedAt,
    exitCode: target.exitCode,
    childChats: deps.childChats,
    aiSummary:
      deps.aiSummaries?.[closeoutId] ||
      closeoutAiSummaryFromMetadata(existing?.metadata) ||
      undefined
  })
  if (existing && isSameTaskWraithCloseout(existing, closeout)) return source
  return {
    ...source,
    messages: upsertTaskWraithCloseoutMessage(source.messages, closeout, {
      sourceRunId: run.runId,
      promptMessageId: run.promptMessageId
    }),
    updatedAt: Date.now()
  }
}
