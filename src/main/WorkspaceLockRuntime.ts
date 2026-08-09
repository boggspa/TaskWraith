import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  createWorkLockProjectionSnapshot,
  type WorkLockProjectionChangeReason,
  type WorkLockProjectionQuery,
  type WorkLockProjectionSnapshot
} from '../shared/workLockProjection'
import {
  deriveWorkspaceMutationClaims,
  WorkspaceMutationClaimDerivationError,
  type WorkspaceMutationCall
} from './WorkspaceMutationClaims'
import { WorkspaceLockProcessIdentityService } from './WorkspaceLockProcessIdentity'
import {
  resolveCanonicalWorkspaceLockPath,
  verifyCanonicalWorkspaceLockPath
} from './workLocks/CanonicalWorkspaceLockPath'
import { NodeWorkspaceLockPersistence } from './workLocks/NodeWorkspaceLockPersistence'
import {
  WorkspaceLockAuthority,
  type WorkspaceLockAuthorityListener,
  type WorkspaceLockRecoveryResult
} from './workLocks/WorkspaceLockAuthority'
import {
  WorkspaceMutationCommitFence,
  WorkspaceMutationCommitFenceBusyError,
  type WorkspaceMutationCommitFenceOwner
} from './workLocks/WorkspaceMutationCommitFence'
import { normalizeWorkspaceLockOwnerPresentation } from './workLocks/WorkspaceLockTypes'
import type {
  WorkspaceLockAcquireResult,
  WorkspaceLockAuthorityFence,
  CanonicalWorkspaceLockClaim,
  WorkspaceLockClaimRequest,
  WorkspaceLockLease,
  WorkspaceLockOwner,
  WorkspaceLockProcessObservation,
  WorkspaceLockReleaseResult,
  WorkspaceLockMutationVerificationResult,
  WorkspaceLockSnapshot
} from './workLocks/WorkspaceLockTypes'

export interface WorkspaceLockRuntimeOpenOptions {
  userDataRoot: string
  instanceId: string
  processIdentity: WorkspaceLockProcessIdentityService
}

export function workspaceLockAuthorityRootForHome(homePath: string): string {
  return join(resolve(homePath), '.taskwraith', 'workspace-lock-authority-v1')
}

export interface WorkspaceLockRuntimeOwnerInput {
  lockOwnerId: string
  runId: string
  lifecycle?: WorkspaceLockOwner['lifecycle']
  laneId?: string
  chatId?: string
  provider?: WorkspaceLockOwner['provider']
  participantId?: string
  displayName?: string
  chatTitle?: string
  /** Main owns brokered writes; native pre-execution hooks supply their child. */
  executionPid?: number
}

export interface WorkspaceLockRuntimeAcquireInput {
  owner: WorkspaceLockRuntimeOwnerInput
  mutation: WorkspaceMutationCall
  /**
   * Main may issue this receipt only after it has validated the exact signed
   * external-path grant against the active run and operation. The receipt is
   * deliberately bound to the full mutation call, not a generic boolean.
   */
  externalMutationAuthority?: WorkspaceExternalMutationAuthorityReceipt
  /**
   * @deprecated Launch-time/coarse claims are intentionally unsupported.
   * Kept temporarily so older coordinator callers fail closed at derivation
   * instead of regaining workspace-wide exclusion through version skew.
   */
  coarseWorkspaceFallback?: boolean
}

interface WorkspaceExternalMutationAuthorityReceiptBase {
  provider: WorkspaceLockOwner['provider']
  runId: string
  targetPath: string
  operationFingerprint: string
}

export type WorkspaceExternalMutationAuthorityReceipt =
  | (WorkspaceExternalMutationAuthorityReceiptBase & {
      kind: 'validated-external-path-grant'
      grantId: string
      grantSignature: string
    })
  | (WorkspaceExternalMutationAuthorityReceiptBase & {
      kind: 'validated-trusted-session-external-write'
      trustContextId: string
    })

export function createWorkspaceExternalMutationAuthorityReceipt(input: {
  mutation: WorkspaceMutationCall
  provider: NonNullable<WorkspaceLockOwner['provider']>
  runId: string
  targetPath: string
  grantId: string
  grantSignature: string
}): WorkspaceExternalMutationAuthorityReceipt {
  return {
    kind: 'validated-external-path-grant',
    provider: input.provider,
    runId: input.runId,
    targetPath: resolve(input.targetPath),
    grantId: input.grantId,
    grantSignature: input.grantSignature,
    operationFingerprint: workspaceMutationFingerprint(input.mutation)
  }
}

export function createTrustedSessionExternalMutationAuthorityReceipt(input: {
  mutation: WorkspaceMutationCall
  provider: NonNullable<WorkspaceLockOwner['provider']>
  runId: string
  targetPath: string
  trustContextId: string
}): WorkspaceExternalMutationAuthorityReceipt {
  return {
    kind: 'validated-trusted-session-external-write',
    provider: input.provider,
    runId: input.runId,
    targetPath: resolve(input.targetPath),
    trustContextId: input.trustContextId,
    operationFingerprint: workspaceMutationFingerprint(input.mutation)
  }
}

export type WorkspaceLockRuntimeAcquireResult =
  | {
      ok: true
      owner: WorkspaceLockOwner
      claims: WorkspaceLockClaimRequest[]
      authority: WorkspaceLockAcquireResult & { ok: true }
    }
  | {
      ok: false
      code:
        | 'runtime_unavailable'
        | 'unmapped_action'
        | 'invalid_claim'
        | 'owner_identity_unavailable'
        | 'owner_not_live'
        | 'authority_busy'
        | 'conflict'
        | 'cancelled'
      message: string
      authority?: WorkspaceLockAcquireResult & { ok: false }
    }

export interface WorkspaceLockRuntimeSubscription {
  snapshot: WorkLockProjectionSnapshot
  unsubscribe: () => void
}

/**
 * Main-only recovery receipt. None of these process or acquisition identities
 * are projected to renderer code; a renderer names one public lock id and main
 * resolves the complete exact acquisition afresh at every recovery boundary.
 */
export interface WorkspaceLockRecoveryBlockedAcquisition {
  lockId: string
  ownerRunId: string
  acquiredTransitionId: string
  leaseIds: string[]
  owner: WorkspaceLockOwner
  workspacePath: string
  worktreePath: string
}

