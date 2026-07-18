import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunSessionChangeEvent } from '../RunManager'
import type { ProviderId, RunQueueJob, RunQueueJobStatus } from '../store/types'
import { ExecutionGraphRepository } from '../executionGraph/ExecutionGraphRepository'
import type { ExecutionPermissionCeilingRef } from '../executionGraph/ExecutionGraphModel'
import {
  ExecutionGraphCoordinator,
  type AppendExecutionStackStepInput,
  type ExecutionGraphAnchorRunStatus,
  type ExecutionGraphCoordinatorDeps
} from './ExecutionGraphCoordinator'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function storageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-graph-coordinator-'))
  roots.push(root)
  return root
}

function queueJob(input: {
  runId: string
  provider: ProviderId
  workspaceId: string
  rootChatId: string
}): RunQueueJob {
  return {
    id: input.runId,
    runId: input.runId,
    provider: input.provider,
    scope: 'workspace',
    workspaceId: input.workspaceId,
    workspacePath: '/workspace',
    chatId: input.rootChatId,
    source: 'system',
    status: 'paused',
    priority: 0,
    attempt: 1,
    createdAt: '2026-07-18T11:00:00.000Z',
    updatedAt: '2026-07-18T11:00:00.000Z'
  }
}

function terminalEvent(
  runId: string,
  status: 'completed' | 'failed' | 'cancelled'
): RunSessionChangeEvent {
  return {
    type: 'updated',
    session: {
      runId,
      provider: 'codex',
      appChatId: 'chat-one',
      workspacePath: '/workspace',
      status,
      startedAt: 1,
      updatedAt: 2,
      approvalIds: new Set(),
      sessionGrants: new Set()
    }
  }
}

function runningEvent(runId: string): RunSessionChangeEvent {
  return {
    ...terminalEvent(runId, 'completed'),
    session: { ...terminalEvent(runId, 'completed').session, status: 'running' }
  }
}

interface Harness {
  repository: ExecutionGraphRepository
  coordinator: ExecutionGraphCoordinator
  jobs: Map<string, RunQueueJob>
  transitions: ReturnType<typeof vi.fn>
  cancelActiveRun: ReturnType<typeof vi.fn>
  materializePausedQueueJob: ReturnType<typeof vi.fn>
  anchorStatuses: Map<string, ExecutionGraphAnchorRunStatus>
  templateRef: string
  ceiling: ExecutionPermissionCeilingRef
  input: (overrides?: Partial<AppendExecutionStackStepInput>) => AppendExecutionStackStepInput
}

function harness(options: { materializeError?: Error } = {}): Harness {
  const repository = new ExecutionGraphRepository(storageRoot())
  const template = repository.saveRunTemplate({
    schemaVersion: 1,
    provider: 'codex',
    scope: 'workspace',
    workspaceId: 'workspace-one',
    workspacePath: '/workspace',
    chatId: 'chat-one',
    request: {
      prompt: 'Do the next task',
      selectedModelType: 'default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: []
    }
  })
  const jobs = new Map<string, RunQueueJob>()
  const transitions = vi.fn((runId: string, status: RunQueueJobStatus): RunQueueJob | null => {
    const existing = jobs.get(runId)
    if (!existing) return null
    const next = { ...existing, status, updatedAt: '2026-07-18T11:00:01.000Z' }
    jobs.set(runId, next)
    return next
  })
  const cancelActiveRun = vi.fn()
  const anchorStatuses = new Map<string, ExecutionGraphAnchorRunStatus>()
  const materializePausedQueueJob = vi.fn(({ runId, provider, workspaceId, rootChatId }) => {
    if (options.materializeError) throw options.materializeError
    const job = queueJob({ runId, provider, workspaceId, rootChatId })
    jobs.set(runId, job)
    return job
  })
  let id = 0
  const deps: ExecutionGraphCoordinatorDeps = {
    repository,
    materializePausedQueueJob,
    getQueueJob: (runId) => jobs.get(runId) ?? null,
    transitionQueueJob: transitions,
    resolveAnchorRunStatus: (runId) => anchorStatuses.get(runId) ?? 'missing',
    cancelActiveRun,
    now: () => '2026-07-18T11:00:00.000Z',
    createId: () => `id-${++id}`,
    onChanged: vi.fn()
  }
  const coordinator = new ExecutionGraphCoordinator(deps)
  const ceiling: ExecutionPermissionCeilingRef = {
    schemaVersion: 1,
    referenceId: 'ceiling-workspace-one',
    authorityDigest: 'a'.repeat(64),
    workspaceId: 'workspace-one'
  }
  return {
    repository,
    coordinator,
    jobs,
    transitions,
    cancelActiveRun,
    materializePausedQueueJob,
    anchorStatuses,
    templateRef: template.templateId,
    ceiling,
    input: (overrides = {}) => ({
      workspaceId: 'workspace-one',
      rootChatId: 'chat-one',
      stepTitle: 'Inspect the change',
      objective: 'Inspect the requested change carefully.',
      provider: 'codex',
      effect: 'read_only',
      runTemplateRef: template.templateId,
      permissionCeilingRef: ceiling,
      ...overrides
    })
  }
}

