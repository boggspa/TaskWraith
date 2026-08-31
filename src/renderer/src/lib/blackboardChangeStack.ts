import type { ChatMessage } from '../../../main/store/types'
import { BLACKBOARD_CHANGE_FRESH_WINDOW_MS } from '../../../shared/blackboardChange'
import { resolveBlackboardChangePresentation } from './blackboardChangePresentation'

export const BLACKBOARD_UPDATE_STACK_WINDOW_MS = BLACKBOARD_CHANGE_FRESH_WINDOW_MS
export const BLACKBOARD_UPDATE_STACK_MAX_ITEMS = 60

export interface BlackboardUpdateStack {
  /** Original durable rows in transcript order. */
  messages: readonly ChatMessage[]
  /** Occurrence-safe source indexes for virtual-row and jump aliases. */
  memberIndexes: readonly number[]
  /** Newest member index; this row owns the summary and disclosure. */
  leadIndex: number
  /** Stable disclosure identity while the burst grows. */
  firstMessageId: string
  /** The original row whose presentation drives the collapsed summary. */
  latestMessage: ChatMessage
}

export interface BlackboardUpdateStackProjection {
  /** Exact source array. Members stay projected for stable row ordinals. */
  messages: readonly ChatMessage[]
  stacks: readonly BlackboardUpdateStack[]
  /** Every member index resolves to the same stack. */
  stackByMessageIndex: ReadonlyMap<number, BlackboardUpdateStack>
}

interface ActiveStack {
  roundId: string
  lastTimestampMs: number
  messages: ChatMessage[]
  memberIndexes: number[]
}

function ensembleRoundId(message: ChatMessage): string | null {
  const value = message.metadata?.ensembleRoundId
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Lossless desktop projection for rapid Blackboard updates.
 *
 * Durable rows stay untouched. Within one contiguous Ensemble round, updates
 * from any provider join a 120-second sliding burst even when ordinary status
 * or Scout-brief rows sit between them. Every source row and row ordinal stays
 * projected; the renderer hides prior members at zero height and lets the
 * newest member own the disclosure.
 */
export function projectBlackboardUpdateStacks(
  sourceMessages: readonly ChatMessage[]
): BlackboardUpdateStackProjection {
  const stacks: BlackboardUpdateStack[] = []
  let active: ActiveStack | null = null
  let currentRoundId: string | null = null

  const flush = (): void => {
    if (!active || active.messages.length < 2) {
      active = null
      return
    }
    stacks.push({
      messages: active.messages,
      memberIndexes: active.memberIndexes,
      leadIndex: active.memberIndexes[active.memberIndexes.length - 1],
      firstMessageId: active.messages[0].id,
      latestMessage: active.messages[active.messages.length - 1]
    })
    active = null
  }

  for (let index = 0; index < sourceMessages.length; index += 1) {
    const message = sourceMessages[index]
    const roundId = ensembleRoundId(message)
    if (roundId && currentRoundId && roundId !== currentRoundId) flush()
    if (roundId) currentRoundId = roundId

    if (message.metadata?.kind === 'transcriptHistoryPageBoundary') {
      flush()
      continue
    }
    const presentation = resolveBlackboardChangePresentation(message)
    if (
      !roundId ||
      presentation?.action !== 'updated' ||
      typeof message.metadata?.pinnedAt === 'number'
    ) {
      if (presentation?.action === 'updated') flush()
      continue
    }
    const timestampMs = Date.parse(presentation.changedAt)
    if (!Number.isFinite(timestampMs)) continue

    const gapMs = active ? timestampMs - active.lastTimestampMs : Number.POSITIVE_INFINITY
    const canJoin =
      active !== null &&
      active.roundId === roundId &&
      gapMs >= 0 &&
      gapMs <= BLACKBOARD_UPDATE_STACK_WINDOW_MS &&
      active.messages.length < BLACKBOARD_UPDATE_STACK_MAX_ITEMS

    if (!canJoin) {
      flush()
      active = {
        roundId,
        lastTimestampMs: timestampMs,
        messages: [message],
        memberIndexes: [index]
      }
      continue
    }

    active.messages.push(message)
    active.memberIndexes.push(index)
    active.lastTimestampMs = timestampMs
  }
  flush()

  const stackByMessageIndex = new Map<number, BlackboardUpdateStack>()
  for (const stack of stacks) {
    for (const memberIndex of stack.memberIndexes) {
      stackByMessageIndex.set(memberIndex, stack)
    }
  }
  return { messages: sourceMessages, stacks, stackByMessageIndex }
}