interface WorkspaceLockAuthorityLike {
  acquireMany(
    owner: WorkspaceLockOwner,
    requests: readonly WorkspaceLockClaimRequest[],
    options?: { transitionId?: string }
  ): Promise<WorkspaceLockAcquireResult>
  replaceAcquisition(
    owner: WorkspaceLockOwner,
    previousAcquiredTransitionId: string,
    requests: readonly WorkspaceLockClaimRequest[],
    options?: { transitionId?: string }
  ): Promise<WorkspaceLockAcquireResult>
  verifyAcquisitionForMutation(
    owner: WorkspaceLockOwner,
    acquiredTransitionId: string
  ): Promise<WorkspaceLockMutationVerificationResult>
  transferAcquisition(
    previousOwner: WorkspaceLockOwner,
    acquiredTransitionId: string,
    nextOwner: WorkspaceLockOwner,
    options?: { transitionId?: string }
  ): Promise<WorkspaceLockAcquireResult>
  releaseAllForRun(
    runId: string,
    options?: { transitionId?: string }
  ): Promise<WorkspaceLockReleaseResult>
  releaseAcquisition(
    ownerRunId: string,
    acquiredTransitionId: string,
    options?: { transitionId?: string }
  ): Promise<WorkspaceLockReleaseResult>
  forceReleaseRecoveryBlockedAcquisition(
    ownerRunId: string,
    acquiredTransitionId: string,
    leaseIds: readonly string[],
    approvalReceiptId: string,
    options?: { transitionId?: string }
  ): Promise<WorkspaceLockReleaseResult>
  quarantineChildOwnerAcquisitions(owner: WorkspaceLockOwner): Promise<WorkspaceLockRecoveryResult>
  snapshot(): WorkspaceLockSnapshot
  onChange(listener: WorkspaceLockAuthorityListener): () => void
  dispose(): void
}

interface WorkspaceMutationCommitFenceLike {
  acquire(owner: WorkspaceLockOwner, partitionKey?: string): Promise<WorkspaceMutationCommitFenceOwner>
  release(owner: WorkspaceMutationCommitFenceOwner): boolean
}

export interface WorkspaceMutationCommitFenceAcquisition {
  readonly owners: readonly WorkspaceMutationCommitFenceOwner[]
}

interface WorkspaceLockProcessIdentityLike {
  currentProcessIdentity(): string
  observe(pid: number): Promise<WorkspaceLockProcessObservation>
  dispose(): void
}

type ProjectionSubscriber = (update: {
  reason: Exclude<WorkLockProjectionChangeReason, 'initial'>
  snapshot: WorkLockProjectionSnapshot
}) => void

/**
 * Small composition adapter around the durable authority. It owns no lock
 * truth: snapshots, markers, recovery, and conflict policy all remain in core.
 */
export class WorkspaceLockRuntime {
  private readonly subscribers = new Set<ProjectionSubscriber>()
  private readonly stopAuthorityListener: () => void
  private lastSnapshot: WorkLockProjectionSnapshot
  private projectionPollTimer: ReturnType<typeof setInterval> | null = null
  private unhealthyReason: string | null = null
  private readonly pendingReconciliations = new Map<string, string>()

  constructor(
    private readonly authority: WorkspaceLockAuthorityLike,
    private readonly mutationFence: WorkspaceMutationCommitFenceLike,
    private readonly processIdentity: WorkspaceLockProcessIdentityLike,
    private readonly mainPid = process.pid
  ) {
    this.lastSnapshot = projectAuthoritySnapshot(authority.snapshot())
    this.stopAuthorityListener = authority.onChange((snapshot) => {
      const projected = projectAuthoritySnapshot(snapshot)
      const reason = inferProjectionChangeReason(this.lastSnapshot, projected)
      this.lastSnapshot = projected
      this.emit(reason, projected)
    })
  }

  static async open(options: WorkspaceLockRuntimeOpenOptions): Promise<WorkspaceLockRuntime> {
    const mainProcessBirthIdentity = await options.processIdentity.initialize()
    const observations = new Map<number, WorkspaceLockProcessObservation>()
    const persistence = new NodeWorkspaceLockPersistence({
      userDataRoot: options.userDataRoot,
      isFenceOwnerLive: (fence) => fenceOwnerIsLive(fence, observations)
    })
    const existingFence = persistence.readInstanceFence()
    if (existingFence) {
      observations.set(existingFence.pid, await options.processIdentity.observe(existingFence.pid))
    }

    const observeProcess = async (pid: number): Promise<WorkspaceLockProcessObservation> => {
      const observation = await options.processIdentity.observe(pid)
      observations.set(pid, observation)
      return observation
    }
    const validateHunkBaseline = (claim: CanonicalWorkspaceLockClaim): Promise<boolean> =>
      validateCurrentHunkBaseline(claim)
    const authority = await WorkspaceLockAuthority.open({
      persistence,
      dependencies: {
        nowIso: () => new Date().toISOString(),
        nextId: (kind) => `${kind}-${randomUUID()}`,
        observeProcess,
        canonicalizePath: canonicalWorkspaceIdentity,
        resolveTargetPath: (rootPath, targetPath) =>
          resolveCanonicalWorkspaceLockPath({ rootPath, targetPath }),
        verifyTargetPath: (expected) => verifyCanonicalWorkspaceLockPath(expected),
        validateHunkBaseline,
        instance: {
          instanceId: options.instanceId,
          pid: process.pid,
          processBirthIdentity: mainProcessBirthIdentity
        }
      }
    })
    const mutationFence = new WorkspaceMutationCommitFence({
      userDataRoot: options.userDataRoot,
      observeProcess
    })
    return new WorkspaceLockRuntime(authority, mutationFence, options.processIdentity, process.pid)
  }

  async acquire(
    input: WorkspaceLockRuntimeAcquireInput
  ): Promise<WorkspaceLockRuntimeAcquireResult> {
    const unavailable = this.unavailableResult()
    if (unavailable) return unavailable
    const derived = await this.deriveClaims(input)
    if (!derived.ok) return derived
    return this.acquireClaims(input.owner, derived.claims)
  }

