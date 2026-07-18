import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileExecutionGraphRevision, executionGraphRevisionRef } from './ExecutionGraphCompiler'
import {
  MAX_EXECUTION_GRAPH_RESULT_ERROR_BYTES,
  MAX_EXECUTION_GRAPH_RESULT_OUTPUT_BYTES,
  MAX_EXECUTION_GRAPH_RESULT_REFERENCE_BYTES
} from './ExecutionGraphAttemptResult'
import {
  ExecutionGraphRepository,
  ExecutionGraphSequenceConflictError
} from './ExecutionGraphRepository'
import type { ExecutionGraphRevision } from './ExecutionGraphModel'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function storageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-execution-graph-'))
  roots.push(root)
  return root
}

function revision(objective = 'Inspect the workspace'): ExecutionGraphRevision {
  const compiled = compileExecutionGraphRevision({
    graphId: 'graph-one',
    revision: 1,
    workspaceId: 'workspace-one',
    name: 'Repository fixture',
    createdAt: '2026-07-18T10:00:00.000Z',
    steps: [
      {
        id: 'inspect',
        kind: 'solo_agent',
        title: 'Inspect',
        objective,
        effect: 'read_only',
        retry: { maxAttempts: 1 },
        agent: {
          provider: 'codex',
          session: { mode: 'fresh' }
        }
      }
    ],
    edges: []
  })
  if (!compiled.ok) throw new Error(compiled.issues.map((issue) => issue.message).join(', '))
  return compiled.revision
}

function createExecution(
  repository: ExecutionGraphRepository,
  base?: ExecutionGraphRevision,
  executionId = 'execution-one'
): void {
  repository.createExecution({
    kind: 'execution_created',
    executionId,
    title: executionId === 'execution-one' ? 'Stack execution' : `Stack execution ${executionId}`,
    workspaceId: 'workspace-one',
    tenant: {
      kind: 'stack',
      tenantId: executionId === 'execution-one' ? 'stack-one' : `stack-${executionId}`
    },
    ...(base ? { baseRevision: executionGraphRevisionRef(base) } : {}),
    permissionCeilingRef: {
      schemaVersion: 1,
      referenceId: 'authority-one',
      authorityDigest: 'signed-authority-digest',
      workspaceId: 'workspace-one'
    },
    timestamp: '2026-07-18T10:01:00.000Z'
  })
}

function createChatExecution(
  repository: ExecutionGraphRepository,
  executionId: string,
  rootChatId: string,
  workspaceId = 'workspace-one'
): void {
  repository.createExecution({
    kind: 'execution_created',
    executionId,
    title: `Stack ${rootChatId}`,
    workspaceId,
    rootChatId,
    tenant: { kind: 'stack', tenantId: rootChatId },
    permissionCeilingRef: {
      schemaVersion: 1,
      referenceId: `authority-${executionId}`,
      authorityDigest: `digest-${executionId}`,
      workspaceId
    },
    timestamp: '2026-07-18T10:01:00.000Z'
  })
}

