import type { ProviderId } from '../store/types'
import type {
  CanonicalWorkspaceLockPathVerification,
  ResolvedCanonicalWorkspaceLockPath
} from './CanonicalWorkspaceLockPath'

export type WorkspaceLockMode = 'read' | 'write'
export type WorkspaceLockClaimKind = 'workspace' | 'tree' | 'file' | 'hunk'
export type WorkspaceLockClaimStatus = 'held' | 'orphan_live' | 'recovery_blocked' | 'recovered'

export interface WorkspaceLockOwner {
  /** Exact per-seat/lane/process lock identity exported to native git hooks. */
  lockOwnerId: string
  /** Durable primary owner. Terminal cleanup is keyed by this value. */
  runId: string
  /** Child-held native leases outlive terminal run cleanup until child close. */
  lifecycle?: 'run' | 'launching-child' | 'child'
  laneId?: string
  chatId?: string
  provider?: ProviderId
  participantId?: string
  displayName?: string
  chatTitle?: string
  pid: number
  /** Exact process-birth identity, not merely a PID-liveness assertion. */
  processBirthIdentity: string
}

export interface WorkspaceLockHunk {
  /** Content digest for the file version whose coordinates these are. */
  baseline: string
  /** Zero-based, inclusive line boundary. */
  startLine: number
  /** Zero-based, exclusive line boundary. Equal to startLine for an insertion. */
  endLine: number
}

export interface WorkspaceLockClaimRequest {
  workspacePath: string
  /** Defaults to workspacePath. Separate worktrees are independent lock domains. */
  worktreePath?: string
  worktreeName?: string
  branch?: string
  kind: WorkspaceLockClaimKind
  mode?: WorkspaceLockMode
  /** Required for tree, file, and hunk claims; ignored for workspace claims. */
  targetPath?: string
  /** Required only for hunk claims. */
  hunk?: WorkspaceLockHunk
  /**
   * Operation-scoped authority over filesystem writes outside the selected
   * worktree. Valid only for a write-mode workspace claim. Its marker is still
   * projected into the initiating checkout, but it conflicts globally.
   */
  globalFilesystem?: boolean
}

export interface CanonicalWorkspaceLockClaim {
  workspaceIdentity: string
  /** Exact, case-preserving root safe to use for marker and filesystem IO. */
  worktreeCanonicalPath: string
  worktreeIdentity: string
  /** Physical identity of the effective worktree root when it was resolved. */
  worktreeObjectIdentity?: string
  /** Exact, case-preserving target safe to pass to the broker executor. */
  targetCanonicalPath: string
  /** Canonical, case-normalized path used only for hierarchy comparisons. */
  comparisonTargetPath: string
  /** Stable dev:ino/planned-object key used for hard-link and alias equality. */
  objectIdentity?: string
  /** @deprecated Use comparisonTargetPath for hierarchy and objectIdentity for equality. */
  physicalTargetIdentity: string
  /** Original user-facing roots retained independently from physical identities. */
  displayWorkspacePath: string
  displayWorktreePath: string
  /** Forward-slash worktree-relative path; absent for a workspace claim. */
  relativeTargetPath?: string
  worktreeName?: string
  branch?: string
  kind: WorkspaceLockClaimKind
  mode: WorkspaceLockMode
  hunk?: WorkspaceLockHunk
  globalFilesystem?: true
  /**
   * Acquisition-time lexical and physical evidence. Brokered mutation paths
   * must re-resolve this evidence while holding the mutation commit fence.
   */
  pathEvidence?: ResolvedCanonicalWorkspaceLockPath
}

export interface WorkspaceLockAuthorityFence {
  instanceId: string
  generation: number
  pid: number
  processBirthIdentity: string
  fenceId: string
  acquiredAt: string
}

