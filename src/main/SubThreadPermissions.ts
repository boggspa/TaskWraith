import { resolve } from 'node:path'
import type {
  AgenticServiceId,
  AgenticServicePolicy,
  EffectiveRunPermissions,
  ExternalPathGrant
} from './store/types'
import { stripUltraTaskDelegationAutoAllow } from './UltraTaskDelegationConsent'

/**
 * The resolved permissions a delegated sub-thread should run under.
 *
 * A sub-thread must never be MORE permissive than its delegator, so it inherits
 * the parent run's effective posture — notably read_only's shellCommands /
 * fileChanges denies — after dropping parent-bound external-path bearer
 * grants. When the parent has no explicit posture (undefined), the sub-thread
 * falls back to global settings, unchanged from the pre-fix behaviour for
 * non-posture runs.
 *
 * SECURITY: without this inheritance a read-only participant could delegate a
 * write. The delegated sub-thread session would carry no effectivePermissions,
 * so the host gate (requestAgenticServiceApproval) resolves the call against
 * GLOBAL settings (default 'ask' / 'allow') instead of the parent's read_only
 * denies — a real read-only escape on the delegating seat.
 */
export function inheritedSubThreadPermissions(parent: {
  effectivePermissions?: EffectiveRunPermissions
}): EffectiveRunPermissions | undefined {
  if (!parent.effectivePermissions) return undefined
  // External-path grants are signed bearer capabilities bound to the parent
  // chat/run. A child cannot safely inherit them: main must issue a fresh grant
  // for the child identity if that workflow is ever added. Fail closed today.
  return {
    ...clonePermissions(parent.effectivePermissions),
    externalPathGrants: []
  }
}

export type SubThreadWorkerIsolationRequest =
  | { kind: 'read_only' }
  /** Same-checkout inherit of parent posture with Full Access demoted and parent grants stripped — used by ephemeral fleet worker/reviewer roles. */
  | { kind: 'capped_inherit' }
  | {
      kind: 'worktree'
      baseWorkspacePath: string
      effectiveWorkspacePath: string
    }
  | {
      kind: 'direct_checkout'
      workspacePath: string
      writeScopes: string[]
      leaseId?: string
      /** True only for runtimes whose writes are routed through TaskWraith's
       * scope validator and the durable workspace-lock authority. Opaque
       * native CLI writes must leave this false and are rejected. */
      lockAwareHostEnforcement?: boolean
    }

export interface ResolveSubThreadWorkerPermissionsInput {
  parentPermissions?: EffectiveRunPermissions
  /** Trusted main-derived read_only preset for this provider/workspace. */
  readOnlyPermissions: EffectiveRunPermissions
  isolation?: SubThreadWorkerIsolationRequest
}

export type SubThreadWorkerPermissionDecision =
  | {
      ok: true
      isolation: 'read_only' | 'capped_inherit' | 'worktree' | 'direct_checkout'
      effectivePermissions: EffectiveRunPermissions
      sessionTrust: false
      effectiveWorkspacePath?: string
      writeScopes?: string[]
      leaseId?: string
    }
  | {
      ok: false
      isolation: 'worktree' | 'direct_checkout'
      reason: string
      sessionTrust: false
    }

const POLICY_RANK: Record<AgenticServicePolicy, number> = {
  deny: 0,
  ask: 1,
  workspace: 2,
  allow: 3
}

function stricterPolicy(
  left: AgenticServicePolicy,
  right: AgenticServicePolicy
): AgenticServicePolicy {
  return POLICY_RANK[left] <= POLICY_RANK[right] ? left : right
}

function cloneGrant(grant: ExternalPathGrant): ExternalPathGrant {
  return { ...grant }
}

function clonePermissions(permissions: EffectiveRunPermissions): EffectiveRunPermissions {
  return stripUltraTaskDelegationAutoAllow({
    ...permissions,
    agenticServices: { ...permissions.agenticServices },
    externalPathGrants: permissions.externalPathGrants.map(cloneGrant),
    workspaceGrantServiceIds: [...permissions.workspaceGrantServiceIds]
  })
}

function capAtReadOnly(
  parent: EffectiveRunPermissions | undefined,
  readOnly: EffectiveRunPermissions
): EffectiveRunPermissions {
  const parentPermissions = parent || readOnly
  const serviceIds = Object.keys(readOnly.agenticServices) as AgenticServiceId[]
  const agenticServices = { ...readOnly.agenticServices }
  for (const service of serviceIds) {
    agenticServices[service] = stricterPolicy(
      parentPermissions.agenticServices[service] || 'deny',
      readOnly.agenticServices[service] || 'deny'
    )
  }
  return {
    ...clonePermissions(readOnly),
    presetId: 'read_only',
    approvalMode: 'plan',
    agenticServices,
    networkAccess:
      parentPermissions.networkAccess === 'deny' || readOnly.networkAccess === 'deny'
        ? 'deny'
        : 'allow',
    externalPathGrants: [],
    workspaceGrantServiceIds: parentPermissions.workspaceGrantServiceIds.filter(
      (service) => agenticServices[service] === 'workspace'
    ),
    readOnly: true
  }
}

