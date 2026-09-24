import type { AgentApprovalAction, AgenticServiceId, ProviderId } from '../store/types'
import type { CanvasCallContext, CanvasSessionRecord } from '../canvas/canvasTypes'
import type { SimulatorControllerLease } from '../simulator/SimulatorControllerLease'
import type { SimulatorSessionStore } from '../simulator/SimulatorSessionStore'
import {
  resolveAppDriveSurfaceDescriptor,
  type AppDriveSurfaceDescriptor
} from '../../shared/appDriveSurface'
import type { AppDriveLeaseRegistry, AppDriveLeaseSnapshot } from './AppDriveLease'
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
  /**
   * Exact main-owned live-surface recheck for the fixed emulator. `other`
   * distinguishes a current non-emulator Canvas from a missing one, so a bad
   * emulator request can never tear down its separately reviewed web authority.
   * Optional for source-compatible production wiring; absent fails closed.
   */
  resolveEmulatorSurface?: (
    canvasId: string,
    context: CanvasCallContext
  ) => 'emulator' | 'other' | 'missing'
}

function isExactEmulatorDescriptor(descriptor: AppDriveSurfaceDescriptor): boolean {
  return (
    descriptor.surfaceKind === 'emulator' &&
    descriptor.surfaceId === descriptor.target.canvasId &&
    Object.keys(descriptor.target).length === 1 &&
    descriptor.verb === 'emulator_step' &&
    descriptor.allowedVerbs.length === 1 &&
    descriptor.allowedVerbs[0] === 'emulator_step'
  )
}

function matchesEmulatorLeaseBinding(
  lease: AppDriveLeaseSnapshot,
  input: {
    chatId: string
    runId: string
    provider: ProviderId
    participantId?: string
  }
): boolean {
  return (
    lease.surfaceKind === 'emulator' &&
    lease.chatId === input.chatId &&
    lease.runId === input.runId &&
    lease.provider === input.provider &&
    (lease.participantId ?? undefined) === input.participantId
  )
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
      ;(approvalPreview as Record<string, unknown>).independentVerificationRequired =
        descriptor.independentVerificationRequired
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
    const chatId = input.chatId
    const runId = input.runId
    if (!chatId || !runId) {
      return { ok: false, error: 'App Drive requires exact active chat and run authority.' }
    }
    const context: CanvasCallContext = {
      provider: input.provider,
      chatId,
      runId,
      workspacePath: input.workspacePath,
      ...(input.participantId ? { participantId: input.participantId } : {})
    }
    if (input.descriptor.surfaceKind === 'emulator') {
      let surfaceState: 'emulator' | 'other' | 'missing' | 'unknown' = 'unknown'
      try {
        if (input.service === 'canvasInteraction' && isExactEmulatorDescriptor(input.descriptor)) {
          surfaceState =
            this.deps.resolveEmulatorSurface?.(input.descriptor.surfaceId, context) ?? 'unknown'
        }
      } catch {
        surfaceState = 'unknown'
      }
      if (surfaceState !== 'emulator') {
        const current = this.deps.leases.peek(input.descriptor.surfaceId)
        // Only an explicitly missing surface can retire a lease, and only when
        // it is positively an emulator lease held by this exact caller. A
        // wrong-kind/cross-chat request must never revoke a real web/simulator
        // surface or its generic canvasInteraction session grant.
        if (
          surfaceState === 'missing' &&
          current &&
          matchesEmulatorLeaseBinding(current, {
            chatId,
            runId,
            provider: input.provider,
            ...(input.participantId ? { participantId: input.participantId } : {})
          })
        ) {
          this.deps.leases.revokeSurface(input.descriptor.surfaceId, 'surface-closed')
          this.deps.removeSessionGrant(
            input.provider,
            input.workspacePath,
            'canvasInteraction',
            runId,
            input.descriptor.surfaceId
          )
        }
        return {
          ok: false,
          error: 'App Drive requires the exact current chat-owned emulator surface.'
        }
      }
    }
    if (input.descriptor.surfaceKind === 'web') {
      const origin = this.deps.webOrigin(input.descriptor.surfaceId, context)
      if (origin) input.descriptor.target.origin = origin
    }
    return authorizeApprovedAppDriveSurface(
      {
        ...input,
        chatId,
        runId
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

  /** Exact lifecycle release for a fixed emulator surface; never touches web leases. */
  invalidateEmulatorSurface(input: {
    canvasId: string
    record: CanvasSessionRecord
    ctx: CanvasCallContext
    reason: 'surface-closed' | 'human-takeover'
  }): void {
    if (input.record.id !== input.canvasId || input.record.driver !== 'emulator') return
    const chatId = input.record.chatId
    const runId = input.record.runId
    if (!chatId || !runId) return
    const surfaceHostId = input.ctx.surfaceHostId
    const exactAgentContext =
      input.ctx.chatId === chatId && input.ctx.runId === runId && Boolean(input.ctx.provider)
    // Renderer-owned close uses a main-stamped WebContents id and chat scope,
    // but intentionally carries no agent run/provider. Only a close may derive
    // authority from the exact live lease; renderer takeover remains agent-only.
    const trustedRendererClose =
      input.reason === 'surface-closed' &&
      input.ctx.chatId === chatId &&
      input.ctx.runId === undefined &&
      input.ctx.provider === undefined &&
      typeof surfaceHostId === 'number' &&
      Number.isSafeInteger(surfaceHostId) &&
      surfaceHostId > 0
    if (!exactAgentContext && !trustedRendererClose) return

    const lease = this.deps.leases.peek(input.canvasId)
    if (lease) {
      if (
        lease.surfaceKind !== 'emulator' ||
        lease.chatId !== chatId ||
        lease.runId !== runId ||
        (exactAgentContext && lease.provider !== input.ctx.provider)
      ) {
        return
      }
      this.deps.leases.revokeSurface(input.canvasId, input.reason)
      this.deps.removeSessionGrant(
        lease.provider as ProviderId,
        input.record.workspacePath,
        'canvasInteraction',
        runId,
        input.canvasId
      )
      return
    }
    if (!exactAgentContext) return
    this.deps.removeSessionGrant(
      input.ctx.provider as ProviderId,
      input.record.workspacePath,
      'canvasInteraction',
      runId,
      input.canvasId
    )
  }

  revokeRun(runId: string): void {
    this.deps.leases.revokeForRun(runId)
  }
}
