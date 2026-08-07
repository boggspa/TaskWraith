import type { ChatRecord, ExternalPathGrant, ProviderId } from '../../../main/store/types'
import { isChatBoundDurableExternalPathGrant } from '../../../shared/externalPathGrantBinding'
import {
  EXTERNAL_PATH_GRANT_DISPATCH_PROVIDERS,
  isExternalPathGrantDispatchProvider
} from '../../../main/store/ExternalPathGrants'

export interface ExternalPathGrantGap {
  path: string
  access: 'read' | 'write'
  missingProviders: ProviderId[]
  selectionReceipt?: string
}

export interface ExternalPathGrantPreflight {
  gaps: ExternalPathGrantGap[]
  targets: ProviderId[]
  paths: string[]
}

export function externalPathGrantTargetsForChat(
  chat: ChatRecord | null | undefined
): ProviderId[] {
  if (!chat) return []
  if (chat.chatKind === 'ensemble' && chat.ensemble?.participants?.length) {
    const seen = new Set<ProviderId>()
    const targets: ProviderId[] = []
    for (const participant of chat.ensemble.participants) {
      if (!participant.enabled) continue
      if (!isExternalPathGrantDispatchProvider(participant.provider)) continue
      if (seen.has(participant.provider)) continue
      seen.add(participant.provider)
      targets.push(participant.provider)
    }
    return targets
  }
  if (isExternalPathGrantDispatchProvider(chat.provider)) {
    return [chat.provider]
  }
  return []
}

export function externalWorkspacePathsFromGrants(
  grants: ExternalPathGrant[],
  primaryWorkspacePath?: string | null
): string[] {
  const primary = primaryWorkspacePath?.trim()
  const paths = new Set<string>()
  for (const grant of grants) {
    const path = grant.path?.trim()
    if (!path) continue
    if (primary && path === primary) continue
    paths.add(path)
  }
  return [...paths]
}

function isPersistedDispatchGrant(grant: ExternalPathGrant): boolean {
  return (
    isExternalPathGrantDispatchProvider(grant.provider) &&
    grant.issuedBy === 'main' &&
    typeof grant.signature === 'string' &&
    grant.signature.length > 0 &&
    typeof grant.path === 'string' &&
    grant.path.trim().length > 0
  )
}

/** Prior consent exists for this path even if the primary-workspace binding is stale. */
export function pathHasPriorConsentExternalPathGrant(
  grants: ExternalPathGrant[],
  path: string
): boolean {
  const normalized = path.trim()
  if (!normalized) return false
  return grants.some(
    (grant) => isPersistedDispatchGrant(grant) && grant.path.trim() === normalized
  )
}

function grantSatisfiesAccess(
  grant: ExternalPathGrant,
  requiredAccess: ExternalPathGrantGap['access']
): boolean {
  return requiredAccess === 'read' || grant.access === 'write'
}

function grantCoversProviderPath(input: {
  chat: ChatRecord | null | undefined
  grant: ExternalPathGrant
  provider: ProviderId
  path: string
  access: ExternalPathGrantGap['access']
}): boolean {
  if (!input.chat) return false
  if (!isPersistedDispatchGrant(input.grant)) return false
  if (input.grant.provider !== input.provider) return false
  if (input.grant.path.trim() !== input.path) return false
  if (!grantSatisfiesAccess(input.grant, input.access)) return false
  // Stale primary-workspace / chat binding must not count as coverage —
  // remint or prompt instead of dispatching grants main will refuse.
  return isChatBoundDurableExternalPathGrant(input.grant, input.chat)
}

export function missingExternalPathGrantProviders(input: {
  chat: ChatRecord | null | undefined
  grants: ExternalPathGrant[]
  path: string
  access?: ExternalPathGrantGap['access']
}): ProviderId[] {
  const targets = externalPathGrantTargetsForChat(input.chat)
  const path = input.path.trim()
  const requiredAccess = input.access ?? 'read'
  if (!path || targets.length === 0) return []
  return targets.filter(
    (provider) =>
      !input.grants.some((grant) =>
        grantCoversProviderPath({
          chat: input.chat,
          grant,
          provider,
          path,
          access: requiredAccess
        })
      )
  )
}

export function findExternalPathGrantGaps(input: {
  chat: ChatRecord | null | undefined
  grants: ExternalPathGrant[]
  primaryWorkspacePath?: string | null
}): ExternalPathGrantPreflight {
  const targets = externalPathGrantTargetsForChat(input.chat)
  const paths = externalWorkspacePathsFromGrants(input.grants, input.primaryWorkspacePath)
  const gaps: ExternalPathGrantGap[] = []
  if (targets.length === 0 || paths.length === 0) {
    return { gaps, targets, paths }
  }

  for (const path of paths) {
    const pathGrants = input.grants.filter((grant) => grant.path?.trim() === path)
    const access = pathGrants.some((grant) => grant.access === 'write') ? 'write' : 'read'
    const missingProviders = targets.filter(
      (provider) =>
        !input.grants.some((grant) =>
          grantCoversProviderPath({
            chat: input.chat,
            grant,
            provider,
            path,
            access
          })
        )
    )
    if (missingProviders.length === 0) continue
    // pick-and-persist / repair always remints the full active provider set
    // for the path (one consent → every seat). missingProviders names who
    // still lacks executable coverage so the card can explain the gap.
    gaps.push({ path, access, missingProviders })
  }

  return { gaps, targets, paths }
}

export function filterDispatchExternalPathGrants(grants: ExternalPathGrant[]): ExternalPathGrant[] {
  return grants.filter((grant) => EXTERNAL_PATH_GRANT_DISPATCH_PROVIDERS.has(grant.provider))
}
