import type { LaunchAttempt } from '../../../main/launch/types'

export type LaunchAttemptRowTone = 'active' | 'pending' | 'done' | 'warn' | 'bad'

export interface LaunchAttemptRow {
  id: string
  label: string
  status: LaunchAttempt['status']
  statusLabel: string
  tone: LaunchAttemptRowTone
  provider: LaunchAttempt['provider']
  workspacePath: string
  workspaceName: string
  command: string
  cwd: string
  pid?: number
  chatId?: string
  runId?: string
  startedAt: string
  updatedAt: string
  duration: string
  active: boolean
  canStop: boolean
  outputPreview: string
  outputTruncated: boolean
  lastError?: string
}

const ACTIVE_STATUSES = new Set<LaunchAttempt['status']>(['starting', 'running', 'stopping'])
const STOPPABLE_STATUSES = new Set<LaunchAttempt['status']>(['starting', 'running'])

const STATUS_LABELS: Record<LaunchAttempt['status'], string> = {
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  stopped: 'Stopped',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted'
}

const STATUS_TONES: Record<LaunchAttempt['status'], LaunchAttemptRowTone> = {
  starting: 'pending',
  running: 'active',
  stopping: 'pending',
  stopped: 'done',
  failed: 'bad',
  cancelled: 'warn',
  interrupted: 'bad'
}

function parseTime(value: string | undefined): number {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

function formatElapsed(startedAt: string, endedAt: string | undefined, now: Date): string {
  const start = parseTime(startedAt)
  const end = parseTime(endedAt) || now.getTime()
  if (!start || !end || end < start) return ''
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function activeRank(status: LaunchAttempt['status']): number {
  if (status === 'running') return 0
  if (status === 'starting') return 1
  if (status === 'stopping') return 2
  if (status === 'failed' || status === 'interrupted') return 3
  if (status === 'cancelled') return 4
  return 5
}

function outputPreview(attempt: LaunchAttempt): string {
  const trimmed = attempt.outputTail.trim()
  if (!trimmed) return ''
  const lines = trimmed.split(/\r?\n/)
  return lines.slice(-8).join('\n')
}

export function isLaunchAttemptActive(status: LaunchAttempt['status']): boolean {
  return ACTIVE_STATUSES.has(status)
}

export function buildLaunchAttemptRows(
  attempts: LaunchAttempt[],
  now: Date = new Date()
): LaunchAttemptRow[] {
  return attempts
    .slice()
    .sort(
      (a, b) =>
        activeRank(a.status) - activeRank(b.status) ||
        parseTime(b.updatedAt) - parseTime(a.updatedAt) ||
        parseTime(b.startedAt) - parseTime(a.startedAt)
    )
    .map((attempt) => {
      const active = isLaunchAttemptActive(attempt.status)
      return {
        id: attempt.id,
        label: attempt.targetLabel || attempt.commandRaw || attempt.targetId,
        status: attempt.status,
        statusLabel: STATUS_LABELS[attempt.status],
        tone: STATUS_TONES[attempt.status],
        provider: attempt.provider,
        workspacePath: attempt.workspacePath,
        workspaceName: basename(attempt.workspacePath),
        command: attempt.commandRaw || attempt.argv.join(' '),
        cwd: attempt.cwd,
        pid: attempt.pid,
        chatId: attempt.chatId,
        runId: attempt.runId,
        startedAt: attempt.startedAt,
        updatedAt: attempt.updatedAt,
        duration: formatElapsed(
          attempt.startedAt,
          active ? undefined : attempt.endedAt || attempt.updatedAt,
          now
        ),
        active,
        canStop: STOPPABLE_STATUSES.has(attempt.status),
        outputPreview: outputPreview(attempt),
        outputTruncated: attempt.outputTruncated,
        lastError: attempt.lastError
      }
    })
}
