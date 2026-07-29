import { resolve } from 'node:path'

import { resolveToolDispatchContractStrict } from '../shared/providerActionTaxonomy'
import type { ChatScope, EnsembleRunIdentity, ProviderId } from './store/types'
import type {
  WorkspaceExternalMutationAuthorityReceipt,
  WorkspaceLockRuntime,
  WorkspaceLockRuntimeAcquireResult,
  WorkspaceLockRuntimeAcquireInput
} from './WorkspaceLockRuntime'
import type {
  CanonicalWorkspaceLockClaim,
  WorkspaceLockClaimRequest,
  WorkspaceLockOwner
} from './workLocks/WorkspaceLockTypes'

export interface WorkspaceLockMcpAdmissionContext {
  scope: ChatScope
  cwd: string
  workspacePath?: string
  appRunId?: string
  appChatId?: string
  ensembleRun?: EnsembleRunIdentity
}

export interface WorkspaceLockMcpAdmissionChat {
  workspacePath?: string
  title?: string
}

export interface WorkspaceLockMcpOwnerIdentityQuery {
  runId: string
  provider: ProviderId
  chatId?: string
  laneId?: string
  participantId?: string
}

export interface WorkspaceLockMcpLaneScopeQuery {
  toolName: string
  workspacePath: string
  /** Exact executor resource. Undefined means workspace-wide scope is required. */
  resourcePath: string | undefined
}

export type WorkspaceLockMcpLaneScopeDecision = { ok: true } | { ok: false; reason: string }

export interface WorkspaceLockMcpProviderScopeAdmission {
  runId: string
  owner: WorkspaceLockOwner
  transitionId: string
  workspacePath: string
  worktreePath: string
}

export interface WorkspaceLockMcpProviderSubleaseInput {
  admission: WorkspaceLockMcpProviderScopeAdmission
  runtimeInput: WorkspaceLockRuntimeAcquireInput
}

export interface WorkspaceLockMcpAdmissionCoordinatorDependencies {
  getRuntime: () => Pick<WorkspaceLockRuntime, 'acquire'> | null
  getRuntimeUnavailableReason?: () => string | null | undefined
  getChat: (chatId: string) => WorkspaceLockMcpAdmissionChat | null | undefined
  getOpaqueOwnerId: (query: WorkspaceLockMcpOwnerIdentityQuery) => string | null | undefined
  getProviderScopeAdmission: (
    query: WorkspaceLockMcpOwnerIdentityQuery
  ) => WorkspaceLockMcpProviderScopeAdmission | null | undefined
  acquireProviderScopeSublease: (
    input: WorkspaceLockMcpProviderSubleaseInput
  ) => Promise<WorkspaceLockRuntimeAcquireResult>
  validateLaneWriteScope: (
    runId: string,
    query: WorkspaceLockMcpLaneScopeQuery
  ) => WorkspaceLockMcpLaneScopeDecision | undefined
  markLaneBlocked: (runId: string, reason: string) => void
  encode: (payload: Readonly<Record<string, unknown>>) => string
  providerDisplayName: (provider: ProviderId) => string
}

export interface WorkspaceLockMcpAdmissionInput<
  Context extends WorkspaceLockMcpAdmissionContext = WorkspaceLockMcpAdmissionContext
> {
  context: Context
  provider: ProviderId
  toolName: string
  args: Record<string, unknown>
  /**
   * Pre-resolved exact executor resource. The coordinator passes these bytes to
   * lane validation unchanged and never guesses a target from another field.
   */
  resourcePath?: string
  externalMutationAuthority?: WorkspaceExternalMutationAuthorityReceipt
  executionPid?: number
  /**
   * Subprocess-capable broker operations persist a launching-child owner before
   * raw spawn. POSIX may additionally use an inert gate, but Windows safety
   * relies on this durable pre-spawn lifecycle.
   */
  ownerLifecycle?: 'run' | 'launching-child'
}

export type WorkspaceLockMcpAdmission =
  | {
      ok: true
      owner?: WorkspaceLockOwner
      claims: WorkspaceLockClaimRequest[]
      canonicalClaims: CanonicalWorkspaceLockClaim[]
      claimsHeld: boolean
      acquiredTransitionId?: string
      releaseAfterOperation: boolean
      runtimeInput?: WorkspaceLockRuntimeAcquireInput
    }
  | {
      ok: false
      text: string
      reason: string
    }

/**
 * Main-process MCP admission adapter. Strict taxonomy, exact run/owner
 * identity, lane envelope validation and durable acquisition converge here;
 * executors receive only the structured result.
 */
export class WorkspaceLockMcpAdmissionCoordinator {
  constructor(private readonly deps: WorkspaceLockMcpAdmissionCoordinatorDependencies) {}

