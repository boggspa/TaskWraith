import type { ProviderId } from './store/types'
import {
  WorkspaceLockExecutionIdentityRegistry,
  type WorkspaceLockExecutionIdentityScope
} from './WorkspaceLockExecutionIdentity'
import {
  type WorkspaceLockRuntime,
  type WorkspaceLockRuntimeAcquireInput,
  type WorkspaceLockRuntimeAcquireResult,
  type WorkspaceLockRuntimeOwnerInput
} from './WorkspaceLockRuntime'
import type { WorkspaceLockOwner } from './workLocks/WorkspaceLockTypes'

export interface WorkspaceLockProviderAdmission {
  runId: string
  owner: WorkspaceLockOwner
  transitionId: string
  workspacePath: string
  worktreePath: string
}

export interface WorkspaceLockProviderAdmissionKey {
  runId: string
  laneId?: string
  participantId?: string
}

interface WorkspaceLockProviderCoordinatorDependencies {
  getRuntime: () => WorkspaceLockRuntime | null
  identities?: WorkspaceLockExecutionIdentityRegistry
}

export class WorkspaceLockProviderCoordinator {
  private readonly identities: WorkspaceLockExecutionIdentityRegistry
  private readonly admissions = new Map<string, WorkspaceLockProviderAdmission>()
  private readonly pendingAdmissions = new Map<string, Promise<WorkspaceLockProviderAdmission>>()
  private readonly pendingTransfers = new Map<
    string,
    { executionPid: number; operation: Promise<WorkspaceLockProviderAdmission> }
  >()

  constructor(private readonly deps: WorkspaceLockProviderCoordinatorDependencies) {
    this.identities = deps.identities ?? new WorkspaceLockExecutionIdentityRegistry()
  }

  async admitCoarseWriteRun(input: {
    provider: ProviderId
    runId: string
    chatId?: string
    laneId?: string
    participantId?: string
    displayName?: string
    chatTitle?: string
    workspacePath: string
    worktreePath: string
  }): Promise<WorkspaceLockProviderAdmission> {
    const key = providerAdmissionKey(input)
    const existing = this.admissions.get(key)
    if (existing) return requireMatchingAdmission(existing, input)
    const pending = this.pendingAdmissions.get(key)
    if (pending) return requireMatchingAdmission(await pending, input)
    const operation = this.acquireCoarseWriteRun(input, key)
    this.pendingAdmissions.set(key, operation)
    try {
      return await operation
    } finally {
      if (this.pendingAdmissions.get(key) === operation) {
        this.pendingAdmissions.delete(key)
      }
    }
  }

