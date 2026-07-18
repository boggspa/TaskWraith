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
 * Build the stable permission-ceiling envelope for a persisted graph run
 * template. Presentation-only request fields (for example `displayPrompt`)
 * are deliberately absent, while every field in the original v1 authority
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
