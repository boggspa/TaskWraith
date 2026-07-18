import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compileExecutionGraphRevision, executionGraphRevisionRef } from './ExecutionGraphCompiler'
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
  })

  it('ignores a semantic append torn at every byte until its frame newline is durable', () => {
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
      expect(new ExecutionGraphRepository(root).getExecution('execution-one')).toMatchObject({
        lastSequence: 1,
        state: 'pending'
      })
    }

    writeFileSync(ledger, complete)
    expect(new ExecutionGraphRepository(root).getExecution('execution-one')).toMatchObject({
      lastSequence: 3,
      integrity: 'valid'
    })
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

  it('ignores and repairs only an unterminated final fragment before the next append', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    createExecution(repository)
    const ledger = join(root, 'execution-graph-ledgers-v1', 'execution-execution-one.jsonl')

    appendFileSync(ledger, '{"schemaVersion":1,"eventId":"torn"', 'utf8')
    expect(repository.readExecutionEvents('execution-one')).toHaveLength(1)

    repository.appendExecutionEvent(
      {
        kind: 'execution_state_changed',
        executionId: 'execution-one',
        state: 'running',
        timestamp: '2026-07-18T10:02:00.000Z'
      },
      { expectedLastSequence: 1 }
    )

    const ledgerText = readFileSync(ledger, 'utf8')
    expect(ledgerText).not.toContain('"eventId":"torn"')
    expect(ledgerText.endsWith('\n')).toBe(true)
    expect(new ExecutionGraphRepository(root).getExecution('execution-one')).toMatchObject({
      state: 'running',
      lastSequence: 2,
      integrity: 'valid'
    })
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

  it('rebuilds a missing projection index from an authoritative ledger', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    createExecution(repository)
    rmSync(join(root, 'execution-graph-executions-v1.json'))

    const recovered = new ExecutionGraphRepository(root)
    expect(recovered.listExecutions()).toHaveLength(1)
    expect(recovered.getExecution('execution-one')).toMatchObject({
      title: 'Stack execution',
      integrity: 'valid',
      lastSequence: 1
    })
    expect(readFileSync(join(root, 'execution-graph-executions-v1.json'), 'utf8')).toContain(
      'execution-one'
    )
  })
})
