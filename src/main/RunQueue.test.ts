import { describe, expect, it } from 'vitest'
import {
  capRunQueueJobs,
  createRunQueueJob,
  filterRunQueueJobs,
  MAX_TERMINAL_RUN_QUEUE_JOBS,
  recoverInterruptedRunQueueJobs,
  sortRunQueueJobs,
  findNextRunnableQueueIndex,
  updateRunQueueJobRecord
} from './RunQueue'

describe('RunQueue', () => {
  it('creates a durable queued job with a compact request preview', () => {
    const job = createRunQueueJob(
      {
        id: 'run-1',
        runId: 'run-1',
        provider: 'gemini',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        chatId: 'chat-1',
        source: 'manual',
        request: {
          prompt: '  Inspect   this workspace and summarize the next step.  ',
          selectedModelType: 'flash-lite',
          customModel: '',
          approvalMode: 'default',
          sessionTrust: false,
          imageAttachments: []
        }
      },
      '2026-05-06T00:00:00.000Z'
    )

    expect(job.status).toBe('queued')
    expect(job.enqueuedAt).toBe('2026-05-06T00:00:00.000Z')
    expect(job.promptPreview).toBe('Inspect this workspace and summarize the next step.')
    expect(job.attempt).toBe(1)
  })

  it('caps terminal jobs to the newest MAX while always keeping in-flight jobs', () => {
    const request = {
      prompt: 'do work',
      selectedModelType: 'flash-lite',
      customModel: '',
      approvalMode: 'default' as const,
      sessionTrust: false,
      imageAttachments: []
    }
    const make = (id: string, status: 'queued' | 'active' | 'paused' | 'completed', ts: string) =>
      createRunQueueJob(
        {
          id,
          runId: id,
          provider: 'claude',
          workspaceId: 'w',
          workspacePath: '/w',
          chatId: 'c',
          source: 'manual',
          status,
          request
        },
        ts
      )

    // In-flight jobs must NEVER be dropped, no matter how old.
    const inflight = [
      make('queued-1', 'queued', '2020-01-01T00:00:00.000Z'),
      make('active-1', 'active', '2020-01-01T00:00:00.000Z'),
      make('paused-1', 'paused', '2020-01-01T00:00:00.000Z')
    ]
    const base = Date.parse('2026-06-01T00:00:00.000Z')
    const terminal = Array.from({ length: MAX_TERMINAL_RUN_QUEUE_JOBS + 5 }, (_, i) =>
      make(`done-${i}`, 'completed', new Date(base + i * 1000).toISOString())
    )

    const capped = capRunQueueJobs([...terminal, ...inflight])
    const ids = new Set(capped.map((job) => job.id))

    // All in-flight kept; total = MAX terminal + 3 in-flight.
    expect(ids.has('queued-1')).toBe(true)
    expect(ids.has('active-1')).toBe(true)
    expect(ids.has('paused-1')).toBe(true)
    expect(capped.filter((job) => job.status === 'completed')).toHaveLength(
      MAX_TERMINAL_RUN_QUEUE_JOBS
    )
    expect(capped).toHaveLength(MAX_TERMINAL_RUN_QUEUE_JOBS + 3)

    // The 5 oldest terminal jobs are dropped; the newest are kept.
    expect(ids.has('done-0')).toBe(false)
    expect(ids.has('done-4')).toBe(false)
    expect(ids.has('done-5')).toBe(true)
    expect(ids.has(`done-${MAX_TERMINAL_RUN_QUEUE_JOBS + 4}`)).toBe(true)

    // Under the cap, the same array is returned untouched.
    const small = [...terminal.slice(0, 3), ...inflight]
    expect(capRunQueueJobs(small)).toBe(small)
  })

  it('creates global queued jobs without workspace fields', () => {
    const job = createRunQueueJob(
      {
        id: 'global-run-1',
        runId: 'global-run-1',
        provider: 'codex',
        scope: 'global',
        chatId: 'global-chat-1',
        source: 'manual',
        request: {
          scope: 'global',
          prompt: 'Search online and sketch options.',
          selectedModelType: 'gpt-5.5',
          customModel: '',
          approvalMode: 'default',
          sessionTrust: false,
          imageAttachments: []
        }
      },
      '2026-05-06T00:00:00.000Z'
    )

    expect(job.scope).toBe('global')
    expect(job.workspacePath).toBeUndefined()
    expect(job.workspaceId).toBeUndefined()
    expect(job.status).toBe('queued')
  })

  it('persists active and terminal timestamps during transitions', () => {
    const queued = createRunQueueJob(
      {
        id: 'run-1',
        runId: 'run-1',
        provider: 'codex',
        workspacePath: '/workspace',
        source: 'manual'
      },
      '2026-05-06T00:00:00.000Z'
    )
    const active = updateRunQueueJobRecord(
      queued,
      { status: 'active', processPid: 123 },
      '2026-05-06T00:01:00.000Z'
    )
    const failed = updateRunQueueJobRecord(
      active,
      { status: 'failed', lastError: 'Process exited 1' },
      '2026-05-06T00:02:00.000Z'
    )

    expect(active.startedAt).toBe('2026-05-06T00:01:00.000Z')
    expect(active.processPid).toBe(123)
    expect(failed.failedAt).toBe('2026-05-06T00:02:00.000Z')
    expect(failed.endedAt).toBe('2026-05-06T00:02:00.000Z')
    expect(failed.lastError).toBe('Process exited 1')
  })

  it('preserves steering metadata and normalizes it out of terminal status paths', () => {
    const steering = createRunQueueJob(
      {
        id: 'steer-run',
        runId: 'steer-run',
        provider: 'codex',
        workspacePath: '/workspace',
        source: 'system',
        status: 'steer_promoting',
        promotionOwnerToken: 'owner-token-123',
        promotionToken: 'token-123',
        promotionAttempt: 4,
        transitionVersion: 2,
        promotedAt: '2026-05-06T00:00:30.000Z',
        queueMessageId: 'message-1'
      },
      '2026-05-06T00:00:00.000Z'
    )

    expect(steering.status).toBe('steer_promoting')
    expect(steering.promotionOwnerToken).toBe('owner-token-123')
    expect(steering.promotionToken).toBe('token-123')
    expect(steering.promotionAttempt).toBe(4)
    expect(steering.transitionVersion).toBe(2)
    expect(steering.promotedAt).toBe('2026-05-06T00:00:30.000Z')
    expect(steering.queueMessageId).toBe('message-1')

    const failed = updateRunQueueJobRecord(
      steering,
      { status: 'failed', lastError: 'provider cancelled before queueing' },
      '2026-05-06T00:01:00.000Z'
    )
    expect(failed.status).toBe('failed')
    expect(failed.promotionOwnerToken).toBeUndefined()
    expect(failed.promotionToken).toBeUndefined()
    expect(failed.transitionVersion).toBeUndefined()
    expect(failed.promotionAttempt).toBeUndefined()
    expect(failed.queueMessageId).toBeUndefined()
    expect(failed.promotedAt).toBeUndefined()
  })

  it('allows queued -> steer_promoting -> starting and steer_promoting -> queued transitions', () => {
    const queued = createRunQueueJob({
      id: 'queued-steer',
      runId: 'queued-steer',
      provider: 'gemini',
      workspacePath: '/workspace',
      source: 'manual'
    })
    const promoting = updateRunQueueJobRecord(
      queued,
      { status: 'steer_promoting', promotionToken: 'token-456' },
      '2026-05-06T00:01:00.000Z'
    )
    const requeued = updateRunQueueJobRecord(promoting, { status: 'queued' }, '2026-05-06T00:02:00.000Z')
    const starting = updateRunQueueJobRecord(
      promoting,
      { status: 'starting' },
      '2026-05-06T00:02:30.000Z'
    )

    expect(promoting.status).toBe('steer_promoting')
    expect(promoting.promotionToken).toBe('token-456')
    expect(requeued.status).toBe('queued')
    expect(starting.status).toBe('starting')
  })

  it('preserves the first terminal job status when late updates arrive', () => {
    const cancelled = createRunQueueJob(
      {
        id: 'run-1',
        runId: 'run-1',
        provider: 'gemini',
        workspacePath: '/workspace',
        source: 'manual',
        status: 'cancelled'
      },
      '2026-05-06T00:02:00.000Z'
    )

    const lateFailure = updateRunQueueJobRecord(
      cancelled,
      { status: 'failed', lastError: 'Late process close' },
      '2026-05-06T00:03:00.000Z'
    )

    expect(lateFailure.status).toBe('cancelled')
    expect(lateFailure.cancelledAt).toBe('2026-05-06T00:02:00.000Z')
    expect(lateFailure.failedAt).toBeUndefined()
    expect(lateFailure.lastError).toBe('Late process close')
  })

  it('prevents terminal jobs from moving back to active lifecycle states', () => {
    const terminalStatuses = ['cancelled', 'failed', 'completed'] as const
    for (const terminalStatus of terminalStatuses) {
      const terminal = createRunQueueJob({
        id: `blocked-${terminalStatus}`,
        runId: `blocked-${terminalStatus}`,
        provider: 'gemini',
        workspacePath: '/workspace',
        source: 'manual',
        status: terminalStatus
      })
      expect(updateRunQueueJobRecord(terminal, { status: 'queued' }).status).toBe(terminalStatus)
      expect(updateRunQueueJobRecord(terminal, { status: 'starting' }).status).toBe(terminalStatus)
      expect(updateRunQueueJobRecord(terminal, { status: 'active' }).status).toBe(terminalStatus)
      expect(updateRunQueueJobRecord(terminal, { status: 'steer_promoting' }).status).toBe(terminalStatus)
    }
  })

  it('recovers active jobs as failed on startup while leaving queued jobs alone', () => {
    const queued = createRunQueueJob({
      id: 'queued',
      runId: 'queued',
      provider: 'gemini',
      workspacePath: '/workspace',
      source: 'manual'
    })
    const active = createRunQueueJob({
      id: 'active',
      runId: 'active',
      provider: 'codex',
      workspacePath: '/workspace',
      source: 'manual',
      status: 'active'
    })

    const recovered = recoverInterruptedRunQueueJobs([queued, active], '2026-05-06T00:03:00.000Z')

    expect(recovered.find((job) => job.id === 'queued')?.status).toBe('queued')
    const recoveredActive = recovered.find((job) => job.id === 'active')
    expect(recoveredActive?.status).toBe('failed')
    expect(recoveredActive?.recoveryReason).toBe('marked_failed_on_startup')
    expect(recoveredActive?.failedAt).toBe('2026-05-06T00:03:00.000Z')
  })

  it('filters and sorts jobs by active work before queued and terminal history', () => {
    const jobs = [
      createRunQueueJob({
        id: 'done',
        runId: 'done',
        provider: 'gemini',
        workspacePath: '/a',
        source: 'manual',
        status: 'completed'
      }),
      createRunQueueJob({
        id: 'queued',
        runId: 'queued',
        provider: 'gemini',
        workspacePath: '/a',
        source: 'manual',
        status: 'queued'
      }),
      createRunQueueJob({
        id: 'active',
        runId: 'active',
        provider: 'codex',
        workspacePath: '/b',
        source: 'manual',
        status: 'active'
      })
    ]

    expect(sortRunQueueJobs(jobs).map((job) => job.id)).toEqual(['active', 'queued', 'done'])
    expect(filterRunQueueJobs(jobs).map((job) => job.id)).toEqual(['queued', 'active'])
    expect(filterRunQueueJobs(jobs, { statuses: ['completed'] }).map((job) => job.id)).toEqual([
      'done'
    ])
  })

  it('finds the first queued job allowed by the per-job dispatch predicate', () => {
    const jobs = [
      createRunQueueJob({
        id: 'chat-a',
        runId: 'chat-a',
        provider: 'codex',
        workspacePath: '/workspace',
        chatId: 'busy-chat',
        source: 'manual'
      }),
      createRunQueueJob({
        id: 'chat-b',
        runId: 'chat-b',
        provider: 'codex',
        workspacePath: '/workspace',
        chatId: 'idle-chat',
        source: 'manual'
      })
    ]

    expect(findNextRunnableQueueIndex(jobs, (job) => job.chatId !== 'busy-chat')).toBe(1)
    expect(findNextRunnableQueueIndex(jobs, () => false)).toBe(-1)
  })

  it('skips steer_promoting jobs in normal runnable queue selection', () => {
    const jobs = [
      createRunQueueJob({
        id: 'steering',
        runId: 'steering',
        provider: 'codex',
        workspacePath: '/workspace',
        source: 'manual',
        status: 'steer_promoting'
      }),
      createRunQueueJob({
        id: 'ready',
        runId: 'ready',
        provider: 'codex',
        workspacePath: '/workspace',
        source: 'manual',
        status: 'queued'
      })
    ]

    expect(findNextRunnableQueueIndex(jobs, () => true)).toBe(1)
  })
})
