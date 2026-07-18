import type { WorkflowDefinition, WorkflowTrigger } from '../../store/types'
import type {
  ExecutionControlEdge,
  ExecutionDataEdge,
  ExecutionEffect,
  ExecutionGraphLimits,
  ExecutionGraphRevisionDraft,
  ExecutionStepCommon,
  ExecutionStepDefinition
} from '../ExecutionGraphModel'
import type {
  ResolveWorkflowRunTemplateRef,
  ResolvedWorkflowRunTemplateRef,
  WorkflowExecutionBinding,
  WorkflowScheduleBinding
} from './WorkflowExecutionBinding'

export type WorkflowDefinitionCompilationDiagnosticCode =
  | 'unsupported_loop'
  | 'invalid_workflow_identity'
  | 'invalid_revision'
  | 'invalid_revision_created_at'
  | 'invalid_legacy_authority'
  | 'template_resolution_failed'
  | 'invalid_run_template_ref'
  | 'invalid_run_template_digest'
  | 'run_template_ref_digest_mismatch'
  | 'invalid_execution_effect'
  | 'missing_solo_session'
  | 'invalid_solo_session'
  | 'missing_ensemble_snapshot'
  | 'invalid_ensemble_snapshot_ref'
  | 'invalid_ensemble_snapshot_digest'
  | 'ensemble_snapshot_ref_digest_mismatch'
  | 'untrusted_ensemble_snapshot_ref'

export interface WorkflowDefinitionCompilationDiagnostic {
  readonly severity: 'error'
  readonly code: WorkflowDefinitionCompilationDiagnosticCode
  readonly path: string
  readonly message: string
}

export interface CompileWorkflowDefinitionOptions {
  readonly revision: number
  /** Creation time of this graph revision, not the Workflow lifecycle timestamp. */
  readonly revisionCreatedAt: string
  /** Existing main-owned Workflow authority root; never minted by this compiler. */
  readonly legacyAuthorityRef: string
  readonly legacyAuthorityDigest: string
  readonly resolveRunTemplateRef: ResolveWorkflowRunTemplateRef
}

export interface WorkflowDefinitionCompilationResult {
  readonly revisionDraft?: ExecutionGraphRevisionDraft
  readonly binding?: WorkflowExecutionBinding
  readonly diagnostics: readonly WorkflowDefinitionCompilationDiagnostic[]
}

const SHA_256_HEX = /^[0-9a-f]{64}$/i
const WORKFLOW_ID_FOR_GRAPH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,118}$/

function diagnostic(
  code: WorkflowDefinitionCompilationDiagnosticCode,
  path: string,
  message: string
): WorkflowDefinitionCompilationDiagnostic {
  return { severity: 'error', code, path, message }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isValidIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value))
}

function cloneTrigger(trigger: WorkflowTrigger): Readonly<WorkflowTrigger> {
  return {
    kind: trigger.kind,
    ...(trigger.runAt !== undefined ? { runAt: trigger.runAt } : {}),
    ...(trigger.intervalMs !== undefined ? { intervalMs: trigger.intervalMs } : {}),
    ...(trigger.startAt !== undefined ? { startAt: trigger.startAt } : {}),
    ...(trigger.cronExpression !== undefined ? { cronExpression: trigger.cronExpression } : {}),
    ...(trigger.timezone !== undefined ? { timezone: trigger.timezone } : {})
  }
}

function scheduleBinding(workflow: WorkflowDefinition): WorkflowScheduleBinding {
  return {
    enabled: workflow.enabled,
    trigger: cloneTrigger(workflow.trigger),
    missedRunPolicy: workflow.missedRunPolicy,
    concurrencyPolicy: workflow.concurrencyPolicy,
    ...(workflow.limits.maxRunsPerDay !== undefined
      ? { maxRunsPerDay: workflow.limits.maxRunsPerDay }
      : {}),
    ...(workflow.limits.maxConsecutiveFailures !== undefined
      ? { maxConsecutiveFailures: workflow.limits.maxConsecutiveFailures }
      : {})
  }
}

