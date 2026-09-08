import { isDeepStrictEqual } from 'node:util'
import type { IncrementalChatPendingReplayState } from './IncrementalChatJournal'
import type { ChatRecord } from './types'

export interface CanonicalCatalogueReadSources {
  chatId: string
  /** Missing legacy files are deletion/absence, not permission to resurrect a mirror. */
  legacyFileExists: boolean
  normalize(record: ChatRecord): ChatRecord
  readLegacy(): ChatRecord | null
  readIncremental(): ChatRecord | null
  pendingReplayState(): IncrementalChatPendingReplayState
  readSegmented?: () => ChatRecord | null
  logger?: Pick<Console, 'error' | 'warn'>
}

function revision(record: ChatRecord): number {
  const value = record.persistenceRevision
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0
}

/**
 * The canonical source-selection contract shared with the history worker.
 * Legacy wins an equal-revision disagreement. A healthy leading journal or
 * opted-in segmented record must remain visible during compatibility lag.
 * These callbacks may decode complete histories; callers choose the process.
 */
export function readCanonicalCatalogueChat(
  sources: CanonicalCatalogueReadSources
): ChatRecord | null {
  const { chatId, normalize } = sources
  if (!sources.legacyFileExists) return null
  const logger = sources.logger ?? console
  let segmented: ChatRecord | null = null
  if (sources.readSegmented) {
    try {
      const candidate = sources.readSegmented()
      segmented = candidate ? normalize(candidate) : null
    } catch (error) {
      logger.error(
        `[chat-store-v2] read failed for ${chatId}; using the compatibility record`,
        error
      )
    }
  }

  const legacy = sources.readLegacy()
  if (!legacy) return segmented
  const legacyRecord = normalize(legacy)
  const legacyRevision = revision(legacyRecord)
  let record = legacyRecord
  const pending = sources.pendingReplayState()
  const replayCannotLead =
    !pending.hasTail &&
    pending.checkpointRevision !== null &&
    pending.checkpointRevision <= legacyRevision
  try {
    const replayed = replayCannotLead ? null : sources.readIncremental()
    if (replayed) {
      const incremental = normalize(replayed)
      const incrementalRevision = revision(incremental)
      if (
        incrementalRevision > legacyRevision ||
        (incrementalRevision === legacyRevision && isDeepStrictEqual(incremental, legacyRecord))
      ) {
        record = incremental
      } else if (incrementalRevision === legacyRevision) {
        logger.warn(
          `[incremental-chat] equal-revision replay mismatch for ${chatId}; ` +
            'using the compatibility checkpoint'
        )
      }
    }
  } catch (error) {
    logger.error(
      `[incremental-chat] replay failed for ${chatId}; using the compatibility checkpoint`,
      error
    )
  }

  if (
    segmented &&
    (revision(segmented) > revision(record) ||
      (revision(segmented) === revision(record) && isDeepStrictEqual(segmented, record)))
  ) {
    record = segmented
  }
  return record
}