function capWriterPermissions(
  parent: EffectiveRunPermissions,
  readOnly: EffectiveRunPermissions
): EffectiveRunPermissions {
  if (parent.readOnly) return capAtReadOnly(parent, readOnly)
  const capped = clonePermissions(parent)
  return {
    ...capped,
    // Never let an async worker drop the provider sandbox. An isolated
    // worktree/direct-checkout lease needs workspace writes, not host access.
    presetId: capped.presetId === 'full_access' ? 'workspace_write' : capped.presetId,
    externalPathGrants: [],
    readOnly: false
  }
}

function normalizedWriteScopes(scopes: readonly string[]): string[] | null {
  const normalized = [...new Set(scopes.map((scope) => scope.trim().replace(/\\/g, '/')))]
    .filter(Boolean)
  if (normalized.length === 0 || normalized.length > 32) return null
  for (const scope of normalized) {
    if (
      scope === '.' ||
      scope === '*' ||
      scope === '**' ||
      scope.startsWith('/') ||
      /^[A-Za-z]:\//.test(scope) ||
      scope.split('/').includes('..')
    ) {
      return null
    }
  }
  return normalized
}

function parentCanWrite(parent: EffectiveRunPermissions): boolean {
  return (
    !parent.readOnly &&
    (parent.agenticServices.fileChanges !== 'deny' ||
      parent.agenticServices.shellCommands !== 'deny')
  )
}

export function resolveSubThreadWorkerPermissions(
  input: ResolveSubThreadWorkerPermissionsInput
): SubThreadWorkerPermissionDecision {
  const isolation = input.isolation || { kind: 'read_only' as const }
  if (isolation.kind === 'read_only') {
    return {
      ok: true,
      isolation: 'read_only',
      effectivePermissions: capAtReadOnly(input.parentPermissions, input.readOnlyPermissions),
      sessionTrust: false
    }
  }

  if (isolation.kind === 'capped_inherit') {
    return {
      ok: true,
      isolation: 'capped_inherit',
      effectivePermissions: input.parentPermissions
        ? capWriterPermissions(input.parentPermissions, input.readOnlyPermissions)
        : capAtReadOnly(undefined, input.readOnlyPermissions),
      sessionTrust: false
    }
  }

  if (isolation.kind === 'worktree') {
    const baseWorkspacePath = isolation.baseWorkspacePath.trim()
    const effectiveWorkspacePath = isolation.effectiveWorkspacePath.trim()
    if (
      !baseWorkspacePath ||
      !effectiveWorkspacePath ||
      resolve(baseWorkspacePath) === resolve(effectiveWorkspacePath)
    ) {
      return {
        ok: false,
        isolation: 'worktree',
        reason: 'Async writer worktree must resolve to a path distinct from the parent checkout.',
        sessionTrust: false
      }
    }
    return {
      ok: true,
      isolation: 'worktree',
      effectivePermissions: input.parentPermissions
        ? capWriterPermissions(input.parentPermissions, input.readOnlyPermissions)
        : capAtReadOnly(undefined, input.readOnlyPermissions),
      sessionTrust: false,
      effectiveWorkspacePath: resolve(effectiveWorkspacePath)
    }
  }

  const writeScopes = normalizedWriteScopes(isolation.writeScopes)
  const leaseId = isolation.leaseId?.trim()
  const workspacePath = isolation.workspacePath.trim()
  if (!input.parentPermissions || !parentCanWrite(input.parentPermissions)) {
    return {
      ok: false,
      isolation: 'direct_checkout',
      reason: 'Direct-checkout async writes cannot exceed the parent worker permission ceiling.',
      sessionTrust: false
    }
  }
  if (!workspacePath || !writeScopes) {
    return {
      ok: false,
      isolation: 'direct_checkout',
      reason: 'Direct-checkout async writes require one or more narrow workspace-relative scopes.',
      sessionTrust: false
    }
  }
  if (!leaseId || isolation.lockAwareHostEnforcement !== true) {
    return {
      ok: false,
      isolation: 'direct_checkout',
      reason:
        'Direct-checkout async writes require a live write lease and lock-aware TaskWraith host enforcement; opaque native CLI writes are not eligible.',
      sessionTrust: false
    }
  }
  return {
    ok: true,
    isolation: 'direct_checkout',
    effectivePermissions: capWriterPermissions(
      input.parentPermissions,
      input.readOnlyPermissions
    ),
    sessionTrust: false,
    effectiveWorkspacePath: resolve(workspacePath),
    writeScopes,
    leaseId
  }
}
