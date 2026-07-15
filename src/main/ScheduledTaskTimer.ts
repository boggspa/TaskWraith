import type { ScheduledTask } from './store/types'

export const SCHEDULED_DUE_RETRY_DELAY_MS = 1_000

type NowProvider = { nowMs?: number }

interface ScheduledTaskTimerInputs extends NowProvider {
  tasks: readonly ScheduledTask[]
  nextWorkflowRunAtMs: number | null | undefined
  nextIntrospectionRunAtMs?: number | null | undefined
}

function parseRunAtMs(runAt: unknown): number {
  return typeof runAt === 'string' ? Date.parse(runAt) : Number.NaN
}

/**
 * Returns the next absolute wall-clock timestamp (in ms) that should trigger
 * scheduled-task processing, or null when there is no known candidate.
 */
export function getNextScheduledTaskRunAtMs({
  tasks,
  nextWorkflowRunAtMs,
  nextIntrospectionRunAtMs,
  nowMs = Date.now()
}: ScheduledTaskTimerInputs): number | null {
  const candidates: number[] = []

  for (const task of tasks) {
    if (task.status === 'due') {
      const runAtMs = parseRunAtMs(task.runAt)
      if (Number.isFinite(runAtMs)) {
        candidates.push(runAtMs <= nowMs ? nowMs + SCHEDULED_DUE_RETRY_DELAY_MS : runAtMs)
      }
      continue
    }
    if (task.status !== 'pending') continue
    const runAtMs = parseRunAtMs(task.runAt)
    if (Number.isFinite(runAtMs)) candidates.push(runAtMs)
  }

  if (typeof nextWorkflowRunAtMs === 'number' && Number.isFinite(nextWorkflowRunAtMs)) {
    candidates.push(nextWorkflowRunAtMs)
  }

  if (typeof nextIntrospectionRunAtMs === 'number' && Number.isFinite(nextIntrospectionRunAtMs)) {
    candidates.push(nextIntrospectionRunAtMs)
  }

  if (candidates.length === 0) return null
  return Math.min(...candidates)
}
