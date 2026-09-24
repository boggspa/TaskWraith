import type { ChatRun } from '../main/store/types'

const terminal = new Set([
  'success',
  'success_with_warnings',
  'succeeded',
  'completed',
  'failed',
  'error',
  'cancelled',
  'canceled'
])

/** A stale renderer snapshot cannot reactivate a run already settled by its source owner. */
export function preserveSettledRunSeals(
  incoming: readonly ChatRun[],
  previous: readonly ChatRun[]
): ChatRun[] {
  const settled = new Map(
    previous
      .filter((run) => run.staleSettlementProvenance && run.endedAt)
      .map((run) => [run.runId, run])
  )
  return incoming.map((run) => {
    const canonical = settled.get(run.runId)
    return canonical && !terminal.has(String(run.status ?? '').toLowerCase()) ? canonical : run
  })
}
