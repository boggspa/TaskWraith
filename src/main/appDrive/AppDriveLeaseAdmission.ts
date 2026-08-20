import type { AgentApprovalAction, AgenticServiceId, ProviderId } from '../store/types'
import type { SimulatorControllerLease } from '../simulator/SimulatorControllerLease'
import type { AppDriveSurfaceDescriptor } from '../../shared/appDriveSurface'
import {
  APP_DRIVE_DEFAULT_LEASE_TTL_MS,
  APP_DRIVE_DEFAULT_STEP_BUDGET,
  type AppDriveLeaseRegistry
} from './AppDriveLease'

export interface AppDriveApprovalResolution {
  action: AgentApprovalAction
  decisionSource: 'user' | 'system'
}

export interface AuthorizeApprovedAppDriveSurfaceInput {
  descriptor: AppDriveSurfaceDescriptor
  provider: ProviderId
  service: AgenticServiceId
  workspacePath?: string
  chatId: string
  runId: string
  participantId?: string
  approval?: AppDriveApprovalResolution
  oneOffPermissionRetry: boolean
}

export interface AppDriveLeaseAdmissionDeps {
  leases: AppDriveLeaseRegistry
  simulatorController: Pick<SimulatorControllerLease, 'authorizeUserLease'>
  hasSessionGrant: (
    provider: ProviderId,
    workspacePath: string | undefined,
    service: AgenticServiceId,
    runId: string,
    surfaceId: string
  ) => boolean
  removeSessionGrant: (
    provider: ProviderId,
    workspacePath: string | undefined,
    service: AgenticServiceId,
    runId: string,
    surfaceId: string
  ) => boolean
  now?: () => number
}

export type AuthorizeApprovedAppDriveSurfaceResult = { ok: true } | { ok: false; error: string }

function userApprovedNow(
  approval: AppDriveApprovalResolution | undefined,
  oneOffPermissionRetry: boolean
): boolean {
  if (oneOffPermissionRetry) return true
  return Boolean(
    approval?.decisionSource === 'user' &&
    (approval.action === 'accept' || approval.action === 'acceptForSession')
  )
}

function exactBindingMatches(
  lease: NonNullable<ReturnType<AppDriveLeaseRegistry['peek']>>,
  input: AuthorizeApprovedAppDriveSurfaceInput
): boolean {
  return (
    lease.status === 'active' &&
    lease.stepsRemaining > 0 &&
    lease.surfaceKind === input.descriptor.surfaceKind &&
    lease.chatId === input.chatId &&
    lease.runId === input.runId &&
    lease.provider === input.provider &&
    (lease.participantId === undefined || lease.participantId === input.participantId)
  )
}

/**
 * Translate the central approval result into one bounded AppDrive lease.
 * Policy/Yolo/Boss auto-allow can never mint it: only an exact user decision or
 * an exact surface session grant created by an earlier user decision qualifies.
 */
export function authorizeApprovedAppDriveSurface(
  input: AuthorizeApprovedAppDriveSurfaceInput,
  deps: AppDriveLeaseAdmissionDeps
): AuthorizeApprovedAppDriveSurfaceResult {
  const current = deps.leases.peek(input.descriptor.surfaceId)
  if (current && exactBindingMatches(current, input)) return { ok: true }

  const approvedNow = userApprovedNow(input.approval, input.oneOffPermissionRetry)
  const sessionGranted = deps.hasSessionGrant(
    input.provider,
    input.workspacePath,
    input.service,
    input.runId,
    input.descriptor.surfaceId
  )

  if (current && !approvedNow) {
    deps.removeSessionGrant(
      input.provider,
      input.workspacePath,
      input.service,
      input.runId,
      input.descriptor.surfaceId
    )
    return {
      ok: false,
      error:
        'The previous App Drive lease ended or changed binding. Retry once to ask the user for a fresh bounded lease.'
    }
  }
  if (!approvedNow && !sessionGranted) {
    return {
      ok: false,
      error:
        'App Drive requires explicit user approval for this exact surface; policy, YOLO, or agent authority cannot mint a lease.'
    }
  }

  const now = (deps.now ?? Date.now)()
  const sessionLease = sessionGranted || input.approval?.action === 'acceptForSession'
  const stepBudget = sessionLease ? APP_DRIVE_DEFAULT_STEP_BUDGET : 1
  const leaseInput = {
    surfaceId: input.descriptor.surfaceId,
    surfaceKind: input.descriptor.surfaceKind,
    chatId: input.chatId,
    runId: input.runId,
    provider: input.provider,
    ...(input.participantId ? { participantId: input.participantId } : {}),
    approvedBy: 'user' as const,
    approvedAt: now,
    expiresAt: now + APP_DRIVE_DEFAULT_LEASE_TTL_MS,
    allowedVerbs: input.descriptor.allowedVerbs,
    stepBudget,
    target: input.descriptor.target
  }

  if (input.descriptor.surfaceKind === 'simulator') {
    const result = deps.simulatorController.authorizeUserLease({
      ...leaseInput,
      verb: input.descriptor.verb,
      ownerParticipantId: input.participantId
    })
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  }
  try {
    deps.leases.authorizeUserLease(leaseInput)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function revokeAppDriveSurfaceAuthority(
  input: {
    descriptor: Pick<AppDriveSurfaceDescriptor, 'surfaceId'>
    provider: ProviderId
    service: AgenticServiceId
    workspacePath?: string
    runId: string
    reason: 'navigation' | 'surface-closed' | 'human-takeover'
  },
  deps: Pick<AppDriveLeaseAdmissionDeps, 'leases' | 'removeSessionGrant'>
): void {
  deps.leases.revokeSurface(input.descriptor.surfaceId, input.reason)
  deps.removeSessionGrant(
    input.provider,
    input.workspacePath,
    input.service,
    input.runId,
    input.descriptor.surfaceId
  )
}
