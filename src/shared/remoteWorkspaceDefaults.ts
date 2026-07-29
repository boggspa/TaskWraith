import { ANTIGRAVITY_PROVIDER_ID, LIVE_SELECTABLE_PROVIDER_IDS } from './retiredProviders'

/**
 * Node-builtin-FREE mirror of the remote-workspace allowlist capability/provider
 * constants that live in `src/main/RemoteWorkspaceAllowlist.ts`.
 *
 * The main module imports `fs` + `path`, so the renderer must NOT import its
 * VALUE exports (that would pull node builtins into the renderer bundle and
 * blank the window — see MEMORY.md). The renderer imports these copies instead.
 * Keep the capability arrays byte-identical to the main module's; the test in
 * `remoteWorkspaceDefaults.test.ts` is a drift guard. The provider list below is
 * the active remote-default set used for new grants.
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
  /**
   * External publication from a paired device: git push and PR creation.
   * Deliberately separate from fileWrite so a phone that can edit/commit files
   * does not automatically gain publish authority.
   */
  | 'externalPublish'
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

/** Active providers for new remote-workspace grants — the canonical
 * live-selectable set (Path-B Cursor included). Retired providers such as
 * Gemini remain readable through compatibility/history paths, but are not
 * granted for new phone-origin remote actions. */
export const PROVIDER_OPTIONS = LIVE_SELECTABLE_PROVIDER_IDS

/**
 * Providers a remote-workspace grant may explicitly authorize. This is wider
 * than the static live offer set only for conditionally admitted providers:
 * granting AntiGravity here never offers or runs it by itself — the independent
 * AGY consent / Gemini API credential + authenticated-catalog gates still apply
 * at picker projection and every dispatch.
 */
export const REMOTE_GRANTABLE_PROVIDER_IDS = [
  ...LIVE_SELECTABLE_PROVIDER_IDS,
  ANTIGRAVITY_PROVIDER_ID
] as const

export const APPROVAL_MODE_OPTIONS = ['default', 'plan'] as const

export const READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES: readonly RemoteWorkspaceCapability[] = [
  'monitor',
  'approve'
]

/** The file-editing trio — the powers a "Read/Write" grant adds on top of the
 * legacy read-write set, and that legacy entries deliberately exclude. Git
 * stage/commit ride this tier; push/PR-create use `externalPublish`. */
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
 * file trio, but not external publishing. */
export const READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES: readonly RemoteWorkspaceCapability[] = [
  ...LEGACY_READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES,
  ...FILE_REMOTE_WORKSPACE_CAPABILITIES
]

/** Admin-only powers. Never part of the mode defaults; preserved verbatim when
 * present on an existing entry. */
export const ADMIN_REMOTE_WORKSPACE_CAPABILITIES: readonly RemoteWorkspaceCapability[] = [
  'externalPublish',
  'pin',
  'yolo'
]

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
