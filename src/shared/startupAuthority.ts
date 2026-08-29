/**
 * Projection of workspace-lock startup-authority health, shared by main, the
 * preload bridge, and the renderer.
 *
 * It lives in shared/ because the renderer must render it and must not import
 * from `src/main/**` (scripts/architecture-guard.cjs). The behaviour that
 * produces it is in `src/main/startup/StartupAuthorityRecovery.ts`.
 */

export type StartupAuthorityFailureClass =
  | 'authority_busy'
  | 'wal_identity_conflict'
  | 'wal_corrupt'
  | 'authority_root_unavailable'
  | 'unknown'

export interface StartupAuthorityFailure {
  failureClass: StartupAuthorityFailureClass
  /** Transient contention is retryable; corruption and permission are not. */
  retryable: boolean
  message: string
}

export type StartupAuthorityStatus =
  | 'pending'
  | 'available'
  | 'retrying'
  | 'degraded'
  | 'permanently_failed'

export interface StartupAuthorityRecoveryState {
  status: StartupAuthorityStatus
  failure: StartupAuthorityFailure | null
  attempts: number
  /** Epoch ms of the next automatic attempt, or null when none is scheduled. */
  nextRetryAtMs: number | null
  lastAttemptAtMs: number | null
  /** A later attempt restored authority; mutation and admission are open again. */
  recoveredAfterRetry: boolean
  /** Boot-only run/schedule recovery a mid-session retry could not safely replay. */
  bootRecoveryIncomplete: boolean
}

/**
 * While this is true, workspace mutation, provider admission, run recovery and
 * scheduling are all fail-closed — the app is usable for reading and nothing
 * else. The 2026-08-29 startup matrix found this state reached only the
 * console, so a degraded launch was indistinguishable from a healthy one.
 */
export function startupAuthorityBlocksMutation(state: StartupAuthorityRecoveryState): boolean {
  return state.status === 'degraded' || state.status === 'permanently_failed'
}

export function startupAuthorityNeedsAttention(state: StartupAuthorityRecoveryState): boolean {
  return startupAuthorityBlocksMutation(state) || state.bootRecoveryIncomplete
}

/** One line a person can act on, derived from the machine-readable state. */
export function describeStartupAuthorityState(state: StartupAuthorityRecoveryState): string | null {
  if (state.status === 'available') {
    return state.bootRecoveryIncomplete
      ? 'Workspace locking is available again. Restart TaskWraith to finish recovering interrupted runs and schedules.'
      : null
  }
  if (state.status === 'pending') return null
  if (state.status === 'retrying') return 'Reconnecting to the workspace-lock authority…'
  if (state.status === 'permanently_failed') {
    return `Workspace locking is unavailable and will not recover on its own: ${state.failure?.message ?? 'unknown error'}`
  }
  return 'Another TaskWraith instance is holding the workspace-lock authority. Workspace edits, run recovery and scheduling stay disabled until it is available.'
}

/** Short chip label; the full sentence is the tooltip/body. */
export function startupAuthorityHeadline(state: StartupAuthorityRecoveryState): string | null {
  switch (state.status) {
    case 'degraded':
      return 'Workspace locking unavailable'
    case 'permanently_failed':
      return 'Workspace locking failed'
    case 'retrying':
      return 'Reconnecting…'
    case 'available':
      return state.bootRecoveryIncomplete ? 'Restart to finish recovery' : null
    default:
      return null
  }
}
