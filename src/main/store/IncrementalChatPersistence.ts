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
  IncrementalChatPendingReplayState,
  IncrementalChatReplayResult
} from './IncrementalChatJournal'
import type { ChatMessage, ChatRecord } from './types'
import type { DeferredCheckpointResult } from './CheckpointPreparationProtocol'
import { observeResidual, type ResidualObserver } from './MainDurabilityResiduals'

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
  terminalCheckpointsDeferred: number
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
  /**
   * Terminal-boundary full checkpoint (and its replay-parity check) deferred
   * to the trailing idle flush. The mutation append is already durable; only
   * replay-bounding moved. Present only when the caller asked to defer.
   */
  terminalCheckpointDeferred?: boolean
  /** Exact durable mutation plus renderer ops, derived once at the producer seam. */
  derived: DerivedChatRecordMutation | null
}

export interface IncrementalChatPersistOptions {
  /** Skip the eager terminal checkpoint+parity for this persist (large records). */
  deferTerminalCheckpoint?: boolean
}

/**
 * Bound on appended batches between full checkpoints while terminal
 * checkpoints are being deferred. Replay (boot recovery, parity) walks every
 * batch since the last checkpoint, so an unbounded deferral would make both
 * linearly slower; at this depth the journal checkpoints eagerly again.
 */
export const DEFERRED_TERMINAL_CHECKPOINT_APPEND_CAP = 16

export interface IncrementalChatPersistence {
  persist(
    previous: ChatRecord | null,
    next: ChatRecord,
    boundary: IncrementalChatPersistenceBoundary,
    authoredTranscript?: AuthoredChatTranscriptMutation,
    options?: IncrementalChatPersistOptions
  ): IncrementalChatPersistResult
  verify(chatId: string, expected: ChatRecord, repair?: boolean): boolean
  replay(chatId: string): IncrementalChatReplayResult
  /** Cheap probe of whether {@link replay} could lead the legacy record. */
  pendingReplayState(chatId: string): IncrementalChatPendingReplayState
  replaceAuthoritative(chatId: string, record: ChatRecord): void
  checkpointIdle(nowMs?: number): number
  checkpointAll(): number
  /** Flush one chat's deferred terminal checkpoint. False when nothing is due. */
  checkpointChat(chatId: string): boolean
  checkpointChatDeferred(chatId: string): Promise<DeferredCheckpointResult>
  checkpointIdleDeferred(nowMs?: number): Promise<number>
  cancelCheckpointPreparations(chatId?: string): void
  /** Appended batches since this chat's last checkpoint (deferral depth). */
  appendsSinceCheckpoint(chatId: string): number
  /**
   * Estimated mutation bytes appended since this chat's last full checkpoint —
   * the volume a deferred compatibility checkpoint would publish. Meters the
   * deferral's accumulated-mutation gate so a trickle of tiny saves does not
   * re-serialize a multi-megabyte record; the journal stays the durable record.
   */
  pendingMutationBytes(chatId: string): number
  purge(chatId: string): void
  clear(): void
  stats(): IncrementalChatPersistenceStats
  awaitDeferredDurability(chatId: string): Promise<void>
}

export interface IncrementalChatPersistenceOptions {
  residualObserver?: ResidualObserver
  journal: IncrementalChatJournal
  canWrite?: () => boolean
  logger?: Pick<Console, 'error' | 'warn'>
}

function durableClone(record: ChatRecord): ChatRecord {
  return JSON.parse(JSON.stringify(record)) as ChatRecord
}

