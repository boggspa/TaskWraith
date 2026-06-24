import { randomUUID } from 'crypto'
import type { RunQueueJob, RunQueueJobFilter, RunQueueJobStatus } from './store/types'

export type RunQueueJobInput = Omit<
  RunQueueJob,
  'id' | 'createdAt' | 'updatedAt' | 'priority' | 'attempt' | 'status' | 'source'
> &
  Partial<
    Pick<
      RunQueueJob,
      'id' | 'createdAt' | 'updatedAt' | 'priority' | 'attempt' | 'status' | 'source'
    >
  >

export const ACTIVE_RUN_QUEUE_STATUSES: RunQueueJobStatus[] = ['starting', 'active', 'cancelling']
export const TERMINAL_RUN_QUEUE_STATUSES: RunQueueJobStatus[] = ['cancelled', 'failed', 'completed']

const RUN_QUEUE_NONTERMINAL_STATUS_SET: Record<RunQueueJobStatus, boolean> = {
  queued: true,
  steer_promoting: true,
  starting: true,
  active: true,
  paused: true,
  cancelling: true,
  cancelled: false,
  failed: false,
  completed: false
}

const RUN_QUEUE_STATUS_TRANSITIONS: Record<RunQueueJobStatus, ReadonlySet<RunQueueJobStatus>> = {
  queued: new Set([
    'queued',
    'starting',
    'active',
    'paused',
    'steer_promoting',
    'cancelling',
    'cancelled',
    'failed',
    'completed'
  ]),
  starting: new Set([
    'queued',
    'starting',
    'active',
    'paused',
    'cancelling',
    'cancelled',
    'failed',
    'completed'
  ]),
  active: new Set(['active', 'paused', 'cancelling', 'cancelled', 'failed', 'completed']),
  paused: new Set([
    'queued',
    'starting',
    'active',
    'paused',
    'cancelled',
    'failed',
    'completed'
  ]),
  steer_promoting: new Set([
    'queued',
    'steer_promoting',
    'starting',
    'cancelled',
    'failed',
    'completed'
  ]),
  cancelling: new Set(['cancelling', 'cancelled', 'failed']),
  cancelled: new Set(['cancelled']),
  failed: new Set(['failed']),
  completed: new Set(['completed'])
}

const RUN_QUEUE_STATUS_ORDER: Record<RunQueueJobStatus, number> = {
  active: 0,
  starting: 1,
  queued: 2,
  steer_promoting: 3,
  paused: 4,
  cancelling: 5,
  failed: 6,
  cancelled: 7,
  completed: 8
}

function isRunQueueJobStatus(value: unknown): value is RunQueueJobStatus {
  return (
    value === 'queued' ||
    value === 'steer_promoting' ||
    value === 'starting' ||
    value === 'active' ||
    value === 'paused' ||
    value === 'cancelling' ||
    value === 'cancelled' ||
    value === 'failed' ||
    value === 'completed'
  )
}

function normalizeStatus(value: unknown): RunQueueJobStatus {
  return isRunQueueJobStatus(value) ? value : 'queued'
}

function canTransitionRunQueueStatus(
  currentStatus: RunQueueJobStatus,
  nextStatus: RunQueueJobStatus
): boolean {
  if (currentStatus === nextStatus) return true
  if (isTerminalRunQueueStatus(currentStatus)) return false
  return RUN_QUEUE_STATUS_TRANSITIONS[currentStatus]?.has(nextStatus) ?? false
}

export function isTerminalRunQueueStatus(status: RunQueueJobStatus): boolean {
  return TERMINAL_RUN_QUEUE_STATUSES.includes(status)
}

export function isNonterminalRunQueueStatus(status: RunQueueJobStatus): boolean {
  return RUN_QUEUE_NONTERMINAL_STATUS_SET[status]
}

