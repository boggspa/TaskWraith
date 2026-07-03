import { describe, expect, it, vi } from 'vitest'
import type { RunQueueJob } from '../store/types'
import {
  REMOTE_COMPOSER_ACTIVE_QUEUE_STATUSES,
  authorizeRemoteComposerQueueDispatch,
  buildRemoteComposerQueueDispatchAction,
  classifyRemoteComposerQueueDispatchFailure,
  classifyRemoteComposerQueueDispatchResult,
  remoteComposerChatIsBusy
} from './RemoteComposerQueueService'

function makeJob(overrides: Partial<RunQueueJob> = {}): RunQueueJob {
  return {
    id: 'job-1',
    runId: 'run-1',
    provider: 'gemini',
    scope: 'workspace',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    chatId: 'chat-1',
    source: 'remote',
    status: 'queued',
    priority: 0,
    attempt: 1,
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z',
    request: {
      scope: 'workspace',
      prompt: 'Run from phone',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: [],
      remoteComposer: {
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        provider: 'gemini',
        text: 'Reopen the issue.',
        approvalMode: 'plan',
        model: 'gemini-2.5',
        reasoningEffort: 'high',
        claudeReasoningEffort: 'medium',
        contextTurns: 4,
        extraWorkspaceIds: ['workspace-extra']
      }
    },
    ...overrides
  }
}

describe('remoteComposerChatIsBusy', () => {
  it('returns true for active remote-composer jobs and non-remote queue jobs on the same chat', () => {
    const jobs = [
      makeJob({
        runId: 'run-queued',
        status: 'queued',
        request: { ...makeJob().request!, remoteComposer: { ...makeJob().request!.remoteComposer!, workspaceId: 'workspace-2', threadId: 'thread-2', provider: 'gemini', text: 'queued' } },
        source: 'remote'
      }),
      makeJob({
        runId: 'run-starting',
        status: 'starting',
        request: { ...makeJob().request!, remoteComposer: { ...makeJob().request!.remoteComposer!, workspaceId: 'workspace-1', threadId: 'thread-1', provider: 'gemini', text: 'starting' } },
        source: 'manual'
      }),
      makeJob({
        runId: 'run-active-non-remote',
        status: 'active',
        source: 'remote',
        request: { ...makeJob().request!, remoteComposer: undefined }
      })
    ]
    expect(remoteComposerChatIsBusy(jobs, 'chat-1')).toBe(true)
  })

  it('returns false when the chat has only queued non-busy jobs', () => {
    const jobs = [makeJob({ runId: 'run-queued', status: 'queued' })]
    expect(remoteComposerChatIsBusy(jobs, 'chat-1')).toBe(false)
  })

  it('returns false for jobs outside the target chat', () => {
    expect(remoteComposerChatIsBusy([makeJob({ chatId: 'other-chat', status: 'active' })], 'chat-1')).toBe(
      false
    )
  })

  it('covers exactly starting/active/cancelling for busy detection', () => {
    for (const status of REMOTE_COMPOSER_ACTIVE_QUEUE_STATUSES) {
      expect(remoteComposerChatIsBusy([makeJob({ status })], 'chat-1')).toBe(true)
    }
    expect(remoteComposerChatIsBusy([makeJob({ status: 'queued' })], 'chat-1')).toBe(false)
  })
})

describe('buildRemoteComposerQueueDispatchAction', () => {
  it('preserves provenance and pins appRunId/queueRunId to job.runId', () => {
    const job = makeJob({
      runId: 'remote-queue-123',
      request: {
        scope: 'workspace',
        prompt: 'from phone',
        selectedModelType: 'cli-default',
        customModel: '',
        approvalMode: 'default',
        sessionTrust: false,
        imageAttachments: [],
        remoteComposer: {
          workspaceId: 'ws-phone',
          threadId: 'thread-phone',
          provider: 'codex',
          text: 'Open a follow-up PR.',
          approvalMode: 'plan',
          workflowMode: 'plan',
          model: 'o4-mini',
          reasoningEffort: 'low',
          claudeReasoningEffort: null,
          contextTurns: 7,
          extraWorkspaceIds: ['ws-extra-2']
        }
      }
    })
    const dispatch = buildRemoteComposerQueueDispatchAction(job)
    expect(dispatch).toEqual({
      queueRunId: 'remote-queue-123',
      appRunId: 'remote-queue-123',
      source: 'remote',
      action: {
        kind: 'composerPrompt',
        workspaceId: 'ws-phone',
        threadId: 'thread-phone',
        provider: 'codex',
        text: 'Open a follow-up PR.',
        approvalMode: 'plan',
        workflowMode: 'plan',
        model: 'o4-mini',
        reasoningEffort: 'low',
        claudeReasoningEffort: null,
        contextTurns: 7,
        extraWorkspaceIds: ['ws-extra-2']
      }
    })
    expect('appRunId' in dispatch!.action).toBe(false)
  })

  it('returns null for non-remote jobs', () => {
    expect(buildRemoteComposerQueueDispatchAction(makeJob({ source: 'manual' }))).toBeNull()
  })
})