function graphLimits(workflow: WorkflowDefinition): Partial<ExecutionGraphLimits> {
  return {
    maxSteps: 2,
    maxConcurrentSteps: 1,
    maxAttempts: 2,
    ...(workflow.limits.timeoutSeconds !== undefined
      ? { maxWallClockMs: workflow.limits.timeoutSeconds * 1_000 }
      : {}),
    ...(workflow.limits.maxTokens !== undefined ? { maxTokens: workflow.limits.maxTokens } : {}),
    ...(workflow.limits.maxCostUsd !== undefined ? { maxCostUsd: workflow.limits.maxCostUsd } : {})
  }
}

function stepCommon(
  id: string,
  title: string,
  objective: string,
  effect: ExecutionEffect
): ExecutionStepCommon {
  return {
    id,
    title,
    objective,
    effect,
    retry: { maxAttempts: 1 }
  }
}

function validateResolvedTemplate(
  workflow: WorkflowDefinition,
  resolved: ResolvedWorkflowRunTemplateRef
): readonly WorkflowDefinitionCompilationDiagnostic[] {
  const diagnostics: WorkflowDefinitionCompilationDiagnostic[] = []
  if (!isNonEmptyString(resolved?.runTemplateRef)) {
    diagnostics.push(
      diagnostic(
        'invalid_run_template_ref',
        'template.runTemplateRef',
        'The template resolver must return a non-empty content-addressed runTemplateRef.'
      )
    )
  }
  if (!SHA_256_HEX.test(resolved?.runTemplateDigest ?? '')) {
    diagnostics.push(
      diagnostic(
        'invalid_run_template_digest',
        'template.runTemplateDigest',
        'The template resolver must return a SHA-256 digest for the complete run template.'
      )
    )
  } else if (
    isNonEmptyString(resolved?.runTemplateRef) &&
    !resolved.runTemplateRef.toLowerCase().includes(resolved.runTemplateDigest.toLowerCase())
  ) {
    diagnostics.push(
      diagnostic(
        'run_template_ref_digest_mismatch',
        'template.runTemplateRef',
        'The content-addressed runTemplateRef must contain its SHA-256 digest.'
      )
    )
  }
  if (!['read_only', 'workspace_write', 'external_side_effect'].includes(resolved?.effect)) {
    diagnostics.push(
      diagnostic(
        'invalid_execution_effect',
        'template.effect',
        'The template resolver must classify the maximum effect of the executable template.'
      )
    )
  }

  if (workflow.template.kind === 'ensemble') {
    if (!resolved?.ensembleSnapshot) {
      diagnostics.push(
        diagnostic(
          'missing_ensemble_snapshot',
          'template.ensembleSnapshot',
          'An Ensemble workflow requires an immutable executable snapshot reference.'
        )
      )
      return diagnostics
    }
    if (!isNonEmptyString(resolved.ensembleSnapshot.snapshotRef)) {
      diagnostics.push(
        diagnostic(
          'invalid_ensemble_snapshot_ref',
          'template.ensembleSnapshot.snapshotRef',
          'The Ensemble snapshot ref must be non-empty.'
        )
      )
    }
    if (!SHA_256_HEX.test(resolved.ensembleSnapshot.snapshotDigest)) {
      diagnostics.push(
        diagnostic(
          'invalid_ensemble_snapshot_digest',
          'template.ensembleSnapshot.snapshotDigest',
          'The Ensemble snapshot resolver must return a SHA-256 digest.'
        )
      )
    } else if (
      isNonEmptyString(resolved.ensembleSnapshot.snapshotRef) &&
      !resolved.ensembleSnapshot.snapshotRef
        .toLowerCase()
        .includes(resolved.ensembleSnapshot.snapshotDigest.toLowerCase())
    ) {
      diagnostics.push(
        diagnostic(
          'ensemble_snapshot_ref_digest_mismatch',
          'template.ensembleSnapshot.snapshotRef',
          'The content-addressed Ensemble snapshot ref must contain its SHA-256 digest.'
        )
      )
    } else if (
      resolved.ensembleSnapshot.snapshotRef === resolved.runTemplateRef &&
      resolved.ensembleSnapshot.snapshotDigest.toLowerCase() !==
        resolved.runTemplateDigest.toLowerCase()
    ) {
      diagnostics.push(
        diagnostic(
          'ensemble_snapshot_ref_digest_mismatch',
          'template.ensembleSnapshot.snapshotDigest',
          'A reused run-template content address must have the same digest as the Ensemble snapshot.'
        )
      )
    }
    if (resolved.ensembleSnapshot.invariant !== 'immutable_executable_ensemble_snapshot') {
      diagnostics.push(
        diagnostic(
          'untrusted_ensemble_snapshot_ref',
          'template.ensembleSnapshot.invariant',
          'The ref was not guaranteed to resolve to an immutable executable Ensemble snapshot.'
        )
      )
    }
  } else if (!resolved?.soloSession) {
    diagnostics.push(
      diagnostic(
        'missing_solo_session',
        'template.soloSession',
        'A solo workflow requires a resolver-owned session policy.'
      )
    )
  } else if (
    resolved.soloSession.mode !== 'fresh' &&
    (resolved.soloSession.mode !== 'bound' || !isNonEmptyString(resolved.soloSession.sessionRef))
  ) {
    diagnostics.push(
      diagnostic(
        'invalid_solo_session',
        'template.soloSession',
        'The solo session policy must be fresh or a bound session with a non-empty ref.'
      )
    )
  }
  return diagnostics
}

