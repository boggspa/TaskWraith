import { dirname, resolve } from 'node:path'

import { resolveToolDispatchContractStrict } from '../shared/providerActionTaxonomy'
import type { ProviderId } from './store/types'
import type { ScopedPathAuthority } from './ScopedPathAccess'
import type { WorkspaceExternalMutationAuthorityIssuer } from './WorkspaceExternalMutationAuthority'
import type {
  WorkspaceLockMcpAdmission,
  WorkspaceLockMcpAdmissionContext,
  WorkspaceLockMcpAdmissionCoordinator
} from './WorkspaceLockMcpAdmissionCoordinator'
import { workspaceLockMcpResourcePath } from './WorkspaceLockMcpResourceScope'
import type { WorkspaceLockRuntime, WorkspaceLockRuntimeAcquireInput } from './WorkspaceLockRuntime'
import type {
  WorkspaceLockRunLifecycleOperation,
  WorkspaceLockRunLifecycleTracker
} from './WorkspaceLockRunLifecycle'
import { prepareVerifiedWorkspaceMutationHandoff } from './mcp/VerifiedWorkspaceMutationHandoff'
import type { WorkspaceMutationCommitFenceOwner } from './workLocks/WorkspaceMutationCommitFence'
import type {
  WorkspaceLockMutationCapability,
  WorkspaceLockOwner
} from './workLocks/WorkspaceLockTypes'

export interface WorkspaceLockMcpExecutionContext extends WorkspaceLockMcpAdmissionContext {
  assertMutationAuthorized?: () => void | Promise<void>
  assertMutationStillLive?: () => void
  /** Exact opaque owner propagated only to the inert gated child. */
  workspaceLockOwnerId?: string
  /**
   * A structural lifecycle shared by foreground, background and launch
   * process adapters. The gate stays inert until bind() durably transfers the
   * exact acquisition to its PID/birth identity.
   */
  workspaceLockLifecycle?: WorkspaceLockMcpChildLifecycle
}

export interface WorkspaceLockMcpChildLifecycleInput {
  pid: number
  workspaceLockOwnerId: string
}

export interface WorkspaceLockMcpChildLifecycle {
  bind(input: WorkspaceLockMcpChildLifecycleInput): Promise<void>
  release(input: WorkspaceLockMcpChildLifecycleInput | null): Promise<void>
}

export type WorkspaceLockMcpExecutionRuntime = Pick<
  WorkspaceLockRuntime,
  | 'acquireMutationFence'
  | 'getUnhealthyReason'
  | 'releaseAcquisition'
  | 'releaseMutationFence'
  | 'replaceAcquisitionForMutation'
  | 'revalidateExternalMutationTarget'
  | 'transferAcquisition'
  | 'verifyAcquisitionForMutation'
>

export interface WorkspaceLockMcpExecutionCoordinatorDependencies<
  Context extends WorkspaceLockMcpExecutionContext = WorkspaceLockMcpExecutionContext
> {
  admission: Pick<WorkspaceLockMcpAdmissionCoordinator, 'admit'>
  externalMutationAuthority: Pick<WorkspaceExternalMutationAuthorityIssuer<Context>, 'issue'>
  lifecycle: Pick<WorkspaceLockRunLifecycleTracker, 'begin'>
  getRuntime: () => WorkspaceLockMcpExecutionRuntime | null
  /**
   * A direct child close is insufficient: descendants or a detached job may
   * still mutate. Omit or return false to retain/quarantine the child lease.
   */
  confirmChildMutationTreeStopped?: (
    input: WorkspaceLockMcpChildLifecycleInput
  ) => boolean | Promise<boolean>
  poison: (reason: string) => void
  encode: (payload: Readonly<Record<string, unknown>>) => string
  logError?: (scope: string, error: unknown) => void
}

export interface WorkspaceLockMcpExecutionPrepareInput<
  Context extends WorkspaceLockMcpExecutionContext = WorkspaceLockMcpExecutionContext
> {
  context: Context
  provider: ProviderId
  toolName: string
  args: Record<string, unknown>
  cwd: string
  executionPid?: number
  executionAuthorityStillLive: () => boolean
  historyClearAdmissionBlocked: (
    runId: string,
    workspacePath: string | undefined,
    chatId: string | undefined
  ) => boolean
}

