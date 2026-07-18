import { describe, expect, it } from 'vitest'
import {
  compileExecutionGraphRevision,
  executionGraphRevisionRef,
  topologyFromRevision
} from './ExecutionGraphCompiler'
import { recoverExecutionRunAfterRestart } from './ExecutionGraphRecovery'
import {
  createExecutionRunEvent,
  executionTopologyFrontier,
  foldExecutionRun,
  nextExecutionRunSequence,
  parseExecutionRunEventLine,
  prepareUserFrontierAppend,
  safeExecutionRunFileName,
  serializeExecutionRunEvent,
  validateUserFrontierAppend,
  type ExecutionRunEvent
} from './ExecutionGraphRun'
import type {
  ExecutionEffect,
  ExecutionGraphRevision,
  ExecutionPermissionCeilingRef,
  ExecutionStepDefinition,
  ExecutionStepResult,
  UserFrontierAppend
} from './ExecutionGraphModel'

const now = '2026-07-18T10:00:00.000Z'
const ceiling: ExecutionPermissionCeilingRef = {
  schemaVersion: 1,
  referenceId: 'ceiling:stack-1',
  authorityDigest: 'authority-digest',
  workspaceId: 'workspace-1'
}
const valueSchema = { type: 'object', required: ['value'] } as const

function agentStep(
  id = 'investigate',
  effect: ExecutionEffect = 'read_only'
): ExecutionStepDefinition {
  return {
    id,
    kind: 'solo_agent',
    title: 'Investigate',
    objective: 'Investigate the failure.',
    effect,
    retry: { maxAttempts: 2 },
    outputs: [{ name: 'finding', schema: valueSchema }],
    agent: { provider: 'codex', session: { mode: 'fresh' } }
  }
}

function checkStep(id = 'check'): ExecutionStepDefinition {
  return {
    id,
    kind: 'deterministic_check',
    title: 'Check',
    objective: 'Validate the finding.',
    effect: 'read_only',
    retry: { maxAttempts: 1 },
    inputs: [{ name: 'finding', schema: valueSchema }],
    outputs: [{ name: 'report', schema: valueSchema }],
    check: { handlerRef: 'checks.finding' }
  }
}

function outputStep(id = 'deliver'): ExecutionStepDefinition {
  return {
    id,
    kind: 'output',
    title: 'Deliver',
    objective: 'Deliver the validated result.',
    effect: 'read_only',
    retry: { maxAttempts: 1 },
    inputs: [{ name: 'report', schema: valueSchema }],
    output: { projectReference: 'none' }
  }
}

function creation(executionId = 'execution-1'): ExecutionRunEvent {
  return createExecutionRunEvent(
    {
      executionId,
      kind: 'execution_created',
      title: 'Fix stack',
      workspaceId: 'workspace-1',
      tenant: { kind: 'stack', tenantId: 'stack-1' },
      rootChatId: 'chat-1',
      anchorRunRef: 'run:seed',
      permissionCeilingRef: ceiling
    },
    1,
    now
  )
}

function appendFirst(executionId = 'execution-1', step = agentStep()) {
  return prepareUserFrontierAppend(
    {
      executionId,
      topology: { steps: [], edges: [] },
      runState: 'pending',
      permissionCeilingRef: ceiling,
      maxSteps: 20
    },
    { appendedBy: 'user', step, incomingEdges: [] }
  )
}

