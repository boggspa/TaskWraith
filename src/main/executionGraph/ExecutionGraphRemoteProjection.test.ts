import { describe, expect, it } from 'vitest'
import type { ExecutionStepDefinition, StepActivation } from './ExecutionGraphModel'
import type { ExecutionRunProjection } from './ExecutionGraphRun'
import {
  REMOTE_EXECUTION_REASON_MAX,
  REMOTE_EXECUTION_RUN_LIST_MAX,
  REMOTE_EXECUTION_TITLE_MAX,
  buildRemoteExecutionRun,
  buildRemoteExecutionRunList
} from './ExecutionGraphRemoteProjection'

const NOW = '2026-07-18T12:00:00.000Z'

function step(
  id: string,
  overrides: Partial<ExecutionStepDefinition> = {}
): ExecutionStepDefinition {
  return {
    id,
    title: `Step ${id}`,
    objective: `private objective ${id}`,
    kind: 'solo_agent',
    effect: 'read_only',
    retry: { maxAttempts: 1 },
    agent: { provider: 'codex', session: { mode: 'fresh' } },
    ...overrides
  } as ExecutionStepDefinition
}

function activation(
  id: string,
  stepId: string,
  state: StepActivation['state'],
  overrides: Partial<StepActivation> = {}
): StepActivation {
  return {
    id,
    stepId,
    state,
    createdAt: NOW,
    updatedAt: NOW,
    attemptIds: [],
    ...overrides
  }
}

function projection(overrides: Partial<ExecutionRunProjection> = {}): ExecutionRunProjection {
  return {
    executionId: 'execution-1',
    title: 'Release Stack',
    workspaceId: 'workspace-1',
    rootChatId: 'chat-1',
    tenant: { kind: 'stack', tenantId: 'stack-1' },
    state: 'running',
    createdAt: '2026-07-18T11:00:00.000Z',
    updatedAt: NOW,
    topology: { steps: [step('plan'), step('ship')], edges: [] },
    topologyDigest: 'private-topology-digest',
    activations: {
      plan: activation('activation-plan', 'plan', 'succeeded'),
      ship: activation('activation-ship', 'ship', 'running')
    },
    attempts: {},
    eventCount: 8,
    lastSequence: 8,
    integrity: 'valid',
    baseRevisionMissing: false,
    diagnostics: [],
    ...overrides
  }
}

describe('ExecutionGraph remote projection', () => {
  it('projects bounded execution identity, attention, progress, and the active step', () => {
    const remote = buildRemoteExecutionRun(projection())

    expect(remote).toEqual({
      schemaVersion: 1,
      executionId: 'execution-1',
      tenantKind: 'stack',
      tenantId: 'stack-1',
      workspaceId: 'workspace-1',
      threadId: 'chat-1',
      title: 'Release Stack',
      state: 'running',
      attention: 'none',
      activeStep: { id: 'ship', title: 'Step ship', state: 'running' },
      completedStepCount: 1,
      totalStepCount: 2,
      createdAt: '2026-07-18T11:00:00.000Z',
      updatedAt: NOW
    })
  })

  it('prioritizes approval attention and redacts credential-shaped text from display fields', () => {
    const longTitle = `Approve ${'x'.repeat(REMOTE_EXECUTION_TITLE_MAX * 2)} sk-proj-abcdefghijklmnop`
    const reason = `Use Bearer abcdefghijklmnop before approval ${'y'.repeat(
      REMOTE_EXECUTION_REASON_MAX * 2
    )}`
    const remote = buildRemoteExecutionRun(
      projection({
        title: 'password=hunter2 Release',
        topology: { steps: [step('gate', { title: longTitle })], edges: [] },
        activations: {
          gate: activation('gate', 'gate', 'waiting_approval', { reason })
        },
        attempts: {
          secret: {
            id: 'secret',
            activationId: 'gate',
            stepId: 'gate',
            ordinal: 1,
            state: 'failed',
            createdAt: NOW,
            updatedAt: NOW,
            error: 'raw failure with sk-proj-should-never-be-projected',
            result: {
              schemaVersion: 1,
              output: { raw: 'private provider output' },
              artifactRefs: [],
              trust: 'untrusted_agent_output'
            }
          }
        }
      })
    )

    expect(remote.attention).toBe('awaiting_approval')
    expect(remote.title).toBe('[REDACTED] Release')
    expect(remote.activeStep?.title.length).toBeLessThanOrEqual(REMOTE_EXECUTION_TITLE_MAX)
    expect(remote.reason).toContain('[REDACTED]')
    expect(remote.reason?.length).toBeLessThanOrEqual(REMOTE_EXECUTION_REASON_MAX)
    const wire = JSON.stringify(remote)
    expect(wire).not.toContain('private objective')
    expect(wire).not.toContain('private provider output')
    expect(wire).not.toContain('should-never-be-projected')
    expect(wire).not.toContain('topology-digest')
    expect(wire).not.toContain('artifactRefs')
    expect(wire).not.toContain('permissionCeilingRef')
  })

  it('surfaces invalid folds and missing pinned revisions without forwarding diagnostics', () => {
    const remote = buildRemoteExecutionRun(
      projection({
        state: 'pending',
        integrity: 'invalid',
        baseRevisionMissing: true,
        diagnostics: [
          { code: 'base_revision_missing', message: 'Sensitive local path /private/repo' }
        ],
        activations: {}
      })
    )

    expect(remote.attention).toBe('requires_action')
    expect(remote.reason).toBe('Pinned graph revision is unavailable.')
    expect(JSON.stringify(remote)).not.toContain('/private/repo')
  })

  it('filters by exact workspace, orders attention first, and enforces the list cap', () => {
    const ordinary = projection({ executionId: 'ordinary', updatedAt: '2026-07-18T12:10:00Z' })
    const approval = projection({
      executionId: 'approval',
      workspaceId: 'workspace-1',
      updatedAt: '2026-07-18T11:00:00Z',
      activations: { gate: activation('gate', 'ship', 'waiting_approval') }
    })
    const otherWorkspace = projection({ executionId: 'other', workspaceId: 'workspace-2' })

    expect(
      buildRemoteExecutionRunList([ordinary, otherWorkspace, approval], {
        workspaceId: 'workspace-1'
      }).map((entry) => entry.executionId)
    ).toEqual(['approval', 'ordinary'])

    const many = Array.from({ length: REMOTE_EXECUTION_RUN_LIST_MAX + 20 }, (_, index) =>
      projection({ executionId: `execution-${index}` })
    )
    expect(buildRemoteExecutionRunList(many, { limit: 10_000 })).toHaveLength(
      REMOTE_EXECUTION_RUN_LIST_MAX
    )
  })
})
