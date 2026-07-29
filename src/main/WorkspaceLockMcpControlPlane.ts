import type {
  WorkspaceExternalMutationAuthorityContext,
  WorkspaceExternalMutationAuthorityIssuerDependencies
} from './WorkspaceExternalMutationAuthority'
import type { ProviderId } from './store/types'
import { WorkspaceExternalMutationAuthorityIssuer } from './WorkspaceExternalMutationAuthority'
import {
  WorkspaceLockMcpAdmissionCoordinator,
  type WorkspaceLockMcpAdmissionChat,
  type WorkspaceLockMcpLaneScopeDecision,
  type WorkspaceLockMcpLaneScopeQuery
} from './WorkspaceLockMcpAdmissionCoordinator'
import {
  WorkspaceLockMcpExecutionCoordinator,
  type WorkspaceLockMcpChildLifecycleInput,
  type WorkspaceLockMcpExecutionContext
} from './WorkspaceLockMcpExecutionCoordinator'
import { WorkspaceLockProviderCoordinator } from './WorkspaceLockProviderCoordinator'
import { WorkspaceLockRunLifecycleTracker } from './WorkspaceLockRunLifecycle'
import type { WorkspaceLockRuntime } from './WorkspaceLockRuntime'

export interface WorkspaceLockMcpControlPlaneDependencies<
  Context extends WorkspaceLockMcpExecutionContext & WorkspaceExternalMutationAuthorityContext
> {
  getChat: (chatId: string) => WorkspaceLockMcpAdmissionChat | null | undefined
  validateLaneWriteScope: (
    runId: string,
    query: WorkspaceLockMcpLaneScopeQuery
  ) => WorkspaceLockMcpLaneScopeDecision | undefined
  markLaneBlocked: (runId: string, reason: string) => void
  encode: (payload: Readonly<Record<string, unknown>>) => string
  providerDisplayName: (provider: ProviderId) => string
  externalMutationAuthority: WorkspaceExternalMutationAuthorityIssuerDependencies<Context>
  confirmChildMutationTreeStopped?: (
    input: WorkspaceLockMcpChildLifecycleInput
  ) => boolean | Promise<boolean>
  unresolvedOperationTimeoutMs?: number
  logError?: (scope: string, error: unknown) => void
}

/**
 * Composition root for the brokered workspace-lock path. Main owns one mutable
 * runtime installation; every provider, admission, lifecycle and execution
 * adapter closes over that same authority and the same fail-closed reason.
 */
export class WorkspaceLockMcpControlPlane<
  Context extends WorkspaceLockMcpExecutionContext & WorkspaceExternalMutationAuthorityContext
> {
  private runtimeRef: WorkspaceLockRuntime | null = null
  private blockedReason: string | null = null

  readonly providerCoordinator: WorkspaceLockProviderCoordinator
  readonly lifecycle: WorkspaceLockRunLifecycleTracker
  readonly externalMutationAuthority: WorkspaceExternalMutationAuthorityIssuer<Context>
  readonly admission: WorkspaceLockMcpAdmissionCoordinator
  readonly execution: WorkspaceLockMcpExecutionCoordinator<Context>

  constructor(private readonly deps: WorkspaceLockMcpControlPlaneDependencies<Context>) {
    this.providerCoordinator = new WorkspaceLockProviderCoordinator({
      getRuntime: () => this.runtimeRef
    })
    this.admission = new WorkspaceLockMcpAdmissionCoordinator({
      getRuntime: () => this.runtimeRef,
      getRuntimeUnavailableReason: () => this.blockedReason,
      getChat: deps.getChat,
      getOpaqueOwnerId: (query) => this.providerCoordinator.getOrCreateLogicalOwnerId(query),
      getProviderScopeAdmission: ({ runId, laneId, participantId }) =>
        this.providerCoordinator.get({ runId, laneId, participantId }),
      acquireProviderScopeSublease: ({ admission, runtimeInput }) =>
        this.providerCoordinator.acquireNestedMutationSublease(
          {
            runId: admission.runId,
            laneId: admission.owner.laneId,
            participantId: admission.owner.participantId
          },
          admission,
          runtimeInput
        ),
      validateLaneWriteScope: deps.validateLaneWriteScope,
      markLaneBlocked: deps.markLaneBlocked,
      encode: deps.encode,
      providerDisplayName: deps.providerDisplayName
    })
    this.lifecycle = new WorkspaceLockRunLifecycleTracker({
      ...(deps.unresolvedOperationTimeoutMs
        ? { unresolvedOperationTimeoutMs: deps.unresolvedOperationTimeoutMs }
        : {}),
      releaseRun: async (runId) => {
        const runtime = this.runtimeRef
        if (!runtime) {
          throw new Error('Workspace-lock runtime disappeared before terminal release.')
        }
        const released = await runtime.releaseRun(runId)
        if (released.ok === false) throw new Error(released.message)
      },
      onReleased: (runId) => this.providerCoordinator.forgetRun(runId),
      onReleaseFailure: ({ runId, error }) => {
        this.poison(errorMessage(error))
        this.deps.logError?.(`terminal release for run ${runId}`, error)
      },
      onFailClosed: (violation) => {
        const reason =
          violation.kind === 'operation-after-terminal'
            ? `Workspace-lock operation started after run ${violation.runId} became terminal.`
            : `Workspace-lock operation ${violation.operationId} for run ${violation.runId} did not settle before its terminal deadline.`
        this.poison(reason)
        this.deps.logError?.('run lifecycle', new Error(reason))
      }
    })
    this.externalMutationAuthority = new WorkspaceExternalMutationAuthorityIssuer(
      deps.externalMutationAuthority
    )
    this.execution = new WorkspaceLockMcpExecutionCoordinator({
      admission: this.admission,
      externalMutationAuthority: this.externalMutationAuthority,
      lifecycle: this.lifecycle,
      getRuntime: () => this.runtimeRef,
      confirmChildMutationTreeStopped: deps.confirmChildMutationTreeStopped,
      poison: (reason) => this.poison(reason),
      encode: deps.encode,
      logError: deps.logError
    })
  }

  getRuntime(): WorkspaceLockRuntime | null {
    return this.runtimeRef
  }

  installRuntime(runtime: WorkspaceLockRuntime): void {
    if (this.runtimeRef && this.runtimeRef !== runtime) {
      throw new Error('Workspace-lock runtime is already installed.')
    }
    this.runtimeRef = runtime
  }

  clearRuntime(runtime?: WorkspaceLockRuntime): void {
    if (runtime && this.runtimeRef !== runtime) return
    this.runtimeRef = null
  }

  getBlockedReason(): string | null {
    return this.blockedReason
  }

  blockStartup(reason: string): void {
    const normalized = reason.trim()
    if (!normalized) throw new Error('Workspace-lock startup block reason is required.')
    this.blockedReason ||= normalized
  }

  poison(reason: string): void {
    const message = `Workspace-lock mutation admission is fail-closed: ${reason}`
    this.runtimeRef?.markUnhealthy(message)
    this.blockedReason ||= message
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
