import { describe, expect, it } from 'vitest'
import type { ScheduledTask, WorkflowDefinition } from './store/types'
import {
  isCanonicalWorkflowScheduledTask,
  sanitizeRendererScheduledTaskLifecyclePatch
} from './ScheduledTaskRendererAuthority'

const now = '2026-07-14T12:00:00.000Z'

function scheduledTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    workspaceId: 'workspace-1',
    workspacePath: '/workspace',
    chatId: 'chat-1',
    provider: 'codex',
    prompt: 'Review the workspace.',
    selectedModelType: 'cli-default',
    customModel: '',
    approvalMode: 'default',
    sessionTrust: false,
    imageAttachments: [],
    runAt: now,
    timezone: 'Europe/London',
    status: 'due',
    workflowId: 'workflow-1',
    workflowExecutionId: 'execution-1',
    workflowOccurrenceAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

function workflow(task: ScheduledTask, overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'workflow-1',
    name: 'Review workflow',
    workspaceId: 'workspace-1',
    workspacePath: '/workspace',
    enabled: true,
    trigger: { kind: 'manual' },
    template: {
      workspaceId: task.workspaceId,
      workspacePath: task.workspacePath,
      chatId: task.chatId,
      provider: task.provider,
      prompt: task.prompt,
      displayPrompt: task.displayPrompt,
      selectedModelType: task.selectedModelType,
      customModel: task.customModel,
      approvalMode: task.approvalMode,
      permissionPresetId: task.permissionPresetId,
      workflowMode: task.workflowMode,
      sessionTrust: task.sessionTrust,
      imageAttachments: task.imageAttachments,
      externalPathGrants: task.externalPathGrants,
      geminiWorktree: task.geminiWorktree,
      codexReasoningEffort: task.codexReasoningEffort,
      codexServiceTier: task.codexServiceTier,
      claudeReasoningEffort: task.claudeReasoningEffort,
      claudeFastMode: task.claudeFastMode,
      kimiFastMode: task.kimiFastMode,
      kimiThinkingEnabled: task.kimiThinkingEnabled,
      grokReasoningEffort: task.grokReasoningEffort,
      cursorReasoningEffort: task.cursorReasoningEffort,
      cursorFastMode: task.cursorFastMode,
      runtimeProfileId: task.runtimeProfileId,
      geminiAuthProfileId: task.geminiAuthProfileId,
      handoffSourceRunId: task.handoffSourceRunId,
      kind: task.kind,
      ensembleSnapshot: task.ensembleSnapshot
    },
    missedRunPolicy: 'coalesce',
    concurrencyPolicy: 'skip',
    limits: { maxConsecutiveFailures: 3 },
    failureStreak: 0,
    activeExecutionId: 'execution-1',
    history: [
      {
        id: 'execution-1',
        workflowId: 'workflow-1',
        scheduledTaskId: task.id,
        plannedFor: now,
        status: task.status === 'running' ? 'running' : 'queued',
        createdAt: now,
        updatedAt: now
      }
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

describe('sanitizeRendererScheduledTaskLifecyclePatch', () => {
  it('accepts only live lifecycle transitions and MAIN-stamps audit times', () => {
    const due = scheduledTask()
    const running = sanitizeRendererScheduledTaskLifecyclePatch(due, {
      status: 'running',
      runId: '  run-1  ',
      firedAt: '2099-01-01T00:00:00.000Z'
    })
    expect(running).toMatchObject({ status: 'running', runId: 'run-1' })
    expect(running.firedAt).not.toBe('2099-01-01T00:00:00.000Z')

    const completed = sanitizeRendererScheduledTaskLifecyclePatch(
      scheduledTask({ status: 'running', runId: 'run-1', firedAt: now }),
      { status: 'completed', completedAt: '2099-01-01T00:00:00.000Z' }
    )
    expect(completed.status).toBe('completed')
    expect(completed.completedAt).not.toBe('2099-01-01T00:00:00.000Z')
  })

  it('rejects readiness minting, illegal transitions, oversized ids, and config mutation', () => {
    const pending = scheduledTask({ status: 'pending' })
    for (const patch of [
      { status: 'due' },
      { status: 'running', runId: 'run-1' },
      { status: 'cancelled', prompt: 'forged' },
      { status: 'cancelled', workflowId: 'other' }
    ]) {
      expect(() => sanitizeRendererScheduledTaskLifecyclePatch(pending, patch)).toThrow()
    }
    expect(() =>
      sanitizeRendererScheduledTaskLifecyclePatch(scheduledTask(), {
        status: 'running',
        runId: 'x'.repeat(513)
      })
    ).toThrow('Scheduled task run id is invalid.')
  })

  it('makes repeated terminal reports idempotent', () => {
    const existing = scheduledTask({
      status: 'failed',
      completedAt: now,
      lastError: 'original evidence'
    })
    expect(
      sanitizeRendererScheduledTaskLifecyclePatch(existing, {
        status: 'failed',
        completedAt: '2099-01-01T00:00:00.000Z',
        lastError: 'replacement evidence'
      })
    ).toEqual({ status: 'failed' })
  })
})

describe('isCanonicalWorkflowScheduledTask', () => {
  const canonicalPath = (value: string) => value.replace(/\/$/, '')

  it('accepts exact due/queued and running/running workflow occurrences', () => {
    const due = scheduledTask()
    expect(isCanonicalWorkflowScheduledTask(due, workflow(due), canonicalPath)).toBe(true)

    const running = scheduledTask({ status: 'running', runId: 'run-1' })
    expect(isCanonicalWorkflowScheduledTask(running, workflow(running), canonicalPath)).toBe(true)
  })

  it('rejects outer workspace, template, history, and lifecycle divergence', () => {
    const task = scheduledTask()
    const base = workflow(task)
    const mutations: WorkflowDefinition[] = [
      { ...base, workspaceId: 'workspace-2' },
      { ...base, workspacePath: '/other' },
      { ...base, template: { ...base.template, prompt: 'Retargeted prompt.' } },
      {
        ...base,
        history: [{ ...base.history[0], scheduledTaskId: 'other-task' }]
      },
      {
        ...base,
        history: [{ ...base.history[0], status: 'running' }]
      },
      {
        ...base,
        history: [{ ...base.history[0], status: 'cancelled' }]
      }
    ]
    for (const candidate of mutations) {
      expect(isCanonicalWorkflowScheduledTask(task, candidate, canonicalPath)).toBe(false)
    }

    const running = scheduledTask({ status: 'running', runId: 'run-1' })
    const queuedWorkflow = workflow(running, {
      history: [{ ...workflow(running).history[0], status: 'queued' }]
    })
    expect(isCanonicalWorkflowScheduledTask(running, queuedWorkflow, canonicalPath)).toBe(false)
  })

  it('fails closed instead of throwing on malformed persisted paths', () => {
    const task = scheduledTask({ workspacePath: null as unknown as string })
    expect(isCanonicalWorkflowScheduledTask(task, workflow(task), canonicalPath)).toBe(false)

    const validTask = scheduledTask()
    const malformedWorkflow = workflow(validTask, {
      workspacePath: null as unknown as string
    })
    expect(
      isCanonicalWorkflowScheduledTask(validTask, malformedWorkflow, canonicalPath)
    ).toBe(false)
  })
})
