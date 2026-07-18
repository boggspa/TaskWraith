import { describe, expect, it, vi } from 'vitest'
import type { WorkflowDefinition, WorkflowRunTemplate } from '../../store/types'
import { compileExecutionGraphRevision } from '../ExecutionGraphCompiler'
import {
  compileWorkflowDefinition,
  type CompileWorkflowDefinitionOptions
} from './WorkflowDefinitionCompiler'
import type {
  ResolveWorkflowRunTemplateRef,
  ResolvedWorkflowRunTemplateRef
} from './WorkflowExecutionBinding'

const REVISION_CREATED_AT = '2026-07-18T12:00:00.000Z'
const LEGACY_AUTHORITY_DIGEST = 'a'.repeat(64)
const TEMPLATE_DIGEST = 'b'.repeat(64)
const SNAPSHOT_DIGEST = 'c'.repeat(64)

function soloTemplate(): WorkflowRunTemplate {
  return {
    workspaceId: 'workspace-1',
    workspacePath: '/work/project',
    chatId: 'chat-workflow',
    provider: 'codex',
    prompt: 'Implement and verify the requested change.',
    displayPrompt: 'Nightly implementation',
    selectedModelType: 'gpt-5.6-sol',
    customModel: 'gpt-5.6-sol',
    approvalMode: 'auto',
    permissionPresetId: 'workspace_write',
    workflowMode: 'normal',
    sessionTrust: false,
    imageAttachments: [],
    codexReasoningEffort: 'high',
    codexServiceTier: 'priority',
    runtimeProfileId: 'runtime-codex-stable',
    handoffSourceRunId: 'run-origin',
    kind: 'single'
  }
}

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'workflow-nightly',
    name: 'Nightly implementation',
    workspaceId: 'workspace-1',
    workspacePath: '/work/project',
    enabled: true,
    trigger: { kind: 'interval', intervalMs: 86_400_000, timezone: 'Europe/London' },
    template: soloTemplate(),
    missedRunPolicy: 'coalesce',
    concurrencyPolicy: 'enqueue',
    limits: {
      maxRunsPerDay: 2,
      maxConsecutiveFailures: 3,
      timeoutSeconds: 120,
      maxTokens: 50_000,
      maxCostUsd: 4
    },
    nextRunAt: '2026-07-19T12:00:00.000Z',
    lastRunAt: '2026-07-17T12:00:00.000Z',
    lastCompletedAt: '2026-07-17T12:01:00.000Z',
    lastStatus: 'completed',
    failureStreak: 0,
    history: [],
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-07-17T12:01:00.000Z',
    ...overrides
  }
}

function soloResolution(): ResolvedWorkflowRunTemplateRef {
  return {
    runTemplateRef: `workflow-run-template:sha256:${TEMPLATE_DIGEST}`,
    runTemplateDigest: TEMPLATE_DIGEST,
    effect: 'workspace_write',
    soloSession: { mode: 'bound', sessionRef: 'chat:chat-workflow' }
  }
}

function options(resolver: ResolveWorkflowRunTemplateRef): CompileWorkflowDefinitionOptions {
  return {
    revision: 1,
    revisionCreatedAt: REVISION_CREATED_AT,
    legacyAuthorityRef: 'workflow-authority:workflow-nightly@current',
    legacyAuthorityDigest: LEGACY_AUTHORITY_DIGEST,
    resolveRunTemplateRef: resolver
  }
}

