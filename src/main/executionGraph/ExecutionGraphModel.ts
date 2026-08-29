/**
 * Pure domain types for TaskWraith's durable execution-graph kernel.
 *
 * "Workflow" is intentionally absent from the internal nouns in this module. A
 * saved Workflow, an Audit, a Stack, or an Ensemble may compile into an
 * ExecutionGraph, but none of those product surfaces owns the kernel.
 */

export const EXECUTION_GRAPH_SCHEMA_VERSION = 1 as const
export const EXECUTION_RUN_EVENT_SCHEMA_VERSION = 1 as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** JSON Schema is kept structural so this package has no dependency on a UI or validator package. */
export type ExecutionJsonSchema = JsonObject

export type ExecutionEffect = 'read_only' | 'workspace_write' | 'external_side_effect'

/**
 * A reference to the permission ceiling resolved by the existing authority
 * system. The graph kernel compares references and digests; it does not import
 * permission-service types or invent a second elevation mechanism.
 */
export interface ExecutionPermissionCeilingRef {
  readonly schemaVersion: 1
  readonly referenceId: string
  readonly authorityDigest: string
  readonly workspaceId?: string
}

/** A step may request a narrower envelope, always bound to its run ceiling. */
export interface ExecutionPermissionRequestRef {
  readonly schemaVersion: 1
  readonly referenceId: string
  readonly ceilingReferenceId: string
  readonly authorityDigest?: string
}

export interface ExecutionPortDefinition {
  readonly name: string
  readonly schema?: ExecutionJsonSchema
  readonly required?: boolean
}

export interface ExecutionRetryPolicy {
  /** Includes the first attempt. V1 never permits an unbounded retry count. */
  readonly maxAttempts: number
  readonly backoffMs?: number
}

export interface ExecutionStepCommon {
  readonly id: string
  readonly title: string
  readonly objective: string
  readonly effect: ExecutionEffect
  readonly inputs?: readonly ExecutionPortDefinition[]
  readonly outputs?: readonly ExecutionPortDefinition[]
  readonly retry: ExecutionRetryPolicy
  readonly permissionRequestRef?: ExecutionPermissionRequestRef
  readonly timeoutMs?: number
}

export interface SoloAgentStep extends ExecutionStepCommon {
  readonly kind: 'solo_agent'
  readonly agent: {
    readonly provider: string
    readonly model?: string
    readonly runtimeProfileRef?: string
    /** Opaque immutable/full request profile owned by the main runtime. */
    readonly runTemplateRef?: string
    readonly session:
      | { readonly mode: 'fresh' }
      | { readonly mode: 'bound'; readonly sessionRef: string }
  }
}

export interface DeterministicCheckStep extends ExecutionStepCommon {
  readonly kind: 'deterministic_check'
  readonly check: {
    /** Stable registry key; arbitrary source strings are deliberately not executable V1 nodes. */
    readonly handlerRef: string
    readonly version?: string
  }
}

export interface HumanGateStep extends ExecutionStepCommon {
  readonly kind: 'human_gate'
  readonly gate:
    | {
        readonly mode: 'approval'
        readonly prompt: string
        readonly approveLabel?: string
        readonly declineLabel?: string
      }
    | {
        readonly mode: 'input'
        readonly prompt: string
        readonly options?: readonly string[]
      }
}

export interface JoinStep extends ExecutionStepCommon {
  readonly kind: 'join'
  readonly join:
    | { readonly mode: 'all'; readonly deadlineMs?: number }
    | { readonly mode: 'any'; readonly deadlineMs?: number }
    | { readonly mode: 'quorum'; readonly quorum: number; readonly deadlineMs?: number }
}

export interface EnsembleRoundStep extends ExecutionStepCommon {
  readonly kind: 'ensemble_round'
  readonly ensemble: {
    /** Refers to an immutable roster/snapshot owned by the Ensemble subsystem. */
    readonly snapshotRef: string
    readonly prompt: string
    readonly orchestrationMode: 'turn_bound' | 'continuous'
  }
}

export interface OutputStep extends ExecutionStepCommon {
  readonly kind: 'output'
  readonly output: {
    readonly label?: string
    /** Promotion remains a reviewed proposal; the graph never mutates Project references directly. */
    readonly projectReference: 'none' | 'propose'
  }
}

export type ExecutionStepDefinition =
  | SoloAgentStep
  | DeterministicCheckStep
  | HumanGateStep
  | JoinStep
  | EnsembleRoundStep
  | OutputStep

export interface ExecutionControlEdge {
  readonly id: string
  readonly kind: 'control'
  readonly fromStepId: string
  readonly toStepId: string
  /** V1 control dependencies are intentionally success-only. */
  readonly outcome: 'success'
}

export interface ExecutionDataEdge {
  readonly id: string
  readonly kind: 'data'
  readonly from: {
    readonly stepId: string
    readonly port: string
  }
  readonly to: {
    readonly stepId: string
    readonly port: string
  }
}

export type ExecutionEdge = ExecutionControlEdge | ExecutionDataEdge

export interface ExecutionGraphLimits {
  readonly maxSteps: number
  readonly maxConcurrentSteps: number
  readonly maxAttempts: number
  readonly maxWallClockMs?: number
  readonly maxTokens?: number
  readonly maxCostUsd?: number
}

export interface ExecutionGraphRevisionDraft {
  readonly graphId: string
  readonly revision: number
  readonly workspaceId: string
  readonly name: string
  readonly description?: string
  readonly createdAt: string
  readonly steps: readonly ExecutionStepDefinition[]
  readonly edges: readonly ExecutionEdge[]
  readonly limits?: Partial<ExecutionGraphLimits>
}

