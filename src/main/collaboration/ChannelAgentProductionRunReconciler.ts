import { isActiveRunSessionStatus, type RunSession, type RunSessionStatus } from '../RunManager'
import type { ProviderId } from '../store/types'
import type { ChannelAgentRunReconciliation } from './ChannelAgentDispatchRecovery'
import {
  ChannelAgentDispatchJournalState,
  type ChannelAgentDispatchJournalSnapshot
} from './ChannelAgentDispatchJournalState'

export interface ChannelAgentProductionRunView {
  readonly runId: string
  readonly provider: ProviderId
  readonly status: RunSessionStatus
}

export interface ChannelAgentProductionRunLookup {
  getRun(
    runId: string
  ):
    | Pick<RunSession, 'runId' | 'provider' | 'status'>
    | ChannelAgentProductionRunView
    | null
    | undefined
}

/**
 * Reconcile only process-owned exact-run liveness. A missing RunManager owner
 * is definitive for redispatch prevention, while a terminal session is kept
 * unavailable because RunManager does not retain the independently collected
 * provider output needed to synthesize a signed Channel reply.
 */
export function reconcileChannelAgentProductionRun(
  lookup: ChannelAgentProductionRunLookup,
  snapshot: ChannelAgentDispatchJournalSnapshot
): ChannelAgentRunReconciliation {
  if (!lookup || typeof lookup.getRun !== 'function') return { kind: 'unavailable' }
  let strict: ChannelAgentDispatchJournalSnapshot
  let directive: ReturnType<ChannelAgentDispatchJournalState['recoveryDirective']>
  try {
    const state = ChannelAgentDispatchJournalState.restore(snapshot)
    strict = state.snapshot()
    directive = state.recoveryDirective()
  } catch {
    return { kind: 'unavailable' }
  }
  if (directive !== 'reconcile_exact_run_without_redispatch') {
    return { kind: 'unavailable' }
  }
  const launches = strict.events.filter((event) => event.kind === 'launch.intent')
  if (launches.length !== 1) return { kind: 'unavailable' }
  const launch = launches[0]
  let run: ReturnType<ChannelAgentProductionRunLookup['getRun']>
  try {
    run = lookup.getRun(strict.binding.runId)
  } catch {
    return { kind: 'unavailable' }
  }
  if (!run) return { kind: 'definitively_absent' }
  if (
    run.runId !== strict.binding.runId ||
    run.provider !== launch.seal.provider ||
    typeof run.status !== 'string'
  ) {
    return { kind: 'unavailable' }
  }
  return isActiveRunSessionStatus(run.status) ? { kind: 'active' } : { kind: 'unavailable' }
}