function buildSteps(
  workflow: WorkflowDefinition,
  resolved: ResolvedWorkflowRunTemplateRef
): readonly ExecutionStepDefinition[] {
  const executable: ExecutionStepDefinition =
    workflow.template.kind === 'ensemble'
      ? {
          ...stepCommon(
            'execute',
            'Execute ensemble round',
            'Execute the bound Workflow template as one durable Ensemble round.',
            resolved.effect
          ),
          kind: 'ensemble_round',
          outputs: [{ name: 'result' }],
          ensemble: {
            snapshotRef: resolved.ensembleSnapshot!.snapshotRef,
            prompt: workflow.template.prompt,
            orchestrationMode: workflow.template.ensembleSnapshot!.orchestrationMode
          }
        }
      : {
          ...stepCommon(
            'execute',
            'Execute agent run',
            'Execute the bound Workflow run template.',
            resolved.effect
          ),
          kind: 'solo_agent',
          outputs: [{ name: 'result' }],
          agent: {
            provider: workflow.template.provider,
            runTemplateRef: resolved.runTemplateRef,
            session: resolved.soloSession!
          }
        }

  return [
    executable,
    {
      ...stepCommon(
        'output',
        'Publish execution result',
        'Expose the terminal Workflow result without automatic Project promotion.',
        'read_only'
      ),
      kind: 'output',
      inputs: [{ name: 'result', required: true }],
      output: { label: 'Workflow result', projectReference: 'none' }
    }
  ]
}

function buildEdges(): readonly (ExecutionControlEdge | ExecutionDataEdge)[] {
  return [
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
  ]
}

/**
 * Compile a saved Workflow into the shared execution kernel while leaving its
 * schedule, occurrence ownership, legacy authority, and concurrency policy in
 * the Workflow subsystem that already enforces them.
 */
