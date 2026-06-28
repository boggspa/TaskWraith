import type { ScheduledTask } from '../../../main/store/types'

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

function parseRunAtMs(runAt: string): number | null {
  const ms = new Date(runAt).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function formatScheduleCountdown(runAt: string, nowMs = Date.now()): string {
  const targetMs = parseRunAtMs(runAt)
  if (targetMs === null) return 'unscheduled'
  const remainingMs = targetMs - nowMs
  if (remainingMs <= 0) return 'due now'

  const days = Math.floor(remainingMs / DAY_MS)
  const hours = Math.floor((remainingMs % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS)
  const seconds = Math.max(0, Math.ceil((remainingMs % MINUTE_MS) / SECOND_MS))

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function formatScheduledTaskCountdown(
  task: Pick<ScheduledTask, 'runAt' | 'status'>,
  nowMs = Date.now()
): string {
  if (task.status === 'running') return 'running'
  if (task.status === 'due') return 'due / waiting'
  const countdown = formatScheduleCountdown(task.runAt, nowMs)
  return countdown === 'due now' ? 'due / waiting' : `in ${countdown}`
}
