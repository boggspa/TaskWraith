import { isDeepStrictEqual } from 'node:util'
import {
  deriveChatRecordMutationWithProjection,
  estimateChatRecordMutationBytes,
  type AuthoredChatTranscriptMutation,
  type ChatRecordMutationBatch,
  type DerivedChatRecordMutation
} from './ChatRecordMutation'
import type {
  IncrementalChatAppendDurability,
  IncrementalChatJournal,
  IncrementalChatJournalStats,
  IncrementalChatReplayResult
} from './IncrementalChatJournal'
import type { ChatMessage, ChatRecord } from './types'

export type IncrementalChatPersistenceBoundary = 'normal' | 'approval' | 'terminal'

export interface IncrementalChatPersistenceStats {
  boundaryMix: Record<IncrementalChatPersistenceBoundary, number>
  seeds: number
  mutationBatchesAppended: number
  mutationBytesAppended: number
  baselineChecks: number
  baselineRepairs: number
  parityChecks: number
  parityMatches: number
  parityMismatches: number
  terminalCheckpoints: number
  idleCheckpoints: number
  shutdownCheckpoints: number
  failures: number
  journal: IncrementalChatJournalStats
}

export interface IncrementalChatPersistResult {
  seeded: boolean
  mutationBytes: number
  checkpointed: boolean
  parityVerified: boolean | null
  /** Exact durable mutation plus renderer ops, derived once at the producer seam. */
  derived: DerivedChatRecordMutation | null
}

export interface IncrementalChatPersistence {
  persist(
    previous: ChatRecord | null,
    next: ChatRecord,
    boundary: IncrementalChatPersistenceBoundary,
    authoredTranscript?: AuthoredChatTranscriptMutation
  ): IncrementalChatPersistResult
  verify(chatId: string, expected: ChatRecord, repair?: boolean): boolean
  replay(chatId: string): IncrementalChatReplayResult
  replaceAuthoritative(chatId: string, record: ChatRecord): void
  checkpointIdle(nowMs?: number): number
  checkpointAll(): number
  purge(chatId: string): void
  clear(): void
  stats(): IncrementalChatPersistenceStats
}

export interface IncrementalChatPersistenceOptions {
  journal: IncrementalChatJournal
  logger?: Pick<Console, 'error' | 'warn'>
}

function durableClone(record: ChatRecord): ChatRecord {
  return JSON.parse(JSON.stringify(record)) as ChatRecord
}

function carriesUserMessage(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) => message.role === 'user')
}

/**
 * ADR §5.2 D1 classifier. A normal-boundary batch may defer its fsync only
 * when every operation is soft stream data: assistant/tool content deltas,
 * tool-activity projections, record metadata. Anything the durability ladder
 * calls D2 — a user message (mid-run steering lands on the normal boundary),
 * a run transition, a content replacement (user edits arrive as `set.content`)
 * — keeps the synchronous flush. Conservative by construction: unknown or
 * ambiguous ops classify as immediate.
 */
export function isDeferrableStreamingMutation(batch: ChatRecordMutationBatch): boolean {
  for (const operation of batch.operations) {
    switch (operation.type) {
      case 'runs_splice':
      case 'run_put':
        return false
      case 'messages_splice':
        if (carriesUserMessage(operation.messages)) return false
        break
      case 'message_put':
        if (operation.message.role === 'user') return false
        break
      case 'message_patch':
        if (
          Object.prototype.hasOwnProperty.call(operation.set, 'content') ||
          operation.clear.includes('content')
        ) {
          return false
        }
        break
      case 'record_patch':
      case 'message_content_append':
      case 'tool_activities_presence':
      case 'tool_activities_splice':
      case 'tool_activity_put':
        break
      default:
        return false
    }
  }
  return true
}

function baselineMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Incremental chat baseline mismatch')
}