/**
 * Immutable, compiled definition. Layout is intentionally not a field: visual
 * coordinates must not affect execution identity, readiness, or authority.
 */
export interface ExecutionGraphRevision {
  readonly schemaVersion: 1
  readonly graphId: string
  readonly revision: number
  readonly revisionId: string
  readonly definitionDigest: string
  readonly workspaceId: string
  readonly name: string
  readonly description?: string
  readonly createdAt: string
  readonly steps: readonly ExecutionStepDefinition[]
  readonly edges: readonly ExecutionEdge[]
  readonly limits: ExecutionGraphLimits
}

export interface ExecutionGraphRevisionRef {
  readonly schemaVersion: 1
  readonly graphId: string
  readonly revision: number
  readonly revisionId: string
  readonly definitionDigest: string
}

/** Projection-only state kept outside ExecutionGraphRevision and its digest. */
export interface ExecutionGraphLayout {
  readonly schemaVersion: 1
  readonly graphId: string
  readonly revision: number
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>
  readonly collapsedGroupIds?: readonly string[]
  readonly viewport?: {
    readonly x: number
    readonly y: number
    readonly zoom: number
  }
}

export type ExecutionResultTrust = 'user' | 'system' | 'deterministic' | 'untrusted_agent_output'

export type ExecutionArtifactKind =
  | 'file'
  | 'diff'
  | 'commit'
  | 'report'
  | 'blob'
  | 'run'
  | 'project_reference'
  | 'other'

export interface ExecutionArtifactRef {
  readonly schemaVersion: 1
  readonly id: string
  readonly kind: ExecutionArtifactKind
  readonly uri?: string
  readonly digest?: string
  readonly mediaType?: string
  readonly byteLength?: number
  readonly createdByAttemptId: string
  readonly trust: ExecutionResultTrust
}

/** Structured output is the data plane; prose transcripts are only linked evidence. */
export interface ExecutionStepResult {
  readonly schemaVersion: 1
  readonly output?: JsonValue
  readonly summary?: string
  readonly artifactRefs: readonly ExecutionArtifactRef[]
  readonly trust: ExecutionResultTrust
  readonly evidenceRefs?: readonly string[]
  readonly providerRunRef?: string
  readonly threadRef?: string
}

export type ExecutionRunState =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface ExecutionTenantRef {
  readonly kind: 'stack' | 'workflow' | 'audit' | 'ensemble'
  readonly tenantId?: string
}

/**
 * The thread and seat answerable for a durable execution.
 *
 * Distinct from both neighbours it is easily confused with. `tenant`/`rootChatId`
 * ASSOCIATE an execution with a thread; they never make that thread responsible
 * for it. `anchorRunRef` points the other way down the dependency — the graph
 * WAITS on that run — so it cannot express "this run answers for the graph".
 *
 * Ownership is mandatory: an execution with no live owner may not dispatch. See
 * the owner-liveness gate in ExecutionGraphCoordinator.drainOne.
 */
export interface ExecutionOwnerRef {
  /**
   * Top-level chat that asked for the work and receives the result. This is
   * the identity liveness is judged on: the thread outlives any single turn.
   */
  readonly threadId: string
  /** Seat identity (`provider` or `provider:model`) accountable for the task. */
  readonly seatId: string
  /**
   * The provider run whose turn invoked the tool, when an agent invoked it.
   * Absent for user-authored graphs, which have an owning thread but no
   * initiating agent turn. Its terminalization is never an ownership loss.
   */
  readonly initiatingRunId?: string
}

export type StepActivationState =
  | 'dormant'
  | 'ready'
  | 'claimed'
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'waiting_retry'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'

export type StepAttemptState =
  | 'created'
  | 'claimed'
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface StepActivation {
  readonly id: string
  readonly stepId: string
  readonly state: StepActivationState
  readonly createdAt: string
  readonly updatedAt: string
  readonly attemptIds: readonly string[]
  readonly retryAt?: string
  readonly reason?: string
}

export interface StepAttempt {
  readonly id: string
  readonly activationId: string
  readonly stepId: string
  readonly ordinal: number
  readonly state: StepAttemptState
  readonly createdAt: string
  readonly updatedAt: string
  readonly startedAt?: string
  readonly completedAt?: string
  readonly providerRunRef?: string
  readonly result?: ExecutionStepResult
  readonly error?: string
}

export interface EffectiveExecutionTopology {
  readonly baseRevision?: ExecutionGraphRevisionRef
  readonly steps: readonly ExecutionStepDefinition[]
  readonly edges: readonly ExecutionEdge[]
}

/**
 * Durable receipt for a renderer-authored mutation command. The request id is
 * an opaque, canonical nonce; the digest is recomputed by main from the
 * sanitized semantic command and is never accepted from the renderer.
 */
export interface ExecutionClientRequestReceipt {
  readonly clientRequestId: string
  readonly clientRequestDigest: string
  /**
   * Digest of the canonical renderer command before volatile target and
   * attachment authority are resolved. Main computes this value; it lets an
   * exact uncertain retry return its committed receipt even when the original
   * live anchor has since become terminal.
   */
  readonly clientSubmissionDigest: string
}

export interface UserFrontierAppend {
  readonly appendedBy: 'user'
  readonly step: ExecutionStepDefinition
  /** All appended edges must target the new step; existing edges are never rewritten. */
  readonly incomingEdges: readonly ExecutionEdge[]
}
