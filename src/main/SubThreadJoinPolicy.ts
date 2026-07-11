import type { SubThreadJoinPolicy } from './store/types'

export const DEFAULT_SUBTHREAD_JOIN_DEBOUNCE_MS = 350
export const MAX_SUBTHREAD_JOIN_DEBOUNCE_MS = 5_000
export const DEFAULT_SUBTHREAD_JOIN_DEADLINE_MS = 5 * 60_000
export const MAX_SUBTHREAD_JOIN_DEADLINE_MS = 60 * 60_000
export const MAX_SUBTHREAD_JOIN_QUORUM = 20

export interface SubThreadJoinPolicyRequest {
  required?: boolean
  quorum?: number
  deadlineMs?: number
  debounceMs?: number
}

export interface SubThreadJoinWorkerState {
  subThreadId: string
  workerRunId?: string
  policy: SubThreadJoinPolicy
  terminal?: {
    at: string
    outcome: 'done' | 'requires_action' | 'failed' | 'cancelled'
  }
}

export interface SubThreadJoinEvaluation {
  status: 'waiting' | 'debouncing' | 'ready' | 'deadline'
  groupId: string
  requiredWorkers: number
  terminalRequiredWorkers: number
  terminalWorkers: number
  quorum: number
  missingRequiredSubThreadIds: string[]
  readyAt?: string
  deadlineAt: string
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function timestampMs(value: string | undefined, fallback: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

export function resolveSubThreadJoinPolicy(
  request: SubThreadJoinPolicyRequest | null | undefined,
  context: { groupId: string; nowMs?: number }
): SubThreadJoinPolicy {
  const nowMs = context.nowMs ?? Date.now()
  const groupId = context.groupId.trim()
  if (!groupId) throw new Error('Sub-thread join policy requires a group id.')
  const deadlineMs = boundedInteger(
    request?.deadlineMs,
    DEFAULT_SUBTHREAD_JOIN_DEADLINE_MS,
    1_000,
    MAX_SUBTHREAD_JOIN_DEADLINE_MS
  )
  return {
    schemaVersion: 1,
    groupId,
    required: request?.required !== false,
    ...(typeof request?.quorum === 'number' && Number.isFinite(request.quorum)
      ? {
          quorum: boundedInteger(
            request.quorum,
            MAX_SUBTHREAD_JOIN_QUORUM,
            1,
            MAX_SUBTHREAD_JOIN_QUORUM
          )
        }
      : {}),
    debounceMs: boundedInteger(
      request?.debounceMs,
      DEFAULT_SUBTHREAD_JOIN_DEBOUNCE_MS,
      0,
      MAX_SUBTHREAD_JOIN_DEBOUNCE_MS
    ),
    armedAt: new Date(nowMs).toISOString(),
    deadlineAt: new Date(nowMs + deadlineMs).toISOString()
  }
}

export function bindSubThreadJoinPolicyToRun(
  policy: SubThreadJoinPolicy,
  workerRunId: string
): SubThreadJoinPolicy {
  const normalizedRunId = workerRunId.trim()
  if (!normalizedRunId) throw new Error('Sub-thread join policy requires a worker run id.')
  return { ...policy, workerRunId: normalizedRunId }
}

export function evaluateSubThreadJoin(
  workers: readonly SubThreadJoinWorkerState[],
  options: { nowMs?: number } = {}
): SubThreadJoinEvaluation | null {
  if (workers.length === 0) return null
  const nowMs = options.nowMs ?? Date.now()
  const groupId = workers[0].policy.groupId
  const groupWorkers = workers.filter((worker) => worker.policy.groupId === groupId)
  if (groupWorkers.length === 0) return null

  const requiredWorkers = groupWorkers.filter((worker) => worker.policy.required)
  const terminalWorkers = groupWorkers.filter((worker) => Boolean(worker.terminal))
  const terminalRequiredWorkers = requiredWorkers.filter((worker) => Boolean(worker.terminal))
  const configuredQuorums = groupWorkers
    .map((worker) => worker.policy.quorum)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const configuredQuorum = configuredQuorums.length
    ? Math.max(...configuredQuorums)
    : requiredWorkers.length
  const quorum =
    requiredWorkers.length === 0
      ? 0
      : Math.max(1, configuredQuorum)
  const deadlineMs = Math.min(
    ...groupWorkers.map((worker) => timestampMs(worker.policy.deadlineAt, nowMs))
  )
  const missingRequiredSubThreadIds = requiredWorkers
    .filter((worker) => !worker.terminal)
    .map((worker) => worker.subThreadId)
  const base = {
    groupId,
    requiredWorkers: requiredWorkers.length,
    terminalRequiredWorkers: terminalRequiredWorkers.length,
    terminalWorkers: terminalWorkers.length,
    quorum,
    missingRequiredSubThreadIds,
    deadlineAt: new Date(deadlineMs).toISOString()
  }

  if (nowMs >= deadlineMs) return { ...base, status: 'deadline' }

  const quorumSatisfied =
    requiredWorkers.length === 0
      ? terminalWorkers.length > 0
      : terminalRequiredWorkers.length >= quorum
  if (!quorumSatisfied) return { ...base, status: 'waiting' }

  const lastTerminalAtMs = Math.max(
    ...terminalWorkers.map((worker) => timestampMs(worker.terminal?.at, nowMs))
  )
  const debounceMs = Math.max(...groupWorkers.map((worker) => worker.policy.debounceMs), 0)
  const readyAtMs = lastTerminalAtMs + debounceMs
  if (nowMs < readyAtMs) {
    return { ...base, status: 'debouncing', readyAt: new Date(readyAtMs).toISOString() }
  }
  return { ...base, status: 'ready', readyAt: new Date(readyAtMs).toISOString() }
}
