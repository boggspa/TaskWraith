import type {
  ChatMessage,
  ChatRecord,
  ToolActivity,
  ToolActivityDetailRef
} from '../../../main/store/types'
import { TASKWRAITH_CLOSEOUT_KIND } from '../../../shared/taskWraithCloseout'
import {
  closeoutCommitActivityKind,
  collectCloseoutCommits,
  isMessageInRunWindow
} from './taskWraithCloseoutMessage'

/**
 * Close-outs written between tool-detail externalization landing and commit
 * evidence being stamped (2026-08-16 → -19) harvested zero commits: by the
 * time the round completed, the committing activities were already stripped to
 * a `detailRef`. The receipts still exist in the run-artifact archive, so a
 * commit-less close-out whose scope holds stripped git-commit activities can
 * be repaired — hydrate those details, re-run the harvest, and write the
 * tombstones the first build should have written. Repair touches close-out
 * metadata only; the transcript record stays stripped.
 */
export interface CloseoutCommitRepairTarget {
  closeoutMessageId: string
  refs: ToolActivityDetailRef[]
}

/** Matches the batched hydration IPC's bound (get-tool-activity-details). */
export const CLOSEOUT_COMMIT_REPAIR_REF_LIMIT = 512

type HydratedDetailLike = { ref: ToolActivityDetailRef; activity?: ToolActivity | null }

function isCloseoutMessage(message: ChatMessage): boolean {
  return message.metadata?.kind === TASKWRAITH_CLOSEOUT_KIND
}

function hasCommitTombstones(message: ChatMessage): boolean {
  const commits = message.metadata?.closeoutCommits
  return Array.isArray(commits) && commits.length > 0
}

function closeoutScopeFilter(
  chat: ChatRecord,
  closeout: ChatMessage
): ((message: ChatMessage) => boolean) | null {
  const metadata = closeout.metadata || {}
  const roundId = typeof metadata.closeoutRoundId === 'string' ? metadata.closeoutRoundId : null
  if (roundId) {
    return (message) => message.metadata?.ensembleRoundId === roundId
  }
  const runId = typeof metadata.sourceRunId === 'string' ? metadata.sourceRunId : null
  if (!runId) return null
  const run = (chat.runs || []).find((candidate) => candidate.runId === runId)
  return (message) => message.runId === runId || Boolean(run && isMessageInRunWindow(message, run))
}

/**
 * A stripped activity keeps only its identity, so only activities whose
 * surviving identity names git commit are worth hydrating: the dedicated tool
 * by name, or a shell row whose display text echoes the command. Plain shell
 * rows are unknowable without hydrating the whole round — skipped by design.
 */
function strippedCommitCandidateRef(activity: ToolActivity): ToolActivityDetailRef | null {
  const ref = activity.detailRef
  if (!ref || ref.storage !== 'run_event_artifact') return null
  if (activity.commitEvidence) return null
  if (
    activity.resultSummary !== undefined ||
    activity.outputPreview !== undefined ||
    activity.rawResultEvent !== undefined
  ) {
    return null
  }
  const kind = closeoutCommitActivityKind(activity)
  if (kind === 'dedicated') return ref
  if (kind !== 'shell') return null
  const text = `${activity.toolName || ''} ${activity.displayName || ''}`.toLowerCase()
  return text.includes('git commit') || text.includes('git_commit') ? ref : null
}

export function findCloseoutCommitRepairTargets(chat: ChatRecord): CloseoutCommitRepairTarget[] {
  const messages = chat.messages || []
  const closeouts = messages.filter(
    (message) => isCloseoutMessage(message) && !hasCommitTombstones(message)
  )
  if (closeouts.length === 0) return []

  const targets: CloseoutCommitRepairTarget[] = []
  for (const closeout of closeouts) {
    const includeMessage = closeoutScopeFilter(chat, closeout)
    if (!includeMessage) continue
    const refs: ToolActivityDetailRef[] = []
    for (const message of messages) {
      if (!includeMessage(message)) continue
      for (const activity of message.toolActivities || []) {
        const ref = strippedCommitCandidateRef(activity)
        if (ref) refs.push(ref)
      }
    }
    if (refs.length > 0) {
      targets.push({
        closeoutMessageId: closeout.id,
        refs: refs.slice(0, CLOSEOUT_COMMIT_REPAIR_REF_LIMIT)
      })
    }
  }
  return targets
}