describe('WorkflowDefinition execution-graph compatibility compiler', () => {
  it('compiles a solo Workflow into a linear agent/output graph and binds the full template', () => {
    const definition = workflow()
    const resolve = vi.fn<ResolveWorkflowRunTemplateRef>(() => soloResolution())
    const result = compileWorkflowDefinition(definition, options(resolve))

    expect(result.diagnostics).toEqual([])
    expect(result.revisionDraft).toMatchObject({
      graphId: 'workflow-workflow-nightly',
      revision: 1,
      workspaceId: 'workspace-1',
      name: 'workflow-workflow-nightly',
      createdAt: REVISION_CREATED_AT,
      limits: {
        maxSteps: 2,
        maxConcurrentSteps: 1,
        maxAttempts: 2,
        maxWallClockMs: 120_000,
        maxTokens: 50_000,
        maxCostUsd: 4
      }
    })
    expect(result.revisionDraft?.steps.map((step) => step.kind)).toEqual(['solo_agent', 'output'])
    expect(result.revisionDraft?.steps[0]).toMatchObject({
      id: 'execute',
      kind: 'solo_agent',
      effect: 'workspace_write',
      agent: {
        provider: 'codex',
        runTemplateRef: `workflow-run-template:sha256:${TEMPLATE_DIGEST}`,
        session: { mode: 'bound', sessionRef: 'chat:chat-workflow' }
      }
    })
    expect(result.revisionDraft?.edges).toEqual([
      {
        id: 'execute-output-control',
        kind: 'control',
        fromStepId: 'execute',
        toStepId: 'output',
        outcome: 'success'
      },
      {
        id: 'execute-output-result',
        kind: 'data',
        from: { stepId: 'execute', port: 'result' },
        to: { stepId: 'output', port: 'result' }
      }
    ])

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0][0].workflowId).toBe(definition.id)
    // Identity is deliberate: the compiler gives the resolver the full stored
    // template instead of constructing a lossy field subset.
    expect(resolve.mock.calls[0][0].template).toBe(definition.template)
    expect(result.binding).toEqual({
      schemaVersion: 1,
      kind: 'workflow',
      workflowId: 'workflow-nightly',
      graphId: 'workflow-workflow-nightly',
      graphRevision: 1,
      runTemplateRef: `workflow-run-template:sha256:${TEMPLATE_DIGEST}`,
      runTemplateDigest: TEMPLATE_DIGEST,
      schedule: {
        enabled: true,
        trigger: {
          kind: 'interval',
          intervalMs: 86_400_000,
          timezone: 'Europe/London'
        },
        missedRunPolicy: 'coalesce',
        concurrencyPolicy: 'enqueue',
        maxRunsPerDay: 2,
        maxConsecutiveFailures: 3
      },
      legacyAuthorityRef: 'workflow-authority:workflow-nightly@current',
      legacyAuthorityDigest: LEGACY_AUTHORITY_DIGEST
    })

    const compiled = compileExecutionGraphRevision(result.revisionDraft!)
    expect(compiled.ok).toBe(true)
  })

  it('uses an explicitly guaranteed immutable executable snapshot for an Ensemble round', () => {
    const template: WorkflowRunTemplate = {
      ...soloTemplate(),
      provider: 'claude',
      kind: 'ensemble',
      ensembleSnapshot: {
        orchestrationMode: 'continuous',
        participants: [
          {
            id: 'planner',
            provider: 'claude',
            enabled: true,
            role: 'Planner',
            instructions: 'Plan the work.',
            order: 0
          },
          {
            id: 'reviewer',
            provider: 'codex',
            enabled: true,
            role: 'Reviewer',
            instructions: 'Review the result.',
            order: 1
          }
        ],
        maxContinuationHops: 4,
        capturedAt: '2026-07-18T11:30:00.000Z'
      }
    }
    const definition = workflow({ template })
    const sharedRef = `workflow-run-template:sha256:${TEMPLATE_DIGEST}`
    const resolve = vi.fn<ResolveWorkflowRunTemplateRef>(() => ({
      runTemplateRef: sharedRef,
      runTemplateDigest: TEMPLATE_DIGEST,
      effect: 'workspace_write',
      ensembleSnapshot: {
        // Reuse is allowed because the resolver asserts the documented
        // registry invariant for this exact ref.
        snapshotRef: sharedRef,
        snapshotDigest: TEMPLATE_DIGEST,
        invariant: 'immutable_executable_ensemble_snapshot'
      }
    }))
    const result = compileWorkflowDefinition(definition, options(resolve))

    expect(result.diagnostics).toEqual([])
    expect(result.revisionDraft?.steps[0]).toMatchObject({
      kind: 'ensemble_round',
      ensemble: {
        snapshotRef: sharedRef,
        prompt: template.prompt,
        orchestrationMode: 'continuous'
      }
    })
    expect(result.binding).toMatchObject({
      runTemplateRef: sharedRef,
      runTemplateDigest: TEMPLATE_DIGEST,
      ensembleSnapshotRef: sharedRef,
      ensembleSnapshotDigest: TEMPLATE_DIGEST
    })
    expect(resolve.mock.calls[0][0].template).toBe(template)
    expect(compileExecutionGraphRevision(result.revisionDraft!).ok).toBe(true)
  })

  it('rejects an Ensemble ref without the immutable executable snapshot guarantee', () => {
    const template: WorkflowRunTemplate = {
      ...soloTemplate(),
      kind: 'ensemble',
      ensembleSnapshot: {
        orchestrationMode: 'turn_bound',
        participants: [],
        capturedAt: REVISION_CREATED_AT
      }
    }
    const result = compileWorkflowDefinition(
      workflow({ template }),
      options(
        () =>
          ({
            runTemplateRef: `workflow-run-template:sha256:${TEMPLATE_DIGEST}`,
            runTemplateDigest: TEMPLATE_DIGEST,
            effect: 'read_only',
            ensembleSnapshot: {
              snapshotRef: `generic-blob-ref:sha256:${SNAPSHOT_DIGEST}`,
              snapshotDigest: SNAPSHOT_DIGEST,
              invariant: 'generic_blob'
            }
          }) as unknown as ResolvedWorkflowRunTemplateRef
      )
    )

    expect(result.revisionDraft).toBeUndefined()
    expect(result.binding).toBeUndefined()
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      'untrusted_ensemble_snapshot_ref'
    )
  })

  it('keeps schedule policy in the binding and out of the graph digest', () => {
    const first = compileWorkflowDefinition(
      workflow(),
      options(() => soloResolution())
    )
    const changed = compileWorkflowDefinition(
      workflow({
        enabled: false,
        trigger: { kind: 'cron', cronExpression: '0 9 * * 1', timezone: 'UTC' },
        missedRunPolicy: 'skip',
        concurrencyPolicy: 'skip',
        limits: {
          ...workflow().limits,
          maxRunsPerDay: 1,
          maxConsecutiveFailures: 1
        }
      }),
      options(() => soloResolution())
    )

    expect(changed.revisionDraft).toEqual(first.revisionDraft)
    expect(changed.binding?.schedule).not.toEqual(first.binding?.schedule)
    const firstRevision = compileExecutionGraphRevision(first.revisionDraft!)
    const changedRevision = compileExecutionGraphRevision(changed.revisionDraft!)
    expect(firstRevision.ok && changedRevision.ok).toBe(true)
    if (!firstRevision.ok || !changedRevision.ok) return
    expect(changedRevision.revision.definitionDigest).toBe(firstRevision.revision.definitionDigest)
  })

  it('excludes Workflow presentation and lifecycle fields from graph identity', () => {
    const first = compileWorkflowDefinition(
      workflow(),
      options(() => soloResolution())
    )
    const renamedAndAdvanced = compileWorkflowDefinition(
      workflow({
        name: 'Renamed in the UI',
        nextRunAt: '2027-01-01T00:00:00.000Z',
        lastRunAt: '2026-07-18T13:00:00.000Z',
        lastCompletedAt: undefined,
        lastStatus: 'failed',
        lastError: 'Provider was unavailable.',
        failureStreak: 9,
        activeExecutionId: 'execution-live',
        history: [
          {
            id: 'execution-old',
            workflowId: 'workflow-nightly',
            plannedFor: '2026-07-18T12:00:00.000Z',
            status: 'failed',
            createdAt: '2026-07-18T12:00:00.000Z',
            updatedAt: '2026-07-18T12:01:00.000Z'
          }
        ],
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2026-07-18T13:00:00.000Z'
      }),
      options(() => soloResolution())
    )

    expect(renamedAndAdvanced.revisionDraft).toEqual(first.revisionDraft)
    const firstRevision = compileExecutionGraphRevision(first.revisionDraft!)
    const advancedRevision = compileExecutionGraphRevision(renamedAndAdvanced.revisionDraft!)
    expect(firstRevision.ok && advancedRevision.ok).toBe(true)
    if (!firstRevision.ok || !advancedRevision.ok) return
    expect(advancedRevision.revision.definitionDigest).toBe(firstRevision.revision.definitionDigest)
  })

  it('fails loops explicitly instead of fake-expanding maker/verifier semantics', () => {
    const resolve = vi.fn<ResolveWorkflowRunTemplateRef>(() => soloResolution())
    const result = compileWorkflowDefinition(
      workflow({
        loop: {
          acceptance: { maxIterations: 3, verifier: { provider: 'claude' } },
          limits: { maxRuns: 6, maxTokens: 80_000 }
        }
      }),
      options(resolve)
    )

    expect(result).toEqual({
      diagnostics: [
        expect.objectContaining({ severity: 'error', code: 'unsupported_loop', path: 'loop' })
      ]
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('fails closed when the main-owned template resolver cannot produce a content address', () => {
    const failed = compileWorkflowDefinition(
      workflow(),
      options(() => {
        throw new Error('template registry unavailable')
      })
    )
    expect(failed.revisionDraft).toBeUndefined()
    expect(failed.binding).toBeUndefined()
    expect(failed.diagnostics).toEqual([
      expect.objectContaining({
        code: 'template_resolution_failed',
        message: 'template registry unavailable'
      })
    ])

    const invalid = compileWorkflowDefinition(
      workflow(),
      options(() => ({
        ...soloResolution(),
        runTemplateRef: ' ',
        runTemplateDigest: 'not-a-digest'
      }))
    )
    expect(invalid.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['invalid_run_template_ref', 'invalid_run_template_digest'])
    )
  })
})