describe('authorizeRemoteComposerQueueDispatch', () => {
  it('revalidates queued remote dispatch against the current startTurn allowlist', () => {
    const evaluateAllowlist = vi.fn(() => ({
      allowed: true,
      entry: {
        workspaceId: 'workspace-1',
        path: '/repo',
        mode: 'read-write',
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['plan'],
        createdAt: 1,
        updatedAt: 1
      }
    }))

    expect(
      authorizeRemoteComposerQueueDispatch(makeJob(), { evaluateAllowlist })
    ).toEqual({ allowed: true })
    expect(evaluateAllowlist).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      provider: 'gemini',
      approvalMode: 'plan',
      capability: 'startTurn'
    })
  })

  it('denies queued remote dispatch when the allowlist has been revoked', () => {
    const decision = authorizeRemoteComposerQueueDispatch(makeJob(), {
      evaluateAllowlist: () => ({ allowed: false, reason: 'Workspace no longer allowlisted' })
    })
    expect(decision).toEqual({
      allowed: false,
      reason: 'Workspace no longer allowlisted'
    })
  })

  it('denies malformed or non-remote queue jobs before allowlist evaluation', () => {
    const evaluateAllowlist = vi.fn()
    const decision = authorizeRemoteComposerQueueDispatch(makeJob({ source: 'manual' }), {
      evaluateAllowlist
    })
    expect(decision).toEqual({
      allowed: false,
      reason: 'Remote composer queue job is not dispatchable.'
    })
    expect(evaluateAllowlist).not.toHaveBeenCalled()
  })
})

describe('classifyRemoteComposerQueueDispatchResult', () => {
  it('treats accepted/dispatched as non-terminal (does not map to failed)', () => {
    const decision = classifyRemoteComposerQueueDispatchResult({
      queueRunId: 'run-1',
      appRunId: 'run-1',
      executed: true,
      message: 'Dispatched from remote queue.'
    })
    expect(decision.transitionStatus).toBeUndefined()
    expect(decision.statusReason).toBeUndefined()
  })

  it('maps not-dispatched results to failed with queue run id preserved', () => {
    const decision = classifyRemoteComposerQueueDispatchResult({
      queueRunId: 'run-2',
      appRunId: 'run-2',
      executed: false,
      message: 'Provider unavailable.'
    })
    expect(decision).toEqual({
      queueRunId: 'run-2',
      appRunId: 'run-2',
      transitionStatus: 'failed',
      statusReason: 'Provider unavailable.',
      lastError: 'Provider unavailable.'
    })
  })
})

describe('classifyRemoteComposerQueueDispatchFailure', () => {
  it('maps exceptions to failed for the internal queue id', () => {
    const failure = classifyRemoteComposerQueueDispatchFailure({
      queueRunId: 'run-3',
      appRunId: 'run-3',
      error: new Error('boom')
    })
    expect(failure).toEqual({
      queueRunId: 'run-3',
      appRunId: 'run-3',
      transitionStatus: 'failed',
      statusReason: 'boom',
      lastError: 'boom'
    })
  })

  it('uses a fallback reason when throwing a non-Error value', () => {
    expect(
      classifyRemoteComposerQueueDispatchFailure({
        queueRunId: 'run-4',
        appRunId: 'run-4',
        error: 13
      }).statusReason
    ).toBe('13')
  })
})
