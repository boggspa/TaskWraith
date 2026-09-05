import { hostComputeGoalRuntimeTiming as computeGoalRuntimeTiming } from '../../../host-shared/ActiveGoalContract'

export function formatGoalRuntimePopoverLabel(
  goal: any,
  nowMs: number,
  lastActivityAt?: number | string
): string | null {
  if (!goal?.runtimeLedger) return null
  const now = Number.isFinite(nowMs) ? new Date(nowMs) : new Date()
  // An open interval stops at the thread's last activity, so reopening a thread
  // whose goal was left `active` shows the time actually worked, not the days
  // since it was created.
  const timing = computeGoalRuntimeTiming(goal.runtimeLedger, now, {
    ...(lastActivityAt === undefined ? {} : { lastActivityAt })
  })
  const parts = [
    `wall ${formatGoalRuntimeDuration(timing.wallMs)}`,
    timing.activeMs > 0 ? `active ${formatGoalRuntimeDuration(timing.activeMs)}` : '',
    timing.blockedMs > 0 ? `blocked ${formatGoalRuntimeDuration(timing.blockedMs)}` : '',
    timing.pausedMs > 0 ? `paused ${formatGoalRuntimeDuration(timing.pausedMs)}` : ''
  ].filter(Boolean)
  return parts.length > 0 ? `Goal runtime · ${parts.join(' · ')}` : null
}

export function formatGoalRuntimeDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}
