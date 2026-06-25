import type { ScheduledTask } from './store/types'

type NowProvider = { nowMs?: number }

interface ScheduledTaskTimerInputs extends NowProvider {
  tasks: readonly ScheduledTask[]
  nextWorkflowRunAtMs: number | null | undefined
}

function parseRunAtMs(runAt: string): number {
  return new Date(runAt).getTime()
}

/**
 * Returns the next absolute wall-clock timestamp (in ms) that should trigger
 * scheduled-task processing, or null when there is no known candidate.
 */
export function getNextScheduledTaskRunAtMs({
  tasks,
  nextWorkflowRunAtMs,
  nowMs = Date.now()
}: ScheduledTaskTimerInputs): number | null {
  const candidates: number[] = []

  for (const task of tasks) {
    if (task.status === 'due') {
      candidates.push(nowMs)
      continue
    }
    if (task.status !== 'pending') continue
    const runAtMs = parseRunAtMs(task.runAt)
    if (Number.isFinite(runAtMs)) candidates.push(runAtMs)
  }

  if (typeof nextWorkflowRunAtMs === 'number' && Number.isFinite(nextWorkflowRunAtMs)) {
    candidates.push(nextWorkflowRunAtMs)
  }

  if (candidates.length === 0) return null
  return Math.min(...candidates)
}
