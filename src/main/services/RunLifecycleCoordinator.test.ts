import { describe, expect, it, vi } from 'vitest'
import {
  RunLifecycleCoordinator,
  type RunLifecycleCoordinatorDeps
} from './RunLifecycleCoordinator'
import type { RunQueueJob, RunQueueRequestSnapshot } from '../store/types'

function makeRequest(overrides: Partial<RunQueueRequestSnapshot> = {}): RunQueueRequestSnapshot {
  return {
    scope: 'workspace',
    prompt: 'Ship it',
    selectedModelType: 'cli-default',
    customModel: '',
    approvalMode: 'default',
    sessionTrust: false,
    imageAttachments: [],
    ...overrides
  }
}

function makeJob(overrides: Partial<RunQueueJob> = {}): RunQueueJob {
  return {
    id: 'queue-1',
    runId: 'queued-run',
    provider: 'codex',
    scope: 'workspace',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    chatId: 'chat-1',
    source: 'manual',
    status: 'queued',
    priority: 0,
    attempt: 0,
    createdAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:00:00.000Z',
    request: makeRequest(),
    ...overrides
  }
}

describe('RunLifecycleCoordinator', () => {
  it('reserves a queued steer promotion before cancelling the active provider run', async () => {
    let job = makeJob()
    const events: string[] = []
    const queue: RunLifecycleCoordinatorDeps['queue'] = {
      getRunQueueJob: () => job,
      promoteQueuedJobForSteer: (input) => {
        events.push('promote')
        job = {
          ...job,
          status: 'steer_promoting',
          promotionOwnerToken: input.ownerToken,
          promotionToken: input.ownerToken,
          statusReason: input.statusReason
        }
        return job
      }
    }
    const cancelProviderRun = vi.fn(() => {
      events.push(`cancel:${job.status}`)
      return true
    })
    const coordinator = new RunLifecycleCoordinator({ queue, cancelProviderRun })

    const result = await coordinator.promoteQueuedJobForSteer({
      runId: 'queued-run',
      ownerToken: 'owner-1',
      provider: 'codex',
      cancelRunId: 'active-run',
      cancelProvider: 'codex'
    })

    expect(result).toMatchObject({
      ok: true,
      kind: 'dispatch-permission',
      runId: 'queued-run',
      ownerToken: 'owner-1',
      jobStatus: 'steer_promoting',
      cancelRequested: true
    })
    expect(events).toEqual(['promote', 'cancel:steer_promoting'])
    expect(cancelProviderRun).toHaveBeenCalledWith('codex', 'active-run')
  })

  it('marks malformed promoted queue jobs failed instead of requeueing them', async () => {
    let job = makeJob({ request: makeRequest({ prompt: '' }) })
    const fallbackPromotedSteerJob = vi.fn((input) => {
      job = {
        ...job,
        status: input.fallbackStatus || 'queued',
        statusReason: input.reason
      }
      return job
    })
    const queue: RunLifecycleCoordinatorDeps['queue'] = {
      getRunQueueJob: () => job,
      promoteQueuedJobForSteer: (input) => {
        job = {
          ...job,
          status: 'steer_promoting',
          promotionOwnerToken: input.ownerToken,
          promotionToken: input.ownerToken
        }
        return job
      },
      fallbackPromotedSteerJob
    }
    const cancelProviderRun = vi.fn(() => true)
    const coordinator = new RunLifecycleCoordinator({ queue, cancelProviderRun })

    const result = await coordinator.promoteQueuedJobForSteer({
      runId: 'queued-run',
      ownerToken: 'owner-1',
      provider: 'codex',
      cancelRunId: 'active-run',
      cancelProvider: 'codex'
    })

    expect(result).toMatchObject({
      ok: false,
      kind: 'fallback',
      runId: 'queued-run',
      ownerToken: 'owner-1',
      jobStatus: 'failed',
      reason: 'Missing queued request payload; marked failed.',
      cancelRequested: false
    })
    expect(fallbackPromotedSteerJob).toHaveBeenCalledWith({
      runId: 'queued-run',
      ownerToken: 'owner-1',
      reason: 'Queued job missing a runnable request payload.',
      fallbackStatus: 'failed'
    })
    expect(cancelProviderRun).not.toHaveBeenCalled()
  })
})
