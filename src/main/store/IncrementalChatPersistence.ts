import { isDeepStrictEqual } from 'node:util'
import { deriveChatRecordMutation, estimateChatRecordMutationBytes } from './ChatRecordMutation'
import type {
  IncrementalChatJournal,
  IncrementalChatJournalStats,
  IncrementalChatReplayResult
} from './IncrementalChatJournal'
import type { ChatRecord } from './types'

export type IncrementalChatPersistenceBoundary = 'normal' | 'approval' | 'terminal'

export interface IncrementalChatPersistenceStats {
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
}

export interface IncrementalChatPersistence {
  persist(
    previous: ChatRecord | null,
    next: ChatRecord,
    boundary: IncrementalChatPersistenceBoundary
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

function baselineMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Incremental chat baseline mismatch')
}

export function createIncrementalChatPersistence(
  options: IncrementalChatPersistenceOptions
): IncrementalChatPersistence {
  const { journal } = options
  const logger = options.logger ?? console
  const baselineVerifiedChatIds = new Set<string>()
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
          'restoring the still-authoritative legacy record'
      )
      replaceAuthoritative(chatId, expected)
    }
    return false
  }

  const ensureBaseline = (previous: ChatRecord): void => {
    const chatId = previous.appChatId
    try {
      journal.initialize(chatId, durableClone(previous))
    } catch (error) {
      if (!baselineMismatch(error)) throw error
      replaceAuthoritative(chatId, previous)
    }
    if (baselineVerifiedChatIds.has(chatId)) return
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
    boundary: IncrementalChatPersistenceBoundary
  ): IncrementalChatPersistResult => {
    try {
      if (!previous) {
        journal.initialize(next.appChatId, durableClone(next))
        baselineVerifiedChatIds.add(next.appChatId)
        seeds += 1
        const parityVerified = boundary === 'normal' ? null : verify(next.appChatId, next, true)
        return { seeded: true, mutationBytes: 0, checkpointed: false, parityVerified }
      }

      ensureBaseline(previous)
      const batch = deriveChatRecordMutation(previous, next)
      const mutationBytes = estimateChatRecordMutationBytes(batch)
      journal.append(batch)
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
      return { seeded: false, mutationBytes, checkpointed, parityVerified }
    } catch (error) {
      failures += 1
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
