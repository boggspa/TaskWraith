import { isDeepStrictEqual } from 'node:util'
import {
  buildConversationCompactionProjection,
  conversationCompactionEligibleMessageIds,
  conversationCompactionEligibleRows,
  resolveBoundedCompactionPrefixMessageIds,
  type ConversationCompactionEligibleRow,
  type ConversationCompactionProjection
} from './PromptComposition'
import type { ChatMessage, ChatRecord, ProviderId } from './store/types'
import {
  buildHostCompactionSummaryPrompt,
  CONTEXT_COMPACTION_SUMMARY_MAX_CHARS,
  type ContextCompactionProvenance
} from '../shared/contextCompaction'

export const HOST_SEAT_COMPACTION_DEADLINE_MS = 240_000
export const HOST_SEAT_COMPACTION_MAX_CHUNKS = 10

const HOST_SEAT_COMPACTION_CHUNK_TURNS = 20
const HOST_SEAT_COMPACTION_CHUNK_BUDGET = {
  maxTurns: HOST_SEAT_COMPACTION_CHUNK_TURNS,
  maxCharsPerTurn: 800,
  maxBlockChars: 12_000
} as const

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.max(1, Math.min(maximum, candidate))
}

export interface HostSeatContextSummary {
  text: string
  createdAt: string
  provider: ProviderId
  preTokens?: number
  provenance?: ContextCompactionProvenance
  coversThroughTimestamp?: string
}

export interface HostSeatCompactionIdentity {
  participantId: string
  provider: 'cursor' | 'kimi' | 'grok' | 'antigravity'
  model?: string
  linkedProviderSessionId?: string | null
  workspace: string
}

export interface HostSeatCheckpointFreshnessInput {
  chat: ChatRecord
  currentWorkspace: string
  identity: HostSeatCompactionIdentity
  snapshotEligibleRows: readonly ConversationCompactionEligibleRow[]
  expectedPreviousSummary: HostSeatContextSummary | undefined
  nextSummary: HostSeatContextSummary
  claimedMessageIds?: readonly string[]
}

type BoundedPromptWindowProvenance = Extract<
  ContextCompactionProvenance,
  { kind: 'bounded_prompt_window' }
>

export interface HostSeatCompactionChunkRequest {
  chunkIndex: number
  prompt: string
  timeoutMs: number
  projection: ConversationCompactionProjection
}

export interface HostSeatCompactionChunkResult {
  ok: boolean
  text?: string
  error?: string
  timedOut?: boolean
}

export interface HostSeatCompactionCheckpointRequest {
  chunkIndex: number
  expectedPreviousSummary: HostSeatContextSummary | undefined
  nextSummary: HostSeatContextSummary
  claimedMessageIds: string[]
  coverageComplete: boolean
}

export interface HostSeatCompactionCheckpointResult {
  ok: boolean
  error?: string
}

export type HostSeatCompactionStopReason =
  | 'complete'
  | 'source_cap'
  | 'deadline'
  | 'no_progress'
  | 'summarizer_failed'
  | 'mutation'

export interface HostSeatCompactionConvergenceResult {
  checkpointCount: number
  coverageComplete: boolean
  stopReason: HostSeatCompactionStopReason
  finalSummary?: HostSeatContextSummary
  error?: string
}

/**
 * Card/result policy for a bounded request: any accepted checkpoint is useful,
 * completed maintenance even if a later child hits its deadline or fails.
 * A CAS mutation remains a failed request because current seat freshness is
 * uncertain; the already-persisted earlier checkpoints still remain durable.
 */
export function hostSeatCompactionRequestSucceeded(
  result: HostSeatCompactionConvergenceResult
): boolean {
  if (result.stopReason === 'mutation') return false
  if (result.checkpointCount > 0) return true
  return result.coverageComplete && Boolean(result.finalSummary?.text.trim())
}

