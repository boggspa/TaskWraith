/**
 * Remint durable secondary-workspace grants onto the chat's CURRENT primary
 * workspace binding for every active dispatch provider.
 *
 * One user consent covers the whole roster: reminting always issues the full
 * current provider set for each repaired path (same as pick-and-persist).
 * Paths with no prior main-signed consent are left alone so the renderer can
 * prompt; we never invent grants from thin air.
 */
import { randomBytes as nodeRandomBytes } from 'crypto'
import type { ChatRecord, ExternalPathGrant, ProviderId } from './store/types'
import { isChatBoundDurableExternalPathGrant } from './ExternalPathGrantBinding'
import { isExternalPathGrantDispatchProvider } from './store/ExternalPathGrants'

export type ExternalPathGrantRepairGap = {
  path: string
  access: 'read' | 'write'
  missingProviders: ProviderId[]
}

export type ExternalPathGrantRepairResult = {
  ok: true
  repairedPaths: string[]
  remainingGaps: ExternalPathGrantRepairGap[]
  chat: ChatRecord
}

export type ExternalPathGrantRepairDeps = {
  getChat: (chatId: string) => ChatRecord | null | undefined
  saveChat: (chat: ChatRecord) => void
  broadcastChatUpdated: (chat: ChatRecord) => void
  collectExternalPathGrantsFromMetadata: (
    metadata: Record<string, unknown> | null | undefined
  ) => ExternalPathGrant[]
  canonicalizeExternalPathGrantMetadata: (
    metadata: Record<string, unknown> | null | undefined,
    nextGrants?: ExternalPathGrant[]
  ) => Record<string, unknown>
  grantProvidersForChat: (chat: ChatRecord) => ProviderId[]
  issueExternalPathGrant: (
    grant: Omit<ExternalPathGrant, 'issuedBy' | 'signature'>,
    options?: { canonicalPath: string }
  ) => ExternalPathGrant
  verifyExternalPathGrantSignatureForGrant: (grant: ExternalPathGrant) => boolean
  realpath: (pathValue: string) => Promise<string>
  stat: (pathValue: string) => Promise<{
    isDirectory(): boolean
    dev?: number | bigint
    ino?: number | bigint
  }>
  primaryWorkspacePathForChat: (chat: ChatRecord) => string | null
  now?: () => number
  randomBytes?: (size: number) => Buffer
}

function isPersistedDispatchGrant(
  grant: ExternalPathGrant,
  verifySignature: ExternalPathGrantRepairDeps['verifyExternalPathGrantSignatureForGrant']
): boolean {
  return (
    isExternalPathGrantDispatchProvider(grant.provider) &&
    grant.issuedBy === 'main' &&
    typeof grant.signature === 'string' &&
    grant.signature.length > 0 &&
    typeof grant.path === 'string' &&
    grant.path.trim().length > 0 &&
    verifySignature(grant)
  )
}

function secondaryPathsFromGrants(
  grants: ExternalPathGrant[],
  primaryWorkspacePath: string | null
): string[] {
  const primary = primaryWorkspacePath?.trim() || ''
  const paths = new Set<string>()
  for (const grant of grants) {
    const path = grant.path?.trim()
    if (!path) continue
    if (primary && path === primary) continue
    paths.add(path)
  }
  return [...paths]
}

export function grantProvidersMissingForPath(input: {
  chat: ChatRecord
  grants: ExternalPathGrant[]
  path: string
  access: 'read' | 'write'
  targets: ProviderId[]
}): ProviderId[] {
  const path = input.path.trim()
  if (!path) return []
  return input.targets.filter(
    (provider) =>
      !input.grants.some(
        (grant) =>
          grant.provider === provider &&
          grant.path?.trim() === path &&
          isChatBoundDurableExternalPathGrant(grant, input.chat) &&
          (input.access === 'read' || grant.access === 'write')
      )
  )
}