  private async acquireCoarseWriteRun(
    input: {
      provider: ProviderId
      runId: string
      chatId?: string
      laneId?: string
      participantId?: string
      displayName?: string
      chatTitle?: string
      workspacePath: string
      worktreePath: string
    },
    key: string
  ): Promise<WorkspaceLockProviderAdmission> {
    const runtime = this.requireRuntime()
    const identityScope = logicalRunScope(input)
    const lockOwnerId = this.identities.getOrCreate(identityScope)
    const ownerInput: WorkspaceLockRuntimeOwnerInput = {
      lockOwnerId,
      runId: input.runId,
      // If main crashes anywhere between durable admission and exact child
      // transfer, recovery must quarantine this claim instead of assuming a
      // potentially running native child died with main.
      lifecycle: 'launching-child',
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.laneId ? { laneId: input.laneId } : {}),
      ...(input.participantId ? { participantId: input.participantId } : {}),
      provider: input.provider,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.chatTitle ? { chatTitle: input.chatTitle } : {})
    }
    const acquired = await runtime.acquire({
      owner: ownerInput,
      mutation: {
        source: 'provider-native',
        provider: input.provider,
        workspacePath: input.workspacePath,
        worktreePath: input.worktreePath,
        action: 'unobservable-write-surface'
      },
      coarseWorkspaceFallback: true
    })
    const admitted = requireAcquired(acquired)
    if (!admitted.claims.length || !admitted.authority.transitionId) {
      throw new Error('Write-capable provider launch did not acquire a workspace claim.')
    }
    const admission: WorkspaceLockProviderAdmission = {
      runId: input.runId,
      owner: admitted.owner,
      transitionId: admitted.authority.transitionId,
      workspacePath: input.workspacePath,
      worktreePath: input.worktreePath
    }
    this.admissions.set(key, admission)
    return admission
  }

  get(input: WorkspaceLockProviderAdmissionKey): WorkspaceLockProviderAdmission | null {
    return this.admissions.get(providerAdmissionKey(input)) ?? null
  }

  getOrCreateLogicalOwnerId(input: WorkspaceLockProviderAdmissionKey): string {
    return this.identities.getOrCreate(logicalRunScope(input))
  }

  ownerId(input: WorkspaceLockProviderAdmissionKey): string | null {
    return this.get(input)?.owner.lockOwnerId ?? null
  }

  async acquireNestedMutationSublease(
    input: WorkspaceLockProviderAdmissionKey,
    expectedAdmission: WorkspaceLockProviderAdmission,
    runtimeInput: WorkspaceLockRuntimeAcquireInput
  ): Promise<WorkspaceLockRuntimeAcquireResult> {
    const current = this.admissions.get(providerAdmissionKey(input))
    if (!current || current !== expectedAdmission) {
      throw new Error('Provider workspace-lock admission changed before nested acquisition.')
    }
    if (current.owner.lifecycle !== 'child') {
      throw new Error('Nested provider mutation requires an exact child-bound admission.')
    }
    if (
      current.runId !== runtimeInput.owner.runId ||
      current.owner.lockOwnerId !== runtimeInput.owner.lockOwnerId ||
      current.owner.provider !== runtimeInput.owner.provider ||
      current.owner.chatId !== runtimeInput.owner.chatId ||
      current.owner.laneId !== runtimeInput.owner.laneId ||
      current.owner.participantId !== runtimeInput.owner.participantId ||
      current.owner.pid !== runtimeInput.owner.executionPid ||
      current.workspacePath !== runtimeInput.mutation.workspacePath ||
      current.worktreePath !== runtimeInput.mutation.worktreePath
    ) {
      throw new Error('Nested provider mutation does not match its coarse admission scope.')
    }
    return this.requireRuntime().acquireMutationSubleaseForExactOwner(runtimeInput, current.owner)
  }

  async transferToChild(
    input: WorkspaceLockProviderAdmissionKey,
    executionPid: number
  ): Promise<WorkspaceLockProviderAdmission> {
    const key = providerAdmissionKey(input)
    const current = this.admissions.get(key)
    if (current?.owner.lifecycle === 'child') {
      if (current.owner.pid === executionPid) return current
      throw new Error('Provider workspace-lock admission is still bound to another child process.')
    }
    const pending = this.pendingTransfers.get(key)
    if (pending) {
      if (pending.executionPid !== executionPid) {
        throw new Error('A provider workspace-lock transfer already targets another child.')
      }
      return pending.operation
    }
    const operation = this.performTransferToChild(key, executionPid)
    this.pendingTransfers.set(key, { executionPid, operation })
    try {
      return await operation
    } finally {
      if (this.pendingTransfers.get(key)?.operation === operation) {
        this.pendingTransfers.delete(key)
      }
    }
  }

  private async performTransferToChild(
    key: string,
    executionPid: number
  ): Promise<WorkspaceLockProviderAdmission> {
    const current = this.admissions.get(key)
    if (!current) throw new Error('Provider run has no exact workspace-lock admission.')
    const runtime = this.requireRuntime()
    const transferred = await runtime.transferAcquisition(current.owner, current.transitionId, {
      lockOwnerId: current.owner.lockOwnerId,
      runId: current.owner.runId,
      ...(current.owner.chatId ? { chatId: current.owner.chatId } : {}),
      ...(current.owner.laneId ? { laneId: current.owner.laneId } : {}),
      ...(current.owner.participantId ? { participantId: current.owner.participantId } : {}),
      ...(current.owner.provider ? { provider: current.owner.provider } : {}),
      ...(current.owner.displayName ? { displayName: current.owner.displayName } : {}),
      ...(current.owner.chatTitle ? { chatTitle: current.owner.chatTitle } : {}),
      executionPid
    })
    const admitted = requireAcquired(transferred)
    const next: WorkspaceLockProviderAdmission = {
      ...current,
      owner: admitted.owner,
      transitionId: admitted.authority.transitionId
    }
    this.admissions.set(key, next)
    return next
  }

  async releaseSetupFailure(
    input: WorkspaceLockProviderAdmissionKey,
    expectedAdmission: WorkspaceLockProviderAdmission
  ): Promise<void> {
    const current = this.admissions.get(providerAdmissionKey(input))
    if (!current || current !== expectedAdmission) return
    if (current.owner.lifecycle !== 'launching-child') {
      throw new Error('Provider setup-failure release requires a pre-transfer guardian.')
    }
    await this.releaseAdmission(input)
  }

  /**
   * Releases an exact child-held acquisition after the owning process has
   * emitted its real close event. A terminal run cleanup deliberately retains
   * this coordinator entry while the child is live so close can still settle
   * the durable transition. The admission object is an incarnation receipt:
   * a stale close from a superseded child must not release its replacement.
   */
  async releaseChild(
    input: WorkspaceLockProviderAdmissionKey,
    childAdmission: WorkspaceLockProviderAdmission
  ): Promise<void> {
    const key = providerAdmissionKey(input)
    const current = this.admissions.get(key)
    if (!current) return
    if (current !== childAdmission) return
    if (current.owner.lifecycle !== 'child') {
      throw new Error('Provider workspace-lock admission is not owned by a child process.')
    }
    await this.releaseAdmission(input)
  }

  private async releaseAdmission(input: WorkspaceLockProviderAdmissionKey): Promise<void> {
    const key = providerAdmissionKey(input)
    const current = this.admissions.get(key)
    if (!current) return
    const runtime = this.requireRuntime()
    const released = await runtime.releaseAcquisition(current.runId, current.transitionId)
    if (!released.ok) throw new Error(released.message)
    this.admissions.delete(key)
    this.releaseIdentityIfUnused(current.runId)
  }

  forgetRun(runId: string): void {
    for (const [key, admission] of this.admissions) {
      if (
        admission.runId === runId &&
        admission.owner.lifecycle !== 'child' &&
        admission.owner.lifecycle !== 'launching-child'
      ) {
        this.admissions.delete(key)
      }
    }
    this.releaseIdentityIfUnused(runId)
  }

  private releaseIdentityIfUnused(runId: string): void {
    if ([...this.admissions.values()].some((admission) => admission.runId === runId)) return
    this.identities.releaseLogicalRun(runId)
  }

  private requireRuntime(): WorkspaceLockRuntime {
    const runtime = this.deps.getRuntime()
    if (!runtime) throw new Error('Workspace-lock runtime is unavailable.')
    const unhealthy = runtime.getUnhealthyReason()
    if (unhealthy) throw new Error(`Workspace-lock runtime is fail-closed: ${unhealthy}`)
    return runtime
  }
}

