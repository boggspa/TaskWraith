import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'

import type {
  WorkspaceLockRuntimeAcquireResult,
  WorkspaceLockRuntimeOwnerInput
} from '../WorkspaceLockRuntime'
import { deriveWorkspaceMutationClaims } from '../WorkspaceMutationClaims'
import type { WorkspaceMutationCommitFenceOwner } from '../workLocks/WorkspaceMutationCommitFence'
import type {
  WorkspaceLockClaimRequest,
  WorkspaceLockMutationVerificationResult,
  WorkspaceLockOwner,
  WorkspaceLockReleaseResult
} from '../workLocks/WorkspaceLockTypes'

export interface FanoutCandidatePromotionLockInput {
  chatId: string
  candidateId: string
  baseWorkspacePath: string
  patch: string
}

export interface VerifiedFanoutCandidatePromotion {
  /** Fresh, exact root capability returned by the lock authority. */
  baseWorkspacePath: string
  /** Fresh, exact patch targets. The immutable patch may touch no other path. */
  targetPaths: readonly string[]
}

export interface FanoutCandidatePromotionLock {
  withPromotionLock<T>(
    input: FanoutCandidatePromotionLockInput,
    operation: (verified: VerifiedFanoutCandidatePromotion) => T | Promise<T>
  ): Promise<FanoutCandidatePromotionLockResult<T>>
}

export interface FanoutCandidatePromotionLockResult<T> {
  value: T
  /**
   * The mutation committed, but an exact fence/lease cleanup needs retry.
   * Callers must preserve the committed outcome and surface this degradation.
   */
  cleanupError?: string
}

/**
 * Narrow runtime surface used by main-owned candidate promotion.
 *
 * The service receives this interface through dependency injection so it
 * cannot reach a process-global authority or silently promote unlocked.
 */
export interface FanoutCandidatePromotionLockRuntime {
  acquireClaims(
    owner: WorkspaceLockRuntimeOwnerInput,
    claims: readonly WorkspaceLockClaimRequest[]
  ): Promise<WorkspaceLockRuntimeAcquireResult>
  replaceClaims(
    owner: WorkspaceLockOwner,
    previousAcquiredTransitionId: string,
    claims: readonly WorkspaceLockClaimRequest[]
  ): Promise<WorkspaceLockRuntimeAcquireResult>
  verifyAcquisitionForMutation(
    owner: WorkspaceLockOwner,
    acquiredTransitionId: string
  ): Promise<WorkspaceLockMutationVerificationResult>
  acquireMutationFence(owner: WorkspaceLockOwner): Promise<WorkspaceMutationCommitFenceOwner>
  releaseMutationFence(fence: WorkspaceMutationCommitFenceOwner): void
  releaseAcquisition(
    runId: string,
    acquiredTransitionId: string
  ): Promise<WorkspaceLockReleaseResult>
}

export interface DurableFanoutCandidatePromotionLockOptions {
  runtime: FanoutCandidatePromotionLockRuntime
  nextOperationId?: () => string
  scheduleCleanupRetry?: (operation: () => void, delayMs: number) => unknown
  cleanupRetryDelaysMs?: readonly number[]
}

export class FanoutCandidatePromotionLockError extends Error {
  readonly code:
    | 'invalid-input'
    | 'lock-unavailable'
    | 'lock-conflict'
    | 'verification-failed'
    | 'cleanup-failed'

  constructor(code: FanoutCandidatePromotionLockError['code'], message: string) {
    super(message)
    this.name = 'FanoutCandidatePromotionLockError'
    this.code = code
  }
}

/**
 * Durable operation-scoped mediation for applying a fan-out candidate patch
 * to its base checkout.
 *
 * Candidate promotion deliberately acquires one atomic claim set:
 *
 * 1. a workspace claim serializes every promotion/mutation in the
 *    same effective base worktree, even when two patches happen to be
 *    disjoint;
 * 2. the immutable apply_patch bytes derive exact paths, conservatively
 *    promoted to whole-file claims because git may apply a hunk with offsets.
 *
 * Separate linked worktrees retain different lock domains and remain
 * independent. The patch acquisition is atomically refreshed after entering
 * the global mutation fence, so hunk baselines and path evidence are current
 * immediately before execution.
 */
export class DurableFanoutCandidatePromotionLock implements FanoutCandidatePromotionLock {
  private readonly runtime: FanoutCandidatePromotionLockRuntime
  private readonly nextOperationId: () => string
  private readonly scheduleCleanupRetry: (operation: () => void, delayMs: number) => unknown
  private readonly cleanupRetryDelaysMs: readonly number[]

