import { createHash } from 'node:crypto'
import { stableExecutionGraphStringify } from './ExecutionGraphCompiler'
import type { JsonObject } from './ExecutionGraphModel'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function jsonObject(value: unknown): JsonObject {
  const cloned = JSON.parse(JSON.stringify(value)) as unknown
  if (!isRecord(cloned)) throw new Error('Run template authority envelope is not a JSON object.')
  return cloned as JsonObject
}

/**
 * Build the original stable authority envelope for a persisted graph run
 * template. This is prompt/model bound and is therefore suitable for checking
 * one exact saved template, not for deciding whether another Stack step fits
 * the same reusable permission ceiling. Every field in the original v1
 * contract remains byte-for-byte compatible.
 *
 * Trusted Session is an ephemeral renderer-turn capability. Even if stale or
 * hostile persisted content says otherwise, a durable graph template always
 * binds `sessionTrust` as false.
 */
export function executionGraphRunTemplateAuthorityEnvelope(content: JsonObject): JsonObject {
  const request = isRecord(content.request) ? content.request : {}
  const posture = isRecord(content.permissionPosture) ? content.permissionPosture : {}
  const grants = Array.isArray(request.externalPathGrants)
    ? request.externalPathGrants.map((grant) => {
        if (!isRecord(grant)) return null
        return {
          provider: grant.provider,
          path: grant.path,
          kind: grant.kind,
          access: grant.access,
          duration: grant.duration,
          issuedBy: grant.issuedBy,
          signature: grant.signature
        }
      })
    : []

  return jsonObject({
    schemaVersion: 1,
    provider: content.provider,
    scope: content.scope,
    workspaceId: content.workspaceId,
    workspacePath: content.workspacePath,
    chatId: content.chatId,
    runtimeProfileId: content.runtimeProfileId,
    selectedModelType: request.selectedModelType,
    customModel: request.customModel,
    effectiveWorkspacePath: request.effectiveWorkspacePath,
    approvalMode: request.approvalMode,
    permissionPresetId: request.permissionPresetId,
    workflowMode: request.workflowMode,
    sessionTrust: false,
    permissionPostureHash: posture.postureHash,
    externalPathGrants: grants,
    projectReferenceContextSelection: request.projectReferenceContextSelection
  })
}

/** Return the lowercase SHA-256 identity of the stable authority envelope. */
export function executionGraphRunTemplateAuthorityDigest(content: JsonObject): string {
  return createHash('sha256')
    .update(stableExecutionGraphStringify(executionGraphRunTemplateAuthorityEnvelope(content)))
    .digest('hex')
}

function permissionCeilingGrantEnvelope(request: Record<string, unknown>): unknown[] {
  if (!Array.isArray(request.externalPathGrants)) return []
  return request.externalPathGrants.map((grant) => {
    if (!isRecord(grant)) return null
    return {
      id: grant.id,
      provider: grant.provider,
      bindingVersion: grant.bindingVersion,
      workspaceId: grant.workspaceId,
      chatId: grant.chatId,
      appRunId: grant.appRunId,
      path: grant.path,
      kind: grant.kind,
      access: grant.access,
      duration: grant.duration,
      securityScopedBookmark: grant.securityScopedBookmark,
      issuedBy: grant.issuedBy,
      signature: grant.signature,
      createdAt: grant.createdAt
    }
  })
}

function canonicalWorkspaceGrantServiceIds(value: unknown): unknown {
  if (!Array.isArray(value)) return []
  if (!value.every((entry) => typeof entry === 'string')) return value
  return [...new Set(value)].sort()
}

/**
 * Build the permission-only ceiling shared by compatible Stack steps.
 *
 * Prompt, model, Project-reference selection, posture hashes/signatures, and
 * presentation are intentionally absent: they identify a particular request,
 * not the authority that request may exercise. The normalized effective
 * permission snapshot and detailed main-issued grants remain bound, along
 * with every target/runtime field that can change where that authority acts.
 */
export function executionGraphRunTemplatePermissionCeilingEnvelope(
  content: JsonObject
): JsonObject {
  const request = isRecord(content.request) ? content.request : {}
  const posture = isRecord(content.permissionPosture) ? content.permissionPosture : {}

  return jsonObject({
    schemaVersion: 1,
    provider: content.provider,
    scope: content.scope,
    workspaceId: content.workspaceId,
    workspacePath: content.workspacePath,
    chatId: content.chatId,
    effectiveWorkspacePath: request.effectiveWorkspacePath,
    runtimeProfileId: content.runtimeProfileId,
    sessionTrust: false,
    approvalMode: posture.approvalMode,
    workflowMode: posture.workflowMode,
    presetId: posture.presetId,
    readOnly: posture.readOnly,
    agenticServices: posture.agenticServices,
    networkAccess: posture.networkAccess,
    workspaceGrantServiceIds: canonicalWorkspaceGrantServiceIds(
      posture.workspaceGrantServiceIds
    ),
    externalPathGrantCount: posture.externalPathGrantCount,
    externalPathGrantHash: posture.externalPathGrantHash,
    externalPathGrants: permissionCeilingGrantEnvelope(request)
  })
}

/** Return the lowercase SHA-256 identity of the reusable Stack permission ceiling. */
export function executionGraphRunTemplatePermissionCeilingDigest(content: JsonObject): string {
  return createHash('sha256')
    .update(
      stableExecutionGraphStringify(executionGraphRunTemplatePermissionCeilingEnvelope(content))
    )
    .digest('hex')
}
