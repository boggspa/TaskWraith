/**
 * Display helpers for Thread Introspection daily schedule state.
 * Matches Main IPC contract: getIntrospectionSchedule / updateIntrospectionSchedule.
 */

export interface IntrospectionScheduleSettings {
  enabled: boolean
  workspaceId?: string | null
  lastRunAt?: string | null
  nextRunAt?: string | null
}

export function formatIntrospectionScheduleTimestamp(
  value: string | null | undefined
): string | null {
  if (!value) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export interface IntrospectionScheduleMetaInput {
  schedule: IntrospectionScheduleSettings | null
  loading?: boolean
  saving?: boolean
}

export function buildIntrospectionScheduleMetaLines(
  input: IntrospectionScheduleMetaInput
): string[] {
  const { schedule, loading = false, saving = false } = input
  if (loading) return ['Loading schedule…']
  if (saving) return ['Saving schedule…']

  if (!schedule) return []

  const lines: string[] = []
  const nextRun = formatIntrospectionScheduleTimestamp(schedule.nextRunAt)
  const lastRun = formatIntrospectionScheduleTimestamp(schedule.lastRunAt)

  if (schedule.enabled) {
    lines.push(nextRun ? `Next run ${nextRun}` : 'Next run pending')
  } else {
    lines.push('Daily run off')
  }

  if (lastRun) {
    lines.push(`Last scheduled run ${lastRun}`)
  }

  return lines
}

export function introspectionScheduleApiReady(api: {
  getIntrospectionSchedule?: unknown
  updateIntrospectionSchedule?: unknown
} | undefined): boolean {
  return (
    typeof api?.getIntrospectionSchedule === 'function' &&
    typeof api?.updateIntrospectionSchedule === 'function'
  )
}