function buildRunningProjection(effect: ExecutionEffect = 'read_only') {
  const first = appendFirst('recover-1', agentStep('investigate', effect))
  if (!first.ok) throw new Error('fixture append failed')
  const events: ExecutionRunEvent[] = [
    creation('recover-1'),
    createExecutionRunEvent(first.input, 2, now),
    createExecutionRunEvent(
      { executionId: 'recover-1', kind: 'execution_state_changed', state: 'running' },
      3,
      now
    ),
    createExecutionRunEvent(
      {
        executionId: 'recover-1',
        kind: 'activation_created',
        activationId: 'activation-1',
        stepId: 'investigate'
      },
      4,
      now
    ),
    createExecutionRunEvent(
      {
        executionId: 'recover-1',
        kind: 'activation_state_changed',
        activationId: 'activation-1',
        state: 'ready'
      },
      5,
      now
    ),
    createExecutionRunEvent(
      {
        executionId: 'recover-1',
        kind: 'activation_state_changed',
        activationId: 'activation-1',
        state: 'claimed'
      },
      6,
      now
    ),
    createExecutionRunEvent(
      {
        executionId: 'recover-1',
        kind: 'attempt_created',
        attemptId: 'attempt-1',
        activationId: 'activation-1',
        stepId: 'investigate',
        ordinal: 1
      },
      7,
      now
    ),
    createExecutionRunEvent(
      {
        executionId: 'recover-1',
        kind: 'attempt_state_changed',
        attemptId: 'attempt-1',
        state: 'claimed'
      },
      8,
      now
    ),
    createExecutionRunEvent(
      {
        executionId: 'recover-1',
        kind: 'activation_state_changed',
        activationId: 'activation-1',
        state: 'running'
      },
      9,
      now
    ),
    createExecutionRunEvent(
      {
        executionId: 'recover-1',
        kind: 'attempt_state_changed',
        attemptId: 'attempt-1',
        state: 'running',
        providerRunRef: 'provider-run-1'
      },
      10,
      now
    )
  ]
  return { events, projection: foldExecutionRun('recover-1', events) }
}