describe('ExecutionGraphRepository revisions and registries', () => {
  it('persists immutable revisions, projection-only layouts, and content-addressed templates', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    const saved = repository.saveRevision(revision())

    expect(repository.saveRevision(saved)).toBe(saved)
    expect(() => repository.saveRevision(revision('Change an immutable revision'))).toThrow(
      /immutable/
    )

    const firstTemplate = repository.saveRunTemplate({
      workspaceId: 'workspace-one',
      provider: 'codex',
      request: { prompt: 'Inspect' }
    })
    const sameTemplate = repository.saveRunTemplate({
      request: { prompt: 'Inspect' },
      provider: 'codex',
      workspaceId: 'workspace-one'
    })
    expect(sameTemplate.templateId).toBe(firstTemplate.templateId)
    expect(firstTemplate.contentDigest).toMatch(/^[a-f0-9]{64}$/)

    const withTemplate = compileExecutionGraphRevision({
      graphId: 'graph-with-template',
      revision: 1,
      workspaceId: 'workspace-one',
      name: 'Template-bound graph',
      createdAt: '2026-07-18T10:00:00.000Z',
      steps: [
        {
          id: 'bound-agent',
          kind: 'solo_agent',
          title: 'Bound agent',
          objective: 'Use the immutable request snapshot',
          effect: 'read_only',
          retry: { maxAttempts: 1 },
          agent: {
            provider: 'codex',
            runTemplateRef: firstTemplate.templateId,
            session: { mode: 'fresh' }
          }
        }
      ],
      edges: []
    })
    if (!withTemplate.ok) throw new Error('Template-bound fixture did not compile.')
    expect(repository.saveRevision(withTemplate.revision).steps[0]).toMatchObject({
      agent: { runTemplateRef: firstTemplate.templateId }
    })

    repository.saveLayout({
      schemaVersion: 1,
      graphId: saved.graphId,
      revision: saved.revision,
      positions: { inspect: { x: 40, y: 80 } },
      viewport: { x: 0, y: 0, zoom: 1 }
    })

    const reloaded = new ExecutionGraphRepository(root)
    expect(reloaded.getRevisionByRef(executionGraphRevisionRef(saved))).toEqual(saved)
    expect(reloaded.getRunTemplate(firstTemplate.templateId)).toEqual(firstTemplate)
    expect(reloaded.getLayout('graph-one', 1)?.positions.inspect).toEqual({ x: 40, y: 80 })
  })

  it('caps layout position count and serialized storage size', () => {
    const repository = new ExecutionGraphRepository(storageRoot())
    const saved = repository.saveRevision(revision())

    expect(() =>
      repository.saveLayout({
        schemaVersion: 1,
        graphId: saved.graphId,
        revision: saved.revision,
        positions: {
          inspect: { x: 0, y: 0 },
          excess: { x: 1, y: 1 }
        }
      })
    ).toThrow(/above its 1-position limit/)

    expect(() =>
      repository.saveLayout({
        schemaVersion: 1,
        graphId: saved.graphId,
        revision: saved.revision,
        positions: {},
        collapsedGroupIds: Array.from({ length: 3_000 }, () => `g${'x'.repeat(127)}`)
      })
    ).toThrow(/256 KiB storage limit/)
  })

  it('rejects a revision whose immutable run-template authority is missing', () => {
    const repository = new ExecutionGraphRepository(storageRoot())
    const compiled = compileExecutionGraphRevision({
      graphId: 'graph-missing-template',
      revision: 1,
      workspaceId: 'workspace-one',
      name: 'Missing template',
      createdAt: '2026-07-18T10:00:00.000Z',
      steps: [
        {
          id: 'agent',
          kind: 'solo_agent',
          title: 'Agent',
          objective: 'Cannot run without its request snapshot',
          effect: 'read_only',
          retry: { maxAttempts: 1 },
          agent: {
            provider: 'codex',
            runTemplateRef: `run-template-${'0'.repeat(64)}`,
            session: { mode: 'fresh' }
          }
        }
      ],
      edges: []
    })
    if (!compiled.ok) throw new Error('Missing-template fixture did not compile.')
    expect(() => repository.saveRevision(compiled.revision)).toThrow(/unknown run template/)
  })
})