export function compileWorkflowDefinition(
  workflow: WorkflowDefinition,
  options: CompileWorkflowDefinitionOptions
): WorkflowDefinitionCompilationResult {
  const diagnostics: WorkflowDefinitionCompilationDiagnostic[] = []

  // A loop is a bounded composite executor, not a pair of graph nodes. Until
  // the kernel has that executor contract, expansion would falsify its budgets,
  // acceptance semantics, and durable occurrence ownership.
  if (workflow.loop) {
    return {
      diagnostics: [
        diagnostic(
          'unsupported_loop',
          'loop',
          'Legacy maker/verifier loops require a bounded composite executor and cannot be compiled in V1.'
        )
      ]
    }
  }

  if (
    !isNonEmptyString(workflow.id) ||
    !WORKFLOW_ID_FOR_GRAPH.test(workflow.id.trim()) ||
    !isNonEmptyString(workflow.workspaceId)
  ) {
    diagnostics.push(
      diagnostic(
        'invalid_workflow_identity',
        'id',
        'Workflow id must be a canonical durable id, and workspace id is required.'
      )
    )
  }
  if (!Number.isInteger(options.revision) || options.revision < 1) {
    diagnostics.push(
      diagnostic('invalid_revision', 'revision', 'Graph revision must be a positive integer.')
    )
  }
  if (!isValidIsoTimestamp(options.revisionCreatedAt)) {
    diagnostics.push(
      diagnostic(
        'invalid_revision_created_at',
        'revisionCreatedAt',
        'Graph revision creation time must be an ISO-compatible timestamp.'
      )
    )
  }
  if (
    !isNonEmptyString(options.legacyAuthorityRef) ||
    !SHA_256_HEX.test(options.legacyAuthorityDigest)
  ) {
    diagnostics.push(
      diagnostic(
        'invalid_legacy_authority',
        'legacyAuthority',
        'A non-empty legacy authority ref and SHA-256 authority digest are required.'
      )
    )
  }
  if (workflow.template.kind === 'ensemble' && !workflow.template.ensembleSnapshot) {
    diagnostics.push(
      diagnostic(
        'missing_ensemble_snapshot',
        'template.ensembleSnapshot',
        'An Ensemble workflow template must contain its scheduled roster snapshot.'
      )
    )
  }
  if (diagnostics.length > 0) return { diagnostics }

  let resolved: ResolvedWorkflowRunTemplateRef
  try {
    // Pass the complete object. The resolver owns persistence/content addressing;
    // this compiler never rebuilds a lossy template subset.
    resolved = options.resolveRunTemplateRef({
      workflowId: workflow.id,
      template: workflow.template
    })
  } catch (error) {
    return {
      diagnostics: [
        diagnostic(
          'template_resolution_failed',
          'template',
          error instanceof Error ? error.message : 'The run template resolver failed.'
        )
      ]
    }
  }

  diagnostics.push(...validateResolvedTemplate(workflow, resolved))
  if (diagnostics.length > 0) return { diagnostics }

  const graphId = `workflow-${workflow.id.trim()}`
  const revisionDraft: ExecutionGraphRevisionDraft = {
    graphId,
    revision: options.revision,
    workspaceId: workflow.workspaceId.trim(),
    // Workflow.name is presentation. A stable kernel label prevents renames
    // from changing execution identity.
    name: graphId,
    createdAt: options.revisionCreatedAt,
    steps: buildSteps(workflow, resolved),
    edges: buildEdges(),
    limits: graphLimits(workflow)
  }
  const binding: WorkflowExecutionBinding = {
    schemaVersion: 1,
    kind: 'workflow',
    workflowId: workflow.id.trim(),
    graphId,
    graphRevision: options.revision,
    runTemplateRef: resolved.runTemplateRef.trim(),
    runTemplateDigest: resolved.runTemplateDigest.toLowerCase(),
    schedule: scheduleBinding(workflow),
    legacyAuthorityRef: options.legacyAuthorityRef.trim(),
    legacyAuthorityDigest: options.legacyAuthorityDigest.toLowerCase(),
    ...(resolved.ensembleSnapshot
      ? {
          ensembleSnapshotRef: resolved.ensembleSnapshot.snapshotRef.trim(),
          ensembleSnapshotDigest: resolved.ensembleSnapshot.snapshotDigest.toLowerCase()
        }
      : {})
  }

  return { revisionDraft, binding, diagnostics: [] }
}
