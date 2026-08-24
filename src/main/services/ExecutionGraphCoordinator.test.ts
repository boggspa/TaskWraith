import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunSessionChangeEvent } from '../RunManager'
import { recoverRunQueueJobsAfterStartup } from '../RunRecovery'
import type { ProviderId, RunQueueJob, RunQueueJobStatus } from '../store/types'
import { compileExecutionGraphRevision } from '../executionGraph/ExecutionGraphCompiler'
import { ExecutionGraphRepository } from '../executionGraph/ExecutionGraphRepository'
import type {
  ExecutionGraphRevision,
  ExecutionPermissionCeilingRef
} from '../executionGraph/ExecutionGraphModel'
import type { ExecutionRunProjection } from '../executionGraph/ExecutionGraphRun'
import { buildExecutionGraphAttemptTerminalReceipt } from '../executionGraph/ExecutionGraphAttemptResult'
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
  executionGraph?: RunQueueJob['executionGraph']
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
    ...(input.executionGraph ? { executionGraph: input.executionGraph } : {}),
    priority: 0,
    attempt: 1,
    createdAt: '2026-07-18T11:00:00.000Z',
    updatedAt: '2026-07-18T11:00:00.000Z'
  }
}

function terminalEvent(
  runId: string,
  status: 'completed' | 'failed' | 'cancelled',
  overrides: Partial<RunSessionChangeEvent['session']> = {}
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
      sessionGrants: new Set(),
      ...overrides
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

function harness(
  options: { materializeError?: Error; omitExecutionGraphBinding?: boolean } = {}
): Harness {
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
  const cancelActiveRun = vi.fn(() => true)
  const anchorStatuses = new Map<string, ExecutionGraphAnchorRunStatus>()
  const materializePausedQueueJob = vi.fn(
    ({
      runId,
      provider,
      workspaceId,
      rootChatId,
      executionId,
      activationId,
      attemptId,
      runTemplate,
      permissionCeilingAuthorityDigest
    }) => {
      if (options.materializeError) throw options.materializeError
      const job = queueJob({
        runId,
        provider,
        workspaceId,
        rootChatId,
        ...(options.omitExecutionGraphBinding
          ? {}
          : {
              executionGraph: {
                schemaVersion: 1,
                executionId,
                activationId,
                attemptId,
                runTemplateRef: runTemplate.templateId,
                permissionCeilingAuthorityDigest
              }
            })
      })
      jobs.set(runId, job)
      return job
    }
  )
  let id = 0
  let clientRequest = 0
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
    input: (overrides = {}) => {
      const clientRequestId = overrides.clientRequestId ?? `client-request-${++clientRequest}`
      return {
        clientSubmissionDigest: 'c'.repeat(64),
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one',
        stepTitle: 'Inspect the change',
        objective: 'Inspect the requested change carefully.',
        provider: 'codex',
        effect: 'read_only',
        runTemplateRef: template.templateId,
        permissionCeilingRef: ceiling,
        ...overrides,
        clientRequestId
      }
    }
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

function markQueueStarting(h: Harness, runId: string): void {
  const job = h.jobs.get(runId)
  if (!job) throw new Error('Fixture has no queue job.')
  h.jobs.set(runId, { ...job, status: 'starting' })
}

function terminalReceipt(
  h: Harness,
  runId: string,
  status: 'completed' | 'failed' | 'cancelled'
) {
  const job = h.jobs.get(runId)
  const binding = job?.executionGraph
  if (!job || !binding || !job.workspaceId || !job.chatId) {
    throw new Error('Fixture has no exact graph queue binding.')
  }
  return buildExecutionGraphAttemptTerminalReceipt({
    binding: {
      schemaVersion: 1,
      executionId: binding.executionId,
      activationId: binding.activationId,
      attemptId: binding.attemptId,
      providerRunRef: runId,
      workspaceId: job.workspaceId,
      rootChatId: job.chatId,
      provider: job.provider
    },
    status,
    committedAt: '2026-07-18T11:00:02.000Z',
    prompt: 'Do the work.',
    content: status === 'completed' ? `Result from ${runId}` : '',
    evidenceRefs: [`assistant-${runId}`],
    ...(status === 'failed' ? { error: 'Provider run failed.' } : {})
  })
}

function structuredJoinRevision(
  h: Harness,
  firstScoutAuthority?: { ceilingReferenceId: string; authorityDigest: string }
): ExecutionGraphRevision {
  const outputSchema = { type: 'object', additionalProperties: true } as const
  const compiled = compileExecutionGraphRevision({
    graphId: 'structured-join-graph',
    revision: 1,
    workspaceId: 'workspace-one',
    name: 'Structured join graph',
    createdAt: '2026-07-18T11:00:00.000Z',
    steps: [
      ...['scout-one', 'scout-two'].map((id, index) => ({
        id,
        kind: 'solo_agent' as const,
        title: id,
        objective: `Run ${id}.`,
        effect: 'read_only' as const,
        outputs: [{ name: 'report', schema: outputSchema, required: true }],
        retry: { maxAttempts: 1 },
        ...(index === 0 && firstScoutAuthority
          ? {
              permissionRequestRef: {
                schemaVersion: 1 as const,
                referenceId: 'scout-one-permission',
                ceilingReferenceId: firstScoutAuthority.ceilingReferenceId,
                authorityDigest: firstScoutAuthority.authorityDigest
              }
            }
          : {}),
        agent: {
          provider: 'codex',
          model: 'gpt-5.5',
          runTemplateRef: h.templateRef,
          session: { mode: 'fresh' as const }
        }
      })),
      {
        id: 'scout-join',
        kind: 'join' as const,
        title: 'Scout join',
        objective: 'Join both scouts.',
        effect: 'read_only' as const,
        retry: { maxAttempts: 1 },
        join: { mode: 'all' as const }
      },
      {
        id: 'worker',
        kind: 'solo_agent' as const,
        title: 'Worker',
        objective: 'Use both scout results.',
        effect: 'read_only' as const,
        inputs: [
          { name: 'scout_1', schema: outputSchema, required: true },
          { name: 'scout_2', schema: outputSchema, required: true }
        ],
        outputs: [{ name: 'artifact', schema: outputSchema, required: true }],
        retry: { maxAttempts: 1 },
        agent: {
          provider: 'codex',
          model: 'gpt-5.5',
          runTemplateRef: h.templateRef,
          session: { mode: 'fresh' as const }
        }
      }
    ],
    edges: [
      {
        id: 'control-scout-one-join',
        kind: 'control',
        fromStepId: 'scout-one',
        toStepId: 'scout-join',
        outcome: 'success'
      },
      {
        id: 'control-scout-two-join',
        kind: 'control',
        fromStepId: 'scout-two',
        toStepId: 'scout-join',
        outcome: 'success'
      },
      {
        id: 'control-join-worker',
        kind: 'control',
        fromStepId: 'scout-join',
        toStepId: 'worker',
        outcome: 'success'
      },
      {
        id: 'data-scout-one-worker',
        kind: 'data',
        from: { stepId: 'scout-one', port: 'report' },
        to: { stepId: 'worker', port: 'scout_1' }
      },
      {
        id: 'data-scout-two-worker',
        kind: 'data',
        from: { stepId: 'scout-two', port: 'report' },
        to: { stepId: 'worker', port: 'scout_2' }
      }
    ],
    limits: { maxSteps: 4, maxConcurrentSteps: 2, maxAttempts: 4 }
  })
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues))
  h.repository.saveRevision(compiled.revision)
  return compiled.revision
}