export function createIncrementalChatPersistence(
  options: IncrementalChatPersistenceOptions
): IncrementalChatPersistence {
  const { journal } = options
  const logger = options.logger ?? console
  const baselineVerifiedChatIds = new Set<string>()
  const boundaryMix: Record<IncrementalChatPersistenceBoundary, number> = {
    normal: 0,
    approval: 0,
    terminal: 0
  }
  let seeds = 0
  let mutationBatchesAppended = 0
  let mutationBytesAppended = 0
  let baselineChecks = 0
  let baselineRepairs = 0
  let parityChecks = 0
  let parityMatches = 0
  let parityMismatches = 0
  let terminalCheckpoints = 0
  let idleCheckpoints = 0
  let shutdownCheckpoints = 0
  let failures = 0

  const replaceAuthoritative = (chatId: string, record: ChatRecord): void => {
    journal.replaceAuthoritativeCheckpoint(chatId, durableClone(record))
    baselineVerifiedChatIds.add(chatId)
    baselineRepairs += 1
  }

  const verify = (chatId: string, expected: ChatRecord, repair = false): boolean => {
    parityChecks += 1
    const replayed = journal.replay(chatId)
    const matches =
      replayed.record !== null && isDeepStrictEqual(replayed.record, durableClone(expected))
    if (matches) {
      parityMatches += 1
      return true
    }
    parityMismatches += 1
    if (repair) {
      logger.warn(
        `[incremental-chat] replay parity mismatch for ${chatId}; ` +
          'restoring the canonical AppStore record'
      )
      replaceAuthoritative(chatId, expected)
    }
    return false
  }

  const ensureBaseline = (previous: ChatRecord): void => {
    const chatId = previous.appChatId
    // Once parity is established, the journal head is advanced solely by this
    // coordinator. Returning before durableClone/initialize is what makes the
    // normal append path genuinely incremental rather than cloning the full
    // transcript just to discover that its baseline already exists.
    if (baselineVerifiedChatIds.has(chatId)) return
    try {
      journal.initialize(chatId, durableClone(previous))
    } catch (error) {
      if (!baselineMismatch(error)) throw error
      replaceAuthoritative(chatId, previous)
    }
    baselineChecks += 1
    if (!verify(chatId, previous, true)) {
      // verify(..., true) repaired the side-band state from the authoritative
      // legacy record. Keep this chat marked verified for subsequent hot saves.
    }
    baselineVerifiedChatIds.add(chatId)
  }

  const persist = (
    previous: ChatRecord | null,
    next: ChatRecord,
    boundary: IncrementalChatPersistenceBoundary,
    authoredTranscript?: AuthoredChatTranscriptMutation
  ): IncrementalChatPersistResult => {
    try {
      boundaryMix[boundary] += 1
      if (!previous) {
        journal.initialize(next.appChatId, durableClone(next))
        baselineVerifiedChatIds.add(next.appChatId)
        seeds += 1
        const parityVerified = boundary === 'normal' ? null : verify(next.appChatId, next, true)
        return {
          seeded: true,
          mutationBytes: 0,
          checkpointed: false,
          parityVerified,
          derived: null
        }
      }

      ensureBaseline(previous)
      const derived = deriveChatRecordMutationWithProjection(
        previous,
        next,
        authoredTranscript ? { authoredTranscript } : {}
      )
      const { batch } = derived
      const mutationBytes = estimateChatRecordMutationBytes(batch)
      const durability: IncrementalChatAppendDurability =
        boundary === 'normal' && isDeferrableStreamingMutation(batch) ? 'deferred' : 'immediate'
      journal.append(batch, { durability })
      mutationBatchesAppended += 1
      mutationBytesAppended += mutationBytes

      let checkpointed = false
      let parityVerified: boolean | null = null
      if (boundary === 'terminal') {
        checkpointed = journal.checkpoint(next.appChatId, 'terminal')
        if (checkpointed) terminalCheckpoints += 1
        parityVerified = verify(next.appChatId, next, true)
      } else if (boundary === 'approval') {
        // Approval state is already fsynced by append. A bounded parity check
        // retains the old barrier's fail-safe semantics without forcing a full
        // checkpoint into every subsequent save while the card remains open.
        parityVerified = verify(next.appChatId, next, true)
      }
      return { seeded: false, mutationBytes, checkpointed, parityVerified, derived }
    } catch (error) {
      failures += 1
      // The legacy path may still advance after this side-band failure. Force
      // the next save to re-establish its baseline instead of retrying forever
      // against a journal head that is now one or more revisions behind.
      baselineVerifiedChatIds.delete(next.appChatId)
      logger.error('[incremental-chat] mutation persistence failed', error)
      throw error
    }
  }

  const checkpointIdle = (nowMs?: number): number => {
    try {
      const count = journal.checkpointIdle(nowMs)
      idleCheckpoints += count
      return count
    } catch (error) {
      failures += 1
      logger.error('[incremental-chat] idle checkpoint failed', error)
      return 0
    }
  }

  const checkpointAll = (): number => {
    try {
      const count = journal.checkpointAll('shutdown')
      shutdownCheckpoints += count
      return count
    } catch (error) {
      failures += 1
      logger.error('[incremental-chat] shutdown checkpoint failed', error)
      return 0
    }
  }

  const purge = (chatId: string): void => {
    journal.purge(chatId)
    baselineVerifiedChatIds.delete(chatId)
  }

  const clear = (): void => {
    journal.clear()
    baselineVerifiedChatIds.clear()
  }

  const stats = (): IncrementalChatPersistenceStats => ({
    boundaryMix: { ...boundaryMix },
    seeds,
    mutationBatchesAppended,
    mutationBytesAppended,
    baselineChecks,
    baselineRepairs,
    parityChecks,
    parityMatches,
    parityMismatches,
    terminalCheckpoints,
    idleCheckpoints,
    shutdownCheckpoints,
    failures,
    journal: journal.stats()
  })

  return {
    persist,
    verify,
    replay: (chatId) => journal.replay(chatId),
    replaceAuthoritative,
    checkpointIdle,
    checkpointAll,
    purge,
    clear,
    stats
  }
}
