import type { RosterEditAction } from '../EnsembleRosterMutation'
import type {
  EnsembleConfig,
  EnsembleFanoutIsolation,
  EnsembleFanoutPolicy,
  EnsembleParticipant,
  EnsembleRoundState
} from '../store/types'
import type { EnsembleFanoutMode, EnsembleFanoutTargetStage } from './EnsembleOrchestratorTypes'

/**
 * Pure fan-out policy normalizers and await/result clamps extracted from
 * EnsembleOrchestrator. The 2026-09-01 On/Off collapse (retired levels map
 * to 'all') is preserved. This module does not change admission or
 * capability policy.
 */

const ENSEMBLE_FANOUT_POLICIES: EnsembleFanoutPolicy[] = [
  'off',
  'read_only',
  'all',
  'locked_writers_with_boss',
  'locked_writers_user_preflight'
]

export function normalizeFanoutMode(value: unknown): EnsembleFanoutMode | null {
  if (value === undefined || value === null || value === '') return 'read_only'
  return value === 'read_only' || value === 'locked_writers' ? value : null
}

/** undefined = not specified (inherit chat config); null = invalid input. */
export function normalizeFanoutIsolation(
  value: unknown
): EnsembleFanoutIsolation | null | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return value === 'worktree' || value === 'off' ? value : null
}

export const ENSEMBLE_AWAIT_POLL_INTERVAL_MS = 500
/**
 * Await budget (owner request 2026-08-05): authoritative seats may hold a
 * fan-out JOIN open for up to 10 minutes per explicit call. The 45-second
 * default stays below Kimi ACP's roughly 60-second native MCP request ceiling,
 * so an omitted timeout still returns a structured progress/check-in result.
 * The MCP
 * broker's long-poll allowance for ensemble_await is this ceiling + 30s grace
 * (MCP_BROKER_LONG_POLL_TIMEOUT_MS in mcp/McpBrokerTimeouts.ts — keep them in
 * lockstep) so the transport kill stays a liveness backstop, never the cap.
 */
export const ENSEMBLE_AWAIT_MAX_TIMEOUT_SECONDS = 600
export const ENSEMBLE_AWAIT_DEFAULT_TIMEOUT_SECONDS = 45
export const ENSEMBLE_LANE_RESULT_DEFAULT_MAX_CHARS = 20_000
export const ENSEMBLE_LANE_RESULT_MAX_CHARS = 60_000

/** null = invalid input; undefined = not provided (await the whole round). */
export function normalizeLaneIdList(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return null
  const laneIds = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
  if (laneIds.length === 0) return null
  return [...new Set(laneIds)]
}

export function clampAwaitTimeoutSeconds(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? value : NaN
  if (!Number.isFinite(requested)) return ENSEMBLE_AWAIT_DEFAULT_TIMEOUT_SECONDS
  return Math.max(5, Math.min(ENSEMBLE_AWAIT_MAX_TIMEOUT_SECONDS, Math.round(requested)))
}

export function clampLaneResultMaxChars(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? value : NaN
  if (!Number.isFinite(requested)) return ENSEMBLE_LANE_RESULT_DEFAULT_MAX_CHARS
  return Math.max(1_000, Math.min(ENSEMBLE_LANE_RESULT_MAX_CHARS, Math.round(requested)))
}

export function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function normalizeFanoutTargetStage(
  value: unknown
): EnsembleFanoutTargetStage | null | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  if (normalized === 'all' || normalized === 'anytyped' || normalized === 'typed') return 'all'
  if (
    normalized === 'scout' ||
    normalized === 'scouts' ||
    normalized === 'reader' ||
    normalized === 'readers' ||
    normalized === 'recon'
  ) {
    return 'scouts'
  }
  if (
    normalized === 'worker' ||
    normalized === 'workers' ||
    normalized === 'writer' ||
    normalized === 'writers'
  ) {
    return 'workers'
  }
  if (normalized === 'review' || normalized === 'reviewer' || normalized === 'reviewers') {
    return 'reviewers'
  }
  if (normalized === 'bg' || normalized === 'background' || normalized === 'backgrounds') {
    return 'backgrounds'
  }
  return null
}