  async admit(input: WorkspaceLockMcpAdmissionInput): Promise<WorkspaceLockMcpAdmission> {
    const contract = resolveToolDispatchContractStrict(input.toolName, input.args)
    if (!contract.ok) {
      return this.denied(input.toolName, contract.reason, {
        code: contract.code
      })
    }
    if (
      contract.lock !== 'workspace-paths' &&
      contract.lock !== 'workspace-repository' &&
      contract.lock !== 'workspace-runtime'
    ) {
      return {
        ok: true,
        claims: [],
        canonicalClaims: [],
        claimsHeld: false,
        releaseAfterOperation: false
      }
    }
    if (input.context.scope === 'global') {
      const reason = `Workspace mutation ${input.toolName} requires an active workspace.`
      return this.denied(input.toolName, reason)
    }

    const runtime = this.deps.getRuntime()
    if (!runtime) {
      const reason =
        this.deps.getRuntimeUnavailableReason?.() ||
        'Workspace-lock authority is not available; mutation was not started.'
      return this.denied(input.toolName, reason)
    }

    const runId = exactRunId(input.context.appRunId)
    if (!runId) {
      const reason = `Workspace mutation ${input.toolName} has no exact run identity.`
      return this.denied(input.toolName, reason)
    }

    const effectiveWorkspacePath = resolve(input.context.workspacePath || input.context.cwd)
    const chat = input.context.appChatId ? this.deps.getChat(input.context.appChatId) : null
    const baseWorkspacePath = resolve(chat?.workspacePath || effectiveWorkspacePath)
    const laneId = input.context.ensembleRun?.laneId
    const scopeCheck = this.deps.validateLaneWriteScope(runId, {
      toolName: input.toolName,
      workspacePath: effectiveWorkspacePath,
      resourcePath: input.resourcePath
    })
    if (scopeCheck && !scopeCheck.ok) {
      this.deps.markLaneBlocked(runId, scopeCheck.reason)
      return this.denied(input.toolName, scopeCheck.reason, { laneId })
    }

    const ownerQuery = this.ownerQuery(input, runId)
    const providerScopeAdmission = this.deps.getProviderScopeAdmission(ownerQuery) || null
    const ownerInput = providerScopeAdmission
      ? exactProviderScopeOwner(
          providerScopeAdmission,
          ownerQuery,
          baseWorkspacePath,
          effectiveWorkspacePath,
          input.toolName,
          input.executionPid
        )
      : this.ownerInput(input, runId, chat, ownerQuery)
    if (!ownerInput.ok) {
      if (laneId) this.deps.markLaneBlocked(runId, ownerInput.reason)
      return this.denied(input.toolName, ownerInput.reason, {
        code: ownerInput.code,
        laneId
      })
    }
    const runtimeInput: WorkspaceLockRuntimeAcquireInput = {
      owner: ownerInput.owner,
      mutation: {
        source: 'taskwraith-catalog',
        provider: input.provider,
        workspacePath: baseWorkspacePath,
        worktreePath: effectiveWorkspacePath,
        action: input.toolName,
        args: input.args
      },
      externalMutationAuthority: input.externalMutationAuthority
    }
    const acquired = providerScopeAdmission
      ? await this.deps.acquireProviderScopeSublease({
          admission: providerScopeAdmission,
          runtimeInput
        })
      : await runtime.acquire(runtimeInput)
    if (!acquired.ok) {
      if (laneId) this.deps.markLaneBlocked(runId, acquired.message)
      return this.denied(input.toolName, acquired.message, {
        code: acquired.code,
        laneId
      })
    }
    if (providerScopeAdmission && !sameExactOwner(acquired.owner, providerScopeAdmission.owner)) {
      const reason = 'Provider-scope workspace-lock sublease returned a different exact owner.'
      if (laneId) this.deps.markLaneBlocked(runId, reason)
      return this.denied(input.toolName, reason, {
        code: 'owner_identity_unavailable',
        laneId
      })
    }

    return {
      ok: true,
      owner: acquired.claims.length ? acquired.owner : undefined,
      claims: acquired.claims,
      canonicalClaims: acquired.authority.leases.map((lease) => lease.claim),
      claimsHeld: acquired.claims.length > 0,
      ...(acquired.claims.length ? { acquiredTransitionId: acquired.authority.transitionId } : {}),
      releaseAfterOperation: true,
      runtimeInput
    }
  }

