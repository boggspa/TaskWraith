import type { HostSnapshot } from '../shared/hostProtocol'
import type { TaskWraithTuiState, TuiQueuedDraft } from './state'

const LIVE_PROVIDER_OUTCOMES = new Set(['running', 'requires_action', 'unknown'])

/** Projected work ids, even when the coherent cache is awaiting a fresh read. */
export function projectedThreadWorkIds(
  snapshot: HostSnapshot | null | undefined,
  threadId: string
): string[] {
  if (!snapshot) return []
  const runs = snapshot.runs
    .filter(
      (run) =>
        run.threadId === threadId &&
        run.endedAt === undefined &&
        LIVE_PROVIDER_OUTCOMES.has(run.providerOutcome)
    )
    .map((run) => run.runId)
  const rounds = snapshot.rounds
    .filter(
      (round) =>
        round.threadId === threadId &&
        round.endedAt === undefined &&
        (round.status === 'running' || round.status === 'unknown')
    )
    .map((round) => round.roundId)
  return [...runs, ...rounds]
}

/** Exact live Host work that can still own the next provider turn for one thread. */
export function liveThreadWorkIds(
  snapshot: HostSnapshot | null | undefined,
  threadId: string
): string[] {
  return snapshot?.freshness === 'live' ? projectedThreadWorkIds(snapshot, threadId) : []
}

export function queuedDraftsForThread(
  state: Pick<TaskWraithTuiState, 'queuedDrafts'>,
  threadId: string | undefined
): TuiQueuedDraft[] {
  if (!threadId) return []
  return (state.queuedDrafts ?? []).filter((draft) => draft.threadId === threadId)
}

/**
 * Oldest dispatchable per-thread head. A busy thread never head-of-line blocks
 * an independent idle thread, while order inside each thread stays strict.
 */
export function nextDispatchableDraft(
  state: Pick<TaskWraithTuiState, 'queuedDrafts'>,
  snapshot: HostSnapshot | null | undefined,
  blockedDraftIds: ReadonlySet<string> = new Set(),
  blockedThreadIds: ReadonlySet<string> = new Set()
): TuiQueuedDraft | undefined {
  if (!snapshot || snapshot.freshness !== 'live') return undefined
  const heads = new Map<string, TuiQueuedDraft>()
  for (const draft of state.queuedDrafts ?? []) {
    if (!heads.has(draft.threadId)) heads.set(draft.threadId, draft)
  }
  return [...heads.values()]
    .filter((draft) => {
      if (
        draft.phase !== 'queued' ||
        blockedDraftIds.has(draft.id) ||
        blockedThreadIds.has(draft.threadId)
      ) {
        return false
      }
      const thread = snapshot.threads.find((candidate) => candidate.id === draft.threadId)
      return Boolean(
        thread && !thread.archived && liveThreadWorkIds(snapshot, draft.threadId).length === 0
      )
    })
    .sort((left, right) => left.enqueuedAt - right.enqueuedAt || left.id.localeCompare(right.id))[0]
}

export function replaceQueuedDraft(
  drafts: readonly TuiQueuedDraft[] | undefined,
  id: string,
  patch: Partial<Pick<TuiQueuedDraft, 'phase' | 'error'>>
): TuiQueuedDraft[] {
  return (drafts ?? []).map((draft) => (draft.id === id ? { ...draft, ...patch } : draft))
}

export function removeQueuedDraft(
  drafts: readonly TuiQueuedDraft[] | undefined,
  id: string
): TuiQueuedDraft[] {
  return (drafts ?? []).filter((draft) => draft.id !== id)
}