  constructor(options: DurableFanoutCandidatePromotionLockOptions) {
    this.runtime = options.runtime
    this.nextOperationId = options.nextOperationId || randomUUID
    this.scheduleCleanupRetry =
      options.scheduleCleanupRetry ||
      ((operation, delayMs) => {
        const timer = setTimeout(operation, delayMs)
        timer.unref?.()
        return timer
      })
    this.cleanupRetryDelaysMs = options.cleanupRetryDelaysMs || [250, 1_000, 4_000, 15_000]
  }

  async withPromotionLock<T>(
    input: FanoutCandidatePromotionLockInput,
    operation: (verified: VerifiedFanoutCandidatePromotion) => T | Promise<T>
  ): Promise<FanoutCandidatePromotionLockResult<T>> {
    validateInput(input)
    if (typeof operation !== 'function') {
      throw new FanoutCandidatePromotionLockError(
        'invalid-input',
        'Candidate promotion requires an operation callback.'
      )
    }

    const operationId = requireOperationId(this.nextOperationId())
    const runId = `fanout-candidate-promotion:${operationId}`
    const lockOwnerId = `fanout-candidate-promotion-owner:${operationId}`
    const ownerInput: WorkspaceLockRuntimeOwnerInput = {
      lockOwnerId,
      runId,
      chatId: input.chatId,
      displayName: `Candidate ${input.candidateId} promotion`
    }

    let owner: WorkspaceLockOwner | null = null
    let acquisitionTransitionId: string | null = null
    let mutationFence: WorkspaceMutationCommitFenceOwner | null = null
    let operationCompleted = false
    let result: T | undefined
    let operationError: unknown

    try {
      const claims = await derivePromotionClaims(input)
      const acquisition = await this.runtime.acquireClaims(ownerInput, claims)
      assertAcquired(acquisition, 'base workspace and candidate patch')
      owner = acquisition.owner
      acquisitionTransitionId = requireTransitionId(
        acquisition.authority.transitionId,
        'base workspace and candidate patch'
      )

      mutationFence = await this.runtime.acquireMutationFence(owner)

      const refreshedClaims = await derivePromotionClaims(input)
      const refreshed = await this.runtime.replaceClaims(
        owner,
        acquisitionTransitionId,
        refreshedClaims
      )
      assertAcquired(refreshed, 'refreshed base workspace and candidate patch')
      acquisitionTransitionId = requireTransitionId(
        refreshed.authority.transitionId,
        'refreshed base workspace and candidate patch'
      )

      const verification = await this.runtime.verifyAcquisitionForMutation(
        owner,
        acquisitionTransitionId
      )
      const verified = verifiedPromotionCapabilities(verification)
      result = await operation(verified)
      operationCompleted = true
    } catch (error) {
      operationError = error
    }

    const cleanupErrors: unknown[] = []
    if (mutationFence) {
      try {
        this.runtime.releaseMutationFence(mutationFence)
      } catch (error) {
        cleanupErrors.push(error)
        this.queueCleanupRetry(() => {
          this.runtime.releaseMutationFence(mutationFence)
        }, 'candidate promotion mutation fence')
      }
    }
    if (owner && acquisitionTransitionId) {
      try {
        const released = await this.runtime.releaseAcquisition(owner.runId, acquisitionTransitionId)
        if (!released.ok && released.reason !== 'stale_token') {
          cleanupErrors.push(
            new FanoutCandidatePromotionLockError(
              'cleanup-failed',
              `Candidate promotion lease release failed: ${released.message}`
            )
          )
          this.queueCleanupRetry(async () => {
            const retry = await this.runtime.releaseAcquisition(
              owner!.runId,
              acquisitionTransitionId!
            )
            if (!retry.ok && retry.reason !== 'stale_token') {
              throw new Error(retry.message)
            }
          }, 'candidate promotion acquisition')
        }
      } catch (error) {
        cleanupErrors.push(error)
        this.queueCleanupRetry(async () => {
          const retry = await this.runtime.releaseAcquisition(
            owner!.runId,
            acquisitionTransitionId!
          )
          if (!retry.ok && retry.reason !== 'stale_token') {
            throw new Error(retry.message)
          }
        }, 'candidate promotion acquisition')
      }
    }

    if (!operationCompleted) {
      if (cleanupErrors.length) {
        throw new AggregateError(
          [operationError, ...cleanupErrors],
          'Candidate promotion failed and its exact lock cleanup also failed.'
        )
      }
      throw operationError
    }
    return {
      value: result as T,
      ...(cleanupErrors.length
        ? {
            cleanupError: `Candidate promotion committed, but durable lock cleanup is retrying: ${cleanupErrors
              .map(errorMessage)
              .join(' ')}`
          }
        : {})
    }
  }

