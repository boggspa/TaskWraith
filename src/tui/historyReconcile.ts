import type { HostHistorySinceResult } from '../shared/hostHistoryProtocol'
import type { TaskWraithControlThreadSnapshot } from '../shared/taskWraithControlProtocol'
import type { TuiHistoryState } from './state'

export type TuiHistoryReconcileDecision = 'apply' | 'ignore' | 'reload'

/** Classify an async history response against the cursor that is authoritative now. */
export function classifyHistoryResult(
  history: TuiHistoryState,
  result: HostHistorySinceResult
): TuiHistoryReconcileDecision {
  if (result.threadId !== history.threadId) return 'ignore'
  if (result.kind === 'full_resnapshot_required') {
    return result.clientGeneration === history.generation && result.clientCursor === history.cursor
      ? 'reload'
      : 'ignore'
  }
  if (result.generation < history.generation) return 'ignore'
  if (result.generation > history.generation) return 'reload'
  if (result.fromCursor === history.cursor) return 'apply'
  if (result.fromCursor < history.cursor && result.toCursor <= history.cursor) return 'ignore'
  return 'reload'
}

/** Refresh thread metadata without replacing authoritative transcript rows with a preview. */
export function preserveAuthoritativeHistoryRows(
  current: TaskWraithControlThreadSnapshot | undefined,
  incoming: TaskWraithControlThreadSnapshot,
  history: TuiHistoryState | undefined
): TaskWraithControlThreadSnapshot {
  if (
    !current ||
    current.thread.id !== incoming.thread.id ||
    history?.threadId !== incoming.thread.id ||
    history.previewOnly
  ) {
    return incoming
  }
  return {
    ...incoming,
    rows: current.rows,
    totalRows: current.totalRows,
    hasMoreAbove: current.hasMoreAbove
  }
}