export function fanoutTargetStageLabel(targetStage: EnsembleFanoutTargetStage | undefined): string {
  if (targetStage === 'scouts') return 'Scout fan-out'
  if (targetStage === 'workers') return 'Worker fan-out'
  if (targetStage === 'reviewers') return 'Review fan-out'
  if (targetStage === 'backgrounds') return 'Background fan-out'
  if (targetStage === 'all') return 'Ensemble fan-out'
  return 'Parallel fan-out'
}

export function fanoutTargetStageMatches(
  participant: EnsembleParticipant,
  targetStage: EnsembleFanoutTargetStage | undefined
): boolean {
  if (!targetStage) return true
  if (targetStage === 'all') {
    return (
      participant.stageRole === 'scout' ||
      participant.stageRole === 'worker' ||
      participant.stageRole === 'reviewer' ||
      participant.stageRole === 'background'
    )
  }
  if (targetStage === 'scouts') return participant.stageRole === 'scout'
  if (targetStage === 'workers') return participant.stageRole === 'worker'
  if (targetStage === 'reviewers') return participant.stageRole === 'reviewer'
  return participant.stageRole === 'background'
}

export function isBackgroundParticipant(participant: EnsembleParticipant): boolean {
  return participant.stageRole === 'background'
}

export function fanoutPolicyAllowsRead(policy: EnsembleFanoutPolicy): boolean {
  return policy === 'read_only' || policy === 'all'
}

export function fanoutPolicyAllowsWriters(policy: EnsembleFanoutPolicy): boolean {
  return (
    policy === 'all' ||
    policy === 'locked_writers_with_boss' ||
    policy === 'locked_writers_user_preflight'
  )
}

export function isRosterEditAction(value: string): value is RosterEditAction {
  return (
    value === 'add_participant' || value === 'remove_participant' || value === 'edit_participant'
  )
}

export function isEnsembleFanoutPolicy(value: unknown): value is EnsembleFanoutPolicy {
  return (
    typeof value === 'string' && ENSEMBLE_FANOUT_POLICIES.includes(value as EnsembleFanoutPolicy)
  )
}

export function fanoutPolicyEnablesConcurrent(policy: EnsembleFanoutPolicy): boolean {
  return policy !== 'off'
}

export function resolveEnsembleFanoutPolicy(
  input:
    | Pick<EnsembleConfig, 'fanoutPolicy' | 'concurrentModeEnabled'>
    | Pick<EnsembleRoundState, 'fanoutPolicy' | 'concurrentMode'>
    | {
        fanoutPolicy?: unknown
        concurrentModeEnabled?: boolean
        concurrentMode?: boolean
      }
    | null
    | undefined
): EnsembleFanoutPolicy {
  const raw = (input || {}) as {
    fanoutPolicy?: unknown
    concurrentMode?: boolean
    concurrentModeEnabled?: boolean
  }
  // Fan-out is On/Off now (2026-09-01): On carries the old 'all' semantics —
  // read/review waves plus writer lanes (Boss writeScopes or user preflight,
  // resolved at dispatch). The retired 'read_only' / 'locked_writers_*'
  // levels and the legacy concurrent booleans all collapse to 'all'; every
  // per-lane write gate (writeScopes admission, preflight, workspace locks)
  // is policy-independent and unchanged.
  if (isEnsembleFanoutPolicy(raw.fanoutPolicy)) {
    return raw.fanoutPolicy === 'off' ? 'off' : 'all'
  }
  if (raw.concurrentMode === true || raw.concurrentModeEnabled === true) {
    return 'all'
  }
  return 'off'
}

export function resolveRequestedEnsembleFanoutPolicy(
  config: Pick<EnsembleConfig, 'fanoutPolicy' | 'concurrentModeEnabled'> | null | undefined,
  input: { fanoutPolicy?: unknown; concurrentMode?: boolean } = {}
): EnsembleFanoutPolicy {
  if (input.fanoutPolicy !== undefined) {
    return resolveEnsembleFanoutPolicy({ fanoutPolicy: input.fanoutPolicy })
  }
  if (input.concurrentMode !== undefined) {
    return resolveEnsembleFanoutPolicy({ concurrentMode: input.concurrentMode })
  }
  return resolveEnsembleFanoutPolicy(config)
}
