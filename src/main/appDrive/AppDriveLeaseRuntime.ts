import type { AgentApprovalAction, AgenticServiceId, ProviderId } from '../store/types'
import type { CanvasCallContext, CanvasSessionRecord } from '../canvas/canvasTypes'
import type { SimulatorControllerLease } from '../simulator/SimulatorControllerLease'
import type { SimulatorSessionStore } from '../simulator/SimulatorSessionStore'
import {
  resolveAppDriveSurfaceDescriptor,
  type AppDriveSurfaceDescriptor
} from '../../shared/appDriveSurface'
import type { AppDriveLeaseRegistry } from './AppDriveLease'
import {
  authorizeApprovedAppDriveSurface,
  revokeAppDriveSurfaceAuthority
} from './AppDriveLeaseAdmission'

export interface AppDriveLeaseRuntimeDeps {
  leases: AppDriveLeaseRegistry
  simulatorController: Pick<SimulatorControllerLease, 'authorizeUserLease'>
  simulatorSessions: Pick<SimulatorSessionStore, 'get'>
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
  webOrigin: (canvasId: string, context: CanvasCallContext) => string | undefined
}

export class AppDriveLeaseRuntime {
  constructor(private readonly deps: AppDriveLeaseRuntimeDeps) {}

  prepareApproval(
    toolName: string,
    args: unknown,
    chatId: string | undefined,
    approvalPreview: unknown
  ): AppDriveSurfaceDescriptor | null {
    const session = chatId ? this.deps.simulatorSessions.get(chatId) : null
    const descriptor = resolveAppDriveSurfaceDescriptor(toolName, args, {
      simulatorUdid: session?.udid,
      simulatorBundleId: session?.bundleId
    })
    if (
      descriptor &&
      approvalPreview &&
      typeof approvalPreview === 'object' &&
      !Array.isArray(approvalPreview)
    ) {
      ;(approvalPreview as Record<string, unknown>).surfaceId = descriptor.surfaceId
    }
    return descriptor
  }

  authorize(input: {
    descriptor: AppDriveSurfaceDescriptor
    provider: ProviderId
    service: AgenticServiceId
    workspacePath?: string
    chatId?: string
    runId?: string
    participantId?: string
    approval?: { action: AgentApprovalAction; decisionSource: 'user' | 'system' }
    oneOffPermissionRetry: boolean
  }): { ok: true } | { ok: false; error: string } {
    if (!input.chatId || !input.runId) {
      return { ok: false, error: 'App Drive requires exact active chat and run authority.' }
    }
    if (input.descriptor.surfaceKind === 'web') {
      const origin = this.deps.webOrigin(input.descriptor.surfaceId, {
        provider: input.provider,
        chatId: input.chatId,
        runId: input.runId,
        workspacePath: input.workspacePath,
        participantId: input.participantId
      })
      if (origin) input.descriptor.target.origin = origin
    }
    return authorizeApprovedAppDriveSurface(
      {
        ...input,
        chatId: input.chatId,
        runId: input.runId
      },
      this.deps
    )
  }

  invalidateWebSurface(input: {
    canvasId: string
    record: CanvasSessionRecord
    ctx: CanvasCallContext
    reason: 'navigation' | 'surface-closed' | 'human-takeover'
  }): void {
    if (!input.record.runId || !input.ctx.provider) {
      this.deps.leases.revokeSurface(input.canvasId, input.reason)
      return
    }
    revokeAppDriveSurfaceAuthority(
      {
        descriptor: { surfaceId: input.canvasId },
        provider: input.ctx.provider as ProviderId,
        service: 'canvasInteraction',
        workspacePath: input.record.workspacePath,
        runId: input.record.runId,
        reason: input.reason
      },
      this.deps
    )
  }

  revokeRun(runId: string): void {
    this.deps.leases.revokeForRun(runId)
  }
}