export interface ConvergeHostSeatCompactionInput {
  provider: 'kimi' | 'grok' | 'antigravity'
  snapshotMessages: readonly ChatMessage[]
  initialSummary?: HostSeatContextSummary
  preTokens?: number
  startedAtMs: number
  now: () => number
  nowIso: () => string
  summarize: (
    request: HostSeatCompactionChunkRequest
  ) => Promise<HostSeatCompactionChunkResult>
  checkpoint: (
    request: HostSeatCompactionCheckpointRequest
  ) => Promise<HostSeatCompactionCheckpointResult> | HostSeatCompactionCheckpointResult
  maxChunks?: number
  deadlineMs?: number
  chunkTurns?: number
  chunkBudget?: {
    maxTurns: number
    maxCharsPerTurn: number
    maxBlockChars: number
  }
}

function boundedProvenance(
  projection: ConversationCompactionProjection,
  previousSummary: HostSeatContextSummary | undefined
): BoundedPromptWindowProvenance {
  return {
    kind: 'bounded_prompt_window',
    suppliedMessageIds: [...projection.suppliedMessageIds],
    ...(projection.carriedForwardMessageIds.length > 0
      ? { carriedForwardMessageIds: [...projection.carriedForwardMessageIds] }
      : {}),
    ...(previousSummary?.text.trim() && previousSummary.createdAt
      ? { previousSummaryCreatedAt: previousSummary.createdAt }
      : {})
  }
}

function claimedIds(provenance: BoundedPromptWindowProvenance): string[] {
  return [...(provenance.carriedForwardMessageIds || []), ...provenance.suppliedMessageIds]
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameOptionalText(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left || '') === (right || '')
}

/** Pure compare-and-set predicate used immediately before every checkpoint. */
export function validateHostSeatCheckpointFreshness(
  input: HostSeatCheckpointFreshnessInput
): { ok: true } | { ok: false; error: string } {
  if (input.nextSummary.provider !== input.identity.provider) {
    return { ok: false, error: 'The replacement summary provider does not match the seat.' }
  }
  const participant = input.chat.ensemble?.participants?.find(
    (candidate) => candidate.id === input.identity.participantId
  )
  if (!participant) return { ok: false, error: 'The participant no longer exists.' }
  if (
    participant.provider !== input.identity.provider ||
    !sameOptionalText(participant.model, input.identity.model) ||
    !sameOptionalText(
      participant.linkedProviderSessionId,
      input.identity.linkedProviderSessionId
    ) ||
    input.currentWorkspace !== input.identity.workspace
  ) {
    return { ok: false, error: 'The participant provider, model, session, or workspace changed.' }
  }
  const currentEligibleRows = conversationCompactionEligibleRows(input.chat.messages || [])
  if (
    currentEligibleRows.length < input.snapshotEligibleRows.length ||
    !isDeepStrictEqual(
      currentEligibleRows.slice(0, input.snapshotEligibleRows.length),
      input.snapshotEligibleRows
    )
  ) {
    return { ok: false, error: 'The frozen eligible transcript snapshot changed.' }
  }
  if (
    !isDeepStrictEqual(
      participant.contextCompactionSummary,
      input.expectedPreviousSummary
    )
  ) {
    return { ok: false, error: 'The participant context summary changed.' }
  }
  if (input.claimedMessageIds) {
    const resolved = resolveBoundedCompactionPrefixMessageIds(
      input.chat.messages || [],
      input.nextSummary.provenance
    )
    if (!sameStrings(resolved, input.claimedMessageIds)) {
      return { ok: false, error: 'The claimed transcript prefix is no longer exact.' }
    }
  }
  return { ok: true }
}

/**
 * Final reset fence for Grok's persistent ACP process. A summary that covered
 * the frozen start snapshot is insufficient if an eligible row arrived while
 * maintenance ran; every currently eligible id must still be covered exactly.
 */
