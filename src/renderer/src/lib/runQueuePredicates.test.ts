import { describe, expect, it } from 'vitest'
import type { RunQueueJob, ScheduledTask } from '../../../main/store/types'
import type { QueuedRunRequest } from './runRequestTypes'
import {
  GUEST_PENDING_RUN_QUEUE_STATUSES,
  acceptedEnsembleRunQueueWrapperReason,
  isQueuedDesktopRunQueueJob,
  isRemoteComposerRunQueueJob,
  isScheduledTaskReadyToDispatch,
  queuedRunFallbackId,
  queuedRunJobSortTime
} from './runQueuePredicates'

function scheduledTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    workspaceId: 'workspace-1',
    workspacePath: '/workspace',
    chatId: 'chat-1',
    provider: 'codex',
    prompt: 'Run it',
    selectedModelType: 'default',
    customModel: '',
    approvalMode: 'default',
    sessionTrust: false,
    imageAttachments: [],
    runAt: '2026-06-27T12:00:00.000Z',
    timezone: 'UTC',
    status: 'pending',
    createdAt: '2026-06-27T11:00:00.000Z',
    updatedAt: '2026-06-27T11:00:00.000Z',
    ...overrides
  }
}

function runQueueJob(overrides: Partial<RunQueueJob> = {}): RunQueueJob {
  return {
    id: 'job-1',
    runId: 'run-1',
    provider: 'codex',
    source: 'manual',
    status: 'queued',
    priority: 0,
    attempt: 0,
    createdAt: '2026-06-27T11:00:00.000Z',
    updatedAt: '2026-06-27T11:30:00.000Z',
    ...overrides
  }
}

function queuedRunRequest(overrides: Partial<QueuedRunRequest> = {}): QueuedRunRequest {
  return {
    provider: 'codex',
    prompt: '0123456789abcdef-extra',
    selectedModelType: 'default',
    customModel: '',
    approvalMode: 'default',
    sessionTrust: false,
    imageAttachments: [],
    ...overrides
  }
}

describe('run queue predicates', () => {
  it('detects scheduled tasks ready to dispatch', () => {
    const nowMs = Date.parse('2026-06-27T12:30:00.000Z')

    expect(isScheduledTaskReadyToDispatch(scheduledTask({ status: 'due' }), nowMs)).toBe(true)
    expect(
      isScheduledTaskReadyToDispatch(
        scheduledTask({ status: 'due', runAt: new Date(nowMs).toISOString() }),
        nowMs
      )
    ).toBe(true)
    expect(
      isScheduledTaskReadyToDispatch(
        scheduledTask({ status: 'due', runAt: '2026-06-27T13:00:00.000Z' }),
        nowMs
      )
    ).toBe(false)
    expect(isScheduledTaskReadyToDispatch(scheduledTask(), nowMs)).toBe(true)
    expect(
      isScheduledTaskReadyToDispatch(
        scheduledTask({ runAt: '2026-06-27T13:00:00.000Z' }),
        nowMs
      )
    ).toBe(false)
    expect(isScheduledTaskReadyToDispatch(scheduledTask({ status: 'running' }), nowMs)).toBe(false)
    expect(isScheduledTaskReadyToDispatch(scheduledTask({ runAt: 'not-a-date' }), nowMs)).toBe(
      false
    )
    expect(
      isScheduledTaskReadyToDispatch(
        scheduledTask({ status: 'due', runAt: 'not-a-date' }),
        nowMs
      )
    ).toBe(false)
    expect(
      isScheduledTaskReadyToDispatch(
        scheduledTask({ status: 'due', runAt: null as unknown as string }),
        nowMs
      )
    ).toBe(false)
    expect(
      isScheduledTaskReadyToDispatch(
        scheduledTask({ status: 'due', runAt: false as unknown as string }),
        nowMs
      )
    ).toBe(false)
  })

  it('distinguishes remote composer jobs from queued desktop jobs', () => {
    const remoteJob = runQueueJob({
      request: {
        prompt: 'Remote',
        selectedModelType: 'default',
        customModel: '',
        approvalMode: 'default',
        sessionTrust: false,
        imageAttachments: [],
        remoteComposer: {
          workspaceId: 'workspace-1',
          threadId: 'chat-1',
          provider: 'codex',
          text: 'Remote'
        }
      }
    })

    expect(isRemoteComposerRunQueueJob(remoteJob)).toBe(true)
    expect(isQueuedDesktopRunQueueJob(remoteJob)).toBe(false)
    expect(isQueuedDesktopRunQueueJob(runQueueJob())).toBe(true)
    expect(isQueuedDesktopRunQueueJob(runQueueJob({ status: 'active' }))).toBe(false)
  })

  it('builds fallback ids from appRunId or provider and prompt prefix', () => {
    expect(queuedRunFallbackId(queuedRunRequest({ appRunId: 'run-1' }))).toBe('run-1')
    expect(queuedRunFallbackId(queuedRunRequest())).toBe('codex-0123456789abcdef')
  })

  it('sorts run queue jobs by enqueue, create, update time fallback', () => {
    expect(
      queuedRunJobSortTime(
        runQueueJob({
          enqueuedAt: '2026-06-27T12:00:00.000Z',
          createdAt: '2026-06-27T11:00:00.000Z'
        })
      )
    ).toBe(Date.parse('2026-06-27T12:00:00.000Z'))
    expect(queuedRunJobSortTime(runQueueJob({ createdAt: '', updatedAt: 'not-a-date' }))).toBe(0)
  })

  it('lists guest pending statuses', () => {
    expect([...GUEST_PENDING_RUN_QUEUE_STATUSES]).toEqual([
      'queued',
      'steer_promoting',
      'starting',
      'active',
      'cancelling'
    ])
  })

  it('terminalizes accepted non-scheduled ensemble queue wrappers', () => {
    expect(acceptedEnsembleRunQueueWrapperReason({ mode: 'normal' })).toBe(
      'Accepted by Ensemble orchestrator.'
    )
    expect(acceptedEnsembleRunQueueWrapperReason({ mode: 'queue' })).toBe(
      'Accepted into Ensemble queued prompt list.'
    )
    expect(
      acceptedEnsembleRunQueueWrapperReason({
        mode: 'normal',
        scheduledTaskId: 'scheduled-task-1'
      })
    ).toBeNull()
    expect(
      acceptedEnsembleRunQueueWrapperReason({
        mode: 'queue',
        scheduledRunAt: '2026-06-27T12:00:00.000Z'
      })
    ).toBeNull()
  })
})