function appendClaimCrashWindow(
  h: Harness,
  executionId: string,
  completeness: 'activation-only' | 'attempt-created' | 'fully-correlated',
  providerRunRef = 'orphan-graph-run'
): void {
  const projection = h.coordinator.getExecution(executionId)!
  const activation = Object.values(projection.activations)[0]
  const attemptId = 'crash-attempt'
  h.repository.appendExecutionEvents(
    [
      {
        executionId,
        kind: 'execution_state_changed',
        state: 'running',
        reason: 'Anchor completed immediately before shutdown.'
      },
      {
        executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'ready'
      },
      {
        executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'claimed'
      },
      ...(completeness === 'activation-only'
        ? []
        : [
            {
              executionId,
              kind: 'attempt_created' as const,
              attemptId,
              activationId: activation.id,
              stepId: activation.stepId,
              ordinal: 1
            }
          ]),
      ...(completeness === 'fully-correlated'
        ? [
            {
              executionId,
              kind: 'attempt_state_changed' as const,
              attemptId,
              state: 'claimed' as const,
              providerRunRef
            }
          ]
        : [])
    ],
    { expectedLastSequence: projection.lastSequence }
  )
}

function providerRunId(projection: ReturnType<ExecutionGraphCoordinator['getExecution']>): string {
  const attempt = Object.values(projection?.attempts ?? {})[0]
  if (!attempt?.providerRunRef) throw new Error('Fixture has no provider run ref.')
  return attempt.providerRunRef
}