  private queueCleanupRetry(operation: () => void | Promise<void>, label: string): void {
    let attempt = 0
    const run = (): void => {
      void Promise.resolve()
        .then(operation)
        .catch((error) => {
          const delay = this.cleanupRetryDelaysMs[attempt]
          attempt += 1
          if (delay === undefined) {
            console.error(`[workspace-lock] ${label} cleanup retries exhausted:`, error)
            return
          }
          this.scheduleCleanupRetry(run, delay)
        })
    }
    const delay = this.cleanupRetryDelaysMs[attempt]
    attempt += 1
    if (delay !== undefined) this.scheduleCleanupRetry(run, delay)
  }
}

function validateInput(input: FanoutCandidatePromotionLockInput): void {
  if (!input || typeof input !== 'object') {
    throw new FanoutCandidatePromotionLockError(
      'invalid-input',
      'Candidate promotion lock input is required.'
    )
  }
  for (const [label, value] of [
    ['chat id', input.chatId],
    ['candidate id', input.candidateId],
    ['base workspace path', input.baseWorkspacePath]
  ] as const) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new FanoutCandidatePromotionLockError(
        'invalid-input',
        `Candidate promotion ${label} is required.`
      )
    }
  }
}

function requireOperationId(value: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FanoutCandidatePromotionLockError(
      'invalid-input',
      'Candidate promotion operation id is unavailable.'
    )
  }
  return value
}

function requireTransitionId(value: string, label: string): string {
  if (!value?.trim()) {
    throw new FanoutCandidatePromotionLockError(
      'lock-unavailable',
      `The ${label} lock did not return a durable acquisition transition.`
    )
  }
  return value
}

function assertAcquired(
  result: WorkspaceLockRuntimeAcquireResult,
  label: string
): asserts result is Extract<WorkspaceLockRuntimeAcquireResult, { ok: true }> {
  if (result.ok) return
  throw new FanoutCandidatePromotionLockError(
    result.code === 'conflict' ? 'lock-conflict' : 'lock-unavailable',
    `Could not lock the ${label} for candidate promotion: ${result.message}`
  )
}

function assertVerified(
  result: WorkspaceLockMutationVerificationResult,
  label: string
): asserts result is Extract<WorkspaceLockMutationVerificationResult, { ok: true }> {
  if (result.ok) return
  throw new FanoutCandidatePromotionLockError(
    'verification-failed',
    `Could not reverify the ${label} for candidate promotion: ${result.message}`
  )
}

function verifiedPromotionCapabilities(
  verification: WorkspaceLockMutationVerificationResult
): VerifiedFanoutCandidatePromotion {
  assertVerified(verification, 'base workspace and candidate patch')
  const workspaceCapabilities = verification.capabilities.filter(
    (capability) => capability.kind === 'workspace'
  )
  if (workspaceCapabilities.length !== 1) {
    throw new FanoutCandidatePromotionLockError(
      'verification-failed',
      'Candidate promotion requires exactly one verified base-workspace capability.'
    )
  }
  const baseWorkspacePath = workspaceCapabilities[0].executableTargetPath
  const targetPaths = [
    ...new Set(
      verification.capabilities
        .filter((capability) => capability.kind !== 'workspace')
        .map((capability) => capability.executableTargetPath)
    )
  ].sort()
  for (const targetPath of targetPaths) {
    const relativePath = relative(baseWorkspacePath, targetPath)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new FanoutCandidatePromotionLockError(
        'verification-failed',
        'A verified candidate-patch target escaped the verified base workspace.'
      )
    }
  }
  return { baseWorkspacePath, targetPaths }
}

async function derivePromotionClaims(
  input: FanoutCandidatePromotionLockInput
): Promise<WorkspaceLockClaimRequest[]> {
  const workspaceClaim: WorkspaceLockClaimRequest = {
    workspacePath: input.baseWorkspacePath,
    worktreePath: input.baseWorkspacePath,
    kind: 'workspace',
    mode: 'write'
  }
  if (!input.patch.trim()) return [workspaceClaim]

  const derived = await deriveWorkspaceMutationClaims({
    workspacePath: input.baseWorkspacePath,
    worktreePath: input.baseWorkspacePath,
    action: 'apply_patch',
    args: { patch: input.patch }
  })
  const conservative = derived.map((claim): WorkspaceLockClaimRequest => {
    if (claim.kind !== 'hunk') return claim
    const { hunk: _hunk, ...wholeFile } = claim
    return { ...wholeFile, kind: 'file' }
  })
  return [workspaceClaim, ...conservative]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
