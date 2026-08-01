import { describe, expect, it } from 'vitest'
import { createRunQueueJob } from './RunQueue'
import {
  filterRunRecoveryRecords,
  recoverRunQueueJobsAfterStartup,
  type ProcessInspector
} from './RunRecovery'
import type { RunQueueJob, RunRecoveryRecord } from './store/types'

const recoveredAt = '2026-05-07T12:00:00.000Z'

function job(input: Partial<RunQueueJob> & Pick<RunQueueJob, 'id' | 'runId'>): RunQueueJob {
  return createRunQueueJob(
    {
      provider: 'codex',
      workspacePath: '/workspace',
      source: 'manual',
      ...input
    },
    '2026-05-07T11:00:00.000Z'
  )
}

describe('RunRecovery', () => {
  it('marks active jobs as failed on startup and records a recoverable thread hint', () => {
    const active = job({
      id: 'run-active',
      runId: 'run-active',
      status: 'active',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      providerSessionId: 'thread-1'
    })

    const recovered = recoverRunQueueJobsAfterStartup([active], recoveredAt, () => undefined)
    const recoveredJob = recovered.jobs[0]

    expect(recoveredJob.status).toBe('failed')
    expect(recoveredJob.recoveryReason).toBe('marked_failed_on_startup')
    expect(recoveredJob.processPid).toBeUndefined()
    expect(recoveredJob.interruptedAt).toBe(recoveredAt)
    expect(recoveredJob.recoveredAt).toBe(recoveredAt)
    expect(recoveredJob.resumeAvailable).toBe(true)
    expect(recovered.records).toHaveLength(1)
    expect(recovered.records[0]).toMatchObject({
      runId: 'run-active',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      previousStatus: 'active',
      recoveredStatus: 'failed',
      action: 'marked_failed',
      resumeAvailable: true
    })
  })

  it('preserves ensemble participant metadata on recovery records', () => {
    const active = job({
      id: 'run-ensemble',
      runId: 'run-ensemble',
      status: 'active',
      chatId: 'chat-ensemble',
      ensembleParticipantId: 'participant-grok',
      ensembleRole: 'Reviewer'
    })

    const recovered = recoverRunQueueJobsAfterStartup([active], recoveredAt, () => undefined)

    expect(recovered.records).toHaveLength(1)
    expect(recovered.records[0]).toMatchObject({
      runId: 'run-ensemble',
      ensembleParticipantId: 'participant-grok',
      ensembleRole: 'Reviewer'
    })
  })

  it('captures live orphan process details for interrupted active jobs', () => {
    const active = job({
      id: 'run-orphan',
      runId: 'run-orphan',
      status: 'starting',
      processPid: 4242,
      processStartedAt: '2026-05-07T11:01:00.000Z',
      processCommand: 'gemini --model flash'
    })
    const inspectProcess: ProcessInspector = (pid, checkedAt) => ({
      pid,
      checkedAt,
      alive: true,
      command: '/opt/homebrew/bin/gemini',
      detection: 'pid_signal_and_ps',
      action: 'left_running'
    })

    const recovered = recoverRunQueueJobsAfterStartup([active], recoveredAt, inspectProcess)
    const recoveredJob = recovered.jobs[0]

    expect(recoveredJob.status).toBe('failed')
    expect(recoveredJob.recoveryReason).toBe('orphan_detected_on_startup')
    expect(recoveredJob.processPid).toBeUndefined()
    expect(recoveredJob.orphanProcess).toMatchObject({
      pid: 4242,
      alive: true,
      action: 'left_running'
    })
    expect(recovered.records[0]).toMatchObject({
      action: 'marked_failed_orphan_detected',
      process: {
        pid: 4242,
        alive: true
      },
      jobSnapshot: {
        processPid: 4242,
        processStartedAt: '2026-05-07T11:01:00.000Z',
        processCommand: 'gemini --model flash'
      }
    })
  })

  it('uses persisted identity-verified reap evidence instead of probing the dead PID again', () => {
    const active = job({
      id: 'run-reaped',
      runId: 'run-reaped',
      status: 'active',
      processPid: 4242,
      processOwnership: {
        schemaVersion: 1,
        pid: 4242,
        processBirthIdentity: 'birth-4242',
        capturedAt: '2026-05-07T11:01:00.000Z',
        containment: { kind: 'posix_process_group', processGroupId: 4242 }
      },
      orphanProcess: {
        pid: 4242,
        checkedAt: recoveredAt,
        alive: false,
        command: '/opt/homebrew/bin/cursor-agent',
        detection: 'verified_process_identity',
        action: 'terminated'
      }
    })
    const inspectProcess: ProcessInspector = () => {
      throw new Error('PID probe should not run after verified cleanup')
    }

    const recovered = recoverRunQueueJobsAfterStartup([active], recoveredAt, inspectProcess)

    expect(recovered.jobs[0]).toMatchObject({
      status: 'failed',
      recoveryReason: 'marked_failed_on_startup',
      orphanProcess: { alive: false, action: 'terminated' }
    })
    expect(recovered.jobs[0].processPid).toBeUndefined()
    expect(recovered.jobs[0].processOwnership).toBeUndefined()
    expect(recovered.records[0]).toMatchObject({
      action: 'marked_failed',
      process: { alive: false, action: 'terminated' },
      jobSnapshot: {
        processPid: 4242,
        processOwnership: {
          processBirthIdentity: 'birth-4242'
        }
      }
    })
  })

  it('clears stale process ids from already failed jobs while preserving terminal status', () => {
    const failed = job({
      id: 'run-failed',
      runId: 'run-failed',
      status: 'failed',
      processPid: 5150,
      lastError: 'Provider exited 1'
    })
    const inspectProcess: ProcessInspector = (pid, checkedAt) => ({
      pid,
      checkedAt,
      alive: true,
      command: '/usr/bin/codex',
      detection: 'pid_signal_and_ps',
      action: 'left_running'
    })

    const recovered = recoverRunQueueJobsAfterStartup([failed], recoveredAt, inspectProcess)
    const recoveredJob = recovered.jobs[0]

    expect(recoveredJob.status).toBe('failed')
    expect(recoveredJob.processPid).toBeUndefined()
    expect(recoveredJob.recoveryReason).toBe('orphan_detected_after_failure')
    expect(recoveredJob.lastError).toBe('Provider exited 1')
    expect(recovered.records[0].action).toBe('cleared_stale_orphan_process')
  })

  it('requeues stale steer_promoting runs that have timed out since startup', () => {
    const steerPromoting = job({
      id: 'run-steer-stale',
      runId: 'run-steer-stale',
      status: 'steer_promoting',
      promotedAt: '2026-05-07T11:57:00.000Z',
      promotionToken: 'token-1',
      promotionAttempt: 2,
      transitionVersion: 3,
      queueMessageId: 'message-1'
    })

    const recovered = recoverRunQueueJobsAfterStartup([steerPromoting], recoveredAt, () => undefined)
    const recoveredJob = recovered.jobs[0]
    const record = recovered.records[0]

    expect(recoveredJob.status).toBe('queued')
    expect(recoveredJob.recoveryReason).toBe('stale_steer_promoting_recovered')
    expect(recoveredJob.processPid).toBeUndefined()
    expect(recoveredJob.promotionToken).toBeUndefined()
    expect(recoveredJob.promotionAttempt).toBeUndefined()
    expect(recoveredJob.transitionVersion).toBeUndefined()
    expect(recoveredJob.queueMessageId).toBeUndefined()
    expect(recoveredJob.promotedAt).toBeUndefined()
    expect(record.action).toBe('requeued_stale_steer_promoting')
    expect(record.reason).toBe('Steer promotion could not resume after app restart.')
  })

  it('requeues recent steer_promoting runs because promotion ownership cannot resume after restart', () => {
    const recent = job({
      id: 'run-steer-recent',
      runId: 'run-steer-recent',
      status: 'steer_promoting',
      promotedAt: '2026-05-07T11:59:59.000Z',
      promotionOwnerToken: 'owner-1',
      promotionToken: 'token-1'
    })

    const recovered = recoverRunQueueJobsAfterStartup([recent], recoveredAt, () => undefined)
    const recoveredJob = recovered.jobs[0]

    expect(recoveredJob.status).toBe('queued')
    expect(recoveredJob.recoveryReason).toBe('stale_steer_promoting_recovered')
    expect(recoveredJob.promotionOwnerToken).toBeUndefined()
    expect(recoveredJob.promotionToken).toBeUndefined()
  })

  it('requeues steer_promoting jobs when promotion metadata is malformed', () => {
    const malformed = job({
      id: 'run-steer-malformed',
      runId: 'run-steer-malformed',
      status: 'steer_promoting'
    })

    const recovered = recoverRunQueueJobsAfterStartup([malformed], '2026-05-07T11:05:00.000Z', () => undefined)
    const recoveredJob = recovered.jobs[0]

    expect(recoveredJob.status).toBe('queued')
    expect(recoveredJob.recoveryReason).toBe('stale_steer_promoting_recovered')
  })

  it('clears stale process metadata from paused jobs and keeps them paused', () => {
    const paused = job({
      id: 'run-paused-stale',
      runId: 'run-paused-stale',
      status: 'paused',
      processPid: 4242
    })
    const inspectProcess: ProcessInspector = (pid, checkedAt) => ({
      pid,
      checkedAt,
      alive: false,
      command: '/usr/bin/codex',
      detection: 'pid_signal',
      action: 'not_found',
      errorCode: 'ESRCH'
    })

    const recovered = recoverRunQueueJobsAfterStartup([paused], recoveredAt, inspectProcess)
    const recoveredJob = recovered.jobs[0]

    expect(recoveredJob.status).toBe('paused')
    expect(recoveredJob.processPid).toBeUndefined()
    expect(recoveredJob.recoveryReason).toBe('stale_process_for_paused_run_on_startup')
    expect(recoveredJob.statusReason).toContain('stale process metadata')
    expect(recovered.records[0]).toMatchObject({
      action: 'cleared_stale_paused_process',
      previousStatus: 'paused',
      recoveredStatus: 'paused',
      process: { pid: 4242, alive: false }
    })
  })

  it('leaves queued and completed jobs unchanged', () => {
    const queued = job({ id: 'queued', runId: 'queued', status: 'queued' })
    const completed = job({ id: 'completed', runId: 'completed', status: 'completed' })

    const recovered = recoverRunQueueJobsAfterStartup([queued, completed], recoveredAt)

    expect(recovered.jobs).toEqual([queued, completed])
    expect(recovered.records).toEqual([])
  })

  it('filters recovery records by orphan status and route metadata', () => {
    const baseRecord: RunRecoveryRecord = {
      schemaVersion: 1,
      id: 'record-1',
      runId: 'run-1',
      jobId: 'job-1',
      provider: 'gemini',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      previousStatus: 'active',
      recoveredStatus: 'failed',
      action: 'marked_failed',
      reason: 'restart',
      recoveredAt: '2026-05-07T12:00:00.000Z',
      resumeAvailable: false,
      resumeHint: 'No session.',
      jobSnapshot: {}
    }
    const orphanRecord: RunRecoveryRecord = {
      ...baseRecord,
      id: 'record-2',
      runId: 'run-2',
      provider: 'codex',
      action: 'marked_failed_orphan_detected',
      recoveredAt: '2026-05-07T12:01:00.000Z',
      process: {
        pid: 222,
        checkedAt: '2026-05-07T12:01:00.000Z',
        alive: true,
        detection: 'pid_signal_and_ps',
        action: 'left_running'
      }
    }

    expect(filterRunRecoveryRecords([baseRecord, orphanRecord]).map((record) => record.id)).toEqual(
      ['record-2', 'record-1']
    )
    expect(
      filterRunRecoveryRecords([baseRecord, orphanRecord], { onlyOrphans: true }).map(
        (record) => record.id
      )
    ).toEqual(['record-2'])
    expect(
      filterRunRecoveryRecords([baseRecord, orphanRecord], { provider: 'gemini' }).map(
        (record) => record.id
      )
    ).toEqual(['record-1'])
  })
})