export function canResetHostSeatAfterCompaction(input: {
  chat: ChatRecord
  currentWorkspace: string
  identity: HostSeatCompactionIdentity
  snapshotEligibleRows: readonly ConversationCompactionEligibleRow[]
  finalSummary: HostSeatContextSummary
}): boolean {
  if (
    (input.identity.provider !== 'grok' && input.identity.provider !== 'antigravity') ||
    input.finalSummary.provider !== input.identity.provider
  ) {
    return false
  }
  const freshness = validateHostSeatCheckpointFreshness({
    chat: input.chat,
    currentWorkspace: input.currentWorkspace,
    identity: input.identity,
    snapshotEligibleRows: input.snapshotEligibleRows,
    expectedPreviousSummary: input.finalSummary,
    nextSummary: input.finalSummary
  })
  if (!freshness.ok) return false
  const eligibleIds = conversationCompactionEligibleMessageIds(input.chat.messages || [])
  if (eligibleIds.length === 0) return false
  const coveredIds = resolveBoundedCompactionPrefixMessageIds(
    input.chat.messages || [],
    input.finalSummary.provenance
  )
  return sameStrings(coveredIds, eligibleIds)
}

/** Backward-compatible name for Grok's process-disposal caller. */
export function canDisposeGrokSeatAfterCompaction(
  input: Parameters<typeof canResetHostSeatAfterCompaction>[0]
): boolean {
  return input.identity.provider === 'grok' && canResetHostSeatAfterCompaction(input)
}

/**
 * Advance a Kimi/Grok host summary across successive exact transcript-prefix
 * chunks inside one accepted maintenance request. The caller owns provider
 * process spawning and the durable compare-and-set; this controller owns only
 * bounded selection, summary chaining, and stop conditions.
 */
