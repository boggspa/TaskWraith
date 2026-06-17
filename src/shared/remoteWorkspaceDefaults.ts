/**
 * Node-builtin-FREE mirror of the remote-workspace allowlist capability/provider
 * constants that live in `src/main/RemoteWorkspaceAllowlist.ts`.
 *
 * The main module imports `fs` + `path`, so the renderer must NOT import its
 * VALUE exports (that would pull node builtins into the renderer bundle and
 * blank the window — see MEMORY.md). The renderer imports these copies instead.
 * Keep the arrays byte-identical to the main module's; the test in
 * `remoteWorkspaceDefaults.test.ts` is a drift guard.
 */

export type RemoteWorkspaceMode = 'read-only' | 'read-write'

export type RemoteWorkspaceCapability =
  | 'monitor'
  | 'approve'
  | 'answer'
  | 'cancel'
  | 'startTurn'
  | 'diffReview'
  | 'steer'
  | 'fileBrowse'
  | 'fileRead'
  | 'fileWrite'
  | 'pin'
  | 'yolo'

/** Renderer-side mirror of the persisted allowlist entry (matches
 * preload/index.d.ts `RemoteWorkspaceEntry`). */
export interface RemoteWorkspaceEntry {
  workspaceId: string
  path: string
  mode: RemoteWorkspaceMode
  capabilities?: RemoteWorkspaceCapability[]
  allowedProviders: string[]
  allowedApprovalModes: string[]
  expiresAt?: number
  createdAt: number
  updatedAt: number
}

/** Every first-class provider, so granting a workspace is one tap (the Mac
 * still enforces whatever subset is saved on every action). */
export const PROVIDER_OPTIONS = ['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'] as const

export const APPROVAL_MODE_OPTIONS = ['default', 'plan'] as const

export const READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES: readonly RemoteWorkspaceCapability[] = [
  'monitor',
  'approve'
]

/** The file-editing trio — the powers a "Read/Write" grant adds on top of the
 * legacy read-write set, and that legacy entries deliberately exclude. */
export const FILE_REMOTE_WORKSPACE_CAPABILITIES: readonly RemoteWorkspaceCapability[] = [
  'fileBrowse',
  'fileRead',
  'fileWrite'
]

/** Read-write WITHOUT the file trio — what a pre-file-editor grant materializes
 * to. Used to detect "read-write but files OFF" so the toggle never silently
 * shows such an entry as full Read/Write. */
export const LEGACY_READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES: readonly RemoteWorkspaceCapability[] = [
  'monitor',
  'approve',
  'answer',
  'cancel',
  'startTurn',
  'diffReview',
  'steer'
]

/** The full read-write default a NEW Read/Write grant writes — includes the
 * file trio (git commit/push is gated on `fileWrite`). */
export const READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES: readonly RemoteWorkspaceCapability[] = [
  ...LEGACY_READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES,
  ...FILE_REMOTE_WORKSPACE_CAPABILITIES
]

/** Admin-only powers (pin/yolo). Never part of the mode defaults; preserved
 * verbatim when present on an existing entry. */
export const ADMIN_REMOTE_WORKSPACE_CAPABILITIES: readonly RemoteWorkspaceCapability[] = ['pin', 'yolo']

/** The default capability set materialized for a brand-new grant of `mode`. */
export function capabilitiesForRemoteWorkspaceMode(
  mode: RemoteWorkspaceMode
): readonly RemoteWorkspaceCapability[] {
  return mode === 'read-only'
    ? READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES
    : READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES
}

export function isAdminRemoteWorkspaceCapability(capability: RemoteWorkspaceCapability): boolean {
  return ADMIN_REMOTE_WORKSPACE_CAPABILITIES.includes(capability)
}