export type WorkspaceLockMcpExecutionFailureKind =
  | 'admission'
  | 'execution-preparation'
  | 'release-failed'
  | 'stale-authority'

export interface WorkspaceLockMcpExecutionFailure {
  ok: false
  kind: WorkspaceLockMcpExecutionFailureKind
  text: string
  reason: string
}

export type WorkspaceLockMcpExecutionCleanupResult =
  | { resolved: true }
  | { resolved: false; reason: string }

export interface WorkspaceLockMcpPreparedExecution<
  Context extends WorkspaceLockMcpExecutionContext = WorkspaceLockMcpExecutionContext
> {
  ok: true
  args: Record<string, unknown>
  cwd: string
  context: Context
  directMutationAuthority: ScopedPathAuthority | null
  finish: () => Promise<WorkspaceLockMcpExecutionCleanupResult>
}

export type WorkspaceLockMcpExecutionPrepareResult<
  Context extends WorkspaceLockMcpExecutionContext = WorkspaceLockMcpExecutionContext
> = WorkspaceLockMcpPreparedExecution<Context> | WorkspaceLockMcpExecutionFailure

interface ExecutionState {
  admission?: Extract<WorkspaceLockMcpAdmission, { ok: true }>
  owner?: WorkspaceLockOwner
  fence: WorkspaceMutationCommitFenceOwner | null
  lifecycleOperation: WorkspaceLockRunLifecycleOperation | null
  transitionId?: string
  cleanupPromise?: Promise<WorkspaceLockMcpExecutionCleanupResult>
  childReleasePromise?: Promise<WorkspaceLockMcpExecutionCleanupResult>
  boundChild?: WorkspaceLockMcpChildLifecycleInput
  finishRequested: boolean
  transitionQueue: Promise<void>
  fatalReason?: string
}

/**
 * Owns the complete brokered workspace-mutation transition:
 *
 * admission -> commit fence -> exact claim refresh -> capability handoff ->
 * final executor verification -> fence/operation release.
 *
 * Any unresolved release poisons future admission and deliberately retains the
 * visible acquisition and run-lifecycle operation. Releasing an ownership
 * record whose settlement is unknown would make a concurrent write appear safe.
 */
export class WorkspaceLockMcpExecutionCoordinator<
  Context extends WorkspaceLockMcpExecutionContext = WorkspaceLockMcpExecutionContext