export async function convergeHostSeatCompaction(
  input: ConvergeHostSeatCompactionInput
): Promise<HostSeatCompactionConvergenceResult> {
  const maxChunks = boundedPositiveInteger(
    input.maxChunks,
    HOST_SEAT_COMPACTION_MAX_CHUNKS,
    HOST_SEAT_COMPACTION_MAX_CHUNKS
  )
  const deadlineAt =
    input.startedAtMs +
    boundedPositiveInteger(
      input.deadlineMs,
      HOST_SEAT_COMPACTION_DEADLINE_MS,
      HOST_SEAT_COMPACTION_DEADLINE_MS
    )
  const chunkTurns = boundedPositiveInteger(
    input.chunkTurns,
    HOST_SEAT_COMPACTION_CHUNK_TURNS,
    HOST_SEAT_COMPACTION_CHUNK_TURNS
  )
  const chunkBudget = {
    maxTurns: boundedPositiveInteger(
      input.chunkBudget?.maxTurns,
      HOST_SEAT_COMPACTION_CHUNK_BUDGET.maxTurns,
      HOST_SEAT_COMPACTION_CHUNK_BUDGET.maxTurns
    ),
    maxCharsPerTurn: boundedPositiveInteger(
      input.chunkBudget?.maxCharsPerTurn,
      HOST_SEAT_COMPACTION_CHUNK_BUDGET.maxCharsPerTurn,
      HOST_SEAT_COMPACTION_CHUNK_BUDGET.maxCharsPerTurn
    ),
    maxBlockChars: boundedPositiveInteger(
      input.chunkBudget?.maxBlockChars,
      HOST_SEAT_COMPACTION_CHUNK_BUDGET.maxBlockChars,
      HOST_SEAT_COMPACTION_CHUNK_BUDGET.maxBlockChars
    )
  }
  let currentSummary = input.initialSummary
  let checkpointCount = 0

  for (let chunkIndex = 0; chunkIndex < maxChunks; chunkIndex += 1) {
    const remainingMs = deadlineAt - input.now()
    if (remainingMs <= 0) {
      return {
        checkpointCount,
        coverageComplete: false,
        stopReason: 'deadline',
        ...(currentSummary ? { finalSummary: currentSummary } : {}),
        error: 'The host compaction request reached its global time budget.'
      }
    }

    const projection = buildConversationCompactionProjection(
      [...input.snapshotMessages],
      chunkTurns,
      currentSummary?.text.trim() ? currentSummary.provenance : undefined,
      chunkBudget
    )
    const priorCoveredCount = projection.carriedForwardMessageIds.length
    if (projection.suppliedMessageIds.length === 0) {
      const alreadyComplete =
        projection.remainingUncoveredMessageCount === 0 &&
        priorCoveredCount > 0 &&
        Boolean(currentSummary?.text.trim())
      return {
        checkpointCount,
        coverageComplete: alreadyComplete,
        stopReason: alreadyComplete ? 'complete' : 'no_progress',
        ...(currentSummary ? { finalSummary: currentSummary } : {}),
        ...(!alreadyComplete
          ? { error: 'No complete transcript row fit in the next compaction chunk.' }
          : {})
      }
    }

    const provenance = boundedProvenance(projection, currentSummary)
    const nextClaimedIds = claimedIds(provenance)
    if (nextClaimedIds.length <= priorCoveredCount) {
      return {
        checkpointCount,
        coverageComplete: false,
        stopReason: 'no_progress',
        ...(currentSummary ? { finalSummary: currentSummary } : {}),
        error: 'The next compaction chunk did not advance exact transcript coverage.'
      }
    }

    const childTimeoutMs = deadlineAt - input.now()
    if (childTimeoutMs <= 0) {
      return {
        checkpointCount,
        coverageComplete: false,
        stopReason: 'deadline',
        ...(currentSummary ? { finalSummary: currentSummary } : {}),
        error: 'The host compaction request reached its global time budget.'
      }
    }
    const chunk = await input.summarize({
      chunkIndex,
      prompt: buildHostCompactionSummaryPrompt({
        previousSummaryText: currentSummary?.text,
        materialBlock: projection.block
      }),
      timeoutMs: childTimeoutMs,
      projection
    })
    if (!chunk.ok || chunk.timedOut) {
      return {
        checkpointCount,
        coverageComplete: false,
        stopReason: chunk.timedOut ? 'deadline' : 'summarizer_failed',
        ...(currentSummary ? { finalSummary: currentSummary } : {}),
        error:
          chunk.error ||
          (chunk.timedOut
            ? 'Timed out waiting for the seat summarize turn.'
            : 'The seat summarize turn failed.')
      }
    }

    const text = (chunk.text || '').trim().slice(0, CONTEXT_COMPACTION_SUMMARY_MAX_CHARS)
    if (!text) {
      return {
        checkpointCount,
        coverageComplete: false,
        stopReason: 'summarizer_failed',
        ...(currentSummary ? { finalSummary: currentSummary } : {}),
        error: 'The seat summarize turn returned no summary.'
      }
    }

    const nextSummary: HostSeatContextSummary = {
      text,
      createdAt: input.nowIso(),
      provider: input.provider,
      ...(input.preTokens !== undefined ? { preTokens: input.preTokens } : {}),
      provenance
    }
    const coverageComplete = projection.remainingUncoveredMessageCount === 0
    const persisted = await input.checkpoint({
      chunkIndex,
      expectedPreviousSummary: currentSummary,
      nextSummary,
      claimedMessageIds: nextClaimedIds,
      coverageComplete
    })
    if (!persisted.ok) {
      return {
        checkpointCount,
        coverageComplete: false,
        stopReason: 'mutation',
        ...(currentSummary ? { finalSummary: currentSummary } : {}),
        error:
          persisted.error ||
          'The seat changed while compaction was running; previously saved progress was retained.'
      }
    }

    checkpointCount += 1
    currentSummary = nextSummary
    if (coverageComplete) {
      return {
        checkpointCount,
        coverageComplete: true,
        stopReason: 'complete',
        finalSummary: currentSummary
      }
    }
  }

  return {
    checkpointCount,
    coverageComplete: false,
    stopReason: 'source_cap',
    ...(currentSummary ? { finalSummary: currentSummary } : {})
  }
}
