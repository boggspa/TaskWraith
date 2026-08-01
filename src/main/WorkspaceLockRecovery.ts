import { randomUUID } from 'node:crypto'

import type { WorkLockRecoveryResult } from '../shared/workLockProjection'
import type { WorkspaceLockRecoveryBlockedAcquisition } from './WorkspaceLockRuntime'
import type {
  WorkspaceLockProcessObservation,
  WorkspaceLockReleaseResult
} from './workLocks/WorkspaceLockTypes'

export type WorkspaceLockRecoveryEvidence = 'owner_dead' | 'pid_reused'

export interface WorkspaceLockRecoveryConfirmation {
  lockId: string
  ownerLabel: string
  ownerPid: number
  runId: string
  workspacePath: string
  worktreePath: string
  evidence: WorkspaceLockRecoveryEvidence
}

export interface WorkspaceLockRecoveryRuntime {
  recoveryBlockedAcquisition(lockId: string): WorkspaceLockRecoveryBlockedAcquisition | null
  observeRecoveryBlockedAcquisitionOwner(
    candidate: WorkspaceLockRecoveryBlockedAcquisition
  ): Promise<WorkspaceLockProcessObservation>
  forceReleaseRecoveryBlockedAcquisition(
    candidate: WorkspaceLockRecoveryBlockedAcquisition,
    approvalReceiptId: string
  ): Promise<WorkspaceLockReleaseResult>
}

export interface RecoverWorkspaceLockOptions {
  runtime: WorkspaceLockRecoveryRuntime
  lockId: string
  confirm: (confirmation: WorkspaceLockRecoveryConfirmation) => Promise<boolean>
  createApprovalReceiptId?: () => string
}

function sameCandidate(
  left: WorkspaceLockRecoveryBlockedAcquisition,
  right: WorkspaceLockRecoveryBlockedAcquisition | null
): boolean {
  return Boolean(
    right &&
    left.lockId === right.lockId &&
    left.ownerRunId === right.ownerRunId &&
    left.acquiredTransitionId === right.acquiredTransitionId &&
    left.owner.lockOwnerId === right.owner.lockOwnerId &&
    left.owner.lifecycle === right.owner.lifecycle &&
    left.owner.pid === right.owner.pid &&
    left.owner.processBirthIdentity === right.owner.processBirthIdentity &&
    left.leaseIds.length === right.leaseIds.length &&
    left.leaseIds.every((leaseId, index) => leaseId === right.leaseIds[index])
  )
}

function recoveryEvidence(
  candidate: WorkspaceLockRecoveryBlockedAcquisition,
  observation: WorkspaceLockProcessObservation
): WorkspaceLockRecoveryEvidence | null {
  if (observation.state === 'dead') return 'owner_dead'
  if (
    observation.state === 'live' &&
    observation.processBirthIdentity !== candidate.owner.processBirthIdentity
  ) {
    return 'pid_reused'
  }
  return null
}

function observationFailure(
  candidate: WorkspaceLockRecoveryBlockedAcquisition,
  observation: WorkspaceLockProcessObservation
): WorkLockRecoveryResult | null {
  if (observation.state === 'identity_unavailable') {
    return {
      ok: false,
      reason: 'owner_identity_unavailable',
      message: 'TaskWraith could not verify the blocked owner process. Recovery remains paused.'
    }
  }
  if (
    observation.state === 'live' &&
    observation.processBirthIdentity === candidate.owner.processBirthIdentity
  ) {
    return {
      ok: false,
      reason: 'owner_live',
      message: 'The exact blocked owner process is still running. Stop it before recovery.'
    }
  }
  return null
}

function releaseFailure(
  result: WorkspaceLockReleaseResult & { ok: false }
): WorkLockRecoveryResult {
  const stale = result.reason === 'stale_generation' || result.reason === 'stale_token'
  return {
    ok: false,
    reason: stale ? 'stale' : 'release_failed',
    message: stale
      ? 'The blocked acquisition changed during review. Refresh the lock panel and try again.'
      : `TaskWraith kept the acquisition protected: ${result.message}`
  }
}

export async function recoverWorkspaceLock(
  options: RecoverWorkspaceLockOptions
): Promise<WorkLockRecoveryResult> {
  const candidate = options.runtime.recoveryBlockedAcquisition(options.lockId)
  if (!candidate) {
    return {
      ok: false,
      reason: 'not_found_or_forbidden',
      message: 'The selected recovery-blocked acquisition is no longer available.'
    }
  }

  let observation: WorkspaceLockProcessObservation
  try {
    observation = await options.runtime.observeRecoveryBlockedAcquisitionOwner(candidate)
  } catch {
    return {
      ok: false,
      reason: 'owner_identity_unavailable',
      message: 'TaskWraith could not verify the blocked owner process. Recovery remains paused.'
    }
  }
  const blocked = observationFailure(candidate, observation)
  if (blocked) return blocked
  const evidence = recoveryEvidence(candidate, observation)
  if (!evidence) {
    return {
      ok: false,
      reason: 'owner_identity_unavailable',
      message: 'TaskWraith could not establish safe evidence for recovery.'
    }
  }

  const confirmed = await options.confirm({
    lockId: candidate.lockId,
    ownerLabel: candidate.owner.displayName || candidate.owner.provider || 'Provider',
    ownerPid: candidate.owner.pid,
    runId: candidate.ownerRunId,
    workspacePath: candidate.workspacePath,
    worktreePath: candidate.worktreePath,
    evidence
  })
  if (!confirmed) {
    return {
      ok: false,
      reason: 'cancelled',
      message: 'Recovery was cancelled. The acquisition remains protected.'
    }
  }

  if (!sameCandidate(candidate, options.runtime.recoveryBlockedAcquisition(candidate.lockId))) {
    return {
      ok: false,
      reason: 'stale',
      message:
        'The blocked acquisition changed during review. Refresh the lock panel and try again.'
    }
  }

  try {
    observation = await options.runtime.observeRecoveryBlockedAcquisitionOwner(candidate)
  } catch {
    return {
      ok: false,
      reason: 'owner_identity_unavailable',
      message: 'TaskWraith could not re-verify the owner after approval. Recovery remains paused.'
    }
  }
  const recheckBlocked = observationFailure(candidate, observation)
  if (recheckBlocked) return recheckBlocked
  if (!recoveryEvidence(candidate, observation)) {
    return {
      ok: false,
      reason: 'owner_identity_unavailable',
      message: 'TaskWraith could not re-establish safe recovery evidence after approval.'
    }
  }

  const approvalReceiptId =
    options.createApprovalReceiptId?.() || `workspace-lock-recovery-${randomUUID()}`
  let released: WorkspaceLockReleaseResult
  try {
    released = await options.runtime.forceReleaseRecoveryBlockedAcquisition(
      candidate,
      approvalReceiptId
    )
  } catch {
    return {
      ok: false,
      reason: 'release_failed',
      message: 'TaskWraith could not durably reconcile the approved recovery.'
    }
  }
  if (!released.ok) return releaseFailure(released)

  return {
    ok: true,
    releasedLeaseCount: released.released.length,
    message:
      'The approved acquisition was released durably. Restart TaskWraith before starting another write-capable run.'
  }
}