function compactPreview(value: string | undefined, maxLength = 240): string | undefined {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

export function createRunQueueJob(
  input: RunQueueJobInput,
  now: string = new Date().toISOString()
): RunQueueJob {
  const status = normalizeStatus(input.status)
  return {
    ...input,
    id: input.id || input.runId || randomUUID(),
    runId: input.runId || input.id || randomUUID(),
    workspacePath: input.workspacePath,
    provider: input.provider,
    source: input.source || 'manual',
    status,
    priority: Number.isFinite(input.priority) ? Number(input.priority) : 0,
    attempt: Number.isFinite(input.attempt) ? Math.max(1, Number(input.attempt)) : 1,
    promptPreview: compactPreview(
      input.promptPreview || input.request?.displayPrompt || input.request?.prompt
    ),
    createdAt: input.createdAt || now,
    updatedAt: now,
    enqueuedAt: status === 'queued' ? input.enqueuedAt || now : input.enqueuedAt,
    startedAt:
      status === 'starting' || status === 'active' || status === 'cancelling'
        ? input.startedAt || now
        : input.startedAt,
    completedAt: status === 'completed' ? input.completedAt || now : input.completedAt,
    cancelledAt: status === 'cancelled' ? input.cancelledAt || now : input.cancelledAt,
    failedAt: status === 'failed' ? input.failedAt || now : input.failedAt,
    endedAt: TERMINAL_RUN_QUEUE_STATUSES.includes(status) ? input.endedAt || now : input.endedAt
  }
}

export function updateRunQueueJobRecord(
  existing: RunQueueJob,
  partial: Partial<RunQueueJob>,
  now: string = new Date().toISOString()
): RunQueueJob {
  const requestedStatus = normalizeStatus(partial.status || existing.status)
  const status = canTransitionRunQueueStatus(existing.status, requestedStatus)
    ? requestedStatus
    : existing.status
  const next: RunQueueJob = {
    ...existing,
    ...partial,
    id: existing.id,
    runId: partial.runId || existing.runId,
    provider: partial.provider || existing.provider,
    workspacePath: partial.workspacePath || existing.workspacePath,
    source: partial.source || existing.source,
    status,
    priority: Number.isFinite(partial.priority) ? Number(partial.priority) : existing.priority,
    attempt: Number.isFinite(partial.attempt)
      ? Math.max(1, Number(partial.attempt))
      : existing.attempt,
    promptPreview: compactPreview(
      partial.promptPreview ||
        partial.request?.displayPrompt ||
        partial.request?.prompt ||
        existing.promptPreview
    ),
    updatedAt: now
  }

  if (status === 'queued') next.enqueuedAt = next.enqueuedAt || now
  if (status === 'starting' || status === 'active' || status === 'cancelling') {
    next.startedAt = next.startedAt || now
  }
  if (status === 'paused') next.pausedAt = next.pausedAt || now
  if (status === 'completed') {
    next.completedAt = next.completedAt || now
    next.endedAt = next.endedAt || now
  }
  if (status === 'failed') {
    next.failedAt = next.failedAt || now
    next.endedAt = next.endedAt || now
  }
  if (status === 'cancelled') {
    next.cancelledAt = next.cancelledAt || now
    next.endedAt = next.endedAt || now
  }
  if (status !== 'steer_promoting') {
    next.promotedAt = undefined
  }
  if (!RUN_QUEUE_NONTERMINAL_STATUS_SET[status]) {
    next.promotionAttempt = undefined
    next.transitionVersion = undefined
    next.promotionToken = undefined
    next.queueMessageId = undefined
  }

  return next
}

export function recoverInterruptedRunQueueJobs(
  jobs: RunQueueJob[],
  recoveredAt: string = new Date().toISOString()
): RunQueueJob[] {
  return jobs.map((job) => {
    if (!ACTIVE_RUN_QUEUE_STATUSES.includes(job.status)) return job
    return updateRunQueueJobRecord(
      job,
      {
        status: 'failed',
        statusReason: 'Interrupted by app shutdown before the run reached a terminal state.',
        lastError: job.lastError || 'Run interrupted by app shutdown.',
        recoveryReason: 'marked_failed_on_startup',
        processPid: undefined
      },
      recoveredAt
    )
  })
}

export function filterRunQueueJobs(
  jobs: RunQueueJob[],
  filter: RunQueueJobFilter = {}
): RunQueueJob[] {
  const statusSet = filter.statuses?.length ? new Set(filter.statuses) : null
  return jobs.filter((job) => {
    if (filter.workspaceId && job.workspaceId !== filter.workspaceId) return false
    if (filter.chatId && job.chatId !== filter.chatId) return false
    if (filter.provider && job.provider !== filter.provider) return false
    if (statusSet && !statusSet.has(job.status)) return false
    if (!filter.includeTerminal && !statusSet && TERMINAL_RUN_QUEUE_STATUSES.includes(job.status))
      return false
    return true
  })
}

export function sortRunQueueJobs(jobs: RunQueueJob[]): RunQueueJob[] {
  return [...jobs].sort((a, b) => {
    const statusDelta = RUN_QUEUE_STATUS_ORDER[a.status] - RUN_QUEUE_STATUS_ORDER[b.status]
    if (statusDelta !== 0) return statusDelta
    if (a.priority !== b.priority) return b.priority - a.priority
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  })
}

/**
 * Cap on retained terminal (completed/failed/cancelled) jobs. The run queue is
 * rewritten in full — synchronously, fsync'd, pretty-printed — on every job
 * save, so an unbounded history turns each run state change into an
 * ever-slower main-thread write (the file had grown to ~1.7MB / 1360 jobs).
 * Newest terminal jobs are kept.
 */
export const MAX_TERMINAL_RUN_QUEUE_JOBS = 500

function runQueueJobRecencyMs(job: RunQueueJob): number {
  const stamp = job.endedAt || job.failedAt || job.updatedAt || job.createdAt
  const ms = stamp ? Date.parse(stamp) : NaN
  return Number.isFinite(ms) ? ms : 0
}

/**
 * Drop the oldest terminal jobs beyond `maxTerminal`. In-flight jobs — anything
 * NOT terminal (queued/starting/steer_promoting/active/paused/cancelling) — are ALWAYS kept, so
 * startup recovery and live dispatch are never affected. Original array order is
 * preserved for kept jobs (callers sort separately).
 */
export function capRunQueueJobs(
  jobs: RunQueueJob[],
  maxTerminal = MAX_TERMINAL_RUN_QUEUE_JOBS
): RunQueueJob[] {
  const terminal = jobs.filter((job) => isTerminalRunQueueStatus(job.status))
  if (terminal.length <= maxTerminal) return jobs
  const keepTerminalIds = new Set(
    [...terminal]
      .sort((a, b) => runQueueJobRecencyMs(b) - runQueueJobRecencyMs(a))
      .slice(0, maxTerminal)
      .map((job) => job.id)
  )
  return jobs.filter(
    (job) => !isTerminalRunQueueStatus(job.status) || keepTerminalIds.has(job.id)
  )
}

/**
 * Scheduling decision: find the first runnable job that the caller says can
 * dispatch now. Pure function — the caller supplies a per-job predicate so this
 * stays decoupled from React refs / RunManager singletons.
 *
 * Extracted from the renderer's pump effect (App.tsx ~7374) so the same
 * decision can run in main (for future bridge-driven dequeues) without
 * forking the logic.
 *
 * Returns the index into `jobs` of the chosen job, or -1 when no job is
 * runnable (queue empty, or every queued job is blocked by the caller's
 * dispatch predicate).
 */
export function findNextRunnableQueueIndex<T>(jobs: T[], canDispatch: (job: T) => boolean): number {
  if (!jobs || jobs.length === 0) return -1
  return jobs.findIndex((job) => {
    const status = (job as { status?: unknown }).status
    if (status === 'steer_promoting') return false
    return canDispatch(job)
  })
}