export interface WorkspaceLockLease {
  leaseId: string
  acquiredTransitionId: string
  authorityInstanceId: string
  authorityGeneration: number
  owner: WorkspaceLockOwner
  claim: CanonicalWorkspaceLockClaim
  acquiredAt: string
  status: WorkspaceLockClaimStatus
  statusChangedAt: string
  recoveryReason?: 'owner_dead' | 'pid_reused'
}

export interface WorkspaceLockToken {
  leaseId: string
  acquiredTransitionId: string
  authorityInstanceId: string
  authorityGeneration: number
  ownerRunId: string
}

export interface WorkspaceLockConflict {
  requested: CanonicalWorkspaceLockClaim
  holders: WorkspaceLockLease[]
  reason: string
}

export type WorkspaceLockAcquireResult =
  | {
      ok: true
      transitionId: string
      tokens: WorkspaceLockToken[]
      leases: WorkspaceLockLease[]
    }
  | {
      ok: false
      reason:
        | 'invalid_request'
        | 'owner_not_live'
        | 'owner_identity_unavailable'
        | 'authority_busy'
        | 'conflict'
      message: string
      conflict?: WorkspaceLockConflict
    }

export type WorkspaceLockReleaseResult =
  | {
      ok: true
      transitionId: string
      released: WorkspaceLockLease[]
      retained?: WorkspaceLockLease[]
      retainedReason?: 'live_child' | 'managed_child' | 'launching_child' | 'managed_children'
    }
  | {
      ok: false
      reason:
        | 'authority_busy'
        | 'foreign_authority'
        | 'stale_generation'
        | 'stale_token'
        | 'foreign_owner'
      message: string
    }

export type WorkspaceLockProcessObservation =
  | { state: 'dead' }
  | { state: 'live'; processBirthIdentity: string }
  | { state: 'identity_unavailable' }

export interface WorkspaceLockAuthorityDependencies {
  nowIso: () => string
  nextId: (kind: 'fence' | 'lease' | 'transition') => string
  /** Exact native process-birth observation; may be asynchronous on macOS. */
  observeProcess: (
    pid: number
  ) => WorkspaceLockProcessObservation | Promise<WorkspaceLockProcessObservation>
  canonicalizePath: (inputPath: string) => string
  resolveTargetPath: (rootPath: string, targetPath: string) => ResolvedCanonicalWorkspaceLockPath
  verifyTargetPath: (
    expected: ResolvedCanonicalWorkspaceLockPath
  ) => CanonicalWorkspaceLockPathVerification
  /** Required before the authority grants a hunk claim. */
  validateHunkBaseline?: (claim: CanonicalWorkspaceLockClaim) => boolean | Promise<boolean>
  instance: {
    instanceId: string
    pid: number
    processBirthIdentity: string
  }
}

export interface WorkspaceLockSnapshot {
  authority: WorkspaceLockAuthorityFence
  sequence: number
  lastTransitionId: string
  leases: WorkspaceLockLease[]
  projectionErrors: string[]
}

export interface WorkspaceLockMutationCapability {
  token: WorkspaceLockToken
  leaseId: string
  kind: WorkspaceLockClaimKind
  /** Fresh exact path that the executor must consume instead of raw input. */
  executableTargetPath: string
  verifiedPathEvidence: ResolvedCanonicalWorkspaceLockPath
  hunk?: WorkspaceLockHunk
}

export type WorkspaceLockMutationVerificationResult =
  | {
      ok: true
      acquiredTransitionId: string
      capabilities: WorkspaceLockMutationCapability[]
    }
  | {
      ok: false
      reason:
        | 'invalid_request'
        | 'owner_not_live'
        | 'owner_identity_unavailable'
        | 'stale_acquisition'
        | 'path_changed'
        | 'baseline_changed'
      message: string
    }

export function workspaceLockToken(lease: WorkspaceLockLease): WorkspaceLockToken {
  return {
    leaseId: lease.leaseId,
    acquiredTransitionId: lease.acquiredTransitionId,
    authorityInstanceId: lease.authorityInstanceId,
    authorityGeneration: lease.authorityGeneration,
    ownerRunId: lease.owner.runId
  }
}
