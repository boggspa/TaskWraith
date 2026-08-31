import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import type { TaskWraithMcpToolDefinition } from '../McpToolCatalog'
import type { ProviderId, TaskWraithMcpProfileId } from '../store/types'
import type { TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import type {
  PermissionOpportunityBinding,
  PermissionOpportunityBoundaryCode,
  PermissionOpportunityRegistry
} from './PermissionOpportunityRegistry'
import {
  buildPermissionOpportunityRedemptionInstruction,
  isUnscopedProcessAuthorityTool,
  validateHostIssuedToolPermissionRetryRequest,
  type PermissionOpportunityRedemptionInstruction,
  type ToolPermissionOpportunityResolver
} from './ToolPermissionRetry'

export interface PermissionOpportunityBindingInput {
  provider: ProviderId
  runId?: string | null
  chatId?: string | null
  profileId?: TaskWraithMcpProfileId | null
  workspaceId?: string | null
  primaryWorkspacePath?: string | null
  effectiveWorkspacePath?: string | null
  providerSessionId?: string | null
  participantId?: string | null
  laneId?: string | null
  postureFingerprint?: string | null
  fixedToolAllowlist?: readonly string[] | null
}

export interface PermissionOpportunityBindingOptions {
  realpath?: (path: string) => string
}

export type HostPermissionOpportunityIssueResult =
  | {
      ok: true
      instruction: PermissionOpportunityRedemptionInstruction
      deduplicated: boolean
    }
  | { ok: false; code: string; error: string }

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function fixedToolAllowlistFingerprint(value: readonly string[] | null | undefined): string | null {
  if (!value) return null
  const canonical = [...new Set(value.map((entry) => entry.trim()).filter(Boolean))].sort()
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/**
 * Build one exact main-owned opportunity binding. Workspace runs require both
 * the logical workspace identity and the physical effective checkout; a partial
 * workspace description fails closed rather than degrading to global scope.
 */
export function buildPermissionOpportunityBinding(
  input: PermissionOpportunityBindingInput,
  options: PermissionOpportunityBindingOptions = {}
): PermissionOpportunityBinding | null {
  const runId = nonEmpty(input.runId)
  const chatId = nonEmpty(input.chatId)
  const profileId = nonEmpty(input.profileId)
  if (!runId || !chatId || !profileId) return null

  const workspaceId = nonEmpty(input.workspaceId)
  const primaryWorkspacePath = nonEmpty(input.primaryWorkspacePath)
  const effectiveWorkspacePath = nonEmpty(input.effectiveWorkspacePath)
  const hasWorkspaceFact = Boolean(workspaceId || primaryWorkspacePath || effectiveWorkspacePath)
  if (hasWorkspaceFact && (!workspaceId || !primaryWorkspacePath || !effectiveWorkspacePath)) {
    return null
  }

  const canonicalRealpath = options.realpath ?? realpathSync
  let logicalWorkspacePath: string | null = null
  let workspaceRealPath: string | null = null
  let effectiveWorktreePath: string | null = null
  if (hasWorkspaceFact) {
    try {
      logicalWorkspacePath = resolve(primaryWorkspacePath!)
      workspaceRealPath = canonicalRealpath(logicalWorkspacePath)
      effectiveWorktreePath = canonicalRealpath(resolve(effectiveWorkspacePath!))
    } catch {
      return null
    }
  }

  const participantId = nonEmpty(input.participantId)
  const laneId = nonEmpty(input.laneId)
  if (laneId && !participantId) return null

  return {
    provider: input.provider,
    runId,
    chatId,
    profileId: profileId as TaskWraithMcpProfileId,
    workspaceId,
    workspacePath: logicalWorkspacePath,
    workspaceRealPath,
    effectiveWorktreePath,
    providerSessionId: nonEmpty(input.providerSessionId),
    participantId,
    laneId,
    postureFingerprint: nonEmpty(input.postureFingerprint),
    fixedToolAllowlistFingerprint: fixedToolAllowlistFingerprint(input.fixedToolAllowlist)
  }
}

/**
 * Validate the host-observed failed invocation once, retain it in main, and
 * return only the opaque direct-redemption instruction to the provider.
 */
export function issueHostPermissionOpportunity(input: {
  registry: PermissionOpportunityRegistry
  binding: PermissionOpportunityBinding | null
  boundaryCode: PermissionOpportunityBoundaryCode
  toolName: TaskWraithMcpToolName
  arguments: Record<string, unknown>
  failure: string
  /** Typed main decision fact; never infer this from provider-visible prose. */
  userDeclined: boolean
  definitions: readonly TaskWraithMcpToolDefinition[]
  isAutoAllowed: (toolName: TaskWraithMcpToolName) => boolean
}): HostPermissionOpportunityIssueResult {
  if (!input.binding) {
    return {
      ok: false,
      code: 'binding_unavailable',
      error: 'The current provider run has no complete permission-opportunity binding.'
    }
  }
  if (input.userDeclined) {
    return {
      ok: false,
      code: 'explicit_user_decline',
      error: 'The user declined this invocation; no permission opportunity may be issued.'
    }
  }
  if (
    input.boundaryCode === 'unscoped_process' &&
    !isUnscopedProcessAuthorityTool(input.toolName)
  ) {
    return {
      ok: false,
      code: 'invalid_boundary_target',
      error: 'An unscoped-process opportunity requires an opaque process target.'
    }
  }
  const validation = validateHostIssuedToolPermissionRetryRequest({
    request: {
      toolName: input.toolName,
      arguments: input.arguments,
      failure: input.failure,
      boundaryCode: input.boundaryCode
    },
    definitions: input.definitions,
    isAutoAllowed: input.isAutoAllowed
  })
  if (!validation.ok) {
    return { ok: false, code: validation.code, error: validation.message }
  }
  let issued: ReturnType<PermissionOpportunityRegistry['issue']>
  try {
    issued = input.registry.issue({
      binding: input.binding,
      request: {
        toolName: validation.request.toolName,
        arguments: validation.request.arguments,
        failure: validation.request.failure,
        boundaryCode: input.boundaryCode
      }
    })
  } catch {
    return {
      ok: false,
      code: 'opportunity_issue_failed',
      error: 'TaskWraith could not retain this permission opportunity safely.'
    }
  }
  if (!issued.ok) return issued
  return {
    ok: true,
    instruction: buildPermissionOpportunityRedemptionInstruction(
      issued.opportunity.permissionOpportunityId
    ),
    deduplicated: issued.deduplicated
  }
}

/**
 * Adapt the registry to ToolPermissionRetry's reservation contract. The live
 * binding supplier is called once at reserve and again immediately before
 * consume, so a modal cannot carry authority across a profile, posture,
 * workspace/worktree, lane, or fixed-tool-ceiling change.
 */
export function createPermissionOpportunityResolver(input: {
  registry: PermissionOpportunityRegistry
  getLiveBinding: () => PermissionOpportunityBinding | null
}): ToolPermissionOpportunityResolver {
  return (permissionOpportunityId) => {
    const bindingAtReserve = input.getLiveBinding()
    if (!bindingAtReserve) {
      return {
        ok: false,
        code: 'opportunity_binding_mismatch',
        error: 'The current provider run no longer has a complete permission-opportunity binding.'
      }
    }
    const reserved = input.registry.reserve({ permissionOpportunityId, binding: bindingAtReserve })
    if (!reserved.ok) return reserved
    const reservation = reserved.reservation
    return {
      ok: true,
      reservation: {
        request: reservation.opportunity.request,
        targetArgumentsSha256: reservation.opportunity.targetArgumentsSha256,
        consumeWithLiveBinding: () => {
          const liveBinding = input.getLiveBinding()
          if (!liveBinding) {
            return {
              ok: false,
              code: 'opportunity_binding_mismatch',
              error:
                'The provider run binding changed while the permission opportunity was awaiting review.'
            }
          }
          return input.registry.consume({
            permissionOpportunityId: reservation.permissionOpportunityId,
            reservationId: reservation.reservationId,
            binding: liveBinding
          })
        },
        release: () =>
          input.registry.release({
            permissionOpportunityId: reservation.permissionOpportunityId,
            reservationId: reservation.reservationId,
            binding: bindingAtReserve
          })
      }
    }
  }
}
