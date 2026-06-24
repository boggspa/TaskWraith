import { execFileSync } from 'child_process'
import { ACTIVE_RUN_QUEUE_STATUSES, updateRunQueueJobRecord } from './RunQueue'
import type {
  RunQueueJob,
  RunRecoveryFilter,
  RunRecoveryProcessSnapshot,
  RunRecoveryRecord
} from './store/types'

export const RUN_RECOVERY_SCHEMA_VERSION = 1

export interface RunRecoveryResult {
  jobs: RunQueueJob[]
  records: RunRecoveryRecord[]
}

export type ProcessInspector = (
  pid: number,
  checkedAt: string
) => RunRecoveryProcessSnapshot | undefined

function isValidPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function readProcessCommand(pid: number): string | undefined {
  if (process.platform === 'win32') return undefined
  try {
    const output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return output.trim() || undefined
  } catch {
    return undefined
  }
}

export function inspectProcessByPid(
  pid: number,
  checkedAt: string = new Date().toISOString()
): RunRecoveryProcessSnapshot | undefined {
  if (!isValidPid(pid)) return undefined
  try {
    process.kill(pid, 0)
    return {
      pid,
      checkedAt,
      alive: true,
      command: readProcessCommand(pid),
      detection: 'pid_signal_and_ps',
      action: 'left_running'
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return {
      pid,
      checkedAt,
      alive: code === 'EPERM',
      command: code === 'EPERM' ? readProcessCommand(pid) : undefined,
      errorCode: code,
      errorMessage: error instanceof Error ? error.message : String(error),
      detection: 'pid_signal',
      action: code === 'ESRCH' ? 'not_found' : code === 'EPERM' ? 'inaccessible' : 'unknown'
    }
  }
}

function resumeHintForJob(job: RunQueueJob): { resumeAvailable: boolean; resumeHint: string } {
  if (job.providerSessionId) {
    return {
      resumeAvailable: true,
      resumeHint:
        'A provider session id was recorded. TaskWraith cannot reattach to the interrupted process, but a follow-up turn can resume this provider thread.'
    }
  }
  return {
    resumeAvailable: false,
    resumeHint:
      'No provider session id was recorded, so this interrupted process cannot be resumed automatically.'
  }
}

function recoveryRecordForJob(
  original: RunQueueJob,
  recovered: RunQueueJob,
  processSnapshot: RunRecoveryProcessSnapshot | undefined,
  recoveredAt: string,
  reason: string,
  action?: RunRecoveryRecord['action']
): RunRecoveryRecord {
  const interrupted = ACTIVE_RUN_QUEUE_STATUSES.includes(original.status)
  const orphan = Boolean(processSnapshot?.alive)
  const { resumeAvailable, resumeHint } = resumeHintForJob(original)
  const resolvedAction: RunRecoveryRecord['action'] = action
    ? action
    : interrupted
      ? orphan
        ? 'marked_failed_orphan_detected'
        : 'marked_failed'
      : orphan
        ? 'cleared_stale_orphan_process'
        : 'cleared_stale_process'

  return {
    schemaVersion: RUN_RECOVERY_SCHEMA_VERSION,
    id: `${original.runId}-${recoveredAt}`,
    runId: original.runId,
    jobId: original.id,
    provider: original.provider,
    chatId: original.chatId,
    workspaceId: original.workspaceId,
    workspacePath: original.workspacePath,
    previousStatus: original.status,
    recoveredStatus: recovered.status,
    action: resolvedAction,
    reason,
    recoveredAt,
    process: processSnapshot,
    resumeAvailable,
    resumeHint,
    jobSnapshot: {
      providerSessionId: original.providerSessionId,
      providerRunId: original.providerRunId,
      promptPreview: original.promptPreview,
      startedAt: original.startedAt,
      updatedAt: original.updatedAt,
      processPid: original.processPid,
      processStartedAt: original.processStartedAt,
      processCommand: original.processCommand
    }
  }
}

function isExpiredSteerPromotingRun(
  job: RunQueueJob,
  recoveredAt: string
): boolean {
  void recoveredAt
  return job.status === 'steer_promoting'
}

function recoverStaleSteerPromotingJob(
  job: RunQueueJob,
  recoveredAt: string,
  processSnapshot: RunRecoveryProcessSnapshot | undefined
): RunQueueJob {
  const { resumeAvailable, resumeHint } = resumeHintForJob(job)
  return updateRunQueueJobRecord(
    job,
    {
      status: 'queued',
      statusReason:
        'Steer promotion state could not resume after app restart; rerunning from queued.',
      recoveryReason: 'stale_steer_promoting_recovered',
      processPid: undefined,
      orphanProcess: processSnapshot,
      recoveredAt,
      resumeAvailable,
      resumeHint,
      promotionOwnerToken: undefined,
      promotionToken: undefined,
      promotionAttempt: undefined,
      transitionVersion: undefined,
      promotedAt: undefined,
      queueMessageId: undefined
    },
    recoveredAt
  )
}

function recoverPausedRunWithStaleProcess(
  job: RunQueueJob,
  recoveredAt: string,
  processSnapshot: RunRecoveryProcessSnapshot
): RunQueueJob {
  return updateRunQueueJobRecord(
    job,
    {
      processPid: undefined,
      orphanProcess: processSnapshot,
      recoveredAt,
      recoveryReason: 'stale_process_for_paused_run_on_startup',
      statusReason: 'Paused run had stale process metadata; cleared process PID.'
    },
    recoveredAt
  )
}

function recoverInterruptedJob(
  job: RunQueueJob,
  recoveredAt: string,
  processSnapshot: RunRecoveryProcessSnapshot | undefined
): RunQueueJob {
  const { resumeAvailable, resumeHint } = resumeHintForJob(job)
  const orphan = Boolean(processSnapshot?.alive)
  return updateRunQueueJobRecord(
    job,
    {
      status: 'failed',
      statusReason: orphan
        ? `Interrupted by app shutdown; process ${processSnapshot?.pid} may still be running outside TaskWraith.`
        : 'Interrupted by app shutdown before the run reached a terminal state.',
      lastError: job.lastError || 'Run interrupted by app shutdown.',
      recoveryReason: orphan ? 'orphan_detected_on_startup' : 'marked_failed_on_startup',
      processPid: undefined,
      orphanProcess: processSnapshot,
      interruptedAt: recoveredAt,
      recoveredAt,
      resumeAvailable,
      resumeHint
    },
    recoveredAt
  )
}

function recoverStaleFailedProcess(
  job: RunQueueJob,
  recoveredAt: string,
  processSnapshot: RunRecoveryProcessSnapshot | undefined
): RunQueueJob {
  const { resumeAvailable, resumeHint } = resumeHintForJob(job)
  return updateRunQueueJobRecord(
    job,
    {
      status: 'failed',
      recoveryReason: processSnapshot?.alive
        ? 'orphan_detected_after_failure'
        : 'cleared_stale_failed_process_pid',
      processPid: undefined,
      orphanProcess: processSnapshot,
      recoveredAt,
      resumeAvailable,
      resumeHint
    },
    recoveredAt
  )
}

export function recoverRunQueueJobsAfterStartup(
  jobs: RunQueueJob[],
  recoveredAt: string = new Date().toISOString(),
  inspectProcess: ProcessInspector = inspectProcessByPid
): RunRecoveryResult {
  const records: RunRecoveryRecord[] = []
  const recoveredJobs = jobs.map((job) => {
    const isInterrupted = ACTIVE_RUN_QUEUE_STATUSES.includes(job.status)
    const hasStaleFailedProcess = job.status === 'failed' && isValidPid(job.processPid)
    const hasStalePausedProcess = job.status === 'paused' && isValidPid(job.processPid)
    const hasExpiredSteerState = isExpiredSteerPromotingRun(job, recoveredAt)
    if (
      !isInterrupted &&
      !hasStaleFailedProcess &&
      !(hasStalePausedProcess) &&
      !hasExpiredSteerState
    ) {
      return job
    }

    const processSnapshot = isValidPid(job.processPid)
      ? inspectProcess(job.processPid, recoveredAt)
      : undefined

    if (hasExpiredSteerState) {
      const recovered = recoverStaleSteerPromotingJob(job, recoveredAt, processSnapshot)
      records.push(
        recoveryRecordForJob(
          job,
          recovered,
          processSnapshot,
          recoveredAt,
          'Steer promotion could not resume after app restart.',
          'requeued_stale_steer_promoting'
        )
      )
      return recovered
    }

    if (hasStalePausedProcess && processSnapshot && !processSnapshot.alive) {
      const recovered = recoverPausedRunWithStaleProcess(job, recoveredAt, processSnapshot)
      records.push(
        recoveryRecordForJob(
          job,
          recovered,
          processSnapshot,
          recoveredAt,
          'Paused run had a stale process id at startup; process was not alive.',
          'cleared_stale_paused_process'
        )
      )
      return recovered
    }

    const reason = isInterrupted
      ? 'Run was active when TaskWraith last exited.'
      : 'Failed run still had a recorded process id at startup.'
    const recovered = isInterrupted
      ? recoverInterruptedJob(job, recoveredAt, processSnapshot)
      : recoverStaleFailedProcess(job, recoveredAt, processSnapshot)

    records.push(recoveryRecordForJob(job, recovered, processSnapshot, recoveredAt, reason))
    return recovered
  })

  return { jobs: recoveredJobs, records }
}

export function filterRunRecoveryRecords(
  records: RunRecoveryRecord[],
  filter: RunRecoveryFilter = {}
): RunRecoveryRecord[] {
  const actionSet = filter.actions?.length ? new Set(filter.actions) : null
  const filtered = records.filter((record) => {
    if (filter.runId && record.runId !== filter.runId) return false
    if (filter.chatId && record.chatId !== filter.chatId) return false
    if (filter.workspaceId && record.workspaceId !== filter.workspaceId) return false
    if (filter.provider && record.provider !== filter.provider) return false
    if (actionSet && !actionSet.has(record.action)) return false
    if (filter.onlyOrphans && !record.process?.alive) return false
    return true
  })
  const sorted = [...filtered].sort(
    (a, b) => new Date(b.recoveredAt).getTime() - new Date(a.recoveredAt).getTime()
  )
  return filter.limit && filter.limit > 0 ? sorted.slice(0, Math.floor(filter.limit)) : sorted
}