function recordRevision(record: Pick<ChatRecord, 'persistenceRevision'>): number {
  const revision = record.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? revision! : 0
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
  const canWrite = (): boolean => {
    try {
      return options.canWrite?.() ?? true
    } catch {
      return false
    }
  }
  const logger = options.logger ?? console
  const baselineVerifiedChatIds = new Set<string>()
  /**
   * Last revision this coordinator durably persisted per chat (baseline,
   * append, or recovery checkpoint). The verified marker alone cannot prove
   * the journal head on the Stage 2 Host mirror path: non-mutation
   * whole-record Host saves advance the authoritative record WITHOUT the
   * journal, so a marker-cached chat can re-enter persist with a previous
   * record newer than the journal head. Comparing against this in-memory
   * revision re-anchors the baseline without any disk read, keeping the hot
   * append path genuinely incremental.
   */
  const lastPersistedRevisionByChatId = new Map<string, number>()
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
  let terminalCheckpointsDeferred = 0
  let idleCheckpoints = 0
  let shutdownCheckpoints = 0
  let failures = 0
  /** Appended batches since each chat's last full checkpoint (replay depth). */
  const appendsSinceCheckpointByChatId = new Map<string, number>()
  /** Estimated mutation bytes appended since each chat's last full checkpoint. */
  const pendingMutationBytesByChatId = new Map<string, number>()
  const noteAppend = (chatId: string, mutationBytes: number): void => {
    appendsSinceCheckpointByChatId.set(
      chatId,
      (appendsSinceCheckpointByChatId.get(chatId) ?? 0) + 1
    )
    pendingMutationBytesByChatId.set(
      chatId,
      (pendingMutationBytesByChatId.get(chatId) ?? 0) + Math.max(0, mutationBytes)
    )
  }
  const noteCheckpoint = (chatId: string): void => {
    appendsSinceCheckpointByChatId.set(chatId, 0)
    pendingMutationBytesByChatId.set(chatId, 0)
  }

  /**
   * The exact record most recently written to each chat's journal head, so a
   * checkpoint serializes it from memory instead of re-reading and re-parsing
   * the whole on-disk checkpoint. The fingerprint catches a caller mutating
   * the object in place after persisting it: any mismatch falls back to the
   * journal's own replay. Taken on use, so a chat's record is retained only
   * until its next checkpoint.
   */
  const headRecordByChatId = new Map<
    string,
    { record: ChatRecord; revision: number; fingerprint: HeadFingerprint }
  >()
  // Identity and O(1) fields only: the hot append path must never index into
  // (or clone) verified history.
  type HeadFingerprint = {
    revision: number
    updatedAt: unknown
    messages: unknown
    messageCount: number
    runs: unknown
    runCount: number
  }
  const headFingerprint = (record: ChatRecord): HeadFingerprint => ({
    revision: recordRevision(record),
    updatedAt: record.updatedAt,
    messages: record.messages,
    messageCount: Array.isArray(record.messages) ? record.messages.length : -1,
    runs: record.runs,
    runCount: Array.isArray(record.runs) ? record.runs.length : -1
  })
  const sameFingerprint = (a: HeadFingerprint, b: HeadFingerprint): boolean =>
    a.revision === b.revision &&
    a.updatedAt === b.updatedAt &&
    a.messages === b.messages &&
    a.messageCount === b.messageCount &&
    a.runs === b.runs &&
    a.runCount === b.runCount
  const rememberHead = (record: ChatRecord): void => {
    headRecordByChatId.set(record.appChatId, {
      record,
      revision: recordRevision(record),
      fingerprint: headFingerprint(record)
    })
  }
  const takeHead = (chatId: string, headRevision: number): ChatRecord | null => {
    const entry = headRecordByChatId.get(chatId)
    if (!entry) return null
    headRecordByChatId.delete(chatId)
    if (entry.revision !== headRevision) return null
    return sameFingerprint(headFingerprint(entry.record), entry.fingerprint) ? entry.record : null
  }
  journal.setHeadRecordResolver?.(takeHead)

  const replaceAuthoritative = (chatId: string, record: ChatRecord): void => {
    if (!canWrite()) throw new Error('Incremental chat persistence is read-only')
    // The journal serializes immediately; a JSON clone first was a second
    // whole-record parse+stringify for no isolation it did not already get.
    journal.replaceAuthoritativeCheckpoint(chatId, record)
    rememberHead(record)
    baselineVerifiedChatIds.add(chatId)
    lastPersistedRevisionByChatId.set(chatId, recordRevision(record))
    noteCheckpoint(chatId)
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
    if (repair && canWrite()) {
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
    if (baselineVerifiedChatIds.has(chatId)) {
      // Stage 2 Host mirror: the verified marker no longer proves the journal
      // head by itself. A non-mutation whole-record Host save (or any
      // Host-native record write) can advance the authoritative record
      // between two mutation saves, leaving the journal behind. Re-anchor the
      // baseline from the authoritative pre-save record when that happens —
      // one in-memory revision compare, no disk read, no transcript clone.
      if (lastPersistedRevisionByChatId.get(chatId) !== recordRevision(previous)) {
        replaceAuthoritative(chatId, previous)
      }
      return
    }
    try {
      journal.initialize(chatId, previous)
      lastPersistedRevisionByChatId.set(chatId, recordRevision(previous))
    } catch (error) {
      if (!baselineMismatch(error)) throw error
      replaceAuthoritative(chatId, previous)
    }
    baselineChecks += 1
    observeResidual(options.residualObserver, 'baselineVerifies')
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
    authoredTranscript?: AuthoredChatTranscriptMutation,
    options: IncrementalChatPersistOptions = {}
  ): IncrementalChatPersistResult => {
    if (!canWrite()) throw new Error('Incremental chat persistence is read-only')
    try {
      boundaryMix[boundary] += 1
      if (!previous) {
        journal.initialize(next.appChatId, next)
        rememberHead(next)
        baselineVerifiedChatIds.add(next.appChatId)
        lastPersistedRevisionByChatId.set(next.appChatId, recordRevision(next))
        noteCheckpoint(next.appChatId)
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
      rememberHead(next)
      mutationBatchesAppended += 1
      mutationBytesAppended += mutationBytes
      lastPersistedRevisionByChatId.set(next.appChatId, batch.revision)
      noteAppend(next.appChatId, mutationBytes)

      let checkpointed = false
      const parityVerified: boolean | null = null
      if (boundary === 'terminal') {
        if (options.deferTerminalCheckpoint) {
          // The append above is durable; the full checkpoint only bounds
          // replay, and its parity verify costs a whole-record clone+compare
          // on large chats. Both ride the trailing idle flush. Depth stays
          // bounded by DEFERRED_TERMINAL_CHECKPOINT_APPEND_CAP at the caller.
          terminalCheckpointsDeferred += 1
          return {
            seeded: false,
            mutationBytes,
            checkpointed: false,
            parityVerified: null,
            terminalCheckpointDeferred: true,
            derived
          }
        }
        // Checkpoint straight from `next`, the authoritative record at the
        // head revision. The former replay-then-verify (read + parse the
        // on-disk checkpoint twice, JSON-clone, deep-compare) could only ever
        // conclude by writing this same record, at ~1s of main per terminal
        // save on a 20MB+ thread.
        const head = takeHead(next.appChatId, recordRevision(next)) ?? next
        checkpointed = journal.checkpoint(next.appChatId, 'terminal', head)
        if (checkpointed) terminalCheckpoints += 1
        noteCheckpoint(next.appChatId)
      }
      // Approval state is fsynced by the append above; no whole-record parity
      // replay rides the approval boundary any more.
      return { seeded: false, mutationBytes, checkpointed, parityVerified, derived }
    } catch (error) {
      failures += 1
      // The legacy path may still advance after this side-band failure. Force
      // the next save to re-establish its baseline instead of retrying forever
      // against a journal head that is now one or more revisions behind.
      baselineVerifiedChatIds.delete(next.appChatId)
      lastPersistedRevisionByChatId.delete(next.appChatId)
      logger.error('[incremental-chat] mutation persistence failed', error)
      throw error
    }
  }

  const checkpointIdle = (nowMs?: number): number => {
    if (!canWrite()) throw new Error('Incremental chat persistence is read-only')
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
    if (!canWrite()) throw new Error('Incremental chat persistence is read-only')
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

  const checkpointChat = (chatId: string): boolean => {
    if (!canWrite()) return false
    // Nothing appended since the last checkpoint: a rewrite would burn a full
    // record write for zero replay-bounding benefit.
    if ((appendsSinceCheckpointByChatId.get(chatId) ?? 0) === 0) return false
    try {
      const checkpointed = journal.checkpoint(chatId, 'idle')
      if (checkpointed) {
        noteCheckpoint(chatId)
        idleCheckpoints += 1
      }
      return checkpointed
    } catch (error) {
      failures += 1
      logger.error('[incremental-chat] deferred chat checkpoint failed', error)
      return false
    }
  }

  const checkpointChatDeferred = async (chatId: string): Promise<DeferredCheckpointResult> => {
    if (!canWrite() || !journal.checkpointDeferred) return 'unavailable'
    const head = headRecordByChatId.get(chatId)
    try {
      const result = await journal.checkpointDeferred(chatId)
      if (result === 'checkpointed') {
        // A newer save may have run between adoption and this continuation.
        // Overcounting is conservative; resetting its byte count is not.
        if (headRecordByChatId.get(chatId) === head) noteCheckpoint(chatId)
        idleCheckpoints += 1
      }
      return result
    } catch (error) {
      failures += 1
      logger.error('[incremental-chat] deferred preparation failed', error)
      return 'unavailable'
    }
  }

  const checkpointIdleDeferred = async (nowMs?: number): Promise<number> => {
    if (!canWrite() || !journal.checkpointIdleDeferred) return 0
    const count = await journal.checkpointIdleDeferred(nowMs)
    idleCheckpoints += count
    return count
  }

  const appendsSinceCheckpoint = (chatId: string): number =>
    appendsSinceCheckpointByChatId.get(chatId) ?? 0

  const pendingMutationBytes = (chatId: string): number =>
    pendingMutationBytesByChatId.get(chatId) ?? 0

  const purge = (chatId: string): void => {
    if (!canWrite()) throw new Error('Incremental chat persistence is read-only')
    journal.purge(chatId)
    headRecordByChatId.delete(chatId)
    baselineVerifiedChatIds.delete(chatId)
    lastPersistedRevisionByChatId.delete(chatId)
    appendsSinceCheckpointByChatId.delete(chatId)
    pendingMutationBytesByChatId.delete(chatId)
  }

  const clear = (): void => {
    if (!canWrite()) throw new Error('Incremental chat persistence is read-only')
    journal.clear()
    headRecordByChatId.clear()
    baselineVerifiedChatIds.clear()
    lastPersistedRevisionByChatId.clear()
    appendsSinceCheckpointByChatId.clear()
    pendingMutationBytesByChatId.clear()
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
    terminalCheckpointsDeferred,
    idleCheckpoints,
    shutdownCheckpoints,
    failures,
    journal: journal.stats()
  })

  return {
    persist,
    verify,
    replay: (chatId) => journal.replay(chatId),
    awaitDeferredDurability: (chatId) => {
      if (!journal.awaitDeferredDurability)
        return Promise.reject(new Error('Journal durability acknowledgement unavailable'))
      return journal.awaitDeferredDurability(chatId)
    },
    pendingReplayState: (chatId) => journal.pendingReplayState(chatId),
    replaceAuthoritative,
    checkpointIdle,
    checkpointAll,
    checkpointChat,
    checkpointChatDeferred,
    checkpointIdleDeferred,
    cancelCheckpointPreparations: (chatId) => journal.cancelCheckpointPreparations?.(chatId),
    appendsSinceCheckpoint,
    pendingMutationBytes,
    purge,
    clear,
    stats
  }
}