  /**
   * Acquires already-derived claims through the same exact-owner authority
   * path. Callers use this when one transaction combines independently
   * derived claims (for example candidate promotion root + patch files).
   */
  async acquireClaims(
    ownerInput: WorkspaceLockRuntimeOwnerInput,
    claims: readonly WorkspaceLockClaimRequest[]
  ): Promise<WorkspaceLockRuntimeAcquireResult> {
    const unavailable = this.unavailableResult()
    if (unavailable) return unavailable
    const exactnessFailure = exactMutationClaimFailure(claims)
    if (exactnessFailure) return exactnessFailure
    const owner = await this.resolveOwner(ownerInput)
    if (!owner.ok) return owner
    if (!claims.length) {
      return {
        ok: true,
        owner: owner.owner,
        claims: [],
        authority: {
          ok: true,
          transitionId: '',
          tokens: [],
          leases: []
        }
      }
    }

    const transitionId = `runtime-acquire-${randomUUID()}`
    let acquired: WorkspaceLockAcquireResult
    try {
      acquired = await retryWorkspaceLockAcquire(() =>
        this.authority.acquireMany(owner.owner, [...claims], { transitionId })
      )
    } catch (error) {
      this.markUnhealthy(
        `Workspace-lock acquisition reconciliation failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return {
        ok: false,
        code: 'runtime_unavailable',
        message: error instanceof Error ? error.message : String(error)
      }
    }
    if (!acquired.ok) {
      if (acquired.reason === 'conflict') this.emit('contended', this.snapshot())
      return {
        ok: false,
        code: acquired.reason === 'invalid_request' ? 'invalid_claim' : acquired.reason,
        message: acquired.message,
        authority: acquired
      }
    }
    return { ok: true, owner: owner.owner, claims: [...claims], authority: acquired }
  }

  /**
   * Acquires a nested broker operation under an already-bound native child.
   * The provider coordinator must supply the exact durable child owner; this
   * method never re-resolves it to main's PID or weakens core owner equality.
   */
  async acquireMutationSubleaseForExactOwner(
    input: WorkspaceLockRuntimeAcquireInput,
    exactOwner: WorkspaceLockOwner
  ): Promise<WorkspaceLockRuntimeAcquireResult> {
    const unavailable = this.unavailableResult()
    if (unavailable) return unavailable
    if (
      exactOwner.lifecycle !== 'child' ||
      exactOwner.lockOwnerId !== input.owner.lockOwnerId ||
      exactOwner.runId !== input.owner.runId ||
      exactOwner.provider !== input.owner.provider ||
      exactOwner.chatId !== input.owner.chatId ||
      exactOwner.laneId !== input.owner.laneId ||
      exactOwner.participantId !== input.owner.participantId ||
      exactOwner.pid !== input.owner.executionPid
    ) {
      return {
        ok: false,
        code: 'owner_not_live',
        message: 'Nested workspace mutation does not match its exact provider child owner.'
      }
    }
    const derived = await this.deriveClaims(input)
    if (!derived.ok) return derived
    if (!derived.claims.length) {
      return {
        ok: true,
        owner: exactOwner,
        claims: [],
        authority: {
          ok: true,
          transitionId: '',
          tokens: [],
          leases: []
        }
      }
    }

    const transitionId = `runtime-sublease-${randomUUID()}`
    let acquired: WorkspaceLockAcquireResult
    try {
      acquired = await retryWorkspaceLockAcquire(() =>
        this.authority.acquireMany(exactOwner, [...derived.claims], { transitionId })
      )
    } catch (error) {
      this.markUnhealthy(
        `Workspace-lock child sublease reconciliation failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return {
        ok: false,
        code: 'runtime_unavailable',
        message: error instanceof Error ? error.message : String(error)
      }
    }
    if (!acquired.ok) {
      if (acquired.reason === 'conflict') this.emit('contended', this.snapshot())
      return {
        ok: false,
        code: acquired.reason === 'invalid_request' ? 'invalid_claim' : acquired.reason,
        message: acquired.message,
        authority: acquired
      }
    }
    return {
      ok: true,
      owner: exactOwner,
      claims: derived.claims,
      authority: acquired
    }
  }

  async replaceAcquisitionForMutation(
    input: WorkspaceLockRuntimeAcquireInput,
    owner: WorkspaceLockOwner,
    previousAcquiredTransitionId: string,
    stillWanted: () => boolean = () => true
  ): Promise<WorkspaceLockRuntimeAcquireResult> {
    const unavailable = this.unavailableResult()
    if (unavailable) return unavailable
    const derived = await this.deriveClaims(input)
    if (!derived.ok) return derived
    return this.replaceClaims(owner, previousAcquiredTransitionId, derived.claims, stillWanted)
  }

  async replaceClaims(
    owner: WorkspaceLockOwner,
    previousAcquiredTransitionId: string,
    claims: readonly WorkspaceLockClaimRequest[],
    stillWanted: () => boolean = () => true
  ): Promise<WorkspaceLockRuntimeAcquireResult> {
    const unavailable = this.unavailableResult()
    if (unavailable) return unavailable
    const exactnessFailure = exactMutationClaimFailure(claims)
    if (exactnessFailure) return exactnessFailure
    if (!claims.length) {
      return {
        ok: true,
        owner,
        claims: [],
        authority: {
          ok: true,
          transitionId: previousAcquiredTransitionId,
          tokens: [],
          leases: []
        }
      }
    }
    const transitionId = `runtime-replace-${randomUUID()}`
    for (;;) {
      let replaced: WorkspaceLockAcquireResult
      try {
        replaced = await retryWorkspaceLockAcquire(() =>
          this.authority.replaceAcquisition(owner, previousAcquiredTransitionId, [...claims], {
            transitionId
          })
        )
      } catch (error) {
        this.markUnhealthy(
          `Workspace-lock replacement reconciliation failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return {
          ok: false,
          code: 'runtime_unavailable',
          message: error instanceof Error ? error.message : String(error)
        }
      }
      if (replaced.ok) return { ok: true, owner, claims: [...claims], authority: replaced }
      if (replaced.reason !== 'conflict' && replaced.reason !== 'authority_busy') {
        return {
          ok: false,
          code: replaced.reason === 'invalid_request' ? 'invalid_claim' : replaced.reason,
          message: replaced.message,
          authority: replaced
        }
      }
      if (!stillWanted()) return cancelledWorkspaceMutationReplacement()
      try {
        await this.waitForMutationAvailability(stillWanted)
      } catch (error) {
        if (!stillWanted()) return cancelledWorkspaceMutationReplacement()
        throw error
      }
    }
  }

  async transferAcquisition(
    previousOwner: WorkspaceLockOwner,
    acquiredTransitionId: string,
    nextOwnerInput: WorkspaceLockRuntimeOwnerInput
  ): Promise<WorkspaceLockRuntimeAcquireResult> {
    const unavailable = this.unavailableResult()
    if (unavailable) return unavailable
    const nextOwner = await this.resolveOwner(nextOwnerInput)
    if (!nextOwner.ok) return nextOwner
    const transitionId = `runtime-transfer-${randomUUID()}`
    let transferred: WorkspaceLockAcquireResult
    try {
      transferred = await retryWorkspaceLockAcquire(() =>
        this.authority.transferAcquisition(
          previousOwner,
          acquiredTransitionId,
          nextOwner.owner,
          { transitionId }
        )
      )
    } catch (error) {
      this.markUnhealthy(
        `Workspace-lock transfer reconciliation failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return {
        ok: false,
        code: 'runtime_unavailable',
        message: error instanceof Error ? error.message : String(error)
      }
    }
    if (!transferred.ok) {
      return {
        ok: false,
        code: transferred.reason === 'invalid_request' ? 'invalid_claim' : transferred.reason,
        message: transferred.message,
        authority: transferred
      }
    }
    const transferredOwner = transferred.leases[0]?.owner
    if (
      !transferredOwner ||
      transferredOwner.lifecycle !== 'child' ||
      transferred.leases.some(
        (lease) =>
          lease.owner.lockOwnerId !== transferredOwner.lockOwnerId ||
          lease.owner.runId !== transferredOwner.runId ||
          lease.owner.pid !== transferredOwner.pid ||
          lease.owner.processBirthIdentity !== transferredOwner.processBirthIdentity ||
          lease.owner.lifecycle !== 'child'
      )
    ) {
      const message = 'Workspace-lock transfer returned no coherent exact child owner.'
      this.markUnhealthy(message)
      return {
        ok: false,
        code: 'runtime_unavailable',
        message
      }
    }
    return {
      ok: true,
      owner: transferredOwner,
      claims: transferred.leases.map((lease) => ({
        workspacePath: lease.claim.displayWorkspacePath,
        worktreePath: lease.claim.displayWorktreePath,
        ...(lease.claim.worktreeName ? { worktreeName: lease.claim.worktreeName } : {}),
        ...(lease.claim.branch ? { branch: lease.claim.branch } : {}),
        kind: lease.claim.kind,
        mode: lease.claim.mode,
        ...(lease.claim.relativeTargetPath ? { targetPath: lease.claim.targetCanonicalPath } : {}),
        ...(lease.claim.hunk ? { hunk: lease.claim.hunk } : {}),
        ...(lease.claim.globalFilesystem ? { globalFilesystem: true } : {})
      })),
      authority: transferred
    }
  }

  verifyAcquisitionForMutation(
    owner: WorkspaceLockOwner,
    acquiredTransitionId: string
  ): Promise<WorkspaceLockMutationVerificationResult> {
    this.assertHealthy()
    return this.authority.verifyAcquisitionForMutation(owner, acquiredTransitionId)
  }

  async revalidateExternalMutationTarget(
    input: WorkspaceLockRuntimeAcquireInput
  ): Promise<string> {
    return (await this.revalidateExternalMutationAuthority(input)).targetPath
  }

  async revalidateExternalMutationAuthority(
    input: WorkspaceLockRuntimeAcquireInput
  ): Promise<{ rootPath: string; targetPath: string }> {
    this.assertHealthy()
    const match = await exactExternalMutationAuthorityMatch(input)
    if (!match) {
      throw new Error('External mutation authority no longer matches its exact target.')
    }
    return {
      rootPath: await canonicalExistingDirectoryForTarget(match.targetPath),
      targetPath: match.targetPath
    }
  }

  async acquireMutationFence(
    owner: WorkspaceLockOwner,
    claims: readonly CanonicalWorkspaceLockClaim[] = [],
    stillWanted: () => boolean = () => true
  ): Promise<WorkspaceMutationCommitFenceAcquisition> {
    this.assertHealthy()
    const partitionKeys = mutationFencePartitionKeys(claims)
    if (!partitionKeys.length) {
      throw new Error('Workspace mutation commit fence requires at least one exact claim.')
    }
    const owners: WorkspaceMutationCommitFenceOwner[] = []
    try {
      for (const partitionKey of partitionKeys) {
        for (;;) {
          if (!stillWanted()) {
            throw new Error('Workspace mutation was cancelled while waiting for its exact target.')
          }
          try {
            owners.push(await this.mutationFence.acquire(owner, partitionKey))
            break
          } catch (error) {
            if (!(error instanceof WorkspaceMutationCommitFenceBusyError)) throw error
            await this.waitForMutationAvailability(stillWanted)
          }
        }
      }
      return Object.freeze({ owners: Object.freeze([...owners]) })
    } catch (error) {
      const releaseErrors: unknown[] = []
      for (const acquired of [...owners].reverse()) {
        try {
          if (!this.mutationFence.release(acquired)) {
            releaseErrors.push(
              new Error(`Workspace mutation partition ${acquired.partitionKey} was not released.`)
            )
          }
        } catch (releaseError) {
          releaseErrors.push(releaseError)
        }
      }
      if (releaseErrors.length) {
        const message =
          'Workspace mutation fence acquisition failed and partial partition cleanup failed.'
        this.markUnhealthy(message)
        throw new AggregateError([error, ...releaseErrors], message)
      }
      throw error
    }
  }

  releaseMutationFence(fence: WorkspaceMutationCommitFenceAcquisition): void {
    const errors: unknown[] = []
    for (const owner of [...fence.owners].reverse()) {
      try {
        if (!this.mutationFence.release(owner)) {
          errors.push(
            new Error(`Workspace mutation partition ${owner.partitionKey} was not owned.`)
          )
        }
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) {
      const message = 'Workspace mutation commit fence was not owned in full by this operation.'
      this.markUnhealthy(message)
      throw new AggregateError(errors, message)
    }
  }

  private waitForMutationAvailability(stillWanted: () => boolean): Promise<void> {
    return new Promise((resolveWait, rejectWait) => {
      let settled = false
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        clearInterval(cancelPoll)
        this.subscribers.delete(onUpdate)
        if (error) rejectWait(error)
        else resolveWait()
      }
      const onUpdate: ProjectionSubscriber = () => finish()
      this.subscribers.add(onUpdate)
      const cancelPoll = setInterval(() => {
        if (!stillWanted()) {
          finish(new Error('Workspace mutation was cancelled while waiting for its exact target.'))
        } else {
          // Cross-process fence release precedes the matching durable lease
          // release by only the executor cleanup boundary. This bounded
          // recheck also closes a release-before-subscribe race.
          finish()
        }
      }, 250)
      cancelPoll.unref?.()
      if (!stillWanted()) {
        finish(new Error('Workspace mutation was cancelled while waiting for its exact target.'))
      }
    })
  }

  async releaseRun(runId: string): Promise<WorkspaceLockReleaseResult> {
    const transitionId = `runtime-release-run-${randomUUID()}`
    try {
      const released = await retryWorkspaceLockRelease(
        () => this.authority.releaseAllForRun(runId, { transitionId }),
        (reason) => this.markReleaseReconciliation(transitionId, reason)
      )
      this.pendingReconciliations.delete(transitionId)
      if (!released.ok)
        this.markUnhealthy(`Terminal workspace-lock release failed: ${released.message}`)
      return released
    } catch (error) {
      this.pendingReconciliations.delete(transitionId)
      this.markUnhealthy(
        `Terminal workspace-lock release failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      throw error
    }
  }

  async releaseAcquisition(
    runId: string,
    acquiredTransitionId: string
  ): Promise<WorkspaceLockReleaseResult> {
    const transitionId = `runtime-release-acquisition-${randomUUID()}`
    try {
      const released = await retryWorkspaceLockRelease(
        () =>
          this.authority.releaseAcquisition(runId, acquiredTransitionId, { transitionId }),
        (reason) => this.markReleaseReconciliation(transitionId, reason)
      )
      this.pendingReconciliations.delete(transitionId)
      if (!released.ok) {
        this.markUnhealthy(`Exact workspace-lock release failed: ${released.message}`)
      }
      return released
    } catch (error) {
      this.pendingReconciliations.delete(transitionId)
      this.markUnhealthy(
        `Exact workspace-lock release failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      throw error
    }
  }

  async quarantineChildOwnerAcquisitions(owner: WorkspaceLockOwner): Promise<void> {
    this.assertHealthy()
    const reconciliationId = `runtime-quarantine-child-${owner.runId}:${owner.lockOwnerId}:${owner.pid}`
    try {
      await retryWorkspaceLockRecovery(
        () => this.authority.quarantineChildOwnerAcquisitions(owner),
        (reason) => this.pendingReconciliations.set(reconciliationId, reason)
      )
      this.pendingReconciliations.delete(reconciliationId)
    } catch (error) {
      this.pendingReconciliations.delete(reconciliationId)
      const message = `Child workspace-lock quarantine reconciliation failed: ${
        error instanceof Error ? error.message : String(error)
      }`
      this.markUnhealthy(message)
      throw error
    }
  }

  recoveryBlockedAcquisition(
    lockId: string
  ): WorkspaceLockRecoveryBlockedAcquisition | null {
    const requestedLockId = lockId.trim()
    if (!requestedLockId) return null
    const snapshot = this.authority.snapshot()
    const selected = snapshot.leases.find(
      (lease) => lease.leaseId === requestedLockId && lease.status === 'recovery_blocked'
    )
    if (
      !selected ||
      (selected.owner.lifecycle !== 'launching-child' &&
        selected.owner.lifecycle !== 'child')
    ) {
      return null
    }
    const acquisition = snapshot.leases
      .filter(
        (lease) =>
          lease.owner.runId === selected.owner.runId &&
          lease.acquiredTransitionId === selected.acquiredTransitionId
      )
      .sort((left, right) => left.leaseId.localeCompare(right.leaseId))
    if (
      !acquisition.length ||
      acquisition.some(
        (lease) =>
          lease.status !== 'recovery_blocked' ||
          lease.owner.lifecycle !== selected.owner.lifecycle ||
          lease.owner.lockOwnerId !== selected.owner.lockOwnerId ||
          lease.owner.pid !== selected.owner.pid ||
          lease.owner.processBirthIdentity !== selected.owner.processBirthIdentity
      )
    ) {
      return null
    }
    return {
      lockId: requestedLockId,
      ownerRunId: selected.owner.runId,
      acquiredTransitionId: selected.acquiredTransitionId,
      leaseIds: acquisition.map((lease) => lease.leaseId),
      owner: { ...selected.owner },
      workspacePath: selected.claim.displayWorkspacePath,
      worktreePath: selected.claim.displayWorktreePath
    }
  }

  async observeRecoveryBlockedAcquisitionOwner(
    candidate: WorkspaceLockRecoveryBlockedAcquisition
  ): Promise<WorkspaceLockProcessObservation> {
    if (!this.recoveryCandidateIsCurrent(candidate)) {
      return { state: 'identity_unavailable' }
    }
    return this.processIdentity.observe(candidate.owner.pid)
  }

  async forceReleaseRecoveryBlockedAcquisition(
    candidate: WorkspaceLockRecoveryBlockedAcquisition,
    approvalReceiptId: string
  ): Promise<WorkspaceLockReleaseResult> {
    if (!approvalReceiptId.trim() || !this.recoveryCandidateIsCurrent(candidate)) {
      return {
        ok: false,
        reason: 'stale_token',
        message: 'The exact recovery-blocked acquisition changed before release.'
      }
    }
    const transitionId = `runtime-force-release-recovery-${randomUUID()}`
    try {
      const released = await retryWorkspaceLockRelease(
        () =>
          this.authority.forceReleaseRecoveryBlockedAcquisition(
            candidate.ownerRunId,
            candidate.acquiredTransitionId,
            candidate.leaseIds,
            approvalReceiptId,
            { transitionId }
          ),
        (reason) => this.markReleaseReconciliation(transitionId, reason)
      )
      this.pendingReconciliations.delete(transitionId)
      return released
    } catch (error) {
      this.pendingReconciliations.delete(transitionId)
      this.markUnhealthy(
        `Recovery workspace-lock release reconciliation failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      throw error
    }
  }

  activeLeaseCountForRun(runId: string): number {
    const requestedRunId = runId.trim()
    if (!requestedRunId) return 0
    return this.authority
      .snapshot()
      .leases.filter(
        (lease) => lease.owner.runId === requestedRunId && lease.status !== 'recovered'
      ).length
  }

  markUnhealthy(reason: string): void {
    if (!this.unhealthyReason) this.unhealthyReason = reason
  }

  getUnhealthyReason(): string | null {
    return this.unhealthyReason ?? this.pendingReconciliations.values().next().value ?? null
  }

  snapshot(): WorkLockProjectionSnapshot {
    return projectAuthoritySnapshot(this.authority.snapshot())
  }

  list(_query: WorkLockProjectionQuery = {}): WorkLockProjectionSnapshot {
    return this.snapshot()
  }

  subscribe(
    _query: WorkLockProjectionQuery,
    onUpdate: ProjectionSubscriber
  ): WorkspaceLockRuntimeSubscription {
    const snapshot = this.snapshot()
    if (!projectionSnapshotsEqual(this.lastSnapshot, snapshot)) {
      const reason = inferProjectionChangeReason(this.lastSnapshot, snapshot)
      this.lastSnapshot = snapshot
      this.emit(reason, snapshot)
    }
    this.subscribers.add(onUpdate)
    this.ensureProjectionPoll()
    let subscribed = true
    return {
      snapshot,
      unsubscribe: () => {
        if (!subscribed) return
        subscribed = false
        this.subscribers.delete(onUpdate)
        if (!this.subscribers.size) this.stopProjectionPoll()
      }
    }
  }

  dispose(): void {
    this.stopProjectionPoll()
    this.stopAuthorityListener()
    this.subscribers.clear()
    this.pendingReconciliations.clear()
    this.authority.dispose()
    this.processIdentity.dispose()
  }

  private recoveryCandidateIsCurrent(
    candidate: WorkspaceLockRecoveryBlockedAcquisition
  ): boolean {
    const current = this.recoveryBlockedAcquisition(candidate.lockId)
    return Boolean(
      current &&
        current.ownerRunId === candidate.ownerRunId &&
        current.acquiredTransitionId === candidate.acquiredTransitionId &&
        current.owner.lockOwnerId === candidate.owner.lockOwnerId &&
        current.owner.lifecycle === candidate.owner.lifecycle &&
        current.owner.pid === candidate.owner.pid &&
        current.owner.processBirthIdentity === candidate.owner.processBirthIdentity &&
        current.leaseIds.length === candidate.leaseIds.length &&
        current.leaseIds.every((leaseId, index) => leaseId === candidate.leaseIds[index])
    )
  }

  private async resolveOwner(
    input: WorkspaceLockRuntimeOwnerInput
  ): Promise<
    | { ok: true; owner: WorkspaceLockOwner }
    | Extract<WorkspaceLockRuntimeAcquireResult, { ok: false }>
  > {
    const pid = input.executionPid ?? this.mainPid
    const observation = await this.processIdentity.observe(pid)
    if (observation.state !== 'live') {
      return {
        ok: false,
        code: observation.state === 'dead' ? 'owner_not_live' : 'owner_identity_unavailable',
        message:
          observation.state === 'dead'
            ? `Workspace mutation owner PID ${pid} is no longer live.`
            : `Exact process-birth identity is unavailable for workspace mutation owner PID ${pid}.`
      }
    }
    return {
      ok: true,
      owner: normalizeWorkspaceLockOwnerPresentation({
        lockOwnerId: input.lockOwnerId,
        runId: input.runId,
        ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
        ...(input.laneId ? { laneId: input.laneId } : {}),
        ...(input.chatId ? { chatId: input.chatId } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.participantId ? { participantId: input.participantId } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.chatTitle ? { chatTitle: input.chatTitle } : {}),
        pid,
        processBirthIdentity: observation.processBirthIdentity
      })
    }
  }

  private unavailableResult(): Extract<WorkspaceLockRuntimeAcquireResult, { ok: false }> | null {
    const unavailableReason = this.getUnhealthyReason()
    return unavailableReason
      ? {
          ok: false,
          code: 'runtime_unavailable',
          message: `Workspace-lock runtime is fail-closed: ${unavailableReason}`
        }
      : null
  }

  private markReleaseReconciliation(transitionId: string, reason: string): void {
    if (this.pendingReconciliations.has(transitionId)) return
    const message = `Workspace-lock release is reconciling durable state: ${reason}`
    this.pendingReconciliations.set(transitionId, message)
    console.warn(`[workspace-lock] ${message}`)
  }

  private assertHealthy(): void {
    const unavailable = this.unavailableResult()
    if (unavailable) throw new Error(unavailable.message)
  }

  private async deriveClaims(
    input: WorkspaceLockRuntimeAcquireInput
  ): Promise<
    | { ok: true; claims: WorkspaceLockClaimRequest[] }
    | Extract<WorkspaceLockRuntimeAcquireResult, { ok: false }>
  > {
    try {
      return { ok: true, claims: await deriveWorkspaceMutationClaims(input.mutation) }
    } catch (error) {
      if (error instanceof WorkspaceMutationClaimDerivationError && error.code === 'path-escape') {
        const match = await exactExternalMutationAuthorityMatch(input)
        if (match) {
          const rootPath = await canonicalExistingDirectoryForTarget(match.targetPath)
          const targetPaths =
            input.mutation.action === 'write_file'
              ? exactTargetPathPrefixes(rootPath, match.targetPath)
              : [match.targetPath]
          return {
            ok: true,
            claims: targetPaths.map((targetPath) => ({
              workspacePath: rootPath,
              worktreePath: rootPath,
              kind: 'file',
              mode: 'write',
              targetPath
            }))
          }
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        code:
          error instanceof WorkspaceMutationClaimDerivationError && error.code === 'unmapped-action'
            ? 'unmapped_action'
            : 'invalid_claim',
        message
      }
    }
  }

  private emit(
    reason: Exclude<WorkLockProjectionChangeReason, 'initial'>,
    snapshot: WorkLockProjectionSnapshot
  ): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber({ reason, snapshot })
      } catch {
        // Subscribers are projections, never participants in lock commits.
      }
    }
  }

  private ensureProjectionPoll(): void {
    if (this.projectionPollTimer) return
    this.projectionPollTimer = setInterval(() => {
      try {
        const current = this.snapshot()
        if (projectionSnapshotsEqual(this.lastSnapshot, current)) return
        const reason = inferProjectionChangeReason(this.lastSnapshot, current)
        this.lastSnapshot = current
        this.emit(reason, current)
      } catch {
        // A transient metadata/read error must not tear down every renderer
        // subscription. The one shared poll retries on the next tick.
      }
    }, 1_000)
    this.projectionPollTimer.unref?.()
  }

  private stopProjectionPoll(): void {
    if (!this.projectionPollTimer) return
    clearInterval(this.projectionPollTimer)
    this.projectionPollTimer = null
  }
}

async function retryWorkspaceLockAcquire(
  acquire: () => Promise<WorkspaceLockAcquireResult>
): Promise<WorkspaceLockAcquireResult> {
  const retryDelaysMs = [15, 40, 100]
  let lastError: unknown
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const result = await acquire()
      if (result.ok || result.reason !== 'authority_busy' || attempt === retryDelaysMs.length) {
        return result
      }
    } catch (error) {
      lastError = error
      if (attempt === retryDelaysMs.length) throw error
    }
    await new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, retryDelaysMs[attempt])
    )
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Workspace-lock acquisition reconciliation did not complete.')
}

async function retryWorkspaceLockRelease(
  release: () => Promise<WorkspaceLockReleaseResult>,
  onRetry: (reason: string) => void
): Promise<WorkspaceLockReleaseResult> {
  const busyRetryDelaysMs = [15, 40, 100]
  const errorRetryDelaysMs = [15, 40, 100, 250, 750, 2_000]
  let busyAttempt = 0
  let errorAttempt = 0
  while (true) {
    try {
      const result = await release()
      if (result.ok || result.reason !== 'authority_busy') return result
      if (busyAttempt >= busyRetryDelaysMs.length) {
        return result
      }
      onRetry(result.message)
      const delayMs = busyRetryDelaysMs[busyAttempt]
      busyAttempt += 1
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs))
    } catch (error) {
      if (errorAttempt >= errorRetryDelaysMs.length) throw error
      onRetry(error instanceof Error ? error.message : String(error))
      const delayMs = errorRetryDelaysMs[errorAttempt]
      errorAttempt += 1
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs))
    }
  }
}

async function retryWorkspaceLockRecovery(
  recover: () => Promise<WorkspaceLockRecoveryResult>,
  onRetry: (reason: string) => void
): Promise<WorkspaceLockRecoveryResult> {
  const retryDelaysMs = [15, 40, 100, 250, 750, 2_000]
  let lastError: unknown
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await recover()
    } catch (error) {
      lastError = error
      if (attempt === retryDelaysMs.length) throw error
      onRetry(error instanceof Error ? error.message : String(error))
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, retryDelaysMs[attempt]))
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Workspace-lock recovery reconciliation did not complete.')
}

function projectionSnapshotsEqual(
  left: WorkLockProjectionSnapshot,
  right: WorkLockProjectionSnapshot
): boolean {
  return (
    left.generation === right.generation &&
    JSON.stringify(left.locks) === JSON.stringify(right.locks)
  )
}

async function exactExternalMutationAuthorityMatch(
  input: WorkspaceLockRuntimeAcquireInput
): Promise<{ targetPath: string } | null> {
  const receipt = input.externalMutationAuthority
  if (!receipt) return null
  const provider = input.mutation.provider || input.owner.provider
  if (
    receipt.runId !== input.owner.runId ||
    receipt.provider !== provider ||
    receipt.operationFingerprint !== workspaceMutationFingerprint(input.mutation)
  ) {
    return null
  }
  if (
    receipt.kind === 'validated-external-path-grant'
      ? !receipt.grantId.trim() || !/^[0-9a-f]{64}$/i.test(receipt.grantSignature)
      : !receipt.trustContextId.trim()
  ) {
    return null
  }
  if (
    input.mutation.source === 'provider-native' ||
    (input.mutation.action !== 'write_file' && input.mutation.action !== 'replace')
  ) {
    return null
  }
  const args = input.mutation.args || {}
  const rawTargetValue =
    typeof args.path === 'string' && args.path.trim()
      ? args.path
      : typeof args.file_path === 'string' && args.file_path.trim()
        ? args.file_path
        : null
  if (rawTargetValue === null) return null
  const rawTarget = rawTargetValue
  const lexicalRoot = resolve(input.mutation.worktreePath || input.mutation.workspacePath)
  const lexicalTarget = isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(lexicalRoot, rawTarget)
  const [rootPath, targetPath] = await Promise.all([
    canonicalizePathThroughExistingAncestor(lexicalRoot),
    canonicalizePathThroughExistingAncestor(lexicalTarget)
  ])
  // The receipt target is already the signed canonical authority. Re-resolving
  // it here would let a later symlink/directory replacement retarget the grant.
  const receiptTargetPath = resolve(receipt.targetPath)
  if (targetPath !== receiptTargetPath) return null
  const relativePath = relative(rootPath, targetPath)
  return isAbsolute(targetPath) &&
    (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
    ? { targetPath }
    : null
}

async function canonicalizePathThroughExistingAncestor(inputPath: string): Promise<string> {
  let cursor = resolve(inputPath)
  const missingSegments: string[] = []
  while (true) {
    try {
      const real = await fs.realpath(cursor)
      return resolve(real, ...missingSegments)
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code || '')
          : ''
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = resolve(cursor, '..')
      if (parent === cursor) throw new Error(`Unable to canonicalize path ${inputPath}.`)
      missingSegments.unshift(basename(cursor))
      cursor = parent
    }
  }
}

async function canonicalExistingDirectoryForTarget(targetPath: string): Promise<string> {
  let cursor = dirname(resolve(targetPath))
  while (true) {
    try {
      const stat = await fs.lstat(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('External mutation ancestor is not a stable directory.')
      }
      return await fs.realpath(cursor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      cursor = parent
    }
  }
}

function exactTargetPathPrefixes(rootPath: string, targetPath: string): string[] {
  const relativePath = relative(rootPath, targetPath)
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error('External mutation target is not beneath its stable directory root.')
  }
  const segments = relativePath.split(sep).filter(Boolean)
  return segments.map((_segment, index) => resolve(rootPath, ...segments.slice(0, index + 1)))
}

function workspaceMutationFingerprint(mutation: WorkspaceMutationCall): string {
  return createHash('sha256')
    .update(
      stableJson({
        workspacePath: resolve(mutation.workspacePath),
        worktreePath: resolve(mutation.worktreePath || mutation.workspacePath),
        source: mutation.source || 'taskwraith-catalog',
        provider: mutation.provider || null,
        action: mutation.action,
        args: mutation.args || {},
        executionMode: mutation.executionMode || 'execute'
      })
    )
    .digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

async function validateCurrentHunkBaseline(
  claim: Pick<CanonicalWorkspaceLockClaim, 'kind' | 'targetCanonicalPath' | 'hunk'>
): Promise<boolean> {
  if (claim.kind !== 'hunk') return true
  if (!claim.targetCanonicalPath || !claim.hunk?.baseline) return false
  try {
    const buffer = await fs.readFile(claim.targetCanonicalPath)
    return createHash('sha256').update(buffer).digest('hex') === claim.hunk.baseline
  } catch {
    return false
  }
}

function canonicalWorkspaceIdentity(inputPath: string): string {
  return resolveCanonicalWorkspaceLockPath({
    rootPath: resolve(inputPath),
    targetPath: resolve(inputPath)
  }).comparisonPath
}

/**
 * A commit fence protects the shortest mutation boundary that can still race.
 * File and hunk claims for the same physical target deliberately share one
 * partition, so disjoint hunk leases re-read and commit serially without
 * blocking unrelated files. Broad claims are rejected again at this boundary
 * so a stale or version-skewed caller cannot revive a workspace-wide fence.
 */
export function mutationFencePartitionKeys(
  claims: readonly CanonicalWorkspaceLockClaim[]
): readonly string[] {
  const keys = new Set<string>()
  for (const claim of claims) {
    if (claim.kind !== 'file' && claim.kind !== 'hunk') {
      throw new Error(
        `Workspace mutation fences accept only exact file/hunk claims; ${claim.kind} scope is not permitted.`
      )
    }
    const domain = claim.worktreeObjectIdentity || claim.worktreeIdentity
    const target = claim.objectIdentity || claim.comparisonTargetPath
    const scope = `file\0${domain}\0${target}`
    keys.add(`mutation-target:${createHash('sha256').update(scope, 'utf8').digest('hex')}`)
  }
  return Object.freeze([...keys].sort())
}

function exactMutationClaimFailure(
  claims: readonly WorkspaceLockClaimRequest[]
): Extract<WorkspaceLockRuntimeAcquireResult, { ok: false }> | null {
  const broadClaim = claims.find((claim) => claim.kind !== 'file' && claim.kind !== 'hunk')
  return broadClaim
    ? {
        ok: false,
        code: 'invalid_claim',
        message: `Workspace mutation transactions accept only exact file/hunk claims; ${broadClaim.kind} scope is not permitted.`
      }
    : null
}

function cancelledWorkspaceMutationReplacement(): Extract<
  WorkspaceLockRuntimeAcquireResult,
  { ok: false }
> {
  return {
    ok: false,
    code: 'cancelled',
    message: 'Workspace mutation was cancelled while waiting to refresh its exact edit scope.'
  }
}

function fenceOwnerIsLive(
  fence: WorkspaceLockAuthorityFence,
  observations: ReadonlyMap<number, WorkspaceLockProcessObservation>
): boolean {
  const observation = observations.get(fence.pid)
  if (!observation || observation.state === 'identity_unavailable') return true
  return (
    observation.state === 'live' && observation.processBirthIdentity === fence.processBirthIdentity
  )
}

const RECOVERED_PROJECTION_WINDOW_MS = 15 * 60 * 1_000
const RECOVERED_PROJECTION_LIMIT = 20

function projectAuthoritySnapshot(
  snapshot: WorkspaceLockSnapshot,
  sampledAtMs = Date.now()
): WorkLockProjectionSnapshot {
  const recoveredCutoff = sampledAtMs - RECOVERED_PROJECTION_WINDOW_MS
  const active = snapshot.leases.filter((lease) => lease.status !== 'recovered')
  const recovered = snapshot.leases
    .filter(
      (lease) =>
        lease.status === 'recovered' &&
        Number.isFinite(Date.parse(lease.statusChangedAt)) &&
        Date.parse(lease.statusChangedAt) >= recoveredCutoff
    )
    .sort((left, right) => Date.parse(right.statusChangedAt) - Date.parse(left.statusChangedAt))
    .slice(0, RECOVERED_PROJECTION_LIMIT)
  return createWorkLockProjectionSnapshot({
    generation: snapshot.sequence,
    sampledAt: new Date(sampledAtMs).toISOString(),
    locks: [...active, ...recovered].map(projectLease)
  })
}

function projectLease(lease: WorkspaceLockLease) {
  const relativePath = lease.claim.relativeTargetPath || '.'
  const target =
    lease.claim.kind === 'workspace'
      ? ({ kind: 'workspace' } as const)
      : lease.claim.kind === 'hunk'
        ? ({
            kind: 'hunk',
            path: relativePath,
            startLine: lease.claim.hunk?.startLine ?? 0,
            endLine: lease.claim.hunk?.endLine ?? 0,
            baseline: lease.claim.hunk?.baseline,
            coordinateSystem: 'zero-based-half-open'
          } as const)
        : ({
            kind: lease.claim.kind,
            path: relativePath
          } as const)
  return {
    lockId: lease.leaseId,
    status: lease.status,
    owner: {
      displayName:
        lease.owner.displayName || lease.owner.provider || lease.owner.laneId || lease.owner.runId,
      ...(lease.owner.provider ? { provider: lease.owner.provider } : {}),
      ...(lease.owner.chatId ? { chatId: lease.owner.chatId } : {}),
      ...(lease.owner.chatTitle ? { chatTitle: lease.owner.chatTitle } : {}),
      ...(lease.owner.laneId ? { laneId: lease.owner.laneId } : {}),
      runId: lease.owner.runId,
      ...(lease.owner.participantId ? { participantId: lease.owner.participantId } : {})
    },
    workspace: {
      basePath: lease.claim.displayWorkspacePath,
      effectivePath: lease.claim.displayWorktreePath,
      isWorktree: lease.claim.displayWorkspacePath !== lease.claim.displayWorktreePath,
      ...(lease.claim.worktreeName ? { worktreeName: lease.claim.worktreeName } : {}),
      ...(lease.claim.branch ? { branch: lease.claim.branch } : {})
    },
    target,
    acquiredAt: lease.acquiredAt,
    statusChangedAt: lease.statusChangedAt,
    ...(lease.status === 'recovered' ? { recoveredAt: lease.statusChangedAt } : {})
  }
}

function inferProjectionChangeReason(
  previous: WorkLockProjectionSnapshot,
  next: WorkLockProjectionSnapshot
): Exclude<WorkLockProjectionChangeReason, 'initial'> {
  const before = new Map(previous.locks.map((lock) => [lock.lockId, lock]))
  const after = new Map(next.locks.map((lock) => [lock.lockId, lock]))
  if ([...after.keys()].some((id) => !before.has(id))) return 'acquired'
  if ([...before.keys()].some((id) => !after.has(id))) return 'released'
  if (
    next.locks.some(
      (lock) =>
        lock.status === 'recovery_blocked' && before.get(lock.lockId)?.status !== lock.status
    )
  ) {
    return 'recovery-blocked'
  }
  if (
    next.locks.some(
      (lock) => lock.status === 'orphan_live' && before.get(lock.lockId)?.status !== lock.status
    )
  ) {
    return 'orphan-detected'
  }
  if (
    next.locks.some(
      (lock) => lock.status === 'recovered' && before.get(lock.lockId)?.status !== lock.status
    )
  ) {
    return 'recovered'
  }
  return 'replayed'
}
