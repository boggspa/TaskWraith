import { describe, expect, it, vi } from 'vitest'
import {
  RunLifecycleCoordinator,
  type ClaimNextLifecycleJobInput,
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
  it('claims the next queued job and returns a sanitized legacy dispatch ticket', async () => {
    let job = makeJob({
      request: makeRequest({
        prompt: 'Clean this up.',
        selectedModelType: '',
        approvalMode: '',
        workflowMode: 'plan',
        customModel: '',
        imageAttachments: [
          { path: '/tmp/a.png', id: 'img-1', name: 'a.png' } as RunQueueRequestSnapshot['imageAttachments'][number]
        ],
        displayPrompt: '   Clean this up.   '
      })
    })
    const leaseQueuedJob = vi.fn(() => job)
    const queue: RunLifecycleCoordinatorDeps['queue'] = {
      getRunQueueJob: () => job,
      leaseQueuedJob
    }
    const cancelProviderRun = vi.fn(() => true)
    const coordinator = new RunLifecycleCoordinator({ queue, cancelProviderRun })
    const input: ClaimNextLifecycleJobInput = {
      provider: 'codex',
      chatId: 'chat-1',
      ownerToken: 'owner-1',
      statusReason: 'Renderer requested next queued run'
    }

    const ticket = await coordinator.claimNextLifecycleJob(input)

    expect(ticket).toMatchObject({
      kind: 'lifecycle-dispatch-ticket',
      dispatchMode: 'renderer-legacy',
      runId: 'queued-run',
      jobId: 'queue-1',
      provider: 'codex',
      chatId: 'chat-1',
      source: 'manual',
      ownerToken: 'owner-1',
      request: {
        scope: 'workspace',
        prompt: 'Clean this up.',
        selectedModelType: 'cli-default',
        customModel: '',
        approvalMode: 'default',
        workflowMode: 'plan',
        sessionTrust: false,
        imageAttachments: [{ id: 'img-1', path: '/tmp/a.png', name: 'a.png' }],
        displayPrompt: '   Clean this up.   '
      }
    })
    expect(leaseQueuedJob).toHaveBeenCalledWith({
      provider: 'codex',
      chatId: 'chat-1',
      ownerToken: 'owner-1',
      statusReason: 'Renderer requested next queued run'
    })
  })

  it('returns null when no queued lifecycle job can be claimed for renderer', async () => {
    const leaseQueuedJob = vi.fn(() => null)
    const queue: RunLifecycleCoordinatorDeps['queue'] = {
      getRunQueueJob: () => makeJob(),
      leaseQueuedJob
    }
    const cancelProviderRun = vi.fn(() => true)
    const coordinator = new RunLifecycleCoordinator({ queue, cancelProviderRun })

    const ticket = await coordinator.claimNextLifecycleJob({ provider: 'codex', chatId: 'chat-1' })

    expect(ticket).toBeNull()
    expect(leaseQueuedJob).toHaveBeenCalledWith({
      provider: 'codex',
      chatId: 'chat-1',
      ownerToken: expect.any(String),
      statusReason: 'Queued run leased from main lifecycle coordinator.'
    })
  })

  it('drops invalid workflow mode values from queued dispatch tickets', async () => {
    const job = makeJob({
      request: makeRequest({ workflowMode: 'read_only' as any })
    })
    const queue: RunLifecycleCoordinatorDeps['queue'] = {
      getRunQueueJob: () => job,
      leaseQueuedJob: vi.fn(() => job)
    }
    const cancelProviderRun = vi.fn(() => true)
    const coordinator = new RunLifecycleCoordinator({ queue, cancelProviderRun })

    const ticket = await coordinator.claimNextLifecycleJob({ provider: 'codex', chatId: 'chat-1' })

    expect(ticket?.request.workflowMode).toBeUndefined()
  })

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

  it('does not use generic queue transitions for steer ownership paths', async () => {
    let job = makeJob()
    const transitionJob = vi.fn(() => makeJob({ status: 'steer_promoting' }))
    const leaseQueuedJob = vi.fn(() => job)
    const cancelProviderRun = vi.fn(() => true)
    const queue: RunLifecycleCoordinatorDeps['queue'] = {
      getRunQueueJob: () => job,
      leaseQueuedJob,
      transitionJob
    }
    const coordinator = new RunLifecycleCoordinator({ queue, cancelProviderRun })

    const promote = await coordinator.promoteQueuedJobForSteer({
      runId: 'queued-run',
      ownerToken: 'owner-1',
      provider: 'codex',
      cancelRunId: 'active-run',
      cancelProvider: 'codex'
    })

    expect(promote).toMatchObject({
      ok: false,
      kind: 'fallback',
      runId: 'queued-run',
      ownerToken: 'owner-1',
      jobStatus: 'queued',
      cancelRequested: false
    })
    expect(cancelProviderRun).not.toHaveBeenCalled()
    expect(transitionJob).not.toHaveBeenCalled()

    const claim = await coordinator.claimNextLifecycleJob({ provider: 'codex', chatId: 'chat-1' })
    expect(claim?.provider).toBe('codex')
    expect(claim?.jobId).toBe('queue-1')
    expect(transitionJob).not.toHaveBeenCalled()

    job = makeJob({ status: 'steer_promoting', promotionOwnerToken: 'owner-1' })

    const lease = await coordinator.leasePromotedSteerJob({
      runId: 'queued-run',
      ownerToken: 'owner-1'
    })
    expect(lease).toMatchObject({
      ok: false,
      kind: 'not-available',
      runId: 'queued-run',
      ownerToken: 'owner-1',
      reason: 'Steer lease did not succeed.'
    })
    expect(transitionJob).not.toHaveBeenCalled()

    const fallback = await coordinator.fallbackPromotedSteerJob({
      runId: 'queued-run',
      ownerToken: 'owner-1',
      reason: 'timed out'
    })
    expect(fallback).toMatchObject({
      ok: false,
      kind: 'not-found',
      runId: 'queued-run',
      ownerToken: 'owner-1',
      reason: 'Could not transition run queued-run out of steer promotion.'
    })
    expect(transitionJob).not.toHaveBeenCalled()
  })
})
