// Namespace import (not `{ createHmac, timingSafeEqual }`): this module is reachable
// from the renderer bundle (externalPathGrantPreflight -> isChatBoundDurableExternalPathGrant).
// A named `crypto` import makes the browser build fail on the missing export — vite
// swaps the module for an empty `__vite-browser-external` stub and rollup errors at
// bind time, before tree-shaking can drop the signing helpers. A namespace binding
// resolves the member only at call time, which only ever happens in the main process.
// Same fix as `936d3d89a` for CanvasEvalAudit. Keep this a namespace import.
import * as nodeCrypto from 'node:crypto'
import type { ChatRecord, ExternalPathGrant, ProviderId, WorkspaceRecord } from './store/types'
import { resolveCanonicalWorkspaceId } from './WorkspaceIdentity'
import { EXTERNAL_PATH_GRANT_BINDING_VERSION } from '../shared/externalPathGrantBinding'

export {
  EXTERNAL_PATH_GRANT_BINDING_VERSION,
  isChatBoundDurableExternalPathGrant
} from '../shared/externalPathGrantBinding'

type GrantSigningFields = Pick<
  ExternalPathGrant,
  | 'id'
  | 'provider'
  | 'workspaceId'
  | 'chatId'
  | 'appRunId'
  | 'bindingVersion'
  | 'path'
  | 'kind'
  | 'access'
  | 'duration'
  | 'securityScopedBookmark'
  | 'createdAt'
>

export interface ExternalPathGrantRunBindingContext {
  provider: ProviderId
  appChatId?: string
  appRunId?: string
  workspaceId?: string
}

function trimmed(value: string | null | undefined): string | null {
  const result = typeof value === 'string' ? value.trim() : ''
  return result || null
}

/**
 * Stable HMAC payload for external-path grants.
 *
 * Grants minted before binding version 2 deliberately retain their historical
 * payload so they can still be decoded and displayed. They are not executable:
 * `matchesExternalPathGrantRunBinding` rejects every unversioned grant. New
 * grants bind the signature to the originating chat, its canonical primary
 * workspace, and (when known at issuance) the exact run.
 */
export function externalPathGrantSigningPayload(
  grant: GrantSigningFields,
  canonicalizePath: (value: string) => string
): string {
  const base = {
    id: grant.id,
    provider: grant.provider,
    path: canonicalizePath(grant.path),
    kind: grant.kind,
    access: grant.access,
    duration: grant.duration,
    createdAt: grant.createdAt
  }
  if (grant.bindingVersion !== EXTERNAL_PATH_GRANT_BINDING_VERSION) {
    return JSON.stringify(base)
  }
  return JSON.stringify({
    ...base,
    bindingVersion: EXTERNAL_PATH_GRANT_BINDING_VERSION,
    workspaceId: trimmed(grant.workspaceId),
    chatId: trimmed(grant.chatId),
    appRunId: trimmed(grant.appRunId),
    securityScopedBookmark: trimmed(grant.securityScopedBookmark)
  })
}

export function signExternalPathGrantPayload(
  secret: Buffer,
  grant: GrantSigningFields,
  canonicalizePath: (value: string) => string
): string {
  return nodeCrypto
    .createHmac('sha256', secret)
    .update(externalPathGrantSigningPayload(grant, canonicalizePath))
    .digest('hex')
}

export function verifyExternalPathGrantSignature(
  secret: Buffer,
  grant: ExternalPathGrant,
  canonicalizePath: (value: string) => string
): boolean {
  if (!grant || grant.issuedBy !== 'main' || !/^[0-9a-f]{64}$/i.test(grant.signature || '')) {
    return false
  }
  const expected = Buffer.from(signExternalPathGrantPayload(secret, grant, canonicalizePath), 'hex')
  const actual = Buffer.from(grant.signature!, 'hex')
  return expected.length === actual.length && nodeCrypto.timingSafeEqual(expected, actual)
}

