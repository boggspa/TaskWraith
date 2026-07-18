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
  templateRef: string
  ceiling: ExecutionPermissionCeilingRef
  input: (overrides?: Partial<AppendExecutionStackStepInput>) => AppendExecutionStackStepInput
}

function harness(): Harness {
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
  let id = 0
  const deps: ExecutionGraphCoordinatorDeps = {
    repository,
    materializePausedQueueJob: ({ runId, provider, workspaceId, rootChatId }) => {
      const job = queueJob({ runId, provider, workspaceId, rootChatId })
      jobs.set(runId, job)
      return job
    },
    getQueueJob: (runId) => jobs.get(runId) ?? null,
    transitionQueueJob: transitions,
    cancelActiveRun: vi.fn(),
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
})