function providerAdmissionKey(input: WorkspaceLockProviderAdmissionKey): string {
  return [input.runId, input.laneId || '', input.participantId || ''].join('\u0000')
}

function requireMatchingAdmission(
  admission: WorkspaceLockProviderAdmission,
  input: {
    provider: ProviderId
    runId: string
    laneId?: string
    participantId?: string
    workspacePath: string
    worktreePath: string
  }
): WorkspaceLockProviderAdmission {
  if (
    admission.runId !== input.runId ||
    admission.owner.provider !== input.provider ||
    (admission.owner.laneId || '') !== (input.laneId || '') ||
    (admission.owner.participantId || '') !== (input.participantId || '') ||
    admission.workspacePath !== input.workspacePath ||
    admission.worktreePath !== input.worktreePath
  ) {
    throw new Error('Provider workspace-lock admission was reused with different authority.')
  }
  return admission
}

function logicalRunScope(input: {
  runId: string
  laneId?: string
  participantId?: string
}): WorkspaceLockExecutionIdentityScope {
  return {
    kind: 'logical-run',
    runId: input.runId,
    ...(input.laneId ? { laneId: input.laneId } : {}),
    ...(input.participantId ? { participantId: input.participantId } : {})
  }
}

function requireAcquired(
  result: WorkspaceLockRuntimeAcquireResult
): Extract<WorkspaceLockRuntimeAcquireResult, { ok: true }> {
  if (!result.ok) throw new Error(result.message)
  return result
}
