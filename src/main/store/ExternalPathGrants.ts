import type { ExternalPathGrant, ProviderId } from './types'
import { isLiveSelectableProvider } from '../../shared/retiredProviders'

export const EXTERNAL_PATH_GRANT_METADATA_KEYS = [
  'externalPathGrants',
  'codexExternalPathGrants',
  'claudeExternalPathGrants',
  'geminiExternalPathGrants',
  'kimiExternalPathGrants',
  'ollamaExternalPathGrants'
] as const

// Structural provider ids preserve signed historical grants during decode and
// coalescing. Live dispatch eligibility is filtered separately, so retaining a
// Cursor grant here does not make Cursor runnable.
const KNOWN_PROVIDER_IDS: ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'cursor',
  'grok',
  'kimi',
  'ollama'
]
const KNOWN_PROVIDERS = new Set<ProviderId>(KNOWN_PROVIDER_IDS)

/**
 * Live providers whose runtimes consume signed external-path grants at dispatch.
 *
 * Keep historical providers in `KNOWN_PROVIDERS` so old chat metadata still
 * decodes, but never put a retired provider here. Ollama belongs in this set now
 * that its local tool loop uses the same signed run posture and path-grant
 * checks as the brokered provider runtimes.
 */
export const EXTERNAL_PATH_GRANT_DISPATCH_PROVIDERS = new Set<ProviderId>(
  KNOWN_PROVIDER_IDS.filter((provider) => isLiveSelectableProvider(provider))
)

export function isExternalPathGrantDispatchProvider(
  provider: ProviderId | string | null | undefined
): provider is ProviderId {
  return (
    typeof provider === 'string' &&
    EXTERNAL_PATH_GRANT_DISPATCH_PROVIDERS.has(provider as ProviderId)
  )
}

function grantKey(grant: ExternalPathGrant): string {
  return `${grant.provider}:${grant.path}`
}

function isGrantLike(value: unknown): value is ExternalPathGrant {
  if (!value || typeof value !== 'object') return false
  const grant = value as Partial<ExternalPathGrant>
  return (
    typeof grant.id === 'string' &&
    typeof grant.path === 'string' &&
    KNOWN_PROVIDERS.has(grant.provider as ProviderId)
  )
}

function isExecutionBoundGrant(grant: ExternalPathGrant): boolean {
  if (grant.bindingVersion !== 2) return false
  if (typeof grant.chatId !== 'string' || !grant.chatId.trim()) return false
  if (typeof grant.workspaceId !== 'string' || !grant.workspaceId.trim()) return false
  if (grant.duration === 'thisRun') {
    return typeof grant.appRunId === 'string' && Boolean(grant.appRunId.trim())
  }
  return true
}

export function coalesceExternalPathGrants(
  grants: Array<ExternalPathGrant | null | undefined>
): ExternalPathGrant[] {
  const byKey = new Map<string, ExternalPathGrant>()
  for (const grant of grants) {
    if (!isGrantLike(grant)) continue
    if (!grant.path.trim()) continue
    const key = `${grant.provider}:${grant.path}`
    const normalized: ExternalPathGrant = { ...grant }
    const existing = byKey.get(key)
    const existingIsBound = existing ? isExecutionBoundGrant(existing) : false
    const incomingIsBound = isExecutionBoundGrant(normalized)
    const shouldReplace =
      !existing ||
      (incomingIsBound && !existingIsBound) ||
      (incomingIsBound === existingIsBound &&
        existing.access === 'read' &&
        normalized.access === 'write')
    if (shouldReplace) {
      // Preserve a previously-resolved order if the incoming
      // duplicate lacks one — keeps explicit reorder sticky when
      // a write grant upgrades an earlier read grant for the
      // same provider:path.
      if (normalized.order === undefined && existing?.order !== undefined) {
        normalized.order = existing.order
      }
      byKey.set(key, normalized)
    }
  }
  return assignExternalPathGrantOrder([...byKey.values()])
}

/**
 * 1.0.6-EW66 — Assign a stable per-PATH display order to a
 * (de-duped) grant list. Grants that share a `path` always get
 * the same `order` (an ensemble chat stores one grant per
 * enabled participant-provider). Existing explicit orders are
 * preserved — the minimum order seen for a path wins, so a
 * user's manual reorder is sticky. Paths that lack any order
 * are appended after the highest existing order, sequenced by
 * earliest `createdAt` (then `path` for determinism). The
 * returned list is sorted by (order, path, provider).
 *
 * Idempotent: running it again over an already-ordered list is
 * a no-op (every path already has an explicit order, nothing to
 * append, sort is stable).
 *
 * `order` is intentionally OUTSIDE the HMAC signing payload
 * (`externalGrantSigningPayload` in index.ts), so rewriting it
 * here never invalidates a grant's signature.
 */