describe('ExecutionGraphCoordinator linear Stack scheduling', () => {
  it('returns the committed projection when the same client mutation is retried', () => {
    const h = harness()
    const command = h.input({
      clientRequestId: 'renderer-run-retry-one',
      stepTitle: '  Inspect the change  ',
      objective: '  Inspect the requested change carefully.  '
    })

    const first = h.coordinator.appendStackStep(command)
    const firstEventCount = first.eventCount
    const firstJobCount = h.jobs.size
    const retried = h.coordinator.appendStackStep({
      ...command,
      executionId: first.executionId,
      stepTitle: 'Inspect the change',
      objective: 'Inspect the requested change carefully.'
    })

    expect(retried.executionId).toBe(first.executionId)
    expect(retried.eventCount).toBe(firstEventCount)
    expect(retried.topology.steps).toHaveLength(1)
    expect(h.jobs.size).toBe(firstJobCount)
    const append = h.repository
      .readExecutionEvents(first.executionId)
      .find((event) => event.kind === 'step_appended')
    expect(append).toMatchObject({
      clientRequestReceipt: {
        clientRequestId: 'renderer-run-retry-one',
        clientRequestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        clientSubmissionDigest: 'c'.repeat(64)
      }
    })
  })

  it('preflights a committed submission without requiring its original live anchor', () => {
    const h = harness()
    const clientSubmissionDigest = 'd'.repeat(64)
    const first = h.coordinator.appendStackStep(
      h.input({
        clientRequestId: 'renderer-run-preflight-one',
        clientSubmissionDigest,
        anchorRunRef: 'anchor-run'
      })
    )

    expect(
      h.coordinator.resolveStackAppendReceipt({
        clientRequestId: 'renderer-run-preflight-one',
        clientSubmissionDigest,
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one'
      })
    ).toMatchObject({ executionId: first.executionId, anchorRunRef: 'anchor-run' })
    expect(() =>
      h.coordinator.resolveStackAppendReceipt({
        clientRequestId: 'renderer-run-preflight-one',
        clientSubmissionDigest: 'e'.repeat(64),
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one'
      })
    ).toThrow(/different submitted payload/i)
    expect(() =>
      h.coordinator.resolveStackAppendReceipt({
        clientRequestId: 'renderer-run-preflight-one',
        clientSubmissionDigest,
        workspaceId: 'workspace-two',
        rootChatId: 'chat-one'
      })
    ).toThrow(/different execution target/i)
    expect(
      h.coordinator.resolveStackAppendReceipt({
        clientRequestId: 'renderer-run-preflight-missing',
        clientSubmissionDigest,
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one'
      })
    ).toBeUndefined()
  })

  it('rejects client request id reuse with a different semantic payload', () => {
    const h = harness()
    const command = h.input({ clientRequestId: 'renderer-run-reused' })
    const first = h.coordinator.appendStackStep(command)

    expect(() =>
      h.coordinator.appendStackStep({
        ...command,
        executionId: first.executionId,
        objective: 'A different operation must not inherit the prior receipt.'
      })
    ).toThrow(/already used with a different payload or target/i)
    expect(h.coordinator.getExecution(first.executionId)?.topology.steps).toHaveLength(1)
  })

  it('rejects direct retry when the renderer submission digest changes', () => {
    const h = harness()
    const command = h.input({ clientRequestId: 'renderer-run-digest-reused' })
    const first = h.coordinator.appendStackStep(command)

    expect(() =>
      h.coordinator.appendStackStep({
        ...command,
        executionId: first.executionId,
        clientSubmissionDigest: 'f'.repeat(64)
      })
    ).toThrow(/different submitted payload/i)
    expect(h.coordinator.getExecution(first.executionId)?.topology.steps).toHaveLength(1)
  })

  it('attention-gates an exact provider attempt on an unsupported continuation path', () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)

    const gated = h.coordinator.requireActionForProviderRun(
      runId,
      'Host-process reruns are not replay-safe for Stack attempts.'
    )

    expect(gated).toMatchObject({ state: 'requires_action' })
    expect(Object.values(gated?.attempts ?? {})[0]).toMatchObject({ state: 'interrupted' })
    expect(Object.values(gated?.activations ?? {})[0]).toMatchObject({
      state: 'requires_action'
    })
  })

  it('does not deduplicate intentionally identical prompts with distinct request ids', () => {
    const h = harness()
    const first = h.coordinator.appendStackStep(
      h.input({ clientRequestId: 'renderer-run-identical-one' })
    )
    const second = h.coordinator.appendStackStep(
      h.input({
        clientRequestId: 'renderer-run-identical-two',
        executionId: first.executionId
      })
    )

    expect(second.topology.steps).toHaveLength(2)
    expect(
      h.repository
        .readExecutionEvents(first.executionId)
        .filter((event) => event.kind === 'step_appended')
    ).toHaveLength(2)
  })

  it('finds a committed client receipt after its execution becomes terminal', () => {
    const h = harness()
    const command = h.input({ clientRequestId: 'renderer-run-terminal-retry' })
    const started = h.coordinator.appendStackStep(command)
    const runId = providerRunId(started)
    markQueueStarting(h, runId)
    h.coordinator.onRunSessionChange(
      terminalEvent(runId, 'completed'),
      terminalReceipt(h, runId, 'completed')
    )
    expect(h.coordinator.getExecution(started.executionId)?.state).toBe('succeeded')

    expect(
      h.coordinator.resolveStackAppendReceipt({
        clientRequestId: command.clientRequestId,
        clientSubmissionDigest: command.clientSubmissionDigest,
        workspaceId: command.workspaceId,
        rootChatId: command.rootChatId
      })
    ).toMatchObject({ executionId: started.executionId, state: 'succeeded' })

    const retried = h.coordinator.appendStackStep(command)

    expect(retried.executionId).toBe(started.executionId)
    expect(retried.state).toBe('succeeded')
    expect(retried.topology.steps).toHaveLength(1)
  })

  it('reconciles a terminal graph attempt before a stale queue lease can block successors', () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    markQueueStarting(h, runId)
    h.coordinator.onRunSessionChange(
      terminalEvent(runId, 'completed'),
      terminalReceipt(h, runId, 'completed')
    )
    expect(h.jobs.get(runId)?.status).toBe('starting')

    h.coordinator.recover()

    expect(h.jobs.get(runId)?.status).toBe('completed')
    expect(h.coordinator.getExecution(started.executionId)?.state).toBe('succeeded')
  })

  it('rejects a received request id when its retry points at another target', () => {
    const h = harness()
    const command = h.input({ clientRequestId: 'renderer-run-target-reuse' })
    h.coordinator.appendStackStep(command)

    expect(() =>
      h.coordinator.appendStackStep({
        ...command,
        rootChatId: 'chat-two'
      })
    ).toThrow(/does not belong to this workspace and chat/i)
  })

  // 20s budget: synchronous but long (many coordinator transitions + deep
  // matchers), starved past the 5s default on a Windows CI runner under 3-way
  // job contention (2026-07-24 run 30083371364); sub-second uncontended.
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

    markQueueStarting(h, firstRunId)
    h.coordinator.onRunSessionChange(runningEvent(firstRunId))
    expect(h.jobs.size).toBe(1)
    h.coordinator.onRunSessionChange(
      terminalEvent(firstRunId, 'completed'),
      terminalReceipt(h, firstRunId, 'completed')
    )

    const advanced = h.coordinator.getExecution(first.executionId)!
    const states = Object.values(advanced.activations).map((activation) => activation.state)
    expect(states).toEqual(['succeeded', 'queued'])
    expect(h.jobs.size).toBe(2)

    const secondRunId = Object.values(advanced.attempts).find(
      (attempt) => attempt.providerRunRef !== firstRunId
    )?.providerRunRef
    if (!secondRunId) throw new Error('Second attempt did not materialize.')
    markQueueStarting(h, secondRunId)
    h.coordinator.onRunSessionChange(
      terminalEvent(secondRunId, 'completed'),
      terminalReceipt(h, secondRunId, 'completed')
    )
    expect(h.coordinator.getExecution(first.executionId)?.state).toBe('succeeded')
  }, 20_000)

  it('attention-gates terminal evidence until the exact structured result is committed', () => {
    const h = harness()
    const first = h.coordinator.appendStackStep(h.input())
    const firstRunId = providerRunId(first)
    h.coordinator.appendStackStep(
      h.input({
        executionId: first.executionId,
        stepTitle: 'Must wait for result commit',
        objective: 'Do not launch from provider status alone.'
      })
    )
    markQueueStarting(h, firstRunId)

    expect(
      h.coordinator.onRunSessionChange(terminalEvent(firstRunId, 'completed'))
    ).toBe('accepted')

    const gated = h.coordinator.getExecution(first.executionId)!
    expect(gated.state).toBe('requires_action')
    expect(Object.values(gated.activations).map((activation) => activation.state)).toEqual([
      'requires_action',
      'dormant'
    ])
    expect(h.jobs.size).toBe(1)
    expect(Object.values(gated.attempts)[0].error).toMatch(/durable result barrier/i)
  })

  it('asserts exact graph authority at the queue dispatch boundary', () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)

    expect(h.coordinator.assertQueueJobDispatchable(runId)).toBe(h.jobs.get(runId))

    const job = h.jobs.get(runId)!
    h.jobs.set(runId, {
      ...job,
      executionGraph: { ...job.executionGraph!, executionId: 'another-execution' }
    })
    expect(() => h.coordinator.assertQueueJobDispatchable(runId)).toThrow(/not dispatchable/i)
  })

  it('rejects provider dispatch once the graph attempt is terminal', () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    h.coordinator.onRunSessionChange(terminalEvent(runId, 'completed'))

    expect(() => h.coordinator.assertQueueJobDispatchable(runId)).toThrow(/not dispatchable/i)
  })

  it('attention-gates an exact pre-session dispatch failure after containing its queue row', () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    h.jobs.set(runId, { ...h.jobs.get(runId)!, status: 'starting' })
    h.transitions.mockClear()

    const attention = h.coordinator.recordPreSessionDispatchFailure(
      runId,
      'Composer rejected the frozen graph request.'
    )

    expect(h.jobs.get(runId)).toMatchObject({ status: 'failed' })
    expect(h.transitions).toHaveBeenCalledWith(
      runId,
      'failed',
      expect.objectContaining({
        lastError: 'Composer rejected the frozen graph request.'
      })
    )
    expect(attention.state).toBe('requires_action')
    expect(Object.values(attention.activations)[0].state).toBe('requires_action')
    expect(Object.values(attention.attempts)[0]).toMatchObject({
      state: 'interrupted',
      error: expect.stringMatching(/did not create a RunManager session/i)
    })
  })

  it('terminalizes a durably contained requires-action Stack when the user cancels it', async () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    h.jobs.set(runId, { ...h.jobs.get(runId)!, status: 'starting' })
    h.coordinator.recordPreSessionDispatchFailure(
      runId,
      'Composer rejected the frozen graph request.'
    )

    await h.coordinator.cancelExecution(started.executionId)

    const cancelled = h.coordinator.getExecution(started.executionId)!
    expect(cancelled.state).toBe('cancelled')
    expect(Object.values(cancelled.activations)[0].state).toBe('cancelled')
    expect(Object.values(cancelled.attempts)[0].state).toBe('interrupted')
    expect(h.jobs.get(runId)?.status).toBe('failed')

    const replacement = h.coordinator.appendStackStep(h.input())
    expect(replacement.executionId).not.toBe(started.executionId)
  })

  it('persists graph attention when pre-session queue containment cannot be confirmed', async () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    h.jobs.set(runId, { ...h.jobs.get(runId)!, status: 'starting' })
    h.transitions.mockImplementationOnce(() => null)

    expect(() =>
      h.coordinator.recordPreSessionDispatchFailure(runId, 'Dispatch failed before RunManager.')
    ).toThrow(/containment could not be confirmed/i)

    const attention = h.coordinator.getExecution(started.executionId)!
    expect(attention.state).toBe('requires_action')
    expect(Object.values(attention.attempts)[0].state).toBe('interrupted')

    await h.coordinator.cancelExecution(started.executionId)
    expect(h.coordinator.getExecution(started.executionId)?.state).toBe('requires_action')
    expect(h.jobs.get(runId)?.status).toBe('starting')
  })

  it('rejects pre-session failure reconciliation for a mismatched queue binding', () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    const job = h.jobs.get(runId)!
    h.jobs.set(runId, {
      ...job,
      executionGraph: { ...job.executionGraph!, activationId: 'another-activation' }
    })

    expect(() =>
      h.coordinator.recordPreSessionDispatchFailure(runId, 'Must not cross authority.')
    ).toThrow(/cannot record a verified/i)
    expect(h.coordinator.getExecution(started.executionId)?.state).toBe('running')
  })

  it('treats the current provider run as an anchor dependency', () => {
    const h = harness()
    const waiting = h.coordinator.appendStackStep(h.input({ anchorRunRef: 'anchor-run' }))

    expect(waiting.state).toBe('waiting')
    expect(Object.values(waiting.activations)[0].state).toBe('dormant')
    expect(h.jobs.size).toBe(0)

    h.anchorStatuses.set('anchor-run', 'completed')
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

    markQueueStarting(h, firstRunId)
    h.coordinator.onRunSessionChange(
      terminalEvent(firstRunId, 'failed'),
      terminalReceipt(h, firstRunId, 'failed')
    )
    const failed = h.coordinator.getExecution(first.executionId)!
    expect(failed.state).toBe('failed')
    expect(Object.values(failed.activations).map((activation) => activation.state)).toEqual([
      'failed',
      'skipped'
    ])
    expect(h.jobs.size).toBe(1)
  })

  it.each([
    ['provider', { provider: 'claude' as const }],
    ['chat', { appChatId: 'chat-two' }],
    ['workspace', { workspacePath: '/another-workspace' }]
  ])('rejects a RunManager terminal event whose %s identity differs', (_label, overrides) => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)

    h.coordinator.onRunSessionChange(terminalEvent(runId, 'completed', overrides))

    const rejected = h.coordinator.getExecution(started.executionId)!
    expect(rejected.state).toBe('requires_action')
    expect(Object.values(rejected.activations)[0].state).toBe('requires_action')
    expect(Object.values(rejected.attempts)[0]).toMatchObject({
      state: 'interrupted',
      error: expect.stringMatching(/RunManager event rejected/i)
    })
  })

  it('rejects a RunManager event when the exact queue graph binding differs', () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    const job = h.jobs.get(runId)!
    h.jobs.set(runId, {
      ...job,
      executionGraph: { ...job.executionGraph!, attemptId: 'another-attempt' }
    })

    h.coordinator.onRunSessionChange(terminalEvent(runId, 'completed'))

    const rejected = h.coordinator.getExecution(started.executionId)!
    expect(rejected.state).toBe('requires_action')
    expect(Object.values(rejected.attempts)[0]).toMatchObject({
      state: 'interrupted',
      error: expect.stringMatching(/queue graph binding/i)
    })
  })

  it('rejects a RunManager event when the queue workspace differs from its template', () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    const job = h.jobs.get(runId)!
    h.jobs.set(runId, { ...job, workspacePath: '/another-workspace' })

    h.coordinator.onRunSessionChange(
      terminalEvent(runId, 'completed', { workspacePath: '/another-workspace' })
    )

    const rejected = h.coordinator.getExecution(started.executionId)!
    expect(rejected.state).toBe('requires_action')
    expect(Object.values(rejected.attempts)[0].error).toMatch(/queue graph binding/i)
  })

  it('does not settle an anchor from a mismatched terminal event', () => {
    const h = harness()
    const waiting = h.coordinator.appendStackStep(h.input({ anchorRunRef: 'anchor-run' }))
    h.anchorStatuses.set('anchor-run', 'completed')

    h.coordinator.onRunSessionChange(
      terminalEvent('anchor-run', 'completed', { appChatId: 'another-chat' })
    )

    const rejected = h.coordinator.getExecution(waiting.executionId)!
    expect(rejected.state).toBe('requires_action')
    expect(h.jobs.size).toBe(0)
  })

  it('rejects a RunManager event when its exact queue row is missing', () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    h.jobs.delete(runId)

    h.coordinator.onRunSessionChange(terminalEvent(runId, 'completed'))

    const rejected = h.coordinator.getExecution(started.executionId)!
    expect(rejected.state).toBe('requires_action')
    expect(Object.values(rejected.attempts)[0].state).toBe('interrupted')
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

  it('continues recovering healthy executions after one execution throws', () => {
    const h = harness()
    const broken = h.coordinator.appendStackStep(h.input())
    const healthy = h.coordinator.appendStackStep(
      h.input({ rootChatId: 'chat-two', title: 'Second Stack' })
    )
    const healthyRunId = providerRunId(healthy)
    h.jobs.set(healthyRunId, { ...h.jobs.get(healthyRunId)!, status: 'completed' })

    const internals = h.coordinator as unknown as {
      reconcileTerminalAttemptQueueRows: (projection: ExecutionRunProjection) => void
    }
    const original = internals.reconcileTerminalAttemptQueueRows.bind(h.coordinator)
    vi.spyOn(internals, 'reconcileTerminalAttemptQueueRows').mockImplementation((projection) => {
      if (projection.executionId === broken.executionId) {
        throw new Error('one execution is unreadable')
      }
      original(projection)
    })

    const diagnostics = h.coordinator.recover()

    expect(diagnostics).toEqual([
      {
        executionId: broken.executionId,
        message: 'one execution is unreadable'
      }
    ])
    expect(h.coordinator.getExecution(healthy.executionId)).toMatchObject({
      state: 'requires_action'
    })
  })

  it.each(['starting', 'active', 'cancelling'] as const)(
    'does not treat a generically recovered %s queue job as provider failure',
    (interruptedStatus) => {
      const h = harness()
      const first = h.coordinator.appendStackStep(h.input())
      const runId = providerRunId(first)
      h.coordinator.appendStackStep(
        h.input({
          executionId: first.executionId,
          stepTitle: 'Must not advance',
          objective: 'This successor requires authoritative provider success.'
        })
      )
      const original = { ...h.jobs.get(runId)!, status: interruptedStatus }
      const genericRecovery = recoverRunQueueJobsAfterStartup(
        [original],
        '2026-07-18T11:01:00.000Z',
        () => undefined
      )
      expect(genericRecovery.jobs[0]).toMatchObject({
        status: 'failed',
        recoveryReason: 'marked_failed_on_startup'
      })
      h.jobs.set(runId, genericRecovery.jobs[0])
      h.transitions.mockClear()

      h.coordinator.recover()

      const recovered = h.coordinator.getExecution(first.executionId)!
      expect(recovered.state).toBe('requires_action')
      expect(Object.values(recovered.attempts)[0].state).toBe('interrupted')
      expect(Object.values(recovered.activations).map((activation) => activation.state)).toEqual([
        'requires_action',
        'dormant'
      ])
      expect(h.transitions).not.toHaveBeenCalled()
    }
  )

  it('requires action when startup recovery finds a possibly alive orphan provider process', () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    const original = { ...h.jobs.get(runId)!, status: 'active' as const, processPid: 4242 }
    const genericRecovery = recoverRunQueueJobsAfterStartup(
      [original],
      '2026-07-18T11:01:00.000Z',
      (pid, checkedAt) => ({
        pid,
        checkedAt,
        alive: true,
        command: '/usr/bin/codex',
        detection: 'pid_signal_and_ps',
        action: 'left_running'
      })
    )
    expect(genericRecovery.jobs[0]).toMatchObject({
      status: 'failed',
      recoveryReason: 'orphan_detected_on_startup',
      orphanProcess: { alive: true }
    })
    h.jobs.set(runId, genericRecovery.jobs[0])
    h.transitions.mockClear()

    h.coordinator.recover()

    const recovered = h.coordinator.getExecution(started.executionId)!
    expect(recovered.state).toBe('requires_action')
    expect(Object.values(recovered.attempts)[0]).toMatchObject({
      state: 'interrupted',
      error: expect.stringMatching(/still be running/i)
    })
    expect(h.transitions).not.toHaveBeenCalled()
  })

  it('does not replay a steer promotion that generic startup recovery requeued', () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    const original = {
      ...h.jobs.get(runId)!,
      status: 'steer_promoting' as const,
      promotionOwnerToken: 'owner-one',
      promotionToken: 'promotion-one',
      promotionAttempt: 1,
      promotedAt: '2026-07-18T11:00:30.000Z'
    }
    const genericRecovery = recoverRunQueueJobsAfterStartup(
      [original],
      '2026-07-18T11:01:00.000Z',
      () => undefined
    )
    expect(genericRecovery.jobs[0]).toMatchObject({
      status: 'queued',
      recoveryReason: 'stale_steer_promoting_recovered'
    })
    h.jobs.set(runId, genericRecovery.jobs[0])
    h.transitions.mockClear()

    h.coordinator.recover()

    const recovered = h.coordinator.getExecution(started.executionId)!
    expect(recovered.state).toBe('requires_action')
    expect(Object.values(recovered.attempts)[0]).toMatchObject({
      state: 'interrupted',
      error: expect.stringMatching(/steer promotion/i)
    })
    expect(h.jobs.get(runId)?.status).toBe('queued')
    expect(h.transitions).not.toHaveBeenCalled()
  })

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'does not trust recovered queue status %s as a provider outcome',
    (terminalStatus) => {
      const h = harness()
      const started = h.coordinator.appendStackStep(h.input())
      const runId = providerRunId(started)
      h.jobs.set(runId, {
        ...h.jobs.get(runId)!,
        status: terminalStatus,
        recoveredAt: '2026-07-18T11:01:00.000Z',
        recoveryReason: 'marked_failed_on_startup'
      })
      h.transitions.mockClear()

      h.coordinator.recover()

      const recovered = h.coordinator.getExecution(started.executionId)!
      expect(recovered.state).toBe('requires_action')
      expect(Object.values(recovered.activations)[0].state).toBe('requires_action')
      expect(Object.values(recovered.attempts)[0].state).toBe('interrupted')
      expect(h.transitions).not.toHaveBeenCalled()
    }
  )

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'does not trust a plain terminal queue status %s as provider evidence',
    (terminalStatus) => {
      const h = harness()
      const started = h.coordinator.appendStackStep(h.input())
      const runId = providerRunId(started)
      h.jobs.set(runId, { ...h.jobs.get(runId)!, status: terminalStatus })
      h.transitions.mockClear()

      h.coordinator.recover()

      const recovered = h.coordinator.getExecution(started.executionId)!
      expect(recovered.state).toBe('requires_action')
      expect(Object.values(recovered.attempts)[0]).toMatchObject({
        state: 'interrupted',
        error: expect.stringMatching(/not authoritative provider terminal evidence/i)
      })
      expect(h.transitions).not.toHaveBeenCalled()
    }
  )

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
    const claimed = h.coordinator.getExecution(waiting.executionId)!
    const attempt = Object.values(claimed.attempts)[0]
    const activation = claimed.activations[attempt.activationId]
    h.jobs.set(
      'paused-graph-run',
      queueJob({
        runId: 'paused-graph-run',
        provider: 'codex',
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one',
        executionGraph: {
          schemaVersion: 1,
          executionId: waiting.executionId,
          activationId: activation.id,
          attemptId: attempt.id,
          runTemplateRef: h.templateRef,
          permissionCeilingAuthorityDigest: h.ceiling.authorityDigest
        }
      })
    )

    h.coordinator.recover()

    const recovered = h.coordinator.getExecution(waiting.executionId)!
    expect(recovered.state).toBe('running')
    expect(Object.values(recovered.activations)[0].state).toBe('queued')
    expect(Object.values(recovered.attempts)[0].state).toBe('queued')
    expect(h.jobs.get('paused-graph-run')?.status).toBe('queued')
  })

  it('does not recover a queue row whose graph authority binding is missing', () => {
    const h = harness()
    const waiting = h.coordinator.appendStackStep(h.input({ anchorRunRef: 'anchor-run' }))
    appendClaimCrashWindow(h, waiting.executionId, 'fully-correlated', 'unowned-graph-run')
    h.jobs.set(
      'unowned-graph-run',
      queueJob({
        runId: 'unowned-graph-run',
        provider: 'codex',
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one'
      })
    )

    h.coordinator.recover()

    const recovered = h.coordinator.getExecution(waiting.executionId)!
    expect(recovered.state).toBe('requires_action')
    expect(Object.values(recovered.attempts)[0].state).toBe('interrupted')
    expect(h.jobs.get('unowned-graph-run')?.status).toBe('paused')
    expect(h.transitions).not.toHaveBeenCalled()
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

  it('requires action when materialization omits the main-owned graph binding', () => {
    const h = harness({ omitExecutionGraphBinding: true })

    const recovered = h.coordinator.appendStackStep(h.input())

    expect(recovered.state).toBe('requires_action')
    expect(Object.values(recovered.attempts)[0]).toMatchObject({
      state: 'interrupted',
      providerRunRef: expect.stringMatching(/^graph-run-/)
    })
    expect([...h.jobs.values()][0]?.status).toBe('failed')
    expect(h.transitions).toHaveBeenCalledWith(
      expect.stringMatching(/^graph-run-/),
      'failed',
      expect.objectContaining({ lastError: expect.stringMatching(/authority binding/i) })
    )
  })

  it('persists cancellation before a provider callback can re-enter the coordinator', async () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    h.jobs.set(runId, { ...h.jobs.get(runId)!, status: 'active' })
    h.coordinator.onRunSessionChange(runningEvent(runId))
    h.transitions.mockClear()
    h.cancelActiveRun.mockImplementation((cancelledRunId: string) => {
      h.coordinator.onRunSessionChange(
        terminalEvent(cancelledRunId, 'cancelled'),
        terminalReceipt(h, cancelledRunId, 'cancelled')
      )
    })

    await expect(h.coordinator.cancelExecution(started.executionId)).resolves.toBeUndefined()

    const cancelled = h.coordinator.getExecution(started.executionId)!
    expect(cancelled.state).toBe('cancelled')
    expect(Object.values(cancelled.activations)[0].state).toBe('cancelled')
    expect(Object.values(cancelled.attempts)[0].state).toBe('cancelled')
    expect(h.cancelActiveRun).toHaveBeenCalledWith(runId)
    expect(h.jobs.get(runId)?.status).toBe('cancelled')
    expect(h.transitions.mock.calls.map((call) => call[1])).toEqual(['cancelling', 'cancelled'])
  })

  it('terminally contains a queued row without touching a provider transport', async () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    h.transitions.mockClear()

    await h.coordinator.cancelExecution(started.executionId)

    expect(h.cancelActiveRun).not.toHaveBeenCalled()
    expect(h.transitions.mock.calls.map((call) => call[1])).toEqual(['cancelled'])
    expect(h.coordinator.getExecution(started.executionId)?.state).toBe('cancelled')
  }, 30_000)

  it('terminally contains a paused graph claim without an invalid cancelling transition', async () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    h.jobs.set(runId, { ...h.jobs.get(runId)!, status: 'paused' })
    h.transitions.mockClear()

    await h.coordinator.cancelExecution(started.executionId)

    expect(h.cancelActiveRun).not.toHaveBeenCalled()
    expect(h.transitions.mock.calls.map((call) => call[1])).toEqual(['cancelled'])
    expect(h.jobs.get(runId)?.status).toBe('cancelled')
    expect(h.coordinator.getExecution(started.executionId)?.state).toBe('cancelled')
  }, 30_000)

  it('requires action and leaves the lease blocked when provider cleanup throws', async () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    h.jobs.set(runId, { ...h.jobs.get(runId)!, status: 'active' })
    h.coordinator.onRunSessionChange(runningEvent(runId))
    h.transitions.mockClear()
    h.cancelActiveRun.mockRejectedValueOnce(new Error('transport unavailable'))

    await expect(h.coordinator.cancelExecution(started.executionId)).resolves.toBeUndefined()

    const attention = h.coordinator.getExecution(started.executionId)!
    expect(attention.state).toBe('requires_action')
    expect(Object.values(attention.activations)[0].state).toBe('requires_action')
    expect(Object.values(attention.attempts)[0]).toMatchObject({
      state: 'interrupted',
      error: expect.stringMatching(/transport unavailable/i)
    })
    expect(h.jobs.get(runId)).toMatchObject({
      status: 'cancelling'
    })
    expect(h.transitions).not.toHaveBeenCalledWith(runId, 'cancelled', expect.anything())
  })

  it('requires action when exact provider cleanup cannot be confirmed', async () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    h.jobs.set(runId, { ...h.jobs.get(runId)!, status: 'starting' })
    h.cancelActiveRun.mockReturnValueOnce(false)

    await h.coordinator.cancelExecution(started.executionId)

    const attention = h.coordinator.getExecution(started.executionId)!
    expect(attention.state).toBe('requires_action')
    expect(Object.values(attention.attempts)[0]).toMatchObject({
      state: 'interrupted',
      error: expect.stringMatching(/could not confirm exact cleanup/i)
    })
    expect(h.jobs.get(runId)?.status).toBe('cancelling')
  })

  it('does not accept a mismatched synchronous cancellation callback as cleanup evidence', async () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    h.jobs.set(runId, { ...h.jobs.get(runId)!, status: 'active' })
    h.cancelActiveRun.mockImplementationOnce((cancelledRunId: string) => {
      h.coordinator.onRunSessionChange(
        terminalEvent(cancelledRunId, 'cancelled', { workspacePath: '/wrong-workspace' })
      )
      return true
    })

    await h.coordinator.cancelExecution(started.executionId)

    const attention = h.coordinator.getExecution(started.executionId)!
    expect(attention.state).toBe('requires_action')
    expect(Object.values(attention.attempts)[0].state).toBe('interrupted')
    expect(h.jobs.get(runId)?.status).toBe('cancelling')
  })

  it('does not dispatch a successor when completion synchronously races cancellation', async () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    h.coordinator.appendStackStep(
      h.input({
        executionId: started.executionId,
        stepTitle: 'Must remain undispatched',
        objective: 'Cancellation owns this frontier.'
      })
    )
    h.jobs.set(runId, { ...h.jobs.get(runId)!, status: 'active' })
    h.cancelActiveRun.mockImplementationOnce((cancelledRunId: string) => {
      h.coordinator.onRunSessionChange(
        terminalEvent(cancelledRunId, 'completed'),
        terminalReceipt(h, cancelledRunId, 'completed')
      )
      return true
    })

    await h.coordinator.cancelExecution(started.executionId)

    const cancelled = h.coordinator.getExecution(started.executionId)!
    expect(cancelled.state).toBe('cancelled')
    expect(Object.values(cancelled.activations).map((activation) => activation.state)).toEqual([
      'succeeded',
      'cancelled'
    ])
    expect(h.jobs.size).toBe(1)
  })

  it('reconciles a stale queued row from its terminal graph attempt', () => {
    const h = harness()
    const started = h.coordinator.appendStackStep(h.input())
    const runId = providerRunId(started)
    markQueueStarting(h, runId)
    h.coordinator.onRunSessionChange(
      terminalEvent(runId, 'completed'),
      terminalReceipt(h, runId, 'completed')
    )
    expect(h.coordinator.getExecution(started.executionId)?.state).toBe('succeeded')
    h.jobs.set(runId, { ...h.jobs.get(runId)!, status: 'queued' })
    expect(h.jobs.get(runId)?.status).toBe('queued')
    h.transitions.mockClear()

    h.coordinator.recover()

    expect(h.jobs.get(runId)?.status).toBe('completed')
    expect(h.transitions).toHaveBeenCalledWith(
      runId,
      'completed',
      expect.objectContaining({ statusReason: expect.stringMatching(/authoritative execution/i) })
    )
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

    h.anchorStatuses.set('anchor-run', 'failed')
    h.coordinator.onRunSessionChange(terminalEvent('anchor-run', 'failed'))

    const failed = h.coordinator.getExecution(first.executionId)!
    expect(failed.state).toBe('failed')
    expect(Object.values(failed.activations).map((entry) => entry.state)).toEqual([
      'skipped',
      'skipped'
    ])
  })
})

