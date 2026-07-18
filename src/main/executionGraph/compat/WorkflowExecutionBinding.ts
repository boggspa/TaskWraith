import type {
  WorkflowConcurrencyPolicy,
  WorkflowMissedRunPolicy,
  WorkflowRunTemplate,
  WorkflowTrigger
} from '../../store/types'
import type { ExecutionEffect, SoloAgentStep } from '../ExecutionGraphModel'

/**
 * A main-owned content address for the complete legacy run template.
 *
 * The resolver must persist/resolve the whole `WorkflowRunTemplate`, rather
 * than selecting a subset of fields. This is the compatibility seam that lets
 * the execution graph stay small without silently losing provider controls,
 * attachments, permission settings, or the scheduled Ensemble roster.
 */
export interface ResolvedWorkflowRunTemplateRef {
  readonly runTemplateRef: string
  readonly runTemplateDigest: string
  /** Conservative, authority-owned classification of what the template may do. */
  readonly effect: ExecutionEffect
  /** Required for a solo workflow so the compiler does not invent session semantics. */
  readonly soloSession?: SoloAgentStep['agent']['session']
  /**
   * Required for Ensemble workflows. `snapshotRef` may equal
   * `runTemplateRef` only when the registry resolves that ref to an immutable,
   * directly executable Ensemble snapshot. The explicit invariant marker is
   * checked at runtime so a generic blob ref cannot be treated as executable.
   */
  readonly ensembleSnapshot?: {
    readonly snapshotRef: string
    readonly snapshotDigest: string
    readonly invariant: 'immutable_executable_ensemble_snapshot'
  }
}

export type ResolveWorkflowRunTemplateRef = (
  input: Readonly<{
    workflowId: string
    /** The complete template, including fields not projected into graph nodes. */
    template: WorkflowRunTemplate
  }>
) => ResolvedWorkflowRunTemplateRef

export interface WorkflowScheduleBinding {
  readonly enabled: boolean
  readonly trigger: Readonly<WorkflowTrigger>
  readonly missedRunPolicy: WorkflowMissedRunPolicy
  readonly concurrencyPolicy: WorkflowConcurrencyPolicy
  /** Scheduler/lifecycle caps remain outside graph execution semantics. */
  readonly maxRunsPerDay?: number
  readonly maxConsecutiveFailures?: number
}

/**
 * Authority and scheduler metadata bound to a compiled Workflow graph.
 *
 * This record is deliberately outside `ExecutionGraphRevisionDraft`: schedule
 * policy and the legacy authority root must not become graph readiness rules or
 * a second permission/consent system.
 */
export interface WorkflowExecutionBinding {
  readonly schemaVersion: 1
  readonly kind: 'workflow'
  readonly workflowId: string
  readonly graphId: string
  readonly graphRevision: number
  readonly runTemplateRef: string
  readonly runTemplateDigest: string
  readonly schedule: WorkflowScheduleBinding
  readonly legacyAuthorityRef: string
  readonly legacyAuthorityDigest: string
  readonly ensembleSnapshotRef?: string
  readonly ensembleSnapshotDigest?: string
}
