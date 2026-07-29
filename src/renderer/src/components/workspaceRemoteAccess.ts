/**
 * Pure (DOM-free, IPC-free) helpers behind the Settings→Workspaces remote-access
 * toggle and the new-workspace modal. Kept separate from the components so the
 * security-critical read-modify-write logic is unit-tested in isolation.
 *
 * The remote allowlist is a SECURITY gate (per-action revalidation in
 * BridgeActionRouter). `RemoteWorkspaceAllowlist.upsert()` is a FULL REPLACE
 * (only createdAt survives), so any upsert MUST carry the complete intended
 * policy — these helpers build that payload while preserving anything a user
 * narrowed in the Devices tab.
 */

import {
  ADMIN_REMOTE_WORKSPACE_CAPABILITIES,
  APPROVAL_MODE_OPTIONS,
  FILE_REMOTE_WORKSPACE_CAPABILITIES,
  LEGACY_READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES,
  PROVIDER_OPTIONS,
  READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES,
  REMOTE_GRANTABLE_PROVIDER_IDS,
  READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES,
  type RemoteWorkspaceCapability,
  type RemoteWorkspaceEntry,
  type RemoteWorkspaceMode
} from '../../../shared/remoteWorkspaceDefaults'

export type WorkspaceRemoteSegment = 'off' | 'read' | 'read-write'

/** The exact bridgeAllowlistUpsert argument shape (preload/index.d.ts). */
export interface AllowlistUpsertPayload {
  workspaceId: string
  path: string
  mode: RemoteWorkspaceMode
  capabilities?: RemoteWorkspaceCapability[]
  allowedProviders: string[]
  allowedApprovalModes: string[]
  expiresAt?: number
}

function isExpired(entry: RemoteWorkspaceEntry, now: number): boolean {
  return entry.expiresAt !== undefined && entry.expiresAt <= now
}

/**
 * Resolve an entry's effective capabilities, applying the legacy
 * materialization rule: a read-write entry persisted WITHOUT an explicit
 * capability list predates remote file editing, so it resolves WITHOUT the file
 * trio (mirrors capabilitiesForRemoteWorkspaceEntry in the main module).
 */
export function resolveEntryCapabilities(entry: RemoteWorkspaceEntry): RemoteWorkspaceCapability[] {
  if (entry.capabilities) return entry.capabilities
  return entry.mode === 'read-only'
    ? [...READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES]
    : [...LEGACY_READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES]
}

/** True only when the entry actually authorizes file editing (the full trio) —
 * derived from RESOLVED capabilities, never from the bare mode label, so a
 * legacy files-off read-write entry is not mistaken for full Read/Write. */
export function entryHasFileCapabilities(entry: RemoteWorkspaceEntry): boolean {
  const caps = new Set(resolveEntryCapabilities(entry))
  return FILE_REMOTE_WORKSPACE_CAPABILITIES.every((capability) => caps.has(capability))
}

/** External publishing is an explicit admin capability, never implied by
 * read-write or fileWrite. */
export function entryCanPublishExternally(entry: RemoteWorkspaceEntry): boolean {
  return resolveEntryCapabilities(entry).includes('externalPublish')
}

/**
 * The toggle segment to display for a workspace given its allowlist entry (or
 * undefined). Missing OR expired entries read as 'off' — list() returns expired
 * entries, so the UI must treat them as off or it would overstate access.
 */
export function deriveWorkspaceRemoteSegment(
  entry: RemoteWorkspaceEntry | undefined,
  now: number = Date.now()
): WorkspaceRemoteSegment {
  if (!entry || isExpired(entry, now)) return 'off'
  return entry.mode === 'read-only' ? 'read' : 'read-write'
}

/**
 * Build the bridgeAllowlistUpsert payload for moving a workspace to `target`.
 *
 * Read-modify-write: when an entry already exists, PRESERVE its allowedProviders,
 * allowedApprovalModes, expiresAt, and any admin caps (pin/yolo) — change only
 * the mode and its mode-default non-admin capabilities. The all-providers /
 * both-approval-modes / no-expiry defaults are used ONLY for a first grant
 * (existing === undefined). This guarantees a coarse toggle can never silently
 * widen, time-unbox, or strip the admin powers of a grant the user narrowed in
 * the Devices tab.
 */
export function buildAllowlistUpsertForSegment(
  workspace: { id: string; path: string },
  target: 'read' | 'read-write',
  existing?: RemoteWorkspaceEntry,
  now: number = Date.now()
): AllowlistUpsertPayload {
  const mode: RemoteWorkspaceMode = target === 'read' ? 'read-only' : 'read-write'
  const baseCapabilities =
    mode === 'read-only'
      ? [...READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES]
      : [...READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES]

  // An expired entry reads as Off in the UI (deriveWorkspaceRemoteSegment), so
  // re-granting it must behave like a fresh grant — NOT resurrect its stale
  // (possibly narrowed) policy or copy a past expiresAt forward (which would
  // make the new grant dead-on-arrival at enforcement).
  if (!existing || isExpired(existing, now)) {
    return {
      workspaceId: workspace.id,
      path: workspace.path,
      mode,
      capabilities: baseCapabilities,
      allowedProviders: [...PROVIDER_OPTIONS],
      allowedApprovalModes: [...APPROVAL_MODE_OPTIONS]
    }
  }

  const preservedAdmin = resolveEntryCapabilities(existing).filter((capability) =>
    ADMIN_REMOTE_WORKSPACE_CAPABILITIES.includes(capability)
  )
  const payload: AllowlistUpsertPayload = {
    workspaceId: workspace.id,
    path: existing.path || workspace.path,
    mode,
    capabilities: [...baseCapabilities, ...preservedAdmin],
    allowedProviders: existing.allowedProviders,
    allowedApprovalModes: existing.allowedApprovalModes
  }
  if (existing.expiresAt !== undefined) payload.expiresAt = existing.expiresAt
  return payload
}

/**
 * Build an explicit provider-policy edit for an existing remote workspace.
 *
 * Every non-provider field is carried forward verbatim/effectively: editing a
 * provider grant must not change mode, file/admin capabilities, approval modes,
 * expiry, workspace identity, or path. Historical provider ids that are no
 * longer grantable stay intact so a provider edit cannot silently remove
 * continuation authority for an existing thread.
 */
export function buildAllowlistUpsertForProviders(
  entry: RemoteWorkspaceEntry,
  selectedProviders: Iterable<string>
): AllowlistUpsertPayload {
  const grantable = new Set<string>(REMOTE_GRANTABLE_PROVIDER_IDS)
  const selected = new Set(
    Array.from(selectedProviders, (provider) => provider.trim().toLowerCase()).filter(
      (provider) => provider && grantable.has(provider)
    )
  )
  const historical = entry.allowedProviders.filter(
    (provider) => !grantable.has(provider.trim().toLowerCase())
  )
  const payload: AllowlistUpsertPayload = {
    workspaceId: entry.workspaceId,
    path: entry.path,
    mode: entry.mode,
    capabilities: [...resolveEntryCapabilities(entry)],
    allowedProviders: [
      ...historical,
      ...REMOTE_GRANTABLE_PROVIDER_IDS.filter((provider) => selected.has(provider))
    ],
    allowedApprovalModes: [...entry.allowedApprovalModes]
  }
  if (entry.expiresAt !== undefined) payload.expiresAt = entry.expiresAt
  return payload
}