  private ownerInput(
    input: WorkspaceLockMcpAdmissionInput,
    runId: string,
    chat: WorkspaceLockMcpAdmissionChat | null | undefined,
    ownerQuery: WorkspaceLockMcpOwnerIdentityQuery
  ):
    | { ok: true; owner: WorkspaceLockRuntimeAcquireInput['owner'] }
    | { ok: false; code: string; reason: string } {
    const laneId = input.context.ensembleRun?.laneId
    const participantId = input.context.ensembleRun?.participantId
    if (
      input.executionPid !== undefined &&
      (!Number.isSafeInteger(input.executionPid) || input.executionPid <= 0)
    ) {
      return {
        ok: false,
        code: 'owner_identity_unavailable',
        reason: 'Workspace-lock execution PID must be a positive safe integer.'
      }
    }
    let lockOwnerId: string | null
    try {
      lockOwnerId = exactOpaqueOwnerId(this.deps.getOpaqueOwnerId(ownerQuery), runId)
    } catch (error) {
      return {
        ok: false,
        code: 'owner_identity_unavailable',
        reason:
          error instanceof Error
            ? error.message
            : 'Workspace-lock opaque owner identity is unavailable.'
      }
    }
    if (!lockOwnerId) {
      return {
        ok: false,
        code: 'owner_identity_unavailable',
        reason: `Workspace mutation ${input.toolName} has no exact opaque lock-owner identity.`
      }
    }
    return {
      ok: true,
      owner: {
        lockOwnerId,
        runId,
        ...(input.ownerLifecycle ? { lifecycle: input.ownerLifecycle } : {}),
        ...(laneId ? { laneId } : {}),
        ...(input.context.appChatId ? { chatId: input.context.appChatId } : {}),
        provider: input.provider,
        ...(participantId ? { participantId } : {}),
        displayName:
          input.context.ensembleRun?.role || this.deps.providerDisplayName(input.provider),
        ...(chat?.title ? { chatTitle: chat.title } : {}),
        ...(input.executionPid ? { executionPid: input.executionPid } : {})
      }
    }
  }

  private ownerQuery(
    input: WorkspaceLockMcpAdmissionInput,
    runId: string
  ): WorkspaceLockMcpOwnerIdentityQuery {
    return {
      runId,
      provider: input.provider,
      ...(input.context.appChatId ? { chatId: input.context.appChatId } : {}),
      ...(input.context.ensembleRun?.laneId ? { laneId: input.context.ensembleRun.laneId } : {}),
      ...(input.context.ensembleRun?.participantId
        ? { participantId: input.context.ensembleRun.participantId }
        : {})
    }
  }

  private denied(
    toolName: string,
    reason: string,
    details: { code?: string; laneId?: string } = {}
  ): WorkspaceLockMcpAdmission {
    return {
      ok: false,
      text: this.deps.encode({
        ok: false,
        tool: toolName,
        ...(details.code ? { code: details.code } : {}),
        error: reason,
        ...(details.laneId ? { laneId: details.laneId } : {})
      }),
      reason
    }
  }
}

function exactRunId(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value.trim()
}

function exactOpaqueOwnerId(value: string | null | undefined, runId: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (value !== value.trim() || value.includes('\u0000') || value.length > 256 || value === runId) {
    throw new Error('Workspace-lock opaque owner identity is malformed.')
  }
  return value
}

function exactProviderScopeOwner(
  admission: WorkspaceLockMcpProviderScopeAdmission,
  query: WorkspaceLockMcpOwnerIdentityQuery,
  workspacePath: string,
  worktreePath: string,
  toolName: string,
  executionPid: number | undefined
):
  | { ok: true; owner: WorkspaceLockRuntimeAcquireInput['owner'] }
  | { ok: false; code: string; reason: string } {
  const owner = admission.owner
  if (
    admission.runId !== query.runId ||
    owner.runId !== query.runId ||
    owner.provider !== query.provider ||
    (owner.chatId || undefined) !== query.chatId ||
    (owner.laneId || undefined) !== query.laneId ||
    (owner.participantId || undefined) !== query.participantId ||
    owner.lifecycle !== 'child' ||
    !owner.lockOwnerId ||
    owner.lockOwnerId !== owner.lockOwnerId.trim() ||
    owner.lockOwnerId.includes('\u0000') ||
    owner.lockOwnerId.length > 256 ||
    owner.lockOwnerId === query.runId ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !owner.processBirthIdentity ||
    !admission.transitionId ||
    (executionPid !== undefined && executionPid !== owner.pid) ||
    resolve(admission.workspacePath) !== workspacePath ||
    resolve(admission.worktreePath) !== worktreePath
  ) {
    return {
      ok: false,
      code: 'owner_identity_unavailable',
      reason: `Workspace mutation ${toolName} does not match its exact provider-scope lock admission.`
    }
  }
  return {
    ok: true,
    owner: {
      lockOwnerId: owner.lockOwnerId,
      runId: owner.runId,
      ...(owner.laneId ? { laneId: owner.laneId } : {}),
      ...(owner.chatId ? { chatId: owner.chatId } : {}),
      ...(owner.provider ? { provider: owner.provider } : {}),
      ...(owner.participantId ? { participantId: owner.participantId } : {}),
      ...(owner.displayName ? { displayName: owner.displayName } : {}),
      ...(owner.chatTitle ? { chatTitle: owner.chatTitle } : {}),
      executionPid: owner.pid
    }
  }
}

function sameExactOwner(left: WorkspaceLockOwner, right: WorkspaceLockOwner): boolean {
  return (
    left.lockOwnerId === right.lockOwnerId &&
    left.runId === right.runId &&
    (left.lifecycle || 'run') === (right.lifecycle || 'run') &&
    left.pid === right.pid &&
    left.processBirthIdentity === right.processBirthIdentity
  )
}