describe('ExecutionGraphRepository execution ledgers', () => {
  it('creates an execution and its initial semantic events in one durable batch', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    const base = repository.saveRevision(revision())
    const projection = repository.createExecution(
      {
        kind: 'execution_created',
        executionId: 'execution-atomic',
        title: 'Atomic execution',
        workspaceId: 'workspace-one',
        tenant: { kind: 'stack', tenantId: 'stack-atomic' },
        baseRevision: executionGraphRevisionRef(base),
        permissionCeilingRef: {
          schemaVersion: 1,
          referenceId: 'authority-one',
          authorityDigest: 'signed-authority-digest',
          workspaceId: 'workspace-one'
        },
        timestamp: '2026-07-18T10:01:00.000Z'
      },
      [
        {
          kind: 'activation_created',
          executionId: 'execution-atomic',
          activationId: 'activation-one',
          stepId: 'inspect',
          timestamp: '2026-07-18T10:02:00.000Z'
        },
        {
          kind: 'activation_state_changed',
          executionId: 'execution-atomic',
          activationId: 'activation-one',
          state: 'ready',
          timestamp: '2026-07-18T10:03:00.000Z'
        }
      ]
    )

    expect(projection.lastSequence).toBe(3)
    const ledger = join(root, 'execution-graph-ledgers-v1', 'execution-execution-atomic.jsonl')
    const frames = readFileSync(ledger, 'utf8').trimEnd().split('\n')
    expect(frames).toHaveLength(1)
    expect(JSON.parse(frames[0])).toMatchObject({
      firstSequence: 1,
      events: [{ kind: 'execution_created' }, { kind: 'activation_created' }, { kind: 'activation_state_changed' }]
    })
    expect(new ExecutionGraphRepository(root).getExecution('execution-atomic')?.lastSequence).toBe(3)
  })

  it('persists each semantic append as one hash-chained batch frame', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    const base = repository.saveRevision(revision())
    createExecution(repository, base)

    repository.appendExecutionEvents([
      {
        kind: 'activation_created',
        executionId: 'execution-one',
        activationId: 'activation-one',
        stepId: 'inspect',
        timestamp: '2026-07-18T10:02:00.000Z'
      },
      {
        kind: 'activation_state_changed',
        executionId: 'execution-one',
        activationId: 'activation-one',
        state: 'ready',
        timestamp: '2026-07-18T10:03:00.000Z'
      }
    ])

    const ledger = join(root, 'execution-graph-ledgers-v1', 'execution-execution-one.jsonl')
    const frames = readFileSync(ledger, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({
      kind: 'execution_event_batch',
      firstSequence: 1,
      previousHash: '0'.repeat(64)
    })
    expect(frames[1]).toMatchObject({
      kind: 'execution_event_batch',
      firstSequence: 2,
      previousHash: frames[0].hash
    })
    expect(frames[1].events).toHaveLength(2)
    expect(frames[1].hash).toMatch(/^[a-f0-9]{64}$/)
    const registry = JSON.parse(
      readFileSync(join(root, 'execution-graph-executions-v1.json'), 'utf8')
    ) as {
      executions: Array<{
        ledgerCheckpoint: {
          lastSequence: number
          tailHash: string
          completeByteLength: number
        }
      }>
    }
    expect(registry.executions[0].ledgerCheckpoint).toEqual({
      schemaVersion: 1,
      lastSequence: 3,
      tailHash: frames[1].hash,
      completeByteLength: readFileSync(ledger).byteLength
    })
  })

  it('quarantines a checkpointed semantic append torn at every byte', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    const base = repository.saveRevision(revision())
    createExecution(repository, base)
    repository.appendExecutionEvents([
      {
        kind: 'activation_created',
        executionId: 'execution-one',
        activationId: 'activation-one',
        stepId: 'inspect',
        timestamp: '2026-07-18T10:02:00.000Z'
      },
      {
        kind: 'activation_state_changed',
        executionId: 'execution-one',
        activationId: 'activation-one',
        state: 'ready',
        timestamp: '2026-07-18T10:03:00.000Z'
      }
    ])
    const ledger = join(root, 'execution-graph-ledgers-v1', 'execution-execution-one.jsonl')
    const complete = readFileSync(ledger)
    const firstFrameLength = complete.indexOf(0x0a) + 1
    const firstFrame = complete.subarray(0, firstFrameLength)
    const appendedFrame = complete.subarray(firstFrameLength)

    for (let byteLength = 0; byteLength < appendedFrame.byteLength; byteLength += 1) {
      writeFileSync(ledger, Buffer.concat([firstFrame, appendedFrame.subarray(0, byteLength)]))
      const recovered = new ExecutionGraphRepository(root)
      expect(recovered.getExecution('execution-one')).toBeUndefined()
      expect(recovered.listRepositoryDiagnostics()).toEqual([
        expect.objectContaining({
          code: 'execution_ledger_corrupt',
          message: expect.stringMatching(/durable checkpoint/)
        })
      ])
    }

    writeFileSync(ledger, complete)
    expect(new ExecutionGraphRepository(root).getExecution('execution-one')).toMatchObject({
      lastSequence: 3,
      integrity: 'valid'
    })
  })

  it('quarantines deletion of every complete ledger suffix instead of accepting a valid prefix', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    createExecution(repository)
    repository.appendExecutionEvent({
      kind: 'execution_state_changed',
      executionId: 'execution-one',
      state: 'running',
      timestamp: '2026-07-18T10:02:00.000Z'
    })
    repository.appendExecutionEvent({
      kind: 'execution_state_changed',
      executionId: 'execution-one',
      state: 'waiting',
      timestamp: '2026-07-18T10:03:00.000Z'
    })
    repository.appendExecutionEvent({
      kind: 'execution_state_changed',
      executionId: 'execution-one',
      state: 'running',
      timestamp: '2026-07-18T10:04:00.000Z'
    })
    const ledger = join(root, 'execution-graph-ledgers-v1', 'execution-execution-one.jsonl')
    const complete = readFileSync(ledger)
    const completeFrameEnds: number[] = []
    for (let index = 0; index < complete.byteLength; index += 1) {
      if (complete[index] === 0x0a) completeFrameEnds.push(index + 1)
    }

    for (const retainedByteLength of [0, ...completeFrameEnds.slice(0, -1)]) {
      writeFileSync(ledger, complete.subarray(0, retainedByteLength))
      const recovered = new ExecutionGraphRepository(root)
      expect(recovered.getExecution('execution-one')).toBeUndefined()
      expect(recovered.listRepositoryDiagnostics()).toEqual([
        expect.objectContaining({
          code: 'execution_ledger_corrupt',
          message: expect.stringMatching(/durable checkpoint/)
        })
      ])
    }

    writeFileSync(ledger, complete)
    expect(new ExecutionGraphRepository(root).getExecution('execution-one')).toMatchObject({
      lastSequence: 4,
      state: 'running'
    })
  })

  it('quarantines registry checkpoint mutations and ledger-ahead mismatches', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    createExecution(repository)
    repository.appendExecutionEvent({
      kind: 'execution_state_changed',
      executionId: 'execution-one',
      state: 'running',
      timestamp: '2026-07-18T10:02:00.000Z'
    })
    const registryPath = join(root, 'execution-graph-executions-v1.json')
    const checkpointedRegistry = readFileSync(registryPath)
    const registry = JSON.parse(checkpointedRegistry.toString('utf8')) as {
      executions: Array<{
        ledgerCheckpoint: {
          lastSequence: number
          tailHash: string
          completeByteLength: number
        }
      }>
    }
    const originalCheckpoint = registry.executions[0].ledgerCheckpoint
    const mutations = [
      { ...originalCheckpoint, lastSequence: originalCheckpoint.lastSequence - 1 },
      { ...originalCheckpoint, tailHash: '0'.repeat(64) },
      {
        ...originalCheckpoint,
        completeByteLength: originalCheckpoint.completeByteLength - 1
      }
    ]

    for (const ledgerCheckpoint of mutations) {
      registry.executions[0].ledgerCheckpoint = ledgerCheckpoint
      writeFileSync(registryPath, JSON.stringify(registry), 'utf8')
      const recovered = new ExecutionGraphRepository(root)
      expect(recovered.getExecution('execution-one')).toBeUndefined()
      expect(recovered.listRepositoryDiagnostics()).toEqual([
        expect.objectContaining({ message: expect.stringMatching(/durable checkpoint/) })
      ])
    }

    writeFileSync(registryPath, checkpointedRegistry)
    repository.appendExecutionEvent({
      kind: 'execution_state_changed',
      executionId: 'execution-one',
      state: 'waiting',
      timestamp: '2026-07-18T10:03:00.000Z'
    })
    writeFileSync(registryPath, checkpointedRegistry)
    const ledgerAhead = new ExecutionGraphRepository(root)
    expect(ledgerAhead.getExecution('execution-one')).toBeUndefined()
    expect(ledgerAhead.listRepositoryDiagnostics()).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/durable checkpoint/) })
    ])
  })

  it('quarantines a complete batch whose hash no longer matches its events', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    const base = repository.saveRevision(revision())
    createExecution(repository, base)
    repository.appendExecutionEvents([
      {
        kind: 'activation_created',
        executionId: 'execution-one',
        activationId: 'activation-one',
        stepId: 'inspect',
        timestamp: '2026-07-18T10:02:00.000Z'
      }
    ])
    const ledger = join(root, 'execution-graph-ledgers-v1', 'execution-execution-one.jsonl')
    const lines = readFileSync(ledger, 'utf8').trimEnd().split('\n')
    const tampered = JSON.parse(lines[1]) as {
      events: Array<{ activationId?: string }>
    }
    tampered.events[0].activationId = 'activation-tampered'
    writeFileSync(ledger, `${lines[0]}\n${JSON.stringify(tampered)}\n`, 'utf8')

    const recovered = new ExecutionGraphRepository(root)
    expect(recovered.getExecution('execution-one')).toBeUndefined()
    expect(recovered.listRepositoryDiagnostics()).toEqual([
      expect.objectContaining({
        code: 'execution_ledger_corrupt',
        executionId: 'execution-one',
        message: expect.stringMatching(/hash is corrupt/)
      })
    ])
  })

  it('creates strict ledgers, folds with the pinned revision, and enforces compare-and-append', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    const base = repository.saveRevision(revision())
    createExecution(repository, base)

    const [activation, ready] = repository.appendExecutionEvents(
      [
        {
          kind: 'activation_created',
          executionId: 'execution-one',
          activationId: 'activation-one',
          stepId: 'inspect',
          timestamp: '2026-07-18T10:02:00.000Z'
        },
        {
          kind: 'activation_state_changed',
          executionId: 'execution-one',
          activationId: 'activation-one',
          state: 'ready',
          timestamp: '2026-07-18T10:03:00.000Z'
        }
      ],
      { expectedLastSequence: 1 }
    )
    expect([activation.sequence, ready.sequence]).toEqual([2, 3])
    expect(repository.getExecution('execution-one')).toMatchObject({
      integrity: 'valid',
      lastSequence: 3,
      baseRevisionMissing: false,
      topology: { steps: [{ id: 'inspect' }] }
    })
    expect(() =>
      repository.appendExecutionEvent(
        {
          kind: 'execution_state_changed',
          executionId: 'execution-one',
          state: 'running'
        },
        { expectedLastSequence: 1 }
      )
    ).toThrow(ExecutionGraphSequenceConflictError)
    expect(repository.readExecutionEvents('execution-one')).toHaveLength(3)
  })

  it('rejects invalid or oversized result-bearing events before they enter the ledger', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    const base = repository.saveRevision(revision())
    createExecution(repository, base)
    repository.appendExecutionEvents([
      {
        kind: 'activation_created',
        executionId: 'execution-one',
        activationId: 'activation-one',
        stepId: 'inspect'
      },
      {
        kind: 'activation_state_changed',
        executionId: 'execution-one',
        activationId: 'activation-one',
        state: 'ready'
      },
      {
        kind: 'attempt_created',
        executionId: 'execution-one',
        activationId: 'activation-one',
        attemptId: 'attempt-one',
        stepId: 'inspect',
        ordinal: 1
      },
      {
        kind: 'attempt_state_changed',
        executionId: 'execution-one',
        attemptId: 'attempt-one',
        state: 'claimed'
      },
      {
        kind: 'activation_state_changed',
        executionId: 'execution-one',
        activationId: 'activation-one',
        state: 'claimed'
      },
      {
        kind: 'attempt_state_changed',
        executionId: 'execution-one',
        attemptId: 'attempt-one',
        state: 'queued',
        providerRunRef: 'run-one'
      },
      {
        kind: 'activation_state_changed',
        executionId: 'execution-one',
        activationId: 'activation-one',
        state: 'queued'
      },
      {
        kind: 'attempt_state_changed',
        executionId: 'execution-one',
        attemptId: 'attempt-one',
        state: 'running',
        providerRunRef: 'run-one'
      },
      {
        kind: 'activation_state_changed',
        executionId: 'execution-one',
        activationId: 'activation-one',
        state: 'running'
      }
    ])
    const ledger = join(root, 'execution-graph-ledgers-v1', 'execution-execution-one.jsonl')
    const before = readFileSync(ledger)

    expect(() =>
      repository.appendExecutionEvent({
        kind: 'attempt_state_changed',
        executionId: 'execution-one',
        attemptId: 'attempt-one',
        state: 'succeeded',
        providerRunRef: 'run-one',
        result: {
          schemaVersion: 1,
          output: 'x'.repeat(MAX_EXECUTION_GRAPH_RESULT_OUTPUT_BYTES + 1),
          artifactRefs: [],
          trust: 'untrusted_agent_output',
          providerRunRef: 'run-one'
        }
      })
    ).toThrow(/invalid_result_payload/)
    expect(() =>
      repository.appendExecutionEvent({
        kind: 'attempt_state_changed',
        executionId: 'execution-one',
        attemptId: 'attempt-one',
        state: 'failed',
        providerRunRef: 'run-one',
        error: 'x'.repeat(MAX_EXECUTION_GRAPH_RESULT_ERROR_BYTES + 1)
      })
    ).toThrow(/invalid_attempt_error/)
    expect(() =>
      repository.appendExecutionEvent({
        kind: 'attempt_state_changed',
        executionId: 'execution-one',
        attemptId: 'attempt-one',
        state: 'failed',
        providerRunRef: 'x'.repeat(MAX_EXECUTION_GRAPH_RESULT_REFERENCE_BYTES + 1),
        error: 'Provider failed.'
      })
    ).toThrow(/invalid_provider_run_ref/)

    expect(readFileSync(ledger)).toEqual(before)
    expect(repository.getExecution('execution-one')).toMatchObject({
      integrity: 'valid',
      lastSequence: 10,
      attempts: { 'attempt-one': { state: 'running', providerRunRef: 'run-one' } }
    })
  })

  it('serves stable cached projections and events, then replaces both caches after append', () => {
    const repository = new ExecutionGraphRepository(storageRoot())
    createExecution(repository)

    const initialProjection = repository.getExecution('execution-one')
    const initialEvents = repository.readExecutionEvents('execution-one')
    expect(repository.getExecution('execution-one')).toBe(initialProjection)
    expect(repository.listExecutions()[0]).toBe(initialProjection)
    expect(repository.readExecutionEvents('execution-one')).toBe(initialEvents)
    expect(repository.listExecutionEvents()[0].events).toBe(initialEvents)

    repository.appendExecutionEvent({
      kind: 'execution_state_changed',
      executionId: 'execution-one',
      state: 'running',
      timestamp: '2026-07-18T10:02:00.000Z'
    })

    const updatedProjection = repository.getExecution('execution-one')
    const updatedEvents = repository.readExecutionEvents('execution-one')
    expect(updatedProjection).not.toBe(initialProjection)
    expect(updatedEvents).not.toBe(initialEvents)
    expect(updatedProjection).toMatchObject({ state: 'running', lastSequence: 2 })
    expect(updatedEvents).toHaveLength(2)
    expect(repository.getExecution('execution-one')).toBe(updatedProjection)
    expect(repository.readExecutionEvents('execution-one')).toBe(updatedEvents)
  })

  it('revalidates only when the ledger stamp changes and preserves verified identities', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    createExecution(repository)
    const parseLedger = vi.spyOn(
      repository as unknown as {
        parseLedger(path: string, executionId: string): unknown
      },
      'parseLedger'
    )

    const initialProjection = repository.getExecution('execution-one')
    const initialEvents = repository.readExecutionEvents('execution-one')
    repository.listExecutions()
    repository.listExecutionEvents()
    repository.appendExecutionEvent({
      kind: 'execution_state_changed',
      executionId: 'execution-one',
      state: 'running'
    })
    expect(parseLedger).not.toHaveBeenCalled()

    const projection = repository.getExecution('execution-one')
    const events = repository.readExecutionEvents('execution-one')
    expect(projection).not.toBe(initialProjection)
    expect(events).not.toBe(initialEvents)
    const ledger = join(root, 'execution-graph-ledgers-v1', 'execution-execution-one.jsonl')
    const future = new Date(Date.now() + 60_000)
    utimesSync(ledger, future, future)

    expect(repository.getExecution('execution-one')).toBe(projection)
    expect(repository.readExecutionEvents('execution-one')).toBe(events)
    expect(parseLedger).toHaveBeenCalledTimes(1)
    repository.listExecutions()
    repository.listExecutionEvents()
    expect(parseLedger).toHaveBeenCalledTimes(1)
  })

  it('quarantines same-length ledger tampering after its file stamp changes', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    createExecution(repository)
    const ledger = join(root, 'execution-graph-ledgers-v1', 'execution-execution-one.jsonl')
    const original = readFileSync(ledger, 'utf8')
    const tampered = original.replace(/"hash":"([a-f0-9])/, (_match, character: string) =>
      `"hash":"${character === 'a' ? 'b' : 'a'}`
    )
    expect(Buffer.byteLength(tampered, 'utf8')).toBe(Buffer.byteLength(original, 'utf8'))
    expect(tampered).not.toBe(original)
    writeFileSync(ledger, tampered, 'utf8')
    const future = new Date(Date.now() + 60_000)
    utimesSync(ledger, future, future)

    expect(repository.getExecution('execution-one')).toBeUndefined()
    expect(repository.listRepositoryDiagnostics()).toEqual([
      expect.objectContaining({
        code: 'execution_ledger_corrupt',
        executionId: 'execution-one',
        message: expect.stringMatching(/hash is corrupt/)
      })
    ])
  })

  it('fails closed when an unterminated fragment appears beyond the durable checkpoint', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    createExecution(repository)
    const ledger = join(root, 'execution-graph-ledgers-v1', 'execution-execution-one.jsonl')

    appendFileSync(ledger, '{"schemaVersion":1,"eventId":"torn"', 'utf8')
    expect(repository.readExecutionEvents('execution-one')).toEqual([])
    expect(repository.listRepositoryDiagnostics()).toEqual([
      expect.objectContaining({
        code: 'execution_ledger_corrupt',
        message: expect.stringMatching(/durable checkpoint/)
      })
    ])
    expect(() =>
      repository.appendExecutionEvent({
        kind: 'execution_state_changed',
        executionId: 'execution-one',
        state: 'running'
      })
    ).toThrow(/quarantined/)
  })

  it('quarantines one corrupt ledger without hiding healthy executions', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    createExecution(repository)
    createExecution(repository, undefined, 'execution-two')
    const ledger = join(root, 'execution-graph-ledgers-v1', 'execution-execution-two.jsonl')
    appendFileSync(ledger, '{"corrupt":true}\n', 'utf8')

    const recovered = new ExecutionGraphRepository(root)
    expect(recovered.listExecutions().map((execution) => execution.executionId)).toEqual([
      'execution-one'
    ])
    expect(recovered.getExecution('execution-two')).toBeUndefined()
    expect(recovered.readExecutionEvents('execution-two')).toEqual([])
    expect(recovered.listRepositoryDiagnostics()).toEqual([
      expect.objectContaining({
        code: 'execution_ledger_corrupt',
        executionId: 'execution-two',
        fileName: 'execution-execution-two.jsonl'
      })
    ])
    expect(() =>
      recovered.appendExecutionEvent({
        kind: 'execution_state_changed',
        executionId: 'execution-two',
        state: 'running'
      })
    ).toThrow(/quarantined/)
    expect(() => createExecution(recovered, undefined, 'execution-two')).toThrow(/already exists/)
  })

  it('quarantines a missing ledger but still fails closed on corrupt registry identity', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    createExecution(repository)
    createExecution(repository, undefined, 'execution-two')
    rmSync(join(root, 'execution-graph-ledgers-v1', 'execution-execution-two.jsonl'))

    const recovered = new ExecutionGraphRepository(root)
    expect(recovered.listExecutions()).toHaveLength(1)
    expect(recovered.listRepositoryDiagnostics()).toEqual([
      expect.objectContaining({
        code: 'execution_ledger_missing',
        executionId: 'execution-two'
      })
    ])

    const secondRoot = storageRoot()
    const secondRepository = new ExecutionGraphRepository(secondRoot)
    createExecution(secondRepository)
    const registryPath = join(secondRoot, 'execution-graph-executions-v1.json')
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      executions: Array<{ fileName: string }>
    }
    registry.executions[0].fileName = '../outside.jsonl'
    writeFileSync(registryPath, JSON.stringify(registry), 'utf8')
    expect(() => new ExecutionGraphRepository(secondRoot)).toThrow(/identity is corrupt/)
  })

  it('quarantines an orphan ledger because rebuilding would silently bless a rollback', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    createExecution(repository)
    rmSync(join(root, 'execution-graph-executions-v1.json'))

    const recovered = new ExecutionGraphRepository(root)
    expect(recovered.listExecutions()).toEqual([])
    expect(recovered.getExecution('execution-one')).toBeUndefined()
    expect(recovered.listRepositoryDiagnostics()).toEqual([
      expect.objectContaining({
        code: 'execution_ledger_corrupt',
        message: expect.stringMatching(/no durable registry checkpoint/)
      })
    ])
    expect(() => createExecution(recovered)).toThrow(/ledger already exists/)
  })

  it('quarantines legacy registry entries without silently migrating an unprotected baseline', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    createExecution(repository)
    const registryPath = join(root, 'execution-graph-executions-v1.json')
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      executions: Array<{ ledgerCheckpoint?: unknown }>
    }
    delete registry.executions[0].ledgerCheckpoint
    writeFileSync(registryPath, JSON.stringify(registry), 'utf8')

    const recovered = new ExecutionGraphRepository(root)
    expect(recovered.getExecution('execution-one')).toBeUndefined()
    expect(recovered.listRepositoryDiagnostics()).toEqual([
      expect.objectContaining({
        code: 'execution_ledger_corrupt',
        message: expect.stringMatching(/Legacy execution.*automatic migration is unsafe/)
      })
    ])
    expect(readFileSync(registryPath, 'utf8')).not.toContain('ledgerCheckpoint')
    expect(() =>
      recovered.appendExecutionEvent({
        kind: 'execution_state_changed',
        executionId: 'execution-one',
        state: 'running'
      })
    ).toThrow(/quarantined/)
  })

  it('deletes one terminal chat-rooted history, its ledger, and orphaned private templates', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    const privateTemplate = repository.saveRunTemplate({
      request: { prompt: 'private prompt for chat-a' }
    })
    createChatExecution(repository, 'execution-chat-a', 'chat-a')
    createChatExecution(repository, 'execution-chat-b', 'chat-b')
    repository.appendExecutionEvent({
      kind: 'execution_state_changed',
      executionId: 'execution-chat-a',
      state: 'cancelled'
    })
    repository.appendExecutionEvent({
      kind: 'execution_state_changed',
      executionId: 'execution-chat-b',
      state: 'cancelled'
    })

    const report = repository.deleteExecutionsForRootChat('chat-a')

    expect(report).toEqual({
      deletedExecutionIds: ['execution-chat-a'],
      deletedRunTemplateIds: [privateTemplate.templateId],
      unscopedQuarantinedExecutionIds: []
    })
    expect(repository.getExecution('execution-chat-a')).toBeUndefined()
    expect(repository.getExecution('execution-chat-b')).toMatchObject({ rootChatId: 'chat-b' })
    expect(repository.listRunTemplates()).toEqual([])
    expect(
      existsSync(
        join(root, 'execution-graph-ledgers-v1', 'execution-execution-chat-a.jsonl')
      )
    ).toBe(false)
    expect(
      existsSync(
        join(root, 'execution-graph-ledgers-v1', 'execution-execution-chat-b.jsonl')
      )
    ).toBe(true)
    expect(new ExecutionGraphRepository(root).listExecutions()).toEqual([
      expect.objectContaining({ executionId: 'execution-chat-b', rootChatId: 'chat-b' })
    ])
  })

  it('fails closed before deleting an active or unattributable quarantined execution', () => {
    const activeRoot = storageRoot()
    const active = new ExecutionGraphRepository(activeRoot)
    createChatExecution(active, 'execution-active', 'chat-active')
    expect(() => active.deleteExecutionsForRootChat('chat-active')).toThrow(/active/)
    expect(active.getExecution('execution-active')).toBeDefined()

    const quarantinedRoot = storageRoot()
    const repository = new ExecutionGraphRepository(quarantinedRoot)
    createChatExecution(repository, 'execution-legacy', 'chat-legacy')
    repository.appendExecutionEvent({
      kind: 'execution_state_changed',
      executionId: 'execution-legacy',
      state: 'cancelled'
    })
    const registryPath = join(quarantinedRoot, 'execution-graph-executions-v1.json')
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      executions: Array<{ workspaceId?: string; rootChatId?: string }>
    }
    delete registry.executions[0].workspaceId
    delete registry.executions[0].rootChatId
    writeFileSync(registryPath, JSON.stringify(registry), 'utf8')
    appendFileSync(
      join(
        quarantinedRoot,
        'execution-graph-ledgers-v1',
        'execution-execution-legacy.jsonl'
      ),
      '{"torn":true',
      'utf8'
    )
    const recovered = new ExecutionGraphRepository(quarantinedRoot)

    expect(() => recovered.deleteExecutionsForRootChat('chat-legacy')).toThrow(
      /cannot attribute quarantined ledgers/
    )
    expect(
      existsSync(
        join(
          quarantinedRoot,
          'execution-graph-ledgers-v1',
          'execution-execution-legacy.jsonl'
        )
      )
    ).toBe(true)
  })

  it('clears definitions, layouts, templates, ledgers, registries, and live caches together', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    const savedRevision = repository.saveRevision(revision())
    repository.saveLayout({
      schemaVersion: 1,
      graphId: savedRevision.graphId,
      revision: savedRevision.revision,
      positions: { inspect: { x: 0, y: 0 } }
    })
    const template = repository.saveRunTemplate({
      request: { prompt: 'private global-clear prompt' }
    })
    createChatExecution(repository, 'execution-clear', 'chat-clear')
    repository.appendExecutionEvent({
      kind: 'execution_state_changed',
      executionId: 'execution-clear',
      state: 'cancelled'
    })

    expect(repository.clearAllHistory()).toEqual({
      deletedExecutionIds: ['execution-clear'],
      deletedRunTemplateIds: [template.templateId],
      deletedRevisionIds: [savedRevision.revisionId],
      deletedLayoutIds: [savedRevision.revisionId],
      unscopedQuarantinedExecutionIds: []
    })
    expect(repository.listExecutions()).toEqual([])
    expect(repository.listRevisions()).toEqual([])
    expect(repository.listLayouts()).toEqual([])
    expect(repository.listRunTemplates()).toEqual([])
    expect(repository.listRepositoryDiagnostics()).toEqual([])
    expect(existsSync(join(root, 'execution-graph-executions-v1.json'))).toBe(false)
    expect(existsSync(join(root, 'execution-graph-revisions-v1.json'))).toBe(false)
    expect(existsSync(join(root, 'execution-graph-layouts-v1.json'))).toBe(false)
    expect(existsSync(join(root, 'execution-graph-templates-v1.json'))).toBe(false)
    expect(new ExecutionGraphRepository(root).listExecutions()).toEqual([])

    // The same live instance remains usable after the privacy reset.
    createChatExecution(repository, 'execution-after-clear', 'chat-after-clear')
    expect(repository.getExecution('execution-after-clear')).toBeDefined()
  })

  it('can globally erase a corrupt storage root that cannot be opened', () => {
    const root = storageRoot()
    writeFileSync(join(root, 'execution-graph-revisions-v1.json'), '{private corrupt history', 'utf8')
    expect(() => new ExecutionGraphRepository(root)).toThrow(/registry is corrupt/)

    ExecutionGraphRepository.clearStorageRootHistory(root)

    expect(existsSync(root)).toBe(false)
  })

  it('checks registry target mentions without parsing quarantined ledgers', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    createChatExecution(repository, 'execution-mentioned', 'chat-mentioned')

    expect(repository.hasHistoryForRootChat('chat-mentioned')).toBe(true)
    expect(repository.hasHistoryForRootChat('chat-unrelated')).toBe(false)
    expect(repository.hasHistoryForWorkspace('workspace-one')).toBe(true)
    expect(repository.hasHistoryForWorkspace('workspace-unrelated')).toBe(false)
    expect(ExecutionGraphRepository.storageRootMentionsRootChat(root, 'chat-mentioned')).toBe(true)
    expect(ExecutionGraphRepository.storageRootMentionsRootChat(root, 'chat-unrelated')).toBe(false)

    const registryPath = join(root, 'execution-graph-executions-v1.json')
    const raw = readFileSync(registryPath, 'utf8')
    writeFileSync(registryPath, `${raw.slice(0, -1)},`, 'utf8')
    expect(ExecutionGraphRepository.storageRootMentionsRootChat(root, 'chat-mentioned')).toBe(true)
    expect(ExecutionGraphRepository.storageRootMentionsRootChat(root, 'chat-unrelated')).toBe(false)
  })
})
