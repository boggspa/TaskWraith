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
          runTemplateRef: 'run-template-fixture',
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
  base?: ExecutionGraphRevision
): void {
  repository.createExecution({
    kind: 'execution_created',
    executionId: 'execution-one',
    title: 'Stack execution',
    workspaceId: 'workspace-one',
    tenant: { kind: 'stack', tenantId: 'stack-one' },
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
})

describe('ExecutionGraphRepository execution ledgers', () => {
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

  it('rejects a corrupt complete ledger record and a non-canonical registry identity', () => {
    const root = storageRoot()
    const repository = new ExecutionGraphRepository(root)
    createExecution(repository)
    const ledger = join(root, 'execution-graph-ledgers-v1', 'execution-execution-one.jsonl')
    appendFileSync(ledger, '{"corrupt":true}\n', 'utf8')
    expect(() => new ExecutionGraphRepository(root)).toThrow(/ledger is corrupt/)

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