export async function repairStaleExternalPathGrantsForChat(
  chatId: string,
  deps: ExternalPathGrantRepairDeps
): Promise<ExternalPathGrantRepairResult | { ok: false; reason: 'no-chat' | 'no-provider' }> {
  const chat = deps.getChat(chatId)
  if (!chat || chat.scope === 'global') return { ok: false, reason: 'no-chat' }
  const targets = deps.grantProvidersForChat(chat)
  if (targets.length === 0) return { ok: false, reason: 'no-provider' }

  const primaryPath = deps.primaryWorkspacePathForChat(chat)
  let workingChat = chat
  let grants = deps.collectExternalPathGrantsFromMetadata(workingChat.providerMetadata)
  const paths = secondaryPathsFromGrants(grants, primaryPath)
  const repairedPaths: string[] = []
  const remainingGaps: ExternalPathGrantRepairGap[] = []
  const now = deps.now?.() ?? Date.now()
  const randomBytes = deps.randomBytes || nodeRandomBytes

  for (const path of paths) {
    const pathGrants = grants.filter((grant) => grant.path?.trim() === path)
    const access = pathGrants.some((grant) => grant.access === 'write') ? 'write' : 'read'
    const missingProviders = grantProvidersMissingForPath({
      chat: workingChat,
      grants,
      path,
      access,
      targets
    })
    if (missingProviders.length === 0) continue

    const priorConsent = pathGrants.filter((grant) =>
      isPersistedDispatchGrant(grant, deps.verifyExternalPathGrantSignatureForGrant)
    )
    const accessSatisfied =
      access === 'read' || priorConsent.some((grant) => grant.access === 'write')
    if (priorConsent.length === 0 || !accessSatisfied) {
      remainingGaps.push({ path, access, missingProviders: targets })
      continue
    }

    let selectedPath: string
    let kind: ExternalPathGrant['kind'] = 'directory'
    let bookmark: string | undefined
    try {
      selectedPath = await deps.realpath(path)
      const stat = await deps.stat(selectedPath)
      kind = stat.isDirectory() ? 'directory' : 'file'
    } catch {
      remainingGaps.push({ path, access, missingProviders: targets })
      continue
    }
    bookmark = priorConsent.find((grant) => grant.securityScopedBookmark)?.securityScopedBookmark

    const newGrants: ExternalPathGrant[] = targets.map((provider) =>
      deps.issueExternalPathGrant(
        {
          id: `repair-${now}-${provider}-${randomBytes(4).toString('hex')}`,
          provider,
          chatId,
          path: selectedPath,
          kind,
          access,
          duration: 'thisThread',
          securityScopedBookmark: bookmark,
          createdAt: new Date(now).toISOString()
        },
        { canonicalPath: selectedPath }
      )
    )

    const existing = deps.collectExternalPathGrantsFromMetadata(workingChat.providerMetadata)
    workingChat = {
      ...workingChat,
      providerMetadata: deps.canonicalizeExternalPathGrantMetadata(workingChat.providerMetadata, [
        ...existing,
        ...newGrants
      ]),
      updatedAt: now
    }
    deps.saveChat(workingChat)
    deps.broadcastChatUpdated(workingChat)
    grants = deps.collectExternalPathGrantsFromMetadata(workingChat.providerMetadata)
    repairedPaths.push(selectedPath)
  }

  // Recompute gaps after remints so the prompt only sees paths that still
  // lack a chat-bound grant for the current primary workspace.
  const liveTargets = deps.grantProvidersForChat(workingChat)
  const liveGrants = deps.collectExternalPathGrantsFromMetadata(workingChat.providerMetadata)
  const livePaths = secondaryPathsFromGrants(liveGrants, primaryPath)
  const finalGaps: ExternalPathGrantRepairGap[] = []
  for (const path of livePaths) {
    const pathGrants = liveGrants.filter((grant) => grant.path?.trim() === path)
    const access = pathGrants.some((grant) => grant.access === 'write') ? 'write' : 'read'
    const missingProviders = grantProvidersMissingForPath({
      chat: workingChat,
      grants: liveGrants,
      path,
      access,
      targets: liveTargets
    })
    if (missingProviders.length === 0) continue
    // One consent opens the path for every active provider — surface the
    // full remaining target set so the prompt remints everyone together.
    finalGaps.push({
      path,
      access,
      missingProviders: liveTargets.length > 0 ? liveTargets : missingProviders
    })
  }

  // Preserve explicit remainingGaps for vanished paths that left the grant
  // list after a failed realpath (they won't appear in livePaths).
  for (const gap of remainingGaps) {
    if (finalGaps.some((candidate) => candidate.path === gap.path)) continue
    if (repairedPaths.some((repaired) => repaired === gap.path)) continue
    finalGaps.push(gap)
  }

  return {
    ok: true,
    repairedPaths,
    remainingGaps: finalGaps,
    chat: workingChat
  }
}
