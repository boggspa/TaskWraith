import {
  LIVE_TOOL_DETAIL_EXTERNALIZE_BYTES,
  authoredMutationMentionsActivityIds,
  estimateLiveToolActivityDetailBytes,
  externalizeToolActivityDetails,
  substituteToolActivitiesInAuthoredMutation
} from './ChatToolDetailExternalization'
import { compactChatForPersist } from './ChatCompaction'
import type { AuthoredChatTranscriptMutation } from './ChatRecordMutation'
import type { ChatRecord, ToolActivity, ToolActivityDetailRef } from './types'

export interface ChatPersistenceDetailBatch<TCheckpoint> {
  stage(runId: string, activity: ToolActivity): ToolActivityDetailRef | null
  commit(): readonly TCheckpoint[]
}

export interface ChatPersistencePreparationResult {
  chat: ChatRecord
  authoredTranscript?: AuthoredChatTranscriptMutation
  /** True requires the caller's conservative full-record durability fallback. */
  externalizationFailed: boolean
}

function hasUnexternalizedJumboLiveToolDetail(chat: ChatRecord): boolean {
  const activeRunIds = new Set(
    chat.runs
      .filter((run) =>
        ['running', 'pending', 'starting', 'sleeping'].includes(
          String(run.status || '').toLowerCase()
        )
      )
      .map((run) => run.runId)
  )
  if (activeRunIds.size === 0) return false
  for (const message of chat.messages) {
    if (!message.runId || !activeRunIds.has(message.runId)) continue
    for (const activity of message.toolActivities ?? []) {
      const sealed =
        (activity.status === 'success' ||
          activity.status === 'warning' ||
          activity.status === 'error') &&
        Boolean(activity.endedAt)
      const carriesRaw =
        activity.parameters !== undefined ||
        activity.rawUseEvent !== undefined ||
        activity.rawResultEvent !== undefined
      if (
        sealed &&
        carriesRaw &&
        !activity.detailRef &&
        estimateLiveToolActivityDetailBytes(activity) >= LIVE_TOOL_DETAIL_EXTERNALIZE_BYTES
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * Shared D4 preparation for legacy-admitted and Host-routed chat persistence.
 *
 * Ordering is deliberate: stage complete detail -> commit/fsync the batch ->
 * persist its strict checkpoint -> publish stripped chat rows. A thrown
 * preparation failure retains the original inline rows; a failed individual
 * stage leaves that activity inline. Both tell the caller to materialize its
 * full compatibility record. The helper owns no paths or stores; all I/O
 * authority arrives through the injected batch/read/checkpoint ports.
 */
export function prepareChatForPersistence<TCheckpoint>(input: {
  chat: ChatRecord
  previous: ChatRecord | null
  authoredTranscript?: AuthoredChatTranscriptMutation
  authoredTranscriptEligible: boolean
  createDetailBatch: () => ChatPersistenceDetailBatch<TCheckpoint>
  readArchivedDetail: (ref: ToolActivityDetailRef) => ToolActivity | null
  persistDetailCheckpoint: (checkpoint: TCheckpoint) => void
  maxTerminalRunsPerPass: number
}): ChatPersistencePreparationResult {
  let externalizedChat = input.chat
  let externalizedActivitiesById: ReadonlyMap<string, ToolActivity> = new Map()
  let externalizationOpRequiredIds: ReadonlySet<string> = new Set()
  let externalizationFailed = false
  try {
    const detailBatch = input.createDetailBatch()
    const externalization = externalizeToolActivityDetails(
      input.chat,
      (runId, activity) => detailBatch.stage(runId, activity),
      {
        previousChat: input.previous,
        readArchivedDetail: input.readArchivedDetail,
        maxTerminalRunsPerPass: input.maxTerminalRunsPerPass
      }
    )
    const checkpoints = detailBatch.commit()
    for (const checkpoint of checkpoints) input.persistDetailCheckpoint(checkpoint)
    externalizedChat = externalization.chat
    externalizedActivitiesById = externalization.strippedActivitiesById
    externalizationOpRequiredIds = externalization.opRequiredActivityIds
    if (hasUnexternalizedJumboLiveToolDetail(externalizedChat)) {
      externalizationFailed = true
    }
  } catch (error) {
    externalizationFailed = true
    console.error('Failed to externalize tool activity detail', error)
  }

  const compactedChat = compactChatForPersist(externalizedChat)
  const authoredCandidate =
    input.authoredTranscript &&
    input.authoredTranscriptEligible &&
    compactedChat.messages === externalizedChat.messages &&
    authoredMutationMentionsActivityIds(input.authoredTranscript, externalizationOpRequiredIds)
      ? input.authoredTranscript
      : undefined
  const authoredTranscript = authoredCandidate
    ? substituteToolActivitiesInAuthoredMutation(authoredCandidate, externalizedActivitiesById)
    : undefined
  return {
    chat: compactedChat,
    ...(authoredTranscript ? { authoredTranscript } : {}),
    externalizationFailed
  }
}