export function matchesExternalPathGrantRunBinding(
  grant: ExternalPathGrant,
  context: ExternalPathGrantRunBindingContext
): boolean {
  if (grant.bindingVersion !== EXTERNAL_PATH_GRANT_BINDING_VERSION) return false
  const grantChatId = trimmed(grant.chatId)
  const grantWorkspaceId = trimmed(grant.workspaceId)
  const runChatId = trimmed(context.appChatId)
  const runWorkspaceId = trimmed(context.workspaceId)
  if (!grantChatId || !grantWorkspaceId || !runChatId || !runWorkspaceId) return false
  if (grant.provider !== context.provider) return false
  if (grantChatId !== runChatId || grantWorkspaceId !== runWorkspaceId) return false

  const grantRunId = trimmed(grant.appRunId)
  const runId = trimmed(context.appRunId)
  if (grant.duration === 'thisRun' && (!grantRunId || !runId)) return false
  if (grantRunId && grantRunId !== runId) return false
  return true
}

export function isExecutableExternalPathGrantDuration(
  value: unknown
): value is ExternalPathGrant['duration'] {
  return value === 'thisRun' || value === 'thisThread' || value === 'workspace'
}

/** A durable thread capability executes only while its exact signed token is
 * still present on the canonical main-owned chat record. */
export function hasCanonicalExternalPathGrantMembership(
  grant: ExternalPathGrant,
  canonicalGrants: readonly ExternalPathGrant[]
): boolean {
  return canonicalGrants.some(
    (candidate) =>
      candidate.bindingVersion === EXTERNAL_PATH_GRANT_BINDING_VERSION &&
      candidate.id === grant.id &&
      candidate.signature === grant.signature
  )
}

/**
 * Combine the chat/workspace/provider/run binding with revocable durable
 * membership. Both thread- and workspace-duration capabilities must remain on
 * the exact canonical chat record; removing the signed token revokes either
 * one. Run-only capabilities are instead governed by the process-epoch
 * execution registry at the index boundary.
 */
export function matchesExternalPathGrantExecutionAuthority(
  grant: ExternalPathGrant,
  context: ExternalPathGrantRunBindingContext,
  canonicalGrants: readonly ExternalPathGrant[]
): boolean {
  if (
    (grant.duration === 'thisThread' || grant.duration === 'workspace') &&
    !hasCanonicalExternalPathGrantMembership(grant, canonicalGrants)
  ) {
    return false
  }
  return matchesExternalPathGrantRunBinding(grant, context)
}

/**
 * Resolve a chat's primary workspace without consulting UI focus.
 *
 * An explicit workspace identity must resolve and, when a persisted path is
 * also present, both identities must agree. Only genuinely path-only legacy
 * chats may recover through a registered canonical path.
 */
export function resolveChatPrimaryWorkspace(
  chat: Pick<ChatRecord, 'scope' | 'workspaceId' | 'workspacePath'>,
  workspaces: readonly WorkspaceRecord[],
  canonicalizePath: (value: string) => string
): WorkspaceRecord | null {
  if (chat.scope === 'global') return null
  const rawWorkspaceId = trimmed(chat.workspaceId)
  const rawWorkspacePath = trimmed(chat.workspacePath)

  if (rawWorkspaceId) {
    const canonicalId = resolveCanonicalWorkspaceId(rawWorkspaceId, workspaces, canonicalizePath)
    if (!canonicalId) return null
    const workspace = workspaces.find((candidate) => candidate.id === canonicalId) || null
    if (!workspace) return null
    if (rawWorkspacePath) {
      let chatPath: string
      let workspacePath: string
      try {
        chatPath = canonicalizePath(rawWorkspacePath)
        workspacePath = canonicalizePath(workspace.path)
      } catch {
        return null
      }
      if (chatPath !== workspacePath) return null
    }
    return workspace
  }

  if (!rawWorkspacePath) return null
  let canonicalChatPath: string
  try {
    canonicalChatPath = canonicalizePath(rawWorkspacePath)
  } catch {
    return null
  }
  return (
    workspaces.find((workspace) => {
      try {
        return canonicalizePath(workspace.path) === canonicalChatPath
      } catch {
        return false
      }
    }) || null
  )
}
