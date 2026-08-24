/**
 * Pure density / rollup helpers for FleetWaveCard.
 *
 * Role literals are deliberately parallel to EnsembleStageRole — do NOT unify.
 */

import type { SeatChangeSeatState } from './seatChange'

/** Parallel to EnsembleStageRole — fleet has no `background`; do not unify. */
export type FleetWaveRole = 'scout' | 'worker' | 'reviewer'

export type FleetWaveAgentStatus = 'pending' | 'working' | 'needs_approval' | 'completed' | 'failed'

export type FleetWaveDensityTier = 'enumerate' | 'chips' | 'aggregate'

export interface FleetWavePendingApproval {
  approvalId: string
  scopeKey: string
  summary: string
  postureLabel?: string
}

export interface FleetWaveAgentState {
  id: string
  label: string
  role: FleetWaveRole | string
  status: FleetWaveAgentStatus
  provider?: string
  /** Resolves the Ollama/Pi upstream brand hue; plain providers ignore it. */
  model?: string
  /**
   * Exact execution-seat presentation projected from the delegated child run.
   * FleetWaveCard passes this to the same SeatChangeInlineStrip used by the
   * round close-out table, so provider/model/reasoning/permission never drift
   * into a fleet-only lookalike.
   */
  seat?: SeatChangeSeatState
  error?: string
  pendingApproval?: FleetWavePendingApproval
}

export interface FleetWaveTelemetry {
  waveId?: string
  status?: 'pending' | 'running' | 'needs_approval' | 'completed' | 'failed' | 'unknown'
  agents?: FleetWaveAgentState[]
  /** Collapsed elevation asks for the wave; optional UI surface on FleetWaveCard. */
  pendingApprovals?: FleetWavePendingApproval[]
  allowMultiProvider?: boolean
  parentProvider?: string
  startedAtMs?: number
  durationMs?: number
  totalTokens?: number
}

/**
 * Settings → General default for Max Wave Agents — how many workers one
 * `delegate_wave` call may spawn before the user raises the slider.
 *
 * 12 rather than the original 8 because 8 was an arbitrary starting point that
 * real work kept overrunning: a caller asked for a 12-agent fleet, was
 * refused, and split it into waves of 8 and 4 — two approvals, two joins, and
 * a roster the reader had to reassemble by hand. This is only where the slider
 * starts; the structural ceiling is unchanged.
 *
 * Lives in shared because BOTH sides need the number: main enforces it, and
 * the Settings hint states it. A renderer value-import from `src/main/**` is
 * the rollup-bind hazard this repo has been bitten by twice.
 */
export const DEFAULT_MAX_WAVE_AGENTS = 12

export function fleetWaveDensityTier(agentCount: number): FleetWaveDensityTier {
  const n = Math.max(0, Math.floor(agentCount))
  if (n <= 6) return 'enumerate'
  if (n <= 20) return 'chips'
  return 'aggregate'
}

/** Exceptions are named at every tier — never suppress failed / needs_approval. */
export function fleetWaveExceptions(agents: readonly FleetWaveAgentState[]): FleetWaveAgentState[] {
  return agents.filter((agent) => agent.status === 'failed' || agent.status === 'needs_approval')
}

export function fleetWaveRoleRollup(agents: readonly FleetWaveAgentState[]): Array<{
  role: string
  total: number
  completed: number
  working: number
  failed: number
  waiting: number
}> {
  const byRole = new Map<
    string,
    {
      role: string
      total: number
      completed: number
      working: number
      failed: number
      waiting: number
    }
  >()
  for (const agent of agents) {
    const role = String(agent.role || 'worker')
    const row = byRole.get(role) || {
      role,
      total: 0,
      completed: 0,
      working: 0,
      failed: 0,
      waiting: 0
    }
    row.total += 1
    if (agent.status === 'completed') row.completed += 1
    else if (agent.status === 'working' || agent.status === 'pending') row.working += 1
    else if (agent.status === 'failed') row.failed += 1
    else if (agent.status === 'needs_approval') row.waiting += 1
    byRole.set(role, row)
  }
  return [...byRole.values()]
}

/** Group pending approvals; Allow-all only when every entry shares scopeKey. */
export function groupPendingApprovalsByScope(
  approvals: readonly FleetWavePendingApproval[]
): { scopeKey: string; approvals: FleetWavePendingApproval[] }[] {
  const byScope = new Map<string, FleetWavePendingApproval[]>()
  for (const approval of approvals) {
    const key = approval.scopeKey.trim() || '__unset__'
    const list = byScope.get(key) || []
    list.push(approval)
    byScope.set(key, list)
  }
  return [...byScope.entries()].map(([scopeKey, list]) => ({ scopeKey, approvals: list }))
}

/** Density-strip cells in dispatch order — never re-sorted by status. */
export function fleetWaveGhostCellStates(
  agents: readonly FleetWaveAgentState[]
): Array<{ id: string; status: FleetWaveAgentStatus; provider?: string; model?: string }> {
  // provider/model ride along so an in-flight ghost can wear its agent's own
  // accent instead of a generic running colour. Both stay optional: a cell
  // without them inherits the card accent.
  return agents.map((agent) => ({
    id: agent.id,
    status: agent.status,
    ...(agent.provider ? { provider: agent.provider } : {}),
    ...(agent.model ? { model: agent.model } : {})
  }))
}

/** Agents that are not failed / needs_approval (exceptions stay named separately). */
export function fleetWaveHealthyCount(agents: readonly FleetWaveAgentState[]): number {
  return agents.filter((agent) => agent.status !== 'failed' && agent.status !== 'needs_approval')
    .length
}

/** Allow-all only when ≥2 pending approvals share one scopeKey. */
export function canAllowAllPendingApprovals(
  approvals: readonly FleetWavePendingApproval[]
): boolean {
  if (approvals.length < 2) return false
  const groups = groupPendingApprovalsByScope(approvals)
  return groups.length === 1
}
