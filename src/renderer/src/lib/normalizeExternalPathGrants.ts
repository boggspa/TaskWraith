import type { ExternalPathGrant, ProviderId } from '../../../main/store/types'
import { coalesceExternalPathGrants } from '../../../main/store/ExternalPathGrants'

const normalizeExternalPathGrants = (value: unknown): ExternalPathGrant[] => {
  if (!Array.isArray(value)) return []
  const grants: ExternalPathGrant[] = []
  // Slice 2 of the external-path-redesign arc: the previous hard
  // filter `grant.provider !== 'codex'` was a leftover from the
  // era when only Codex CLI consumed external-path grants. The
  // Runtime dispatch is provider-aware, while metadata decoding must retain
  // grants for every known provider (including historical Gemini records).
  // Integrity is still guarded by issuedBy/signature; live eligibility is
  // enforced separately by EXTERNAL_PATH_GRANT_DISPATCH_PROVIDERS.
  const VALID_PROVIDERS: ReadonlySet<ProviderId> = new Set([
    'codex',
    'claude',
    'gemini',
    'kimi',
    'grok',
    'cursor',
    'ollama',
    'antigravity',
    'pi'
  ])
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const grant = item as Partial<ExternalPathGrant>
    const providerToken = grant.provider as ProviderId | undefined
    if (!providerToken || !VALID_PROVIDERS.has(providerToken)) continue
    if (typeof grant.id !== 'string' || !grant.id) continue
    if (typeof grant.path !== 'string' || !grant.path.trim()) continue
    if (grant.kind !== 'file' && grant.kind !== 'directory') continue
    if (grant.access !== 'read' && grant.access !== 'write') continue
    if (
      grant.duration !== 'thisRun' &&
      grant.duration !== 'thisThread' &&
      grant.duration !== 'workspace'
    ) {
      continue
    }
    if (typeof grant.createdAt !== 'string' || !grant.createdAt) continue
    if (grant.issuedBy !== 'main' || typeof grant.signature !== 'string' || !grant.signature)
      continue

    // Every field below except `order` participates in either the grant's
    // signed authority or its security-scoped filesystem capability. Do not
    // trim, default, rebind, or otherwise "repair" it in the renderer: doing
    // so turns a valid main-issued grant into a different unsigned claim.
    grants.push({
      id: grant.id,
      provider: providerToken,
      bindingVersion: grant.bindingVersion,
      workspaceId: grant.workspaceId,
      chatId: grant.chatId,
      appRunId: grant.appRunId,
      path: grant.path,
      kind: grant.kind,
      access: grant.access,
      duration: grant.duration,
      securityScopedBookmark: grant.securityScopedBookmark,
      issuedBy: 'main',
      signature: grant.signature,
      createdAt: grant.createdAt,
      // 1.0.6-EW66 — preserve the persisted display order through
      // normalization so a user's drag-reorder survives reload.
      // `coalesceExternalPathGrants` (below) self-heals any missing
      // value from createdAt sequence, so undefined is safe here.
      order: typeof grant.order === 'number' ? grant.order : undefined
    })
  }
  return coalesceExternalPathGrants(grants)
}

export { normalizeExternalPathGrants }