describe('Execution Stack frontier append', () => {
  it('materializes base-less Stack topology from monotonic step_appended events', () => {
    const first = appendFirst()
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = prepareUserFrontierAppend(
      {
        executionId: 'execution-1',
        topology: first.topology,
        runState: 'running',
        permissionCeilingRef: ceiling,
        maxSteps: 20
      },
      {
        appendedBy: 'user',
        step: checkStep(),
        incomingEdges: [
          {
            id: 'investigate-check',
            kind: 'control',
            fromStepId: 'investigate',
            toStepId: 'check',
            outcome: 'success'
          },
          {
            id: 'investigate-check-data',
            kind: 'data',
            from: { stepId: 'investigate', port: 'finding' },
            to: { stepId: 'check', port: 'finding' }
          }
        ]
      }
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return

    const events = [
      creation(),
      createExecutionRunEvent(first.input, 2, now),
      createExecutionRunEvent(second.input, 3, now)
    ]
    const projection = foldExecutionRun('execution-1', events)
    expect(projection.integrity).toBe('valid')
    expect(projection.workspaceId).toBe('workspace-1')
    expect(projection.tenant).toEqual({ kind: 'stack', tenantId: 'stack-1' })
    expect(projection.rootChatId).toBe('chat-1')
    expect(projection.anchorRunRef).toBe('run:seed')
    expect(projection.topology.steps.map((step) => step.id)).toEqual(['investigate', 'check'])
    expect(projection.topology.edges).toHaveLength(2)
    expect(executionTopologyFrontier(projection.topology)).toEqual(['check'])
    expect(Object.isFrozen(projection.topology.steps)).toBe(true)
  })

  it('rejects retroactive edges, non-frontier control, agent append, and ceiling mismatch', () => {
    const first = appendFirst()
    if (!first.ok) throw new Error('fixture append failed')
    const secondAppend: UserFrontierAppend = {
      appendedBy: 'user',
      step: checkStep(),
      incomingEdges: [
        {
          id: 'first-second',
          kind: 'control',
          fromStepId: 'investigate',
          toStepId: 'check',
          outcome: 'success'
        }
      ]
    }
    const second = prepareUserFrontierAppend(
      {
        executionId: 'execution-1',
        topology: first.topology,
        runState: 'running',
        permissionCeilingRef: ceiling
      },
      secondAppend
    )
    if (!second.ok) throw new Error('fixture append failed')

    const retroactive = validateUserFrontierAppend(
      { topology: second.topology, runState: 'running', permissionCeilingRef: ceiling },
      {
        appendedBy: 'user',
        step: outputStep(),
        incomingEdges: [
          {
            id: 'bad-target',
            kind: 'control',
            fromStepId: 'check',
            toStepId: 'investigate',
            outcome: 'success'
          }
        ]
      }
    )
    const nonFrontier = validateUserFrontierAppend(
      { topology: second.topology, runState: 'running', permissionCeilingRef: ceiling },
      {
        appendedBy: 'user',
        step: outputStep(),
        incomingEdges: [
          {
            id: 'old-source',
            kind: 'control',
            fromStepId: 'investigate',
            toStepId: 'deliver',
            outcome: 'success'
          }
        ]
      }
    )
    const requested = agentStep('effectful', 'workspace_write')
    const mismatchedStep = {
      ...requested,
      permissionRequestRef: {
        schemaVersion: 1 as const,
        referenceId: 'write-request',
        ceilingReferenceId: 'different-ceiling'
      }
    }
    const mismatched = validateUserFrontierAppend(
      { topology: second.topology, runState: 'running', permissionCeilingRef: ceiling },
      {
        appendedBy: 'user',
        step: mismatchedStep,
        incomingEdges: [
          {
            id: 'check-effectful',
            kind: 'control',
            fromStepId: 'check',
            toStepId: 'effectful',
            outcome: 'success'
          }
        ]
      }
    )
    const agentDriven = validateUserFrontierAppend(
      { topology: second.topology, runState: 'running', permissionCeilingRef: ceiling },
      {
        appendedBy: 'agent',
        step: outputStep(),
        incomingEdges: []
      } as unknown as UserFrontierAppend
    )

    expect(retroactive.map((entry) => entry.code)).toContain('append_rewrites_existing_topology')
    expect(nonFrontier.map((entry) => entry.code)).toContain('control_source_not_frontier')
    expect(mismatched.map((entry) => entry.code)).toContain('permission_ceiling_mismatch')
    expect(agentDriven.map((entry) => entry.code)).toContain('agent_append_not_supported')
  })
})

describe('Execution-run event fold', () => {
  it('allows a ready activation to enter a durable wait or attention state', () => {
    const first = appendFirst()
    if (!first.ok) throw new Error('fixture append failed')
    const events = [
      creation(),
      createExecutionRunEvent(first.input, 2, now),
      createExecutionRunEvent(
        { executionId: 'execution-1', kind: 'execution_state_changed', state: 'running' },
        3,
        now
      ),
      createExecutionRunEvent(
        {
          executionId: 'execution-1',
          kind: 'activation_created',
          activationId: 'activation-1',
          stepId: 'investigate'
        },
        4,
        now
      ),
      createExecutionRunEvent(
        {
          executionId: 'execution-1',
          kind: 'activation_state_changed',
          activationId: 'activation-1',
          state: 'ready'
        },
        5,
        now
      ),
      createExecutionRunEvent(
        {
          executionId: 'execution-1',
          kind: 'activation_state_changed',
          activationId: 'activation-1',
          state: 'waiting_approval',
          reason: 'User approval is required.'
        },
        6,
        now
      )
    ]

    const projection = foldExecutionRun('execution-1', events)
    expect(projection.integrity).toBe('valid')
    expect(projection.activations['activation-1'].state).toBe('waiting_approval')
  })

  it('pins an immutable base revision and fails closed when it is missing or mismatched', () => {
    const compiled = compileExecutionGraphRevision({
      graphId: 'saved-graph',
      revision: 1,
      workspaceId: 'workspace-1',
      name: 'Saved',
      createdAt: now,
      steps: [agentStep()],
      edges: []
    })
    if (!compiled.ok) throw new Error('fixture compilation failed')
    const base: ExecutionGraphRevision = compiled.revision
    const created = createExecutionRunEvent(
      {
        executionId: 'saved-run',
        kind: 'execution_created',
        title: 'Saved run',
        workspaceId: 'workspace-1',
        tenant: { kind: 'workflow', tenantId: 'workflow-1' },
        baseRevision: executionGraphRevisionRef(base),
        permissionCeilingRef: ceiling
      },
      1,
      now
    )
    const loaded = foldExecutionRun('saved-run', [created], { baseRevision: base })
    const missing = foldExecutionRun('saved-run', [created])
    expect(loaded.integrity).toBe('valid')
    expect(loaded.topology).toEqual(topologyFromRevision(base))
    expect(missing.integrity).toBe('invalid')
    expect(missing.baseRevisionMissing).toBe(true)
    expect(missing.diagnostics[0].code).toBe('base_revision_missing')
  })

  it('folds activation/attempt lifecycle and typed artifact provenance', () => {
    const first = appendFirst()
    if (!first.ok) throw new Error('fixture append failed')
    const result: ExecutionStepResult = {
      schemaVersion: 1,
      output: { value: 'root cause' },
      summary: 'Found it.',
      artifactRefs: [
        {
          schemaVersion: 1,
          id: 'artifact-1',
          kind: 'report',
          createdByAttemptId: 'attempt-1',
          trust: 'untrusted_agent_output'
        }
      ],
      trust: 'untrusted_agent_output',
      providerRunRef: 'provider-run-1',
      threadRef: 'chat-attempt-1'
    }
    const inputs = [
      creation(),
      createExecutionRunEvent(first.input, 2, now),
      createExecutionRunEvent(
        { executionId: 'execution-1', kind: 'execution_state_changed', state: 'running' },
        3,
        now
      ),
      createExecutionRunEvent(
        {
          executionId: 'execution-1',
          kind: 'activation_created',
          activationId: 'activation-1',
          stepId: 'investigate'
        },
        4,
        now
      ),
      createExecutionRunEvent(
        {
          executionId: 'execution-1',
          kind: 'activation_state_changed',
          activationId: 'activation-1',
          state: 'ready'
        },
        5,
        now
      ),
      createExecutionRunEvent(
        {
          executionId: 'execution-1',
          kind: 'activation_state_changed',
          activationId: 'activation-1',
          state: 'claimed'
        },
        6,
        now
      ),
      createExecutionRunEvent(
        {
          executionId: 'execution-1',
          kind: 'attempt_created',
          attemptId: 'attempt-1',
          activationId: 'activation-1',
          stepId: 'investigate',
          ordinal: 1
        },
        7,
        now
      ),
      createExecutionRunEvent(
        {
          executionId: 'execution-1',
          kind: 'attempt_state_changed',
          attemptId: 'attempt-1',
          state: 'claimed'
        },
        8,
        now
      ),
      createExecutionRunEvent(
        {
          executionId: 'execution-1',
          kind: 'activation_state_changed',
          activationId: 'activation-1',
          state: 'running'
        },
        9,
        now
      ),
      createExecutionRunEvent(
        {
          executionId: 'execution-1',
          kind: 'attempt_state_changed',
          attemptId: 'attempt-1',
          state: 'running'
        },
        10,
        now
      ),
      createExecutionRunEvent(
        {
          executionId: 'execution-1',
          kind: 'attempt_state_changed',
          attemptId: 'attempt-1',
          state: 'succeeded',
          result
        },
        11,
        now
      ),
      createExecutionRunEvent(
        {
          executionId: 'execution-1',
          kind: 'activation_state_changed',
          activationId: 'activation-1',
          state: 'succeeded'
        },
        12,
        now
      ),
      createExecutionRunEvent(
        { executionId: 'execution-1', kind: 'execution_state_changed', state: 'succeeded' },
        13,
        now
      )
    ]
    const projection = foldExecutionRun('execution-1', inputs)
    expect(projection.integrity).toBe('valid')
    expect(projection.state).toBe('succeeded')
    expect(projection.activations['activation-1'].state).toBe('succeeded')
    expect(projection.attempts['attempt-1']).toMatchObject({
      state: 'succeeded',
      result: { trust: 'untrusted_agent_output' }
    })
    expect(projection.attempts['attempt-1'].result?.artifactRefs[0]).toMatchObject({
      createdByAttemptId: 'attempt-1',
      trust: 'untrusted_agent_output'
    })
  })

  it('ignores duplicate sequences and illegal terminal regression with diagnostics', () => {
    const first = appendFirst()
    if (!first.ok) throw new Error('fixture append failed')
    const events = [
      creation(),
      createExecutionRunEvent(first.input, 2, now),
      createExecutionRunEvent(
        { executionId: 'execution-1', kind: 'execution_state_changed', state: 'failed' },
        3,
        now
      ),
      createExecutionRunEvent(
        { executionId: 'execution-1', kind: 'execution_state_changed', state: 'running' },
        3,
        now
      ),
      createExecutionRunEvent(
        { executionId: 'execution-1', kind: 'execution_state_changed', state: 'running' },
        4,
        now
      )
    ]
    const projection = foldExecutionRun('execution-1', events)
    expect(projection.state).toBe('failed')
    expect(projection.integrity).toBe('invalid')
    expect(projection.diagnostics.map((entry) => entry.code)).toEqual([
      'duplicate_sequence',
      'invalid_execution_transition'
    ])
  })

  it('round-trips valid JSONL events and rejects malformed records', () => {
    const event = creation('run/with unsafe id')
    expect(parseExecutionRunEventLine(serializeExecutionRunEvent(event))).toEqual(event)
    expect(parseExecutionRunEventLine('{"schemaVersion":9}')).toBeNull()
    expect(parseExecutionRunEventLine('not json')).toBeNull()
    expect(nextExecutionRunSequence([event])).toBe(2)
    expect(safeExecutionRunFileName('run/../../escape')).toBe('run_.._.._escape.jsonl')
  })
})

describe('Execution-run restart recovery', () => {
  it('interrupts and requeues a bounded read-only attempt without replaying completed work', () => {
    const { events, projection } = buildRunningProjection('read_only')
    expect(projection.integrity).toBe('valid')
    const plan = recoverExecutionRunAfterRestart(projection, {
      recoveredAt: '2026-07-18T10:01:00.000Z'
    })
    expect(plan.disposition).toBe('resume')
    expect(plan.interruptedAttemptIds).toEqual(['attempt-1'])
    expect(plan.requeuedActivationIds).toEqual(['activation-1'])
    expect(plan.events.map((event) => event.kind)).toEqual([
      'attempt_state_changed',
      'activation_state_changed'
    ])

    const recovered = foldExecutionRun('recover-1', [...events, ...plan.events])
    expect(recovered.integrity).toBe('valid')
    expect(recovered.attempts['attempt-1'].state).toBe('interrupted')
    expect(recovered.activations['activation-1'].state).toBe('ready')
  })

  it('never auto-replays a mutating attempt that crossed the running boundary', () => {
    const { events, projection } = buildRunningProjection('workspace_write')
    const plan = recoverExecutionRunAfterRestart(projection, {
      recoveredAt: '2026-07-18T10:01:00.000Z'
    })
    expect(plan.disposition).toBe('requires_action')
    expect(plan.requeuedActivationIds).toEqual([])
    expect(plan.requiresActionActivationIds).toEqual(['activation-1'])

    const recovered = foldExecutionRun('recover-1', [...events, ...plan.events])
    expect(recovered.integrity).toBe('valid')
    expect(recovered.attempts['attempt-1'].state).toBe('interrupted')
    expect(recovered.activations['activation-1'].state).toBe('requires_action')
    expect(recovered.state).toBe('requires_action')
  })

  it('does nothing for terminal executions', () => {
    const event = creation('terminal-run')
    const terminal = createExecutionRunEvent(
      { executionId: 'terminal-run', kind: 'execution_state_changed', state: 'cancelled' },
      2,
      now
    )
    const plan = recoverExecutionRunAfterRestart(
      foldExecutionRun('terminal-run', [event, terminal])
    )
    expect(plan).toMatchObject({ disposition: 'terminal', events: [] })
  })
})