describe('ExecutionGraphCoordinator structured graph scheduling', () => {
  it('binds a narrower per-step permission digest under the execution ceiling', () => {
    const h = harness()
    const stepAuthorityDigest = 'b'.repeat(64)
    const revision = structuredJoinRevision(h, {
      ceilingReferenceId: h.ceiling.referenceId,
      authorityDigest: stepAuthorityDigest
    })
    h.coordinator.startExecutionGraph({
      executionId: 'step-authority-execution',
      title: 'Step authority execution',
      workspaceId: 'workspace-one',
      rootChatId: 'chat-one',
      tenant: { kind: 'workflow' },
      revision,
      permissionCeilingRef: h.ceiling
    })

    expect(h.materializePausedQueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ permissionCeilingAuthorityDigest: stepAuthorityDigest })
    )
    expect([...h.jobs.values()][0]?.executionGraph?.permissionCeilingAuthorityDigest).toBe(
      stepAuthorityDigest
    )
  })

  it('rejects a step permission request that is not under the execution ceiling', () => {
    const h = harness()
    const revision = structuredJoinRevision(h, {
      ceilingReferenceId: 'another-ceiling',
      authorityDigest: 'b'.repeat(64)
    })

    expect(() =>
      h.coordinator.startExecutionGraph({
        executionId: 'wrong-ceiling-execution',
        title: 'Wrong ceiling execution',
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one',
        tenant: { kind: 'workflow' },
        revision,
        permissionCeilingRef: h.ceiling
      })
    ).toThrow(/invalid permission request binding/i)
    expect(h.jobs.size).toBe(0)
  })

  it('executes an all-join and binds exact predecessor results into the worker', () => {
    const h = harness()
    const revision = structuredJoinRevision(h)
    const started = h.coordinator.startExecutionGraph({
      executionId: 'structured-join-execution',
      title: 'Structured join execution',
      workspaceId: 'workspace-one',
      rootChatId: 'chat-one',
      tenant: { kind: 'workflow', tenantId: 'ultratask-one' },
      revision,
      permissionCeilingRef: h.ceiling
    })

    const firstRunId = providerRunId(started)
    markQueueStarting(h, firstRunId)
    h.coordinator.onRunSessionChange(
      terminalEvent(firstRunId, 'completed'),
      terminalReceipt(h, firstRunId, 'completed')
    )

    const afterFirst = h.coordinator.getExecution(started.executionId)!
    const secondRunId = Object.values(afterFirst.attempts).find(
      (attempt) => attempt.providerRunRef && attempt.providerRunRef !== firstRunId
    )?.providerRunRef
    if (!secondRunId) throw new Error('Second scout did not materialize.')
    markQueueStarting(h, secondRunId)
    h.coordinator.onRunSessionChange(
      terminalEvent(secondRunId, 'completed'),
      terminalReceipt(h, secondRunId, 'completed')
    )

    const afterJoin = h.coordinator.getExecution(started.executionId)!
    expect(
      Object.values(afterJoin.activations).find((activation) => activation.stepId === 'scout-join')
        ?.state
    ).toBe('succeeded')
    const workerAttempt = Object.values(afterJoin.attempts).find(
      (attempt) => attempt.stepId === 'worker'
    )
    expect(workerAttempt?.state).toBe('queued')
    expect(h.materializePausedQueueJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        executionId: started.executionId,
        inputs: {
          scout_1: expect.objectContaining({
            output: { schemaVersion: 1, kind: 'assistant_text', text: `Result from ${firstRunId}` }
          }),
          scout_2: expect.objectContaining({
            output: { schemaVersion: 1, kind: 'assistant_text', text: `Result from ${secondRunId}` }
          })
        }
      })
    )

    const workerRunId = workerAttempt?.providerRunRef
    if (!workerRunId) throw new Error('Worker did not receive a provider run.')
    markQueueStarting(h, workerRunId)
    h.coordinator.onRunSessionChange(
      terminalEvent(workerRunId, 'completed'),
      terminalReceipt(h, workerRunId, 'completed')
    )
    expect(h.coordinator.getExecution(started.executionId)?.state).toBe('succeeded')
  })

  it('refuses graph controls the bound runtime does not enforce yet', () => {
    const h = harness()
    const revision = structuredJoinRevision(h)
    expect(() =>
      h.coordinator.startExecutionGraph({
        executionId: 'budgeted-execution',
        title: 'Budgeted execution',
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one',
        tenant: { kind: 'workflow' },
        revision: {
          ...revision,
          limits: { ...revision.limits, maxCostUsd: 1 }
        },
        permissionCeilingRef: h.ceiling
      })
    ).toThrow(/unenforced budgets/i)
  })
})