describe('ExecutionGraphCoordinator linear Stack scheduling', () => {
  it('holds appended successors until their real predecessor succeeds', () => {
    const h = harness()
    const first = h.coordinator.appendStackStep(h.input())
    const firstRunId = providerRunId(first)
    expect(h.jobs.get(firstRunId)?.status).toBe('queued')
    expect(h.materializePausedQueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: first.executionId,
        permissionCeilingAuthorityDigest: h.ceiling.authorityDigest
      })
    )

    const withSecond = h.coordinator.appendStackStep(
      h.input({
        executionId: first.executionId,
        stepTitle: 'Verify the result',
        objective: 'Verify the prior result.'
      })
    )
    expect(withSecond.topology.steps).toHaveLength(2)
    expect(withSecond.topology.edges).toMatchObject([{ kind: 'control', outcome: 'success' }])
    expect(Object.values(withSecond.activations).map((activation) => activation.state)).toEqual([
      'queued',
      'dormant'
    ])
    expect(h.jobs.size).toBe(1)

    h.coordinator.onRunSessionChange(runningEvent(firstRunId))
    expect(h.jobs.size).toBe(1)
    h.coordinator.onRunSessionChange(terminalEvent(firstRunId, 'completed'))

    const advanced = h.coordinator.getExecution(first.executionId)!
    const states = Object.values(advanced.activations).map((activation) => activation.state)
    expect(states).toEqual(['succeeded', 'queued'])
    expect(h.jobs.size).toBe(2)

    const secondRunId = Object.values(advanced.attempts).find(
      (attempt) => attempt.providerRunRef !== firstRunId
    )?.providerRunRef
    if (!secondRunId) throw new Error('Second attempt did not materialize.')
    h.coordinator.onRunSessionChange(terminalEvent(secondRunId, 'completed'))
    expect(h.coordinator.getExecution(first.executionId)?.state).toBe('succeeded')
  })

  it('treats the current provider run as an anchor dependency', () => {
    const h = harness()
    const waiting = h.coordinator.appendStackStep(h.input({ anchorRunRef: 'anchor-run' }))

    expect(waiting.state).toBe('waiting')
    expect(Object.values(waiting.activations)[0].state).toBe('dormant')
    expect(h.jobs.size).toBe(0)

    h.coordinator.onRunSessionChange(terminalEvent('anchor-run', 'completed'))
    const released = h.coordinator.getExecution(waiting.executionId)!
    expect(released.state).toBe('running')
    expect(Object.values(released.activations)[0].state).toBe('queued')
    expect(h.jobs.size).toBe(1)
  })

  it('propagates provider failure across the success-only frontier', () => {
    const h = harness()
    const first = h.coordinator.appendStackStep(h.input())
    const firstRunId = providerRunId(first)
    h.coordinator.appendStackStep(
      h.input({
        executionId: first.executionId,
        stepTitle: 'Never dispatch',
        objective: 'This must remain blocked.'
      })
    )

    h.coordinator.onRunSessionChange(terminalEvent(firstRunId, 'failed'))
    const failed = h.coordinator.getExecution(first.executionId)!
    expect(failed.state).toBe('failed')
    expect(Object.values(failed.activations).map((activation) => activation.state)).toEqual([
      'failed',
      'skipped'
    ])
    expect(h.jobs.size).toBe(1)
  })

  it('rejects an append that replaces the run permission ceiling', () => {
    const h = harness()
    const first = h.coordinator.appendStackStep(h.input())
    expect(() =>
      h.coordinator.appendStackStep(
        h.input({
          executionId: first.executionId,
          permissionCeilingRef: {
            ...h.ceiling,
            authorityDigest: 'b'.repeat(64)
          }
        })
      )
    ).toThrow(/cannot widen or replace/i)
    expect(h.coordinator.getExecution(first.executionId)?.topology.steps).toHaveLength(1)
  })

  it('requires action instead of replaying a possibly dispatched attempt on recovery', () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    h.jobs.set(runId, { ...h.jobs.get(runId)!, status: 'active' })
    h.transitions.mockClear()

    h.coordinator.recover()

    const recovered = h.coordinator.getExecution(started.executionId)!
    expect(recovered.state).toBe('requires_action')
    expect(Object.values(recovered.activations)[0].state).toBe('requires_action')
    expect(Object.values(recovered.attempts)[0].state).toBe('interrupted')
    expect(h.transitions).not.toHaveBeenCalledWith(runId, 'queued', expect.anything())
  })

  it('reconciles a completed anchor from exact run truth after restart', () => {
    const h = harness()
    const waiting = h.coordinator.appendStackStep(h.input({ anchorRunRef: 'anchor-run' }))
    h.anchorStatuses.set('anchor-run', 'completed')

    h.coordinator.recover()

    const recovered = h.coordinator.getExecution(waiting.executionId)!
    expect(recovered.state).toBe('running')
    expect(Object.values(recovered.activations)[0].state).toBe('queued')
    expect(h.jobs.size).toBe(1)
  })

  it.each(['missing', 'ambiguous'] as const)(
    'requires action when anchor truth is %s after restart',
    (anchorStatus) => {
      const h = harness()
      const waiting = h.coordinator.appendStackStep(h.input({ anchorRunRef: 'anchor-run' }))
      h.anchorStatuses.set('anchor-run', anchorStatus)

      h.coordinator.recover()

      const recovered = h.coordinator.getExecution(waiting.executionId)!
      expect(recovered.state).toBe('requires_action')
      expect(Object.values(recovered.activations)[0].state).toBe('dormant')
      expect(h.jobs.size).toBe(0)
    }
  )

  it('keeps waiting only while exact anchor truth remains nonterminal', () => {
    const h = harness()
    const waiting = h.coordinator.appendStackStep(h.input({ anchorRunRef: 'anchor-run' }))
    h.anchorStatuses.set('anchor-run', 'nonterminal')

    h.coordinator.recover()

    expect(h.coordinator.getExecution(waiting.executionId)?.state).toBe('waiting')
    expect(h.jobs.size).toBe(0)
  })

  it('turns an activation-only torn claim batch into requires action', () => {
    const h = harness()
    const waiting = h.coordinator.appendStackStep(h.input({ anchorRunRef: 'anchor-run' }))
    appendClaimCrashWindow(h, waiting.executionId, 'activation-only')

    h.coordinator.recover()

    const recovered = h.coordinator.getExecution(waiting.executionId)!
    expect(recovered.state).toBe('requires_action')
    expect(Object.values(recovered.activations)[0].state).toBe('requires_action')
    expect(Object.values(recovered.attempts)).toHaveLength(0)
  })

  it('interrupts an attempt-created torn claim batch without replaying it', () => {
    const h = harness()
    const waiting = h.coordinator.appendStackStep(h.input({ anchorRunRef: 'anchor-run' }))
    appendClaimCrashWindow(h, waiting.executionId, 'attempt-created')

    h.coordinator.recover()

    const recovered = h.coordinator.getExecution(waiting.executionId)!
    expect(recovered.state).toBe('requires_action')
    expect(Object.values(recovered.activations)[0].state).toBe('requires_action')
    expect(Object.values(recovered.attempts)[0].state).toBe('interrupted')
    expect(Object.values(recovered.attempts)[0]).not.toHaveProperty('providerRunRef')
    expect(h.materializePausedQueueJob).toHaveBeenCalledTimes(0)
  })

  it('fails safely when restart lands after durable correlation but before materialization', () => {
    const h = harness()
    const waiting = h.coordinator.appendStackStep(h.input({ anchorRunRef: 'anchor-run' }))
    appendClaimCrashWindow(h, waiting.executionId, 'fully-correlated')

    h.coordinator.recover()

    const recovered = h.coordinator.getExecution(waiting.executionId)!
    expect(recovered.state).toBe('requires_action')
    expect(Object.values(recovered.attempts)[0]).toMatchObject({
      state: 'interrupted',
      providerRunRef: 'orphan-graph-run'
    })
    expect(h.transitions).not.toHaveBeenCalled()
  })

  it('recovers a paused job only when its durable claim is fully correlated', () => {
    const h = harness()
    const waiting = h.coordinator.appendStackStep(h.input({ anchorRunRef: 'anchor-run' }))
    appendClaimCrashWindow(h, waiting.executionId, 'fully-correlated', 'paused-graph-run')
    h.jobs.set(
      'paused-graph-run',
      queueJob({
        runId: 'paused-graph-run',
        provider: 'codex',
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one'
      })
    )

    h.coordinator.recover()

    const recovered = h.coordinator.getExecution(waiting.executionId)!
    expect(recovered.state).toBe('running')
    expect(Object.values(recovered.activations)[0].state).toBe('queued')
    expect(Object.values(recovered.attempts)[0].state).toBe('queued')
    expect(h.jobs.get('paused-graph-run')?.status).toBe('queued')
  })

  it('retains durable run correlation when queue materialization throws', () => {
    const h = harness({ materializeError: new Error('disk unavailable') })

    const recovered = h.coordinator.appendStackStep(h.input())

    expect(recovered.state).toBe('requires_action')
    expect(Object.values(recovered.activations)[0].state).toBe('requires_action')
    expect(Object.values(recovered.attempts)[0]).toMatchObject({
      state: 'interrupted',
      providerRunRef: expect.stringMatching(/^graph-run-/)
    })
    expect(h.jobs.size).toBe(0)
  })

  it('persists cancellation before a provider callback can re-enter the coordinator', async () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    h.jobs.set(runId, { ...h.jobs.get(runId)!, status: 'active' })
    h.coordinator.onRunSessionChange(runningEvent(runId))
    h.cancelActiveRun.mockImplementation((cancelledRunId: string) => {
      h.coordinator.onRunSessionChange(terminalEvent(cancelledRunId, 'cancelled'))
    })

    await expect(h.coordinator.cancelExecution(started.executionId)).resolves.toBeUndefined()

    const cancelled = h.coordinator.getExecution(started.executionId)!
    expect(cancelled.state).toBe('cancelled')
    expect(Object.values(cancelled.activations)[0].state).toBe('cancelled')
    expect(Object.values(cancelled.attempts)[0].state).toBe('cancelled')
    expect(h.cancelActiveRun).toHaveBeenCalledWith(runId)
    expect(h.jobs.get(runId)?.status).toBe('cancelled')
  })

  it('cancels the whole remaining Stack only from its dormant frontier', async () => {
    const h = harness()
    const first = h.coordinator.appendStackStep(h.input())
    const firstRunId = providerRunId(first)
    const withSecond = h.coordinator.appendStackStep(
      h.input({
        executionId: first.executionId,
        stepTitle: 'Second step',
        objective: 'Run second.'
      })
    )
    const second = Object.values(withSecond.activations).find(
      (activation) => activation.stepId !== Object.values(withSecond.activations)[0].stepId
    )!
    h.jobs.set(firstRunId, { ...h.jobs.get(firstRunId)!, status: 'active' })
    h.coordinator.onRunSessionChange(runningEvent(firstRunId))

    await h.coordinator.cancelDormantStep(first.executionId, second.id)

    const cancelled = h.coordinator.getExecution(first.executionId)!
    expect(cancelled.state).toBe('cancelled')
    expect(Object.values(cancelled.activations).every((entry) => entry.state === 'cancelled')).toBe(
      true
    )
    expect(h.cancelActiveRun).toHaveBeenCalledWith(firstRunId)
  })

  it('rejects cancellation of a dormant non-frontier step', async () => {
    const h = harness()
    const first = h.coordinator.appendStackStep(h.input({ anchorRunRef: 'anchor-run' }))
    const withSecond = h.coordinator.appendStackStep(
      h.input({
        executionId: first.executionId,
        anchorRunRef: 'anchor-run',
        stepTitle: 'Second step',
        objective: 'Run second.'
      })
    )
    const nonFrontier = Object.values(withSecond.activations).find(
      (activation) => activation.stepId === withSecond.topology.steps[0].id
    )!

    await expect(
      h.coordinator.cancelDormantStep(first.executionId, nonFrontier.id)
    ).rejects.toThrow(/frontier/i)
    expect(h.coordinator.getExecution(first.executionId)?.state).toBe('waiting')
  })

  it('settles every dormant activation when the anchor fails', () => {
    const h = harness()
    const first = h.coordinator.appendStackStep(h.input({ anchorRunRef: 'anchor-run' }))
    h.coordinator.appendStackStep(
      h.input({
        executionId: first.executionId,
        anchorRunRef: 'anchor-run',
        stepTitle: 'Second step',
        objective: 'Run second.'
      })
    )

    h.coordinator.onRunSessionChange(terminalEvent('anchor-run', 'failed'))

    const failed = h.coordinator.getExecution(first.executionId)!
    expect(failed.state).toBe('failed')
    expect(Object.values(failed.activations).map((entry) => entry.state)).toEqual([
      'skipped',
      'skipped'
    ])
  })
})