const HYDRATABLE_FIELDS = [
  'parameters',
  'resultSummary',
  'outputPreview',
  'rawUseEvent',
  'rawResultEvent',
  'outputSummary'
] as const

function hydrateActivity(activity: ToolActivity, archived: ToolActivity): ToolActivity {
  const hydrated: ToolActivity = { ...activity }
  for (const field of HYDRATABLE_FIELDS) {
    if (hydrated[field] === undefined && archived[field] !== undefined) {
      ;(hydrated as unknown as Record<string, unknown>)[field] = archived[field]
    }
  }
  return hydrated
}

/**
 * Re-run the commit harvest over a copy of the transcript with the hydrated
 * archive details substituted in, then write the resulting tombstones onto the
 * commit-less close-out messages. Returns null when nothing was repaired.
 */
export function repairCloseoutCommitTombstones(
  chat: ChatRecord,
  hydrated: readonly HydratedDetailLike[]
): ChatRecord | null {
  const archivedByKey = new Map<string, ToolActivity>()
  for (const detail of hydrated) {
    if (!detail?.ref || !detail.activity) continue
    archivedByKey.set(`${detail.ref.runId}\n${detail.ref.activityId}`, detail.activity)
  }
  if (archivedByKey.size === 0) return null

  const hydratedMessages = (chat.messages || []).map((message) => {
    const activities = message.toolActivities
    if (!Array.isArray(activities) || activities.length === 0) return message
    let changed = false
    const next = activities.map((activity) => {
      const ref = activity.detailRef
      if (!ref) return activity
      const archived = archivedByKey.get(`${ref.runId}\n${ref.activityId}`)
      if (!archived) return activity
      changed = true
      return hydrateActivity(activity, archived)
    })
    return changed ? { ...message, toolActivities: next } : message
  })
  const hydratedChat: ChatRecord = { ...chat, messages: hydratedMessages }

  let repairedAny = false
  const repairedMessages = hydratedChat.messages.map((message) => {
    if (!isCloseoutMessage(message) || hasCommitTombstones(message)) return message
    const includeMessage = closeoutScopeFilter(hydratedChat, message)
    if (!includeMessage) return message
    const commits = collectCloseoutCommits(hydratedChat.messages, includeMessage, {
      chat: hydratedChat
    })
    if (commits.length === 0) return message
    repairedAny = true
    const previousReceipt = message.metadata?.closeoutReceipt
    const receipt =
      previousReceipt && typeof previousReceipt === 'object'
        ? {
            ...previousReceipt,
            observedCommitCount: Math.max(
              commits.length,
              Number((previousReceipt as { observedCommitCount?: number }).observedCommitCount) || 0
            )
          }
        : previousReceipt
    return {
      ...message,
      metadata: {
        ...(message.metadata || {}),
        closeoutCommits: commits,
        ...(receipt !== undefined ? { closeoutReceipt: receipt } : {})
      }
    }
  })
  if (!repairedAny) return null

  // Tombstones ride the ORIGINAL (stripped) messages — hydration was only ever
  // an input to the harvest, never something to persist back.
  const repairedById = new Map<string, ChatMessage>()
  for (const message of repairedMessages) {
    if (isCloseoutMessage(message)) repairedById.set(message.id, message)
  }
  return {
    ...chat,
    messages: (chat.messages || []).map((message) => repairedById.get(message.id) || message)
  }
}