export function assignExternalPathGrantOrder(grants: ExternalPathGrant[]): ExternalPathGrant[] {
  if (grants.length === 0) return grants
  // Resolve each path's order + earliest createdAt.
  const pathInfo = new Map<string, { order?: number; createdAt: string }>()
  for (const grant of grants) {
    const grantOrder = typeof grant.order === 'number' ? grant.order : undefined
    const createdAt = grant.createdAt || ''
    const info = pathInfo.get(grant.path)
    if (!info) {
      pathInfo.set(grant.path, { order: grantOrder, createdAt })
      continue
    }
    if (grantOrder !== undefined) {
      info.order = info.order === undefined ? grantOrder : Math.min(info.order, grantOrder)
    }
    if (createdAt && (!info.createdAt || createdAt < info.createdAt)) {
      info.createdAt = createdAt
    }
  }
  // Highest explicit order across paths — new (unordered) paths
  // append after it so existing slots are preserved.
  let maxOrder = -1
  for (const info of pathInfo.values()) {
    if (info.order !== undefined && info.order > maxOrder) maxOrder = info.order
  }
  const unordered = [...pathInfo.entries()]
    .filter(([, info]) => info.order === undefined)
    .sort((a, b) => {
      if (a[1].createdAt !== b[1].createdAt) {
        return a[1].createdAt < b[1].createdAt ? -1 : 1
      }
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    })
  let next = maxOrder + 1
  for (const [path, info] of unordered) {
    info.order = next++
    pathInfo.set(path, info)
  }
  return grants
    .map((grant) => ({ ...grant, order: pathInfo.get(grant.path)?.order ?? 0 }))
    .sort((a, b) => {
      const orderDelta = (a.order ?? 0) - (b.order ?? 0)
      if (orderDelta !== 0) return orderDelta
      if (a.path !== b.path) return a.path < b.path ? -1 : 1
      return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0
    })
}

/**
 * 1.0.6-EW66 — Rewrite grant `order` so the additional-workspace
 * list matches `orderedPaths` (the renderer hands back the new
 * top-to-bottom path order after a drag). Every grant sharing a
 * path receives that path's new index. Any grant whose path is
 * absent from `orderedPaths` is appended (stably, by path) after
 * the explicitly-ordered ones so nothing is dropped.
 */
export function reorderExternalPathGrantsByPath(
  grants: ExternalPathGrant[],
  orderedPaths: string[]
): ExternalPathGrant[] {
  const indexByPath = new Map<string, number>()
  orderedPaths.forEach((path, idx) => {
    if (!indexByPath.has(path)) indexByPath.set(path, idx)
  })
  const extraPaths = [...new Set(grants.map((grant) => grant.path))]
    .filter((path) => !indexByPath.has(path))
    .sort()
  extraPaths.forEach((path, i) => indexByPath.set(path, orderedPaths.length + i))
  return grants
    .map((grant) => ({ ...grant, order: indexByPath.get(grant.path) ?? grant.order ?? 0 }))
    .sort((a, b) => {
      const orderDelta = (a.order ?? 0) - (b.order ?? 0)
      if (orderDelta !== 0) return orderDelta
      if (a.path !== b.path) return a.path < b.path ? -1 : 1
      return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0
    })
}

/**
 * 1.0.6-EW66 — Drop the display-only `order` field from grants
 * bound for an execution / permission payload (provider dispatch
 * in `ComposerService`, effective-permission resolution in
 * `EffectiveRunPermissions`). `order` is a renderer concern (the
 * composer workspace-manager list order) and is excluded from the
 * HMAC signing payload; it has no meaning in the CLI request
 * envelope, so execution paths strip it to keep their payloads
 * minimal and stable.
 */
export function stripExternalPathGrantOrder(grants: ExternalPathGrant[]): ExternalPathGrant[] {
  return grants.map((grant) => {
    if (grant.order === undefined) return grant
    const next = { ...grant }
    delete next.order
    return next
  })
}

export function externalPathGrantMetadataLists(
  metadata: Record<string, unknown> | null | undefined
): ExternalPathGrant[] {
  if (!metadata) return []
  return EXTERNAL_PATH_GRANT_METADATA_KEYS.flatMap((key) =>
    Array.isArray(metadata[key]) ? (metadata[key] as ExternalPathGrant[]) : []
  )
}

export function collectExternalPathGrantsFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): ExternalPathGrant[] {
  if (!metadata) return []
  const canonical = coalesceExternalPathGrants(
    Array.isArray(metadata.externalPathGrants)
      ? (metadata.externalPathGrants as ExternalPathGrant[])
      : []
  )
  const legacy = coalesceExternalPathGrants(
    EXTERNAL_PATH_GRANT_METADATA_KEYS.filter((key) => key !== 'externalPathGrants').flatMap(
      (key) => (Array.isArray(metadata[key]) ? (metadata[key] as ExternalPathGrant[]) : [])
    )
  )
  const merged = [...canonical]
  const canonicalIndexByKey = new Map(
    canonical.map((grant, index) => [grantKey(grant), index] as const)
  )
  for (const legacyGrant of legacy) {
    const canonicalIndex = canonicalIndexByKey.get(grantKey(legacyGrant))
    if (canonicalIndex === undefined) {
      merged.push(legacyGrant)
      continue
    }
    const canonicalGrant = merged[canonicalIndex]
    if (!isExecutionBoundGrant(canonicalGrant) && isExecutionBoundGrant(legacyGrant)) {
      merged[canonicalIndex] = {
        ...legacyGrant,
        order: legacyGrant.order ?? canonicalGrant.order
      }
    }
  }
  return assignExternalPathGrantOrder(merged)
}

export function canonicalizeExternalPathGrantMetadata(
  metadata: Record<string, unknown> | null | undefined,
  nextGrants?: ExternalPathGrant[]
): Record<string, unknown> {
  const base = { ...(metadata || {}) }
  const grants = nextGrants
    ? coalesceExternalPathGrants(nextGrants)
    : collectExternalPathGrantsFromMetadata(base)
  for (const key of EXTERNAL_PATH_GRANT_METADATA_KEYS) {
    delete base[key]
  }
  return {
    ...base,
    externalPathGrants: grants
  }
}