> {
  constructor(private readonly deps: WorkspaceLockMcpExecutionCoordinatorDependencies<Context>) {}

  async prepare(
    input: WorkspaceLockMcpExecutionPrepareInput<Context>
  ): Promise<WorkspaceLockMcpExecutionPrepareResult<Context>> {
    const state: ExecutionState = {
      fence: null,
      lifecycleOperation: null,
      finishRequested: false,
      transitionQueue: Promise.resolve()
    }

    try {
      const contract = resolveToolDispatchContractStrict(input.toolName, input.args)
      if (contract.ok === false) {
        return this.failure(input.toolName, 'admission', contract.reason, contract.code)
      }
      if (isWorkspaceLock(contract.lock) && input.context.appRunId) {
        state.lifecycleOperation = this.deps.lifecycle.begin(input.context.appRunId)
      }

      const admission = await this.deps.admission.admit({
        context: input.context,
        provider: input.provider,
        toolName: input.toolName,
        args: input.args,
        resourcePath: workspaceLockMcpResourcePath(
          input.toolName,
          input.args,
          resolve(input.context.workspacePath || input.context.cwd)
        ),
        externalMutationAuthority: this.deps.externalMutationAuthority.issue({
          context: input.context,
          provider: input.provider,
          toolName: input.toolName,
          args: input.args
        }),
        ownerLifecycle: requiresChildCapableLifecycle(input.toolName) ? 'launching-child' : 'run',
        ...(input.executionPid ? { executionPid: input.executionPid } : {})
      })
      if (admission.ok === false) {
        state.lifecycleOperation?.finish()
        return {
          ok: false,
          kind: 'admission',
          text: admission.text,
          reason: admission.reason
        }
      }
      state.admission = admission
      state.owner = admission.owner
      state.transitionId = admission.acquiredTransitionId

      if (!input.executionAuthorityStillLive()) {
        const cleanup = await this.cleanup(state, 'stale-operation')
        if (cleanup.resolved === false) {
          return this.releaseFailure(input.toolName, cleanup.reason)
        }
        return this.failure(
          input.toolName,
          'stale-authority',
          'Tool output was discarded because its exact run or chat authority changed.'
        )
      }

      let args = input.args
      let cwd = input.cwd
      let context = input.context
      let directMutationAuthority: ScopedPathAuthority | null = null

      if (admission.owner) {
        const runtime = this.requireRuntime(
          'Workspace-lock authority became unavailable before execution.'
        )
        if (!state.transitionId || !admission.runtimeInput) {
          throw new Error('Workspace mutation admission omitted its exact acquisition receipt.')
        }
        state.fence = await runtime.acquireMutationFence(admission.owner, admission.canonicalClaims)

        const refreshed = await runtime.replaceAcquisitionForMutation(
          admission.runtimeInput,
          admission.owner,
          state.transitionId
        )
        if (refreshed.ok === false) {
          throw new Error(`Workspace mutation refresh failed: ${refreshed.message}`)
        }
        state.transitionId = refreshed.authority.transitionId

        const verified = await runtime.verifyAcquisitionForMutation(
          admission.owner,
          state.transitionId
        )
        if (verified.ok === false) {
          throw new Error(`Workspace mutation verification failed: ${verified.message}`)
        }

        const handedOff = await this.handoff({
          input,
          admission,
          args,
          cwd,
          capabilities: verified.capabilities
        })
        args = handedOff.args
        cwd = handedOff.cwd
        context = {
          ...input.context,
          cwd,
          workspacePath: handedOff.workspacePath
        }
        directMutationAuthority = handedOff.directMutationAuthority

        const finalOwner = admission.owner
        const finalTransitionId = state.transitionId
        const assertMutationStillLive = (): void => {
          if (!input.executionAuthorityStillLive()) {
            throw new Error('Workspace mutation authority expired at the executor commit boundary.')
          }
          if (
            input.historyClearAdmissionBlocked(
              finalOwner.runId,
              context.workspacePath,
              finalOwner.chatId
            )
          ) {
            throw new Error('Workspace mutation was revoked by a concurrent history clear.')
          }
        }
        context = {
          ...context,
          assertMutationStillLive,
          assertMutationAuthorized: async () => {
            assertMutationStillLive()
            const currentRuntime = this.requireRuntime(
              'Workspace-lock authority disappeared at the executor commit boundary.'
            )
            const finalVerification = await currentRuntime.verifyAcquisitionForMutation(
              finalOwner,
              finalTransitionId
            )
            if (finalVerification.ok === false) {
              throw new Error(
                `Workspace mutation final verification failed: ${finalVerification.message}`
              )
            }
            assertMutationStillLive()
          },
          workspaceLockOwnerId: finalOwner.lockOwnerId,
          workspaceLockLifecycle: this.childLifecycle(state, assertMutationStillLive)
        }
      }

      if (!input.executionAuthorityStillLive()) {
        throw new Error('Workspace mutation authority expired before executor dispatch.')
      }

      return {
        ok: true,
        args,
        cwd,
        context,
        directMutationAuthority,
        finish: () => {
          state.finishRequested = true
          return this.cleanup(state, 'operation', true)
        }
      }
    } catch (error) {
      const cleanup = await this.cleanup(state, 'preparation')
      if (cleanup.resolved === false) {
        return this.releaseFailure(input.toolName, cleanup.reason)
      }
      return this.failure(
        input.toolName,
        'execution-preparation',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  private async handoff(input: {
    input: WorkspaceLockMcpExecutionPrepareInput<Context>
    admission: Extract<WorkspaceLockMcpAdmission, { ok: true }>
    args: Record<string, unknown>
    cwd: string
    capabilities: readonly WorkspaceLockMutationCapability[]
  }): Promise<{
    args: Record<string, unknown>
    cwd: string
    workspacePath: string
    directMutationAuthority: ScopedPathAuthority | null
  }> {
    const externalAuthority = input.admission.runtimeInput?.externalMutationAuthority
    if (
      externalAuthority &&
      (input.input.toolName === 'write_file' || input.input.toolName === 'replace')
    ) {
      const workspaceCapability = input.capabilities.find(
        (capability) => capability.kind === 'workspace'
      )
      if (!workspaceCapability || input.capabilities.length !== 1) {
        throw new Error('External mutation verification did not return one workspace capability.')
      }
      const runtimeInput = requireRuntimeInput(input.admission)
      const exactExternalTarget = await this.requireRuntime(
        'Workspace-lock authority disappeared during external-target revalidation.'
      ).revalidateExternalMutationTarget(runtimeInput)
      const {
        path: _path,
        file_path: _filePath,
        filePath: _camelFilePath,
        file: _file,
        target: _target,
        targetPath: _targetPath,
        ...nonPathArgs
      } = input.args
      const cwd = workspaceCapability.verifiedPathEvidence.containment.canonicalRootPath
      return {
        args: { ...nonPathArgs, path: exactExternalTarget },
        cwd,
        workspacePath: cwd,
        directMutationAuthority: {
          rootPath: dirname(exactExternalTarget),
          targetPath: exactExternalTarget
        }
      }
    }

    const handoff = prepareVerifiedWorkspaceMutationHandoff({
      toolName: input.input.toolName,
      args: input.args,
      capabilities: input.capabilities,
      requestedCwd: String(
        input.args.cwd || input.args.working_directory || input.args.workdir || ''
      ),
      effectiveCwd: input.cwd
    })
    if (handoff.ok === false) {
      throw new Error(
        `Workspace mutation capability handoff failed (${handoff.reason}): ${handoff.message}`
      )
    }

    let directMutationAuthority: ScopedPathAuthority | null = null
    if (input.input.toolName === 'write_file' || input.input.toolName === 'replace') {
      const [targetPath] = handoff.executionContext.executableTargetPaths
      if (!targetPath || handoff.executionContext.executableTargetPaths.length !== 1) {
        throw new Error('Direct workspace mutation requires one verified target path.')
      }
      directMutationAuthority = {
        rootPath: handoff.executionContext.workspacePath,
        targetPath
      }
    }
    return {
      args: handoff.args,
      cwd: handoff.executionContext.cwd,
      workspacePath: handoff.executionContext.workspacePath,
      directMutationAuthority
    }
  }

  private childLifecycle(
    state: ExecutionState,
    assertMutationStillLive: () => void
  ): WorkspaceLockMcpChildLifecycle {
    return {
      bind: async (input) => {
        const result = await this.enqueueTransition(state, () =>
          this.bindChild(state, input, assertMutationStillLive)
        )
        if (result.resolved === false) throw new Error(result.reason)
      },
      release: async (input) => {
        if (!input) return
        if (!state.childReleasePromise) {
          state.childReleasePromise = this.enqueueTransition(state, () =>
            this.releaseChild(state, input)
          )
        }
        const result = await state.childReleasePromise
        if (result.resolved === false) throw new Error(result.reason)
      }
    }
  }

  private async bindChild(
    state: ExecutionState,
    input: WorkspaceLockMcpChildLifecycleInput,
    assertMutationStillLive: () => void
  ): Promise<WorkspaceLockMcpExecutionCleanupResult> {
    if (
      !Number.isSafeInteger(input.pid) ||
      input.pid <= 0 ||
      !input.workspaceLockOwnerId ||
      input.workspaceLockOwnerId !== input.workspaceLockOwnerId.trim()
    ) {
      throw new Error('Workspace-lock child binding requires an exact PID and owner id.')
    }
    if (state.finishRequested) {
      throw new Error('Workspace-lock child binding cannot begin after operation finish.')
    }
    if (state.boundChild) {
      throw new Error('Workspace-lock mutation operation already bound one child process.')
    }
    const admission = state.admission
    const currentOwner = state.owner
    const currentTransitionId = state.transitionId
    if (
      !admission?.releaseAfterOperation ||
      !currentOwner ||
      !currentTransitionId ||
      input.workspaceLockOwnerId !== currentOwner.lockOwnerId ||
      (currentOwner.lifecycle !== 'launching-child' && currentOwner.lifecycle !== 'child')
    ) {
      throw new Error('Workspace-lock child binding has no exact operation acquisition.')
    }
    if (!state.fence) {
      throw new Error('Workspace-lock child binding lost its commit-fence phase.')
    }

    assertMutationStillLive()
    const runtime = this.requireRuntime(
      'Workspace-lock authority disappeared before child binding.'
    )
    const verified = await runtime.verifyAcquisitionForMutation(currentOwner, currentTransitionId)
    if (verified.ok === false) {
      throw new Error(`Workspace mutation child verification failed: ${verified.message}`)
    }
    const transferred = await runtime.transferAcquisition(currentOwner, currentTransitionId, {
      lockOwnerId: currentOwner.lockOwnerId,
      runId: currentOwner.runId,
      lifecycle: 'child',
      ...(currentOwner.laneId ? { laneId: currentOwner.laneId } : {}),
      ...(currentOwner.chatId ? { chatId: currentOwner.chatId } : {}),
      ...(currentOwner.provider ? { provider: currentOwner.provider } : {}),
      ...(currentOwner.participantId ? { participantId: currentOwner.participantId } : {}),
      ...(currentOwner.displayName ? { displayName: currentOwner.displayName } : {}),
      ...(currentOwner.chatTitle ? { chatTitle: currentOwner.chatTitle } : {}),
      executionPid: input.pid
    })
    if (transferred.ok === false) {
      throw new Error(`Workspace mutation child transfer failed: ${transferred.message}`)
    }
    if (
      transferred.owner.lockOwnerId !== currentOwner.lockOwnerId ||
      transferred.owner.runId !== currentOwner.runId ||
      transferred.owner.lifecycle !== 'child' ||
      transferred.owner.pid !== input.pid
    ) {
      return this.unresolved(
        state,
        'child-bind',
        'Workspace mutation child transfer returned a different exact owner.'
      )
    }
    state.owner = transferred.owner
    state.transitionId = transferred.authority.transitionId
    state.boundChild = { ...input }

    const fenceRelease = this.releaseFence(state, 'child-bind')
    if (fenceRelease.resolved === false) return fenceRelease
    assertMutationStillLive()
    return { resolved: true }
  }

  private async releaseChild(
    state: ExecutionState,
    input: WorkspaceLockMcpChildLifecycleInput
  ): Promise<WorkspaceLockMcpExecutionCleanupResult> {
    const bound = state.boundChild
    if (!bound) {
      // Bind can fail before transfer. The ordinary outer cleanup still owns
      // the main-process acquisition in that case.
      return { resolved: true }
    }
    if (bound.pid !== input.pid || bound.workspaceLockOwnerId !== input.workspaceLockOwnerId) {
      return this.unresolved(
        state,
        'child-close',
        'Workspace-lock child close did not match the bound exact owner.'
      )
    }
    if (state.fatalReason) {
      return { resolved: false, reason: state.fatalReason }
    }
    const treeStopped = (await this.deps.confirmChildMutationTreeStopped?.(input)) === true
    if (!treeStopped) {
      const reason =
        'Workspace-lock child process-tree death is unproven; acquisition was retained for quarantine.'
      this.deps.logError?.('child-close workspace-lock retention', new Error(reason))
      return { resolved: false, reason }
    }
    state.boundChild = undefined
    return this.performCleanup(state, 'child-close', false)
  }

  private cleanup(
    state: ExecutionState,
    scope: string,
    allowBoundChildHandoff = false
  ): Promise<WorkspaceLockMcpExecutionCleanupResult> {
    if (state.cleanupPromise) return state.cleanupPromise
    state.cleanupPromise = this.enqueueTransition(state, () =>
      this.performCleanup(state, scope, allowBoundChildHandoff)
    )
    return state.cleanupPromise
  }

  private async performCleanup(
    state: ExecutionState,
    scope: string,
    allowBoundChildHandoff = false
  ): Promise<WorkspaceLockMcpExecutionCleanupResult> {
    if (state.fatalReason) return { resolved: false, reason: state.fatalReason }
    const fenceRelease = this.releaseFence(state, scope)
    if (fenceRelease.resolved === false) return fenceRelease
    if (state.boundChild && allowBoundChildHandoff) return { resolved: true }
    if (state.boundChild) {
      return {
        resolved: false,
        reason: 'Workspace-lock child acquisition remains bound to a live or unproven process tree.'
      }
    }

    const admission = state.admission
    if (admission?.releaseAfterOperation && state.transitionId && state.owner) {
      const runtime = this.deps.getRuntime()
      if (!runtime) {
        return this.unresolved(
          state,
          scope,
          'Exact acquisition ownership became unresolved because the runtime disappeared.'
        )
      }
      try {
        const released = await runtime.releaseAcquisition(state.owner.runId, state.transitionId)
        if (released.ok === false) throw new Error(released.message)
        state.transitionId = undefined
        state.owner = undefined
        state.boundChild = undefined
      } catch (error) {
        return this.unresolved(
          state,
          scope,
          error instanceof Error ? error.message : String(error),
          error
        )
      }
    }

    state.lifecycleOperation?.finish()
    state.lifecycleOperation = null
    return { resolved: true }
  }

  private releaseFence(
    state: ExecutionState,
    scope: string
  ): WorkspaceLockMcpExecutionCleanupResult {
    if (!state.fence) return { resolved: true }
    const runtime = this.deps.getRuntime()
    if (!runtime) {
      return this.unresolved(
        state,
        scope,
        'Mutation-fence ownership became unresolved because the runtime disappeared.'
      )
    }
    try {
      runtime.releaseMutationFence(state.fence)
      state.fence = null
      return { resolved: true }
    } catch (error) {
      return this.unresolved(
        state,
        scope,
        error instanceof Error ? error.message : String(error),
        error
      )
    }
  }

  private enqueueTransition<T>(state: ExecutionState, operation: () => Promise<T> | T): Promise<T> {
    const result = state.transitionQueue.then(operation, operation)
    state.transitionQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private unresolved(
    state: ExecutionState,
    scope: string,
    reason: string,
    error: unknown = new Error(reason)
  ): WorkspaceLockMcpExecutionCleanupResult {
    state.fatalReason ||= reason
    this.deps.poison(reason)
    this.deps.logError?.(`${scope} workspace-lock release`, error)
    return { resolved: false, reason }
  }

  private requireRuntime(message: string): WorkspaceLockMcpExecutionRuntime {
    const runtime = this.deps.getRuntime()
    if (!runtime) throw new Error(message)
    return runtime
  }

  private releaseFailure(toolName: string, reason: string): WorkspaceLockMcpExecutionFailure {
    const unhealthy = this.deps.getRuntime()?.getUnhealthyReason()
    return this.failure(
      toolName,
      'release-failed',
      unhealthy || reason || 'Workspace-lock release failed; future mutations are blocked.',
      'workspace_lock_release_failed'
    )
  }

  private failure(
    toolName: string,
    kind: WorkspaceLockMcpExecutionFailureKind,
    reason: string,
    code?: string
  ): WorkspaceLockMcpExecutionFailure {
    return {
      ok: false,
      kind,
      reason,
      text: this.deps.encode({
        ok: false,
        tool: toolName,
        ...(code ? { code } : {}),
        error: reason
      })
    }
  }
}

function isWorkspaceLock(lock: string): boolean {
  return (
    lock === 'workspace-paths' || lock === 'workspace-repository' || lock === 'workspace-runtime'
  )
}

const IN_PROCESS_WORKSPACE_MUTATIONS = new Set([
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path',
  'replace',
  'write_file'
])

function requiresChildCapableLifecycle(toolName: string): boolean {
  return !IN_PROCESS_WORKSPACE_MUTATIONS.has(toolName)
}

function requireRuntimeInput(
  admission: Extract<WorkspaceLockMcpAdmission, { ok: true }>
): WorkspaceLockRuntimeAcquireInput {
  if (!admission.runtimeInput) {
    throw new Error('Workspace mutation admission omitted its exact runtime input.')
  }
  return admission.runtimeInput
}